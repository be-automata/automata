import { and, eq } from "drizzle-orm";

import { DB } from "../../db";
import { agentRun, thread } from "../../db/schema";
import {
  capabilitiesForLane,
  isAgentCapabilities,
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
        eq(agentRun.organizationId, organizationId),
        // The thread's own org too: a thread moved by any path other than
        // rehome stops answering to its old org.
        eq(thread.organizationId, organizationId),
        eq(agentRun.threadId, threadId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!isAgentCapabilities(row.capabilities)) {
    throw new Error(
      `agent_run ${row.threadId}: stored capabilities are malformed`,
    );
  }
  return {
    ...row,
    capabilities: row.capabilities,
    terminal: Boolean(row.terminal),
  };
}

/**
 * Registers `threadId` as the root of its own tree. Idempotent: an existing row
 * is returned unchanged (whatever its lane, even if it is a child). `null` when
 * the thread is absent or belongs to no organization or another one.
 */
export async function ensureRootRun({
  db,
  threadId,
  organizationId,
  lane,
}: {
  db: Executor;
  threadId: string;
  organizationId: string;
  lane: AgentBusLane;
}): Promise<AgentRunView | null> {
  const rows = await db
    .select({
      organizationId: thread.organizationId,
      githubRepoFullName: thread.githubRepoFullName,
    })
    .from(thread)
    .where(eq(thread.id, threadId))
    .limit(1);
  const row = rows[0];
  if (!row || row.organizationId === null) return null;
  if (row.organizationId !== organizationId) return null;

  await db
    .insert(agentRun)
    .values({
      threadId,
      organizationId,
      parentThreadId: null,
      rootThreadId: threadId,
      lane,
      capabilities: capabilitiesForLane(lane, {
        repoGrant: [{ repo: row.githubRepoFullName, access: "write" }],
        skills: null,
      }),
      depth: 0,
    })
    .onConflictDoNothing({ target: agentRun.threadId });

  return getRunForOrg({ db, organizationId, threadId });
}

/**
 * Registers `childThreadId` as a child of the running `parentThreadId`. Checks,
 * in order: both rows in this organization and the child thread's parent
 * matches (`not_found`), parent terminal, parent blocked, narrowing, then the
 * insert; a child that already has a row is refused with `run_exists`.
 */
export async function createChildRun({
  db,
  organizationId,
  parentThreadId,
  childThreadId,
  request,
}: {
  db: Executor;
  organizationId: string;
  parentThreadId: string;
  childThreadId: string;
  request: { lane: AgentBusLane; repo?: string; skills?: string[] };
}): Promise<CreateChildRunResult> {
  const [parent, childRows] = await Promise.all([
    getRunForOrg({ db, organizationId, threadId: parentThreadId }),
    db
      .select({ parentThreadId: thread.parentThreadId })
      .from(thread)
      .where(
        and(
          eq(thread.id, childThreadId),
          eq(thread.organizationId, organizationId),
        ),
      )
      .limit(1),
  ]);
  const child = childRows[0];
  if (!parent || !child || child.parentThreadId !== parentThreadId) {
    return { ok: false, error: "not_found" };
  }
  if (parent.terminal) return { ok: false, error: "sender_not_running" };
  if (parent.blockedAt !== null) return { ok: false, error: "agent_blocked" };

  const narrowed = narrowForChild(parent, request);
  if (!narrowed.ok) return { ok: false, error: narrowed.error };

  const inserted = await db
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
    db,
    organizationId,
    threadId: childThreadId,
  });
  if (!run) return { ok: false, error: "not_found" };
  return { ok: true, run };
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
    .where(
      and(
        eq(agentRun.organizationId, organizationId),
        eq(agentRun.threadId, threadId),
      ),
    );
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
    .where(
      and(
        eq(agentRun.organizationId, organizationId),
        eq(agentRun.threadId, threadId),
      ),
    );
}
