import { env } from "@terragon/env/apps-www";
import { db } from "@/lib/db";
import {
  claimSweepLeases,
  findSweepCandidates,
  hasNewerRun,
  retireHatchetRun,
  setSweepLease,
  type SweepCandidate,
} from "@terragon/shared/model/hatchet-run";
import {
  findOrphanRemoteThreads,
  markThreadTerminal,
} from "@terragon/shared/model/threads";
import type { TerminalCause } from "@terragon/shared/model/terminal-cause";
import { assertNever } from "@terragon/shared/utils";
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
 *  (i)  a recorded run still in_flight for > T whose thread has no terminal:
 *       engine CANCELLED → `superseded` when a newer run exists for the same
 *       (org, repo, PR), else `user-cancelled`; engine NOT_FOUND (pruned, or
 *       the trigger never landed) → `superseded` with a newer sibling, else
 *       `plane-offline`; engine FAILED → `daemon-failed` (onFailure normally
 *       posts this; the sweep is the backstop); engine COMPLETED while the
 *       thread is still reapable → the run row is retired (www missed the
 *       finish; the stalled watchdog owns the thread) so it is not re-read
 *       every tick; QUEUED/RUNNING → left alone, lease pushed out.
 *  (ii) a remote thread dispatched > N ago with NO recorded run at all →
 *       `plane-offline`.
 *
 * Exactly-once by construction: the batch is CLAIMED with one compare-and-set
 * lease UPDATE (`claimSweepLeases`) before any engine read or write — two
 * concurrent ticks never both act on a run — and the terminal write itself
 * only transitions a still-reapable thread (`markThreadTerminal`), so a
 * retry after a crash mid-tick is a no-op. A failed engine read releases the
 * lease so the next tick retries at once.
 */

/** Rule (i): in_flight for longer than this before the engine is consulted. */
export const SWEEP_CANCELLED_AFTER_MS_DEFAULT = 10 * 60 * 1000;
/** Rule (ii): dispatched-without-a-run for longer than this ⇒ plane-offline. */
export const SWEEP_ORPHAN_AFTER_MS_DEFAULT = 15 * 60 * 1000;
/** How long a LIVE run's lease is pushed out before it is re-read. */
const LIVE_RECHECK_MS = 15 * 60 * 1000;
/** Engine reads in flight at once. */
const ENGINE_READ_CONCURRENCY = 4;

/** An env knob is a positive integer ms string or unset; anything else is ignored. */
function msFromEnv(raw: string): number | undefined {
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n > 0 ? n : undefined;
}

export type SweepDeps = {
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
  /** Per-candidate failures — the tick never aborts on one bad row. */
  errors: { externalId: string; message: string }[];
};

/**
 * The newer sibling run for the PR, if any — an app-side fact (hatchet_run),
 * which is why cause inference lives here and not on the engine.
 * TODO(hatchet_run retirement): when the table goes (runbook §success
 * criteria), this must read the engine's run list by `additional_metadata`
 * prKey instead — or every CANCELLED degrades to `user-cancelled`.
 */
function newerSibling(run: SweepCandidate) {
  return hasNewerRun({
    db,
    organizationId: run.organizationId,
    repoFullName: run.repoFullName,
    prNumber: run.prNumber,
    after: run.createdAt,
    excludeExternalId: run.externalId,
  });
}

type Decision =
  | { kind: "terminal"; cause: TerminalCause }
  | { kind: "retire" }
  | { kind: "live" };

/** The exhaustive rule (i) table; a new engine status fails compilation here. */
async function decide(
  status: AgentRunStatus,
  run: SweepCandidate,
): Promise<Decision> {
  switch (status) {
    case "CANCELLED":
      return (await newerSibling(run))
        ? { kind: "terminal", cause: "superseded" }
        : { kind: "terminal", cause: "user-cancelled" };
    case "NOT_FOUND":
      return (await newerSibling(run))
        ? { kind: "terminal", cause: "superseded" }
        : { kind: "terminal", cause: "plane-offline" };
    case "FAILED":
      return { kind: "terminal", cause: "daemon-failed" };
    case "COMPLETED":
      return { kind: "retire" };
    case "QUEUED":
    case "RUNNING":
      return { kind: "live" };
    default:
      return assertNever(status);
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await fn(item);
      }
    }),
  );
}

