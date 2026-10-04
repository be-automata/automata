import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { DB } from "@terragon/shared/db";
import { auditRuns, thread as threadTable } from "@terragon/shared/db/schema";
import {
  finishAuditRun,
  listReclaimableAuditRuns,
  type AuditEffectRow,
} from "@terragon/shared/model/audit-findings";
import * as breakerModel from "@terragon/shared/model/self-heal-breaker";
import * as outboxModel from "@terragon/shared/model/self-heal-outbox";
import { withSelfHealTx } from "@terragon/shared/model/self-heal-tx";
import { ABANDONED_TERMINAL_CAUSES } from "@terragon/shared/model/terminal-cause";
import type { ThreadStatus } from "@terragon/shared/db/types";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { redactSecrets } from "@terragon/utils/redact";

import { resolveBotLogin } from "../review/bot-login";
import { AUDIT_FINDINGS_SKILL_NAME } from "../review/review-skill";
import { applyOutboxEffects } from "./apply-outbox";
import { handleAuditFindingsAtFinish } from "./audit-finish";
import { createDbAuditLedger } from "./audit-ledger";
import { ensureLabelsBestEffort } from "./execute-audit-findings";
import { createIssueWriter } from "./issue-writer";
import {
  isSelfHealLoopEnabled,
  loadSelfHealContext,
  resolveSelfHealEffective,
} from "./resolve-self-heal";
import { createSelfHealOctokit } from "./self-heal-octokit";

/**
 * The self-heal cron's two backstops (RES-08 sweep half, OUTBOX-01 drain).
 *
 * runAuditSweep is the SECOND idempotent entry to the audit finish hook: a
 * terminal audit thread whose hook never ran (or released its claim) is
 * finished here, and so is a claimed run whose lease expired. runOutboxDrain
 * applies the effects a hook decided on but did not get to. Every selector is
 * LIMIT-ed and runs in a timeout-bounded transaction; nothing here throws.
 */

/** The review sweep's grace: the finish hook owns the normal path. */
const AUDIT_SWEEP_GRACE_MS = 10 * 60 * 1000;
const AUDIT_SWEEP_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const TERMINAL_STATUSES: ThreadStatus[] = ["complete", "stopped"];
const DEFAULT_PER_ITEM_MS = 20_000;
const DEFAULT_LIMIT = 20;
/** Below this the next item cannot make a GitHub call (withSelfHealCall floor). */
const MIN_ITEM_BUDGET_MS = 2_000;
/** Effects held back for a repo whose switches are off. */
const DEFER_OFF_MS = 10 * 60_000;
/** Effects held back after a failed token mint. */
const DEFER_MINT_FAILED_MS = 2 * 60_000;

export interface AuditSweepResult {
  scanned: number;
  processed: number;
}

export interface AuditSweepDeps {
  handleFinish: typeof handleAuditFindingsAtFinish;
  now: () => Date;
}

const DEFAULT_SWEEP_DEPS: AuditSweepDeps = {
  handleFinish: handleAuditFindingsAtFinish,
  now: () => new Date(),
};

