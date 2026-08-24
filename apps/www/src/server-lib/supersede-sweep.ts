import { env } from "@terragon/env/apps-www";
import { db } from "@/lib/db";
import {
  claimSweepLease,
  findSweepCandidates,
  hasNewerRun,
  markHatchetRunSwept,
} from "@terragon/shared/model/hatchet-run";
import {
  findOrphanRemoteThreads,
  markThreadTerminal,
} from "@terragon/shared/model/threads";
import type { TerminalCause } from "@terragon/shared/model/terminal-cause";
import {
  getAgentRunStatus,
  type AgentRunStatus,
} from "@/agent/hatchet/transport";

/**
 * #125 C4 supersede sweep — the state machine's backstop for HARD deaths the
 * worker's explicit terminal (C1) cannot cover: a worker SIGKILLed mid-run, a
 * cancelled run whose terminal POST never landed, and the pre-existing
 * non-transactional-enqueue gap (thread written, trigger never fired).
 *
 * Runs every minute on the scheduled-tasks cron. Two rules:
 *  (i)  a recorded run still in_flight for > T whose engine status is
 *       CANCELLED (or gone) and whose thread has no terminal → terminal by
 *       INFERRED cause: `superseded` when a newer run exists for the same
 *       (org, repo, PR), else `user-cancelled`. Engine FAILED → `daemon-failed`
 *       (onFailure normally posts this; the sweep is the backstop).
 *  (ii) a remote thread dispatched > N ago with NO recorded run at all →
 *       `plane-offline`.
 *
 * Exactly-once by construction: every candidate is CLAIMED with a
 * compare-and-set lease (`claimSweepLease`) before any engine read or write —
 * two concurrent ticks never both act — and the terminal write itself only
 * transitions a still-reapable thread (`markThreadTerminal`), so a retry after
 * a crash mid-tick is a no-op. A run that is still RUNNING/QUEUED is left
 * alone (its lease expires and it is re-examined next tick).
 */

/** Rule (i): in_flight for longer than this before the engine is consulted. */
export const SWEEP_CANCELLED_AFTER_MS_DEFAULT = 10 * 60 * 1000;
/** Rule (ii): dispatched-without-a-run for longer than this ⇒ plane-offline. */
export const SWEEP_ORPHAN_AFTER_MS_DEFAULT = 15 * 60 * 1000;

/** An env knob is a positive integer ms string or unset; anything else is ignored. */
function msFromEnv(raw: string): number | undefined {
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n > 0 ? n : undefined;
}

export type SweepDeps = {
  now?: () => Date;
  /** Injected for tests; production reads the engine over REST. */
  readStatus?: (externalId: string) => Promise<AgentRunStatus>;
  cancelledAfterMs?: number;
  orphanAfterMs?: number;
};

export type SweepReport = {
  examined: number;
  claimed: number;
  terminals: { threadId: string; cause: TerminalCause }[];
  orphans: string[];
};

/**
 * Infer the terminal cause for a run the engine reports as CANCELLED / gone —
 * documented here because it is a RULE, not a lookup: a newer sibling run for
 * the PR means this one was superseded; otherwise someone cancelled it.
 */
async function inferCancelledCause(run: {
  organizationId: string;
  repoFullName: string;
  prNumber: number;
  createdAt: Date;
  externalId: string;
}): Promise<TerminalCause> {
  const newer = await hasNewerRun({
    db,
    organizationId: run.organizationId,
    repoFullName: run.repoFullName,
    prNumber: run.prNumber,
    after: run.createdAt,
    excludeExternalId: run.externalId,
  });
  return newer ? "superseded" : "user-cancelled";
}

function causeForStatus(
  status: AgentRunStatus,
): "cancelled" | "failed" | "live" | "done" {
  switch (status) {
    case "CANCELLED":
    case "NOT_FOUND":
      return "cancelled";
    case "FAILED":
      return "failed";
    case "QUEUED":
    case "RUNNING":
      return "live";
    case "COMPLETED":
      return "done";
    default: {
      const exhaustive: never = status;
      throw new Error(`unknown run status ${String(exhaustive)}`);
    }
  }
}

export async function runSupersedeSweep(
  deps: SweepDeps = {},
): Promise<SweepReport> {
  const now = deps.now?.() ?? new Date();
  const cancelledAfterMs =
    deps.cancelledAfterMs ??
    msFromEnv(env.SUPERSEDE_SWEEP_CANCELLED_AFTER_MS) ??
    SWEEP_CANCELLED_AFTER_MS_DEFAULT;
  const orphanAfterMs =
    deps.orphanAfterMs ??
    msFromEnv(env.SUPERSEDE_SWEEP_ORPHAN_AFTER_MS) ??
    SWEEP_ORPHAN_AFTER_MS_DEFAULT;
  const readStatus =
    deps.readStatus ??
    ((externalId: string) =>
      getAgentRunStatus(externalId, {
        apiUrl: env.HATCHET_API_URL,
        tenantId: env.HATCHET_TENANT_ID,
        apiToken: env.HATCHET_API_TOKEN,
      }));

  const report: SweepReport = {
    examined: 0,
    claimed: 0,
    terminals: [],
    orphans: [],
  };

  // Rule (i)
  const candidates = await findSweepCandidates({
    db,
    olderThanMs: cancelledAfterMs,
    now,
  });
  report.examined = candidates.length;
  for (const run of candidates) {
    if (!(await claimSweepLease({ db, id: run.id, now }))) continue;
    report.claimed++;
    let status: AgentRunStatus;
    try {
      status = await readStatus(run.externalId);
    } catch (error) {
      console.error("[supersede-sweep] engine status read failed (skip)", {
        externalId: run.externalId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const kind = causeForStatus(status);
    if (kind === "live" || kind === "done") continue;
    const cause: TerminalCause =
      kind === "failed" ? "daemon-failed" : await inferCancelledCause(run);
    const applied = await markThreadTerminal({
      db,
      threadId: run.threadId,
      cause,
    });
    await markHatchetRunSwept({ db, id: run.id });
    if (applied) report.terminals.push({ threadId: run.threadId, cause });
    console.log("[supersede-sweep] terminal", {
      threadId: run.threadId,
      externalId: run.externalId,
      status,
      cause,
      applied,
    });
  }

  // Rule (ii)
  const orphans = await findOrphanRemoteThreads({
    db,
    olderThanMs: orphanAfterMs,
    now,
  });
  for (const t of orphans) {
    const applied = await markThreadTerminal({
      db,
      threadId: t.id,
      cause: "plane-offline",
    });
    if (applied) {
      report.orphans.push(t.id);
      console.log("[supersede-sweep] orphan → plane-offline", {
        threadId: t.id,
        dispatchedAt: t.createdAt.toISOString(),
      });
    }
  }
  return report;
}