export async function runSupersedeSweep(
  deps: SweepDeps = {},
): Promise<SweepReport> {
  const report: SweepReport = {
    examined: 0,
    claimed: 0,
    terminals: [],
    orphans: [],
    errors: [],
  };
  if (!env.SUPERSEDE_SWEEP_ENABLED) return report;
  const now = new Date();
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

  // Rule (i): claim the batch in ONE compare-and-set, then read the engine
  // with bounded concurrency; every terminal pair is idempotent.
  const candidates = await findSweepCandidates({
    db,
    olderThanMs: cancelledAfterMs,
    now,
  });
  report.examined = candidates.length;
  const won = new Set(
    await claimSweepLeases({ db, ids: candidates.map((c) => c.id), now }),
  );
  const claimed = candidates.filter((c) => won.has(c.id));
  report.claimed = claimed.length;
  await mapLimit(claimed, ENGINE_READ_CONCURRENCY, async (run) => {
    let status: AgentRunStatus;
    try {
      status = await readStatus(run.externalId);
    } catch (error) {
      console.error(
        "[supersede-sweep] engine status read failed (retry next tick)",
        {
          externalId: run.externalId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await setSweepLease({ db, id: run.id, until: null });
      return;
    }
    // FAIL-SOFT per candidate: a thrown write here must neither abort the
    // tick for every other row nor keep the lease — release it so the next
    // tick retries this run (the row is still in_flight: the run row is
    // retired only AFTER the thread terminal landed).
    try {
      await applyDecision(await decide(status, run));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[supersede-sweep] candidate failed (retry next tick)", {
        externalId: run.externalId,
        threadId: run.threadId,
        error: message,
      });
      report.errors.push({ externalId: run.externalId, message });
      await setSweepLease({ db, id: run.id, until: null }).catch(() => {});
    }
    async function applyDecision(decision: Decision): Promise<void> {
      switch (decision.kind) {
        case "live":
          await setSweepLease({
            db,
            id: run.id,
            until: new Date(now.getTime() + LIVE_RECHECK_MS),
          });
          return;
        case "retire":
          await retireHatchetRun({ db, key: { id: run.id }, as: "terminal" });
          return;
        case "terminal": {
          // ORDER MATTERS (no transaction spans the two tables): the thread
          // terminal lands first; the run row leaves the candidate set only
          // once it has. If the thread write fails the row stays in_flight
          // and the next tick retries — retiring first would drop the row
          // from findSweepCandidates while the thread never terminated.
          const applied = await markThreadTerminal({
            db,
            threadId: run.threadId,
            cause: decision.cause,
          });
          await retireHatchetRun({
            db,
            key: { id: run.id },
            as: decision.cause === "superseded" ? "superseded" : "terminal",
          });
          if (applied) {
            report.terminals.push({
              threadId: run.threadId,
              cause: decision.cause,
            });
          }
          console.log("[supersede-sweep] terminal", {
            threadId: run.threadId,
            externalId: run.externalId,
            status,
            cause: decision.cause,
            applied,
          });
          return;
        }
        default:
          return assertNever(decision);
      }
    }
  });

  // Rule (ii)
  const orphans = await findOrphanRemoteThreads({
    db,
    olderThanMs: orphanAfterMs,
    now,
    // Same gate as hatchetDispatchEnabled(): with HATCHET_ENABLED every review
    // thread is remote regardless of its (local-default) provider column.
    remoteProviderOnly: !env.HATCHET_ENABLED,
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