interface SweepCandidate {
  threadId: string;
  userId: string;
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

async function selectStampedThreads({
  db,
  now,
  limit,
}: {
  db: DB;
  now: Date;
  limit: number;
}): Promise<SweepCandidate[]> {
  return withSelfHealTx(db, async (tx) => {
    const rows = await tx
      .select({ threadId: threadTable.id, userId: threadTable.userId })
      .from(threadTable)
      .leftJoin(auditRuns, eq(auditRuns.threadId, threadTable.id))
      .where(
        and(
          inArray(threadTable.status, TERMINAL_STATUSES),
          eq(threadTable.archived, false),
          // v0 keeps chat state on the thread row; a v1 thread is not addressable.
          eq(threadTable.version, 0),
          lte(
            threadTable.updatedAt,
            new Date(now.getTime() - AUDIT_SWEEP_GRACE_MS),
          ),
          gte(
            threadTable.updatedAt,
            new Date(now.getTime() - AUDIT_SWEEP_LOOKBACK_MS),
          ),
          sql`${threadTable.sourceMetadata}->>'type' = 'automation-skill'`,
          sql`${threadTable.sourceMetadata}->>'skillName' = ${AUDIT_FINDINGS_SKILL_NAME}`,
          // An abandoned run never finished its audit: nothing to write.
          or(
            isNull(threadTable.terminalCause),
            notInArray(threadTable.terminalCause, [
              ...ABANDONED_TERMINAL_CAUSES,
            ]),
          ),
          or(isNull(auditRuns.id), eq(auditRuns.status, "dispatched")),
        ),
      )
      .orderBy(asc(threadTable.updatedAt))
      .limit(limit);
    return rows;
  });
}

async function selectThreadsById({
  db,
  threadIds,
}: {
  db: DB;
  threadIds: string[];
}): Promise<Map<string, { userId: string; version: number }>> {
  if (threadIds.length === 0) return new Map();
  const rows = await withSelfHealTx(db, (tx) =>
    tx
      .select({
        id: threadTable.id,
        userId: threadTable.userId,
        version: threadTable.version,
      })
      .from(threadTable)
      .where(inArray(threadTable.id, threadIds))
      .limit(threadIds.length),
  );
  return new Map(
    rows.map((row) => [row.id, { userId: row.userId, version: row.version }]),
  );
}

export async function runAuditSweep({
  db,
  now,
  deadlineAt,
  perItemMs = DEFAULT_PER_ITEM_MS,
  limit = DEFAULT_LIMIT,
  deps = DEFAULT_SWEEP_DEPS,
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  perItemMs?: number;
  limit?: number;
  deps?: AuditSweepDeps;
}): Promise<AuditSweepResult> {
  const candidates: SweepCandidate[] = [];
  try {
    candidates.push(...(await selectStampedThreads({ db, now, limit })));

    const reclaimable = await listReclaimableAuditRuns({ db, now, limit });
    const byId = await selectThreadsById({
      db,
      threadIds: reclaimable.map((run) => run.threadId),
    });
    for (const run of reclaimable) {
      const found = byId.get(run.threadId);
      if (!found) continue;
      if (found.version > 0) {
        // Not addressable (#153): close the run so it stops re-queueing.
        await finishAuditRun({
          db,
          organizationId: run.organizationId,
          id: run.id,
          status: "failed",
          outcome: "error",
          error: "v1 thread chat is not addressable by the sweep",
        });
        console.error("[audit-sweep] v1 thread run closed", {
          threadId: run.threadId,
        });
        continue;
      }
      if (!candidates.some((c) => c.threadId === run.threadId)) {
        candidates.push({ threadId: run.threadId, userId: found.userId });
      }
    }
  } catch (error) {
    console.error("[audit-sweep] selecting candidates failed", {
      error: errorText(error),
    });
    return { scanned: candidates.length, processed: 0 };
  }

  const scanned = candidates.length;
  let processed = 0;
  for (const candidate of candidates.slice(0, limit)) {
    const left = deadlineAt.getTime() - deps.now().getTime();
    if (left < MIN_ITEM_BUDGET_MS) break;
    const itemDeadline = new Date(
      Math.min(deps.now().getTime() + perItemMs, deadlineAt.getTime()),
    );
    try {
      await deps.handleFinish({
        db,
        userId: candidate.userId,
        threadId: candidate.threadId,
        threadChatId: LEGACY_THREAD_CHAT_ID,
        deadlineAt: itemDeadline,
      });
      processed += 1;
    } catch (error) {
      // The hook never throws; this guards the contract, not a known path.
      console.error("[audit-sweep] candidate failed (continuing)", {
        threadId: candidate.threadId,
        error: errorText(error),
      });
    }
  }
  return { scanned, processed };
}

export interface OutboxDrainResult {
  claimed: number;
  applied: number;
  pending: number;
  failed: number;
  groups: number;
}

export interface OutboxDrainDeps {
  isLoopEnabled: (db: DB) => Promise<boolean>;
  claimDue: typeof outboxModel.claimDueEffects;
  loadContext: typeof loadSelfHealContext;
  mint: typeof createSelfHealOctokit;
  createWriter: typeof createIssueWriter;
  applyEffects: typeof applyOutboxEffects;
  now: () => Date;
}

const DEFAULT_DRAIN_DEPS: OutboxDrainDeps = {
  isLoopEnabled: isSelfHealLoopEnabled,
  claimDue: outboxModel.claimDueEffects,
  loadContext: loadSelfHealContext,
  mint: createSelfHealOctokit,
  createWriter: createIssueWriter,
  applyEffects: applyOutboxEffects,
  now: () => new Date(),
};

async function releaseGroup(
  db: DB,
  effects: readonly AuditEffectRow[],
  deferMs: number | null,
  now: Date,
): Promise<void> {
  for (const effect of effects) {
    try {
      await outboxModel.releaseEffectLease({
        db,
        organizationId: effect.organizationId,
        id: effect.id,
        ...(deferMs !== null
          ? { nextAttemptAt: new Date(now.getTime() + deferMs) }
          : {}),
      });
    } catch (error) {
      console.error("[outbox-drain] could not release a lease", {
        effectId: effect.id,
        error: errorText(error),
      });
    }
  }
}

export async function runOutboxDrain({
  db,
  now,
  deadlineAt,
  perItemMs = DEFAULT_PER_ITEM_MS,
  limit = DEFAULT_LIMIT,
  deps = DEFAULT_DRAIN_DEPS,
}: {
  db: DB;
  now: Date;
  deadlineAt: Date;
  perItemMs?: number;
  limit?: number;
  deps?: OutboxDrainDeps;
}): Promise<OutboxDrainResult> {
  const result: OutboxDrainResult = {
    claimed: 0,
    applied: 0,
    pending: 0,
    failed: 0,
    groups: 0,
  };
  // Flag off: pending rows stay pending and nothing is claimed (T-08-12-3).
  if (!(await deps.isLoopEnabled(db))) return result;

  const claimed = await deps.claimDue({ db, now, limit });
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  const groups = new Map<string, AuditEffectRow[]>();
  for (const effect of claimed) {
    const key = `${effect.organizationId}\u0000${effect.repoFullName}`;
    const group = groups.get(key);
    if (group) group.push(effect);
    else groups.set(key, [effect]);
  }

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const organizationId = first.organizationId;
    const repoFullName = first.repoFullName;

    if (deadlineAt.getTime() - deps.now().getTime() < MIN_ITEM_BUDGET_MS) {
      await releaseGroup(db, group, null, deps.now());
      result.pending += group.length;
      continue;
    }
    result.groups += 1;
    const itemDeadline = new Date(
      Math.min(deps.now().getTime() + perItemMs, deadlineAt.getTime()),
    );

    try {
      const [owner, repo] = repoFullName.split("/");
      if (!owner || !repo) {
        throw new Error("malformed repo slug on an outbox effect");
      }
      // Every switch that needs no GitHub call, before the one token mint.
      const ctx = await deps.loadContext({
        db,
        organizationId,
        repoFullName,
        installationKey: "pending",
      });
      const effective = resolveSelfHealEffective({
        ...ctx,
      });
      if (effective.mode !== "on") {
        await releaseGroup(db, group, DEFER_OFF_MS, deps.now());
        result.pending += group.length;
        continue;
      }

      let minted: Awaited<ReturnType<typeof createSelfHealOctokit>>;
      try {
        minted = await deps.mint({
          owner,
          repo,
          signal: AbortSignal.timeout(
            Math.max(itemDeadline.getTime() - deps.now().getTime(), 1_000),
          ),
        });
      } catch (error) {
        console.error("[outbox-drain] token mint failed", {
          repoFullName,
          error: errorText(error),
        });
        await releaseGroup(db, group, DEFER_MINT_FAILED_MS, deps.now());
        result.pending += group.length;
        continue;
      }
      const installationKey = String(minted.installationId);
      const callDeps = {
        db,
        now: deps.now,
        log: (message: string, fields: Record<string, unknown>) =>
          Object.keys(fields).length === 0
            ? console.log(message)
            : console.log(message, fields),
        sleep: (ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms)),
        rand: Math.random,
      };
      const writer = deps.createWriter({
        octokit: minted.octokit,
        owner,
        repo,
        botLogin: resolveBotLogin(),
        organizationId,
        installationKey,
        deadlineAt: itemDeadline,
        deps: callDeps,
      });
      const ledger = createDbAuditLedger({
        db,
        organizationId,
        repoFullName,
        runId: first.runId,
      });
      await ensureLabelsBestEffort({ writer, log: callDeps.log }, group);
      const summary = await deps.applyEffects({
        effects: group,
        writer,
        deadlineAt: itemDeadline,
        mode: "on",
        deps: {
          db,
          installationKey,
          outbox: outboxModel,
          breakers: breakerModel,
          now: deps.now,
          sleep: callDeps.sleep,
          rand: callDeps.rand,
          log: callDeps.log,
          onIssueCreated: (effect, issueNumber) =>
            ledger.markIssueCreated(effect, issueNumber, deps.now()),
          issueNumberFor: (effect) => ledger.issueNumberFor(effect),
        },
      });
      result.applied += summary.applied;
      result.pending += summary.pending;
      result.failed += summary.failed;
    } catch (error) {
      console.error("[outbox-drain] group failed (continuing)", {
        repoFullName,
        error: errorText(error),
      });
      await releaseGroup(db, group, DEFER_MINT_FAILED_MS, deps.now());
      result.pending += group.length;
    }
  }
  return result;
}
