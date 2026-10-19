import { env } from "@terragon/env/apps-www";
import { db } from "@/lib/db";
import {
  claimSweepLeases,
  findNewerRun,
  findSweepCandidates,
  retireHatchetRun,
  setSweepLease,
  type SweepCandidate,
} from "@terragon/shared/model/hatchet-run";
import {
  findOrphanRemoteThreads,
  findUnreportedRemoteThreads,
  markThreadTerminal,
} from "@terragon/shared/model/threads";
import { revokeDaemonTokensForThread } from "@/lib/daemon-token";
import type { TerminalCause } from "@terragon/shared/model/terminal-cause";
import { assertNever } from "@terragon/shared/utils";
import { maybeRecheckOnComplete } from "./supersede-recheck";
import {
  getAgentRunStatus,
  listAgentRunsForThread,
  type AgentRunLookupHint,
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
 *       posts this; the sweep is the backstop), or `run-failed-unreported`
 *       (#380) when the thread never left `booting`; engine COMPLETED while the
 *       thread is still reapable → the run row is retired (www missed the
 *       finish; the stalled watchdog owns the thread) so it is not re-read
 *       every tick; QUEUED/RUNNING → left alone, lease pushed out.
 *  (ii) a remote thread dispatched > N ago with NO recorded run at all →
 *       `plane-offline`.
 *  (iii) (#380) a remote thread of ANY lane still `booting` > N after its
 *       last write, with no run row, whose engine runs (listed by threadId
 *       metadata) have ALL FAILED → `run-failed-unreported`. This is the
 *       reconcile for a run that died before it could post back — an
 *       unsealable payload, a clone failure, a worker death at admission.
 *       Only review runs have a row (rule (i)); task, mention and self-heal
 *       runs had no reconcile at all before this rule. A run still QUEUED
 *       or RUNNING, or one the listing cannot see, is left alone.
 *
 * Every terminal the sweep writes ALSO revokes the thread's remote daemon
 * token(s) (#380): the run is dead, the token is useless, and while it lives
 * the double-dispatch guard silently skips every retry for the token's
 * 1-day backstop TTL.
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
  readStatus?: (
    externalId: string,
    hint: AgentRunLookupHint,
  ) => Promise<AgentRunStatus>;
  /** Rule (iii): the thread's runs by metadata; injected for tests. */
  listRuns?: (
    hint: AgentRunLookupHint,
  ) => Promise<Array<{ externalId: string; status: AgentRunStatus }>>;
  cancelledAfterMs?: number;
  orphanAfterMs?: number;
};

export type SweepReport = {
  examined: number;
  claimed: number;
  terminals: { threadId: string; cause: TerminalCause }[];
  orphans: string[];
  /** Rule (iii): threads marked `run-failed-unreported` this tick. */
  unreported: string[];
  /** Per-candidate failures — the tick never aborts on one bad row. */
  errors: { externalId: string; message: string }[];
};

/**
 * The newer sibling run for the PR, if any — a control-plane fact (hatchet_run),
 * which is why cause inference lives here and not on the engine.
 * TODO(hatchet_run retirement): when the table goes (runbook §success
 * criteria), this must read the engine's run list by `additional_metadata`
 * prKey instead — or every CANCELLED degrades to `user-cancelled`.
 */
function newerSibling(run: SweepCandidate) {
  return findNewerRun({
    db,
    organizationId: run.organizationId,
    repoFullName: run.repoFullName,
    prNumber: run.prNumber,
    after: run.createdAt,
    excludeExternalId: run.externalId,
  });
}

type Decision =
  | { kind: "terminal"; cause: TerminalCause; supersededByThreadId?: string }
  | { kind: "retire" }
  /** #380: the row belongs to an earlier attempt of a resumed thread — retire it, touch nothing else. */
  | { kind: "stale-row" }
  | { kind: "live" };

/** Rule (iii)'s engine listing half-width: covers any dispatch of a thread still inside the watchdog's reach. */
export const RULE_III_LOOKUP_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A thread written this long after a run's dispatch, and booting again, is a later attempt. */
export const STALE_ROW_RESUME_MARGIN_MS = 60 * 1000;

/** The exhaustive rule (i) table; a new engine status fails compilation here. */
async function decide(
  status: AgentRunStatus,
  run: SweepCandidate,
): Promise<Decision> {
  // #380 generation guard: a row that belongs to an OLDER attempt of a
  // thread that moved on — the thread's stamped active run is a different
  // run (a newer review dispatch restamped it, whatever the thread's status
  // now), or, for an UNSTAMPED thread, it is booting again after a write
  // well past this row's dispatch (a non-review resume, which does not
  // restamp; dispatch and its bookkeeping writes land within seconds of the
  // row's createdAt) — is stale evidence whatever the engine says about it
  // (FAILED, CANCELLED by a user stop, pruned). The terminal CAS checks only
  // that the thread is reapable, not WHICH attempt is live, so such a row is
  // retired without a terminal and the live attempt, and its daemon token,
  // are left alone. A thread whose stamp IS this run is this run's: the
  // updatedAt heuristic never applies to it.
  // The guard decides ONLY the branches that write a terminal (and revoke
  // tokens). A QUEUED/RUNNING row is left live and a COMPLETED one retired
  // regardless: neither writes a terminal, and a CURRENT-generation run that
  // waited behind the box slot while its thread was written again must not
  // be mistaken for a stale one.
  const staleRow =
    (run.threadActiveRunExternalId !== null &&
      run.threadActiveRunExternalId !== run.externalId) ||
    (run.threadActiveRunExternalId === null &&
      run.threadBooting &&
      run.threadUpdatedAt.getTime() >
        run.createdAt.getTime() + STALE_ROW_RESUME_MARGIN_MS);
  switch (status) {
    case "CANCELLED":
    case "NOT_FOUND": {
      if (staleRow) return { kind: "stale-row" };
      const newer = await newerSibling(run);
      // Under complete-run-discard the engine CANCELs the NEWEST run
      // (CANCEL_NEWEST) while an OLDER one stays live; the worker never sees
      // that run, so this is the only place it can be named `discarded`. The
      // POLICY decides the cause, not the sibling table: with recheck on, a
      // newer sibling (the recheck of this very head) always exists by the
      // time the grace elapses, and the first prod retirement (2026-08-25
      // 18:25Z) landed as `superseded` for exactly that reason. The sibling
      // is still LINKED so the chip deep-links to the run that reviewed the
      // head.
      if (
        status === "CANCELLED" &&
        run.supersedePolicy === "complete-run-discard"
      ) {
        return {
          kind: "terminal",
          cause: "discarded",
          supersededByThreadId: newer?.threadId,
        };
      }
      if (newer) {
        return {
          kind: "terminal",
          cause: "superseded",
          supersededByThreadId: newer.threadId,
        };
      }
      // A CANCELLED run was cancelled by someone; a VANISHED one never made
      // it to the plane (pruned / trigger lost) — not the user's doing.
      return {
        kind: "terminal",
        cause: status === "CANCELLED" ? "user-cancelled" : "plane-offline",
      };
    }
    case "FAILED":
      if (staleRow) return { kind: "stale-row" };
      // #380: FAILED while the thread never left `booting` = the run died
      // before it could post back (an unsealable payload, a clone failure,
      // an admission throw): the same reconcile class as rule (iii), with
      // the same cause, so every lane reads alike. FAILED after the daemon
      // was up stays the daemon's failure.
      return {
        kind: "terminal",
        cause: run.threadBooting ? "run-failed-unreported" : "daemon-failed",
      };
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
    unreported: [],
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
  const hatchetConfig = {
    apiUrl: env.HATCHET_API_URL,
    tenantId: env.HATCHET_TENANT_ID,
    apiToken: env.HATCHET_API_TOKEN,
  };
  const listRuns =
    deps.listRuns ??
    ((hint: AgentRunLookupHint) => listAgentRunsForThread(hint, hatchetConfig));
  const readStatus =
    deps.readStatus ??
    ((externalId: string, hint: AgentRunLookupHint) =>
      getAgentRunStatus(externalId, hatchetConfig, hint));

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
      status = await readStatus(run.externalId, {
        createdAt: run.createdAt,
        threadId: run.threadId,
      });
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
        case "stale-row":
          await retireHatchetRun({ db, key: { id: run.id }, as: "terminal" });
          console.log("[supersede-sweep] stale row retired (thread resumed)", {
            threadId: run.threadId,
            externalId: run.externalId,
          });
          return;
        case "retire":
          // Engine COMPLETED but www never saw the finish: the run row is
          // retired — and the discard·recheck promise must still be honoured
          // here, exactly as on the terminal path (this backstop population
          // is where a lost recheck has no other re-trigger).
          await retireHatchetRun({ db, key: { id: run.id }, as: "terminal" });
          await maybeRecheckOnComplete({
            threadId: run.threadId,
            thread: {
              userId: run.threadUserId,
              organizationId: run.threadOrganizationId,
              githubRepoFullName: run.threadRepoFullName,
              githubPRNumber: run.threadGithubPRNumber,
              automationId: run.threadAutomationId,
              reviewedSha: run.threadReviewedSha,
              sandboxProvider: run.threadSandboxProvider,
            },
            run: {
              supersedePolicy: run.supersedePolicy,
              recheckOnComplete: run.recheckOnComplete,
            },
          });
          return;
        case "terminal": {
          // ORDER MATTERS (no transaction spans the two tables): the thread
          // terminal lands first; the run row leaves the candidate set only
          // once it has. If the thread write fails the row stays in_flight
          // and the next tick retries — retiring first would drop the row
          // from findSweepCandidates while the thread never terminated.
          const applied = await sweepTerminal({
            threadId: run.threadId,
            userId: run.threadUserId,
            cause: decision.cause,
            supersededByThreadId: decision.supersededByThreadId,
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
          // #125 C5: the reconciliation runs UNCONDITIONALLY (a retried tick
          // must heal a recheck lost between the terminal and the ledger) and
          // with the columns already in hand — zero extra reads (never throws).
          await maybeRecheckOnComplete({
            threadId: run.threadId,
            thread: {
              userId: run.threadUserId,
              organizationId: run.threadOrganizationId,
              githubRepoFullName: run.threadRepoFullName,
              githubPRNumber: run.threadGithubPRNumber,
              automationId: run.threadAutomationId,
              reviewedSha: run.threadReviewedSha,
              sandboxProvider: run.threadSandboxProvider,
            },
            run: {
              supersedePolicy: run.supersedePolicy,
              recheckOnComplete: run.recheckOnComplete,
            },
          });
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

  // Rules (ii) and (iii): both reads are independent of rule (i)'s writes and
  // of each other; only the WRITES are ordered ((ii) first, so a PR-review
  // orphan keeps its `plane-offline` cause).
  // Same gate as hatchetDispatchEnabled(): with HATCHET_ENABLED every review
  // thread is remote regardless of its (local-default) provider column.
  const remoteProviderOnly = !env.HATCHET_ENABLED;
  const [orphans, unreported] = await Promise.all([
    findOrphanRemoteThreads({
      db,
      olderThanMs: orphanAfterMs,
      now,
      remoteProviderOnly,
    }),
    findUnreportedRemoteThreads({
      db,
      olderThanMs: orphanAfterMs,
      now,
      remoteProviderOnly,
    }),
  ]);
  // Rule (ii)
  for (const t of orphans) {
    const applied = await sweepTerminal({
      threadId: t.id,
      userId: t.userId,
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

  // Rule (iii) (#380), written after rule (ii). A thread rule (ii) just
  // terminalised is no longer booting, so its sweepTerminal CAS is a no-op.
  await mapLimit(unreported, ENGINE_READ_CONCURRENCY, async (t) => {
    let runs: Array<{ externalId: string; status: AgentRunStatus }>;
    try {
      // The anchor is the thread's LAST write, not the trigger itself: a
      // later bookkeeping write would move a ±10 min window off the real
      // dispatch, so the window is as wide as a thread can stay booting
      // before the stalled watchdog owns it.
      runs = await listRuns({
        createdAt: t.dispatchedAt,
        threadId: t.id,
        windowMs: RULE_III_LOOKUP_WINDOW_MS,
      });
    } catch (error) {
      console.error(
        "[supersede-sweep] rule (iii) engine list failed (retry next tick)",
        {
          threadId: t.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return;
    }
    // Fail toward "leave it": a live run, a finished one www missed (the
    // stalled watchdog owns it) or an empty listing (the trigger never
    // landed, or the window missed it) is not this rule's to terminate.
    // CANCELLED predecessors (a superseded earlier attempt) do not count;
    // every remaining run must have FAILED.
    const live = runs.filter((r) => r.status !== "CANCELLED");
    if (live.length === 0 || !live.every((r) => r.status === "FAILED")) {
      return;
    }
    try {
      // Fenced on the candidate's own anchor: a thread re-dispatched between
      // the read and this write (booting again, a fresh token, a run the
      // listing did not see) is left for the next tick.
      const applied = await sweepTerminal({
        threadId: t.id,
        userId: t.userId,
        cause: "run-failed-unreported",
        unchangedSince: t.dispatchedAt,
      });
      if (applied) {
        report.unreported.push(t.id);
        console.log("[supersede-sweep] unreported failure → terminal", {
          threadId: t.id,
          externalIds: runs.map((r) => r.externalId),
          dispatchedAt: t.dispatchedAt.toISOString(),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[supersede-sweep] rule (iii) candidate failed", {
        threadId: t.id,
        error: message,
      });
      report.errors.push({ externalId: runs[0]?.externalId ?? "", message });
    }
  });
  return report;
}

/**
 * The ONE way the sweep writes a terminal (#380): the thread's typed
 * terminal, and — ONLY when that compare-and-set applied — the thread's
 * remote daemon tokens, because a terminal the sweep wrote means the run is
 * dead and a live token would make the double-dispatch guard skip every
 * retry for a day. A CAS that lost (the thread went terminal between the
 * read and this write) must not touch tokens. The CAS checks the thread's
 * status, NOT which attempt is live: a thread resumed under a newer run is
 * booting again and the write WOULD apply — that case is kept out of this
 * function by rule (i)'s generation guard (`stale-row` in decide) and by
 * rule (iii)'s all-FAILED listing, because the `${threadId}:` prefix would
 * hit the new run's token too (the S12 class of sibling kill). The revoke
 * is best-effort — a failure never undoes the terminal (the token still
 * expires); it is logged.
 */
async function sweepTerminal({
  threadId,
  userId,
  cause,
  supersededByThreadId,
  unchangedSince,
}: {
  threadId: string;
  userId: string;
  cause: TerminalCause;
  supersededByThreadId?: string;
  /** The thread's updatedAt at candidate-read time: a write since then wins (markThreadsTerminal). */
  unchangedSince?: Date;
}): Promise<boolean> {
  const applied = await markThreadTerminal({
    db,
    threadId,
    cause,
    supersededByThreadId,
    unchangedSince,
  });
  if (!applied) return false;
  try {
    await revokeDaemonTokensForThread({ userId, threadId });
  } catch (error) {
    console.error("[supersede-sweep] daemon token revoke failed", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
