import { and, eq } from "drizzle-orm";

import { DB } from "../../db";
import { agentRun, thread } from "../../db/schema";
import {
  capabilitiesForLane,
  agentBusLaneSchema,
  agentCapabilitiesSchema,
  narrowForChild,
  type AgentBusError,
  type AgentBusLane,
  type AgentRunView,
} from "./capabilities";
import {
  threadEffectiveStatusSql,
  threadIsTerminal,
} from "../thread-effective-status";

/**
 * The agent_run ledger (#659, S1). Every read is scoped to an organization: an
 * id that does not exist and an id that belongs to another organization take
 * the same path and return the same `null`. Policy (what a child may hold) lives
 * in `capabilities.ts`; this file only reads and writes rows.
 */

type Executor = Pick<DB, "select" | "insert" | "update">;

export type CreateChildRunResult =
  | { ok: true; run: AgentRunView }
  | { ok: false; error: AgentBusError };

/** The ledger row of `threadId`, only within `organizationId`. */
function runInOrg(organizationId: string, threadId: string) {
  return and(
    eq(agentRun.organizationId, organizationId),
    eq(agentRun.threadId, threadId),
  );
}

/** The run of `threadId` in `organizationId`, with its thread's effective status. */
export async function getRunForOrg({
  db,
  organizationId,
  threadId,
}: {
  db: Executor;
  organizationId: string;
  threadId: string;
}): Promise<AgentRunView | null> {
  const rows = await db
    .select({
      threadId: agentRun.threadId,
      organizationId: agentRun.organizationId,
      parentThreadId: agentRun.parentThreadId,
      rootThreadId: agentRun.rootThreadId,
      lane: agentRun.lane,
      capabilities: agentRun.capabilities,
      depth: agentRun.depth,
      blockedAt: agentRun.blockedAt,
      status: threadEffectiveStatusSql(),
      terminal: threadIsTerminal(),
    })
    .from(agentRun)
    .innerJoin(thread, eq(thread.id, agentRun.threadId))
    .where(
      and(
        runInOrg(organizationId, threadId),
        // The thread's own org too: a thread moved by any path other than
        // rehome stops answering to its old org.
        eq(thread.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Stored text and jsonb are typed, not checked: fail closed on either.
  const lane = agentBusLaneSchema.safeParse(row.lane);
  const capabilities = agentCapabilitiesSchema.safeParse(row.capabilities);
  if (!lane.success || !capabilities.success) {
    throw new Error(`agent_run ${row.threadId}: stored row is malformed`);
  }
  return {
    ...row,
    lane: lane.data,
    capabilities: capabilities.data,
    terminal: Boolean(row.terminal),
  };
}

/**
 * Registers `threadId` as the root of its own tree. Idempotent: an existing row
 * is returned unchanged (whatever its lane, even if it is a child). `null` when
 * the thread is absent, belongs to no organization or another one, or is the
 * child of a run on the bus: such a thread joins only through
 * `createChildRun`, so it can never escape its parent's narrowing by
 * registering first. A plain fork (its parent is not on the bus) can be a root.
 */
export async function ensureRootRun({
  db,
  threadId,
  organizationId,
  lane,
}: {
  db: Pick<DB, "transaction">;
  threadId: string;
  organizationId: string;
  lane: AgentBusLane;
}): Promise<AgentRunView | null> {
  return db.transaction(async (tx) => {
    // An existing row (the common case) costs one read.
    const existing = await getRunForOrg({ db: tx, organizationId, threadId });
    if (existing) return existing;

    // This thread's row FOR NO KEY UPDATE, then its parent's FOR SHARE: a
    // parent registering itself holds its own row, so a child's check of the
    // parent below waits for it. Locks are always taken child before parent,
    // so two registrations cannot deadlock.
    const rows = await tx
      .select({
        organizationId: thread.organizationId,
        githubRepoFullName: thread.githubRepoFullName,
        parentThreadId: thread.parentThreadId,
      })
      .from(thread)
      .where(eq(thread.id, threadId))
      .limit(1)
      .for("no key update");
    const row = rows[0];
    if (row?.organizationId !== organizationId) return null;
    if (row.parentThreadId !== null) {
      await tx
        .select({ id: thread.id })
        .from(thread)
        .where(eq(thread.id, row.parentThreadId))
        .for("share");
      const parentRun = await tx
        .select({ threadId: agentRun.threadId })
        .from(agentRun)
        .where(eq(agentRun.threadId, row.parentThreadId))
        .limit(1);
      if (parentRun.length > 0) return null;
    }

    await tx
      .insert(agentRun)
      .values({
        threadId,
        organizationId,
        rootThreadId: threadId,
        lane,
        capabilities: capabilitiesForLane(lane, {
          // Review is emit-only: it reads its repo and never pushes.
          repoGrant: [
            {
              repo: row.githubRepoFullName,
              access: lane === "review" ? "read" : "write",
            },
          ],
          skills: null,
        }),
      })
      .onConflictDoNothing({ target: agentRun.threadId });

    return getRunForOrg({ db: tx, organizationId, threadId });
  });
}

/**
 * Registers `childThreadId` as a child of the running `parentThreadId`. Checks,
 * in order: both rows in this organization and the child thread's parent
 * matches (`not_found`), parent terminal, parent blocked, the requested repo is
 * the child thread's own (default) and in the parent's grant
 * (`repo_not_granted`), narrowing, then the insert; a child that already has a row is refused with `run_exists`.
 *
 * One transaction holding the parent's ledger row (`FOR UPDATE`), so a
 * concurrent `markBlocked` cannot land between the check and the insert. A
 * parent that ends in that window is not serialized here (its thread, not its
 * ledger row, changes); the reconciler that cancels children of a terminal
 * parent covers it (#651 G6).
 */
export async function createChildRun({
  db,
  organizationId,
  parentThreadId,
  childThreadId,
  request,
}: {
  db: Pick<DB, "transaction">;
  organizationId: string;
  parentThreadId: string;
  childThreadId: string;
  request: { lane: AgentBusLane; repo?: string; skills?: string[] };
}): Promise<CreateChildRunResult> {
  return db.transaction(async (tx) => {
    await tx
      .select({ threadId: agentRun.threadId })
      .from(agentRun)
      .where(runInOrg(organizationId, parentThreadId))
      .for("update");
    const parent = await getRunForOrg({
      db: tx,
      organizationId,
      threadId: parentThreadId,
    });
    const childRows = await tx
      .select({
        parentThreadId: thread.parentThreadId,
        githubRepoFullName: thread.githubRepoFullName,
      })
      .from(thread)
      .where(
        and(
          eq(thread.id, childThreadId),
          eq(thread.organizationId, organizationId),
        ),
      )
      .limit(1);
    const child = childRows[0];
    if (!parent || !child || child.parentThreadId !== parentThreadId) {
      return { ok: false, error: "not_found" };
    }
    if (parent.terminal) return { ok: false, error: "sender_not_running" };
    if (parent.blockedAt !== null) {
      return { ok: false, error: "agent_blocked" };
    }

    // The grant names the repo the child thread actually runs on.
    const repo = request.repo ?? child.githubRepoFullName;
    if (repo.toLowerCase() !== child.githubRepoFullName.toLowerCase()) {
      return { ok: false, error: "repo_not_granted" };
    }
    const narrowed = narrowForChild(parent, { ...request, repo });
    if (!narrowed.ok) return { ok: false, error: narrowed.error };

    const inserted = await tx
      .insert(agentRun)
      .values({
        threadId: childThreadId,
        organizationId,
        parentThreadId,
        rootThreadId: parent.rootThreadId,
        lane: request.lane,
        capabilities: narrowed.capabilities,
        depth: narrowed.depth,
      })
      .onConflictDoNothing({ target: agentRun.threadId })
      .returning({ threadId: agentRun.threadId });
    if (inserted.length === 0) return { ok: false, error: "run_exists" };

    const run = await getRunForOrg({
      db: tx,
      organizationId,
      threadId: childThreadId,
    });
    if (!run) return { ok: false, error: "not_found" };
    return { ok: true, run };
  });
}

/** Marks the run blocked. A no-op for an absent run or one in another organization. */
export async function markBlocked({
  db,
  organizationId,
  threadId,
  reason,
}: {
  db: Executor;
  organizationId: string;
  threadId: string;
  reason: string;
}): Promise<void> {
  await db
    .update(agentRun)
    .set({ blockedAt: new Date(), blockedReason: reason })
    .where(runInOrg(organizationId, threadId));
}

/** Clears the blocked mark. A no-op for an absent run or one in another organization. */
export async function clearBlocked({
  db,
  organizationId,
  threadId,
}: {
  db: Executor;
  organizationId: string;
  threadId: string;
}): Promise<void> {
  await db
    .update(agentRun)
    .set({ blockedAt: null, blockedReason: null })
    .where(runInOrg(organizationId, threadId));
}
