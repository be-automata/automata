import { db } from "@/lib/db";
import {
  getStalledThreads,
  stopStalledThreads,
  getUserIdsWithThreadsStuckInQueue,
  getUserIdsWithThreadsReadyToProcess,
  getScheduledThreadChatsDueToRun,
} from "@terragon/shared/model/threads";
import { getScheduledAutomationsDueToRun } from "@terragon/shared/model/automations";
import { maybeHibernateSandboxById } from "@/agent/sandbox";
import { maybeStartQueuedThreadChat } from "@/server-lib/process-queued-thread";

// NOTE: runScheduledThread and runAutomation are imported dynamically inside the
// runner bodies below (not at module top). This cron module is eagerly loaded by the
// test harness via the scheduled-tasks route; a static import of automations.ts /
// scheduled-thread.ts would drag their transitive deps (new-thread-shared,
// startAgentMessage) into the global test setup graph and bind real references
// BEFORE per-file vi.mock() can intercept, breaking unrelated suites. The dynamic
// import defers that load until the runner actually executes.

const BATCH_SIZE = 5;

/**
 * Stalled-thread cutoff (enterprise-hardening #2 watchdog delta, amendment 5). The
 * default 60m EQUALS a remote agent-run's worst-case wall time (30m Hatchet schedule
 * timeout + 30m execution timeout), so a legitimately late-starting REMOTE run could
 * be reaped right at the boundary. Raise it to 75m (60m worst case + 15m margin) so
 * the cron only reaps genuinely-stuck threads. This slow watchdog (≤1h) is the
 * BACKSTOP for the revoked-token failure class the fast onFailure path can't cover
 * (its daemonToken is already dead → the callback 401s).
 *
 * TODO(remote-aware cutoff): this widened cutoff applies to EVERY thread, so a
 * stuck IN-PROCESS thread now zombies +15m over the old 60m before its slot frees.
 * Acceptable at pilot volume; when it matters, derive the cutoff per row from
 * `sandboxProvider` (remote 75m, in-process 60m) instead of widening the constant.
 */
export const STALLED_CUTOFF_SECS = 75 * 60;

/**
 * In-process cron runners (S12). The background maintenance jobs were declared ONLY
 * in apps/www/vercel.json (Vercel crons) and NEVER fire on the Cloudflare Workers
 * (OpenNext) deployment — no wrangler triggers.crons, no scheduled() handler. On top
 * of that, the queue-promotion paths went through internalPOST, which self-fetches
 * this worker's own public URL and 404s on Workers (same class as the broadcast bug).
 *
 * These runners do the work IN-PROCESS (direct fn calls, no self-fetch) and are
 * invoked BOTH by the cron GET routes (external hits) AND by the Workers scheduled()
 * handler via runScheduledCron(). Wiring: wrangler triggers.crons → scheduled()
 * (boot-coder owns the worker-entry) → runScheduledCron(event.cron).
 */

const sleep = (ms = 1000) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop stalled (booting/working past cutoff) threads and hibernate their sandboxes.
 * Critical for concurrency: a stuck "active" thread permanently occupies a per-user
 * slot, so without this the queue never becomes eligible and never drains (S12).
 */
export async function runStalledTasksCron(): Promise<void> {
  // ADR-036 GAP-1 backstop: post reviews for terminal PR review-threads that never
  // reached the finish-hook (hung → force-stopped, or dropped finish event). Runs on
  // this hourly recovery cron (the single-writer channel is unconditional). Dynamic import
  // (like the other runners) so the heavy review deps don't poison the test harness's
  // eager cron-module load. Fail-soft — a sweep error must not skip stalled recovery.
  try {
    const { runReviewSweep } = await import("@/server-lib/review/review-sweep");
    await runReviewSweep();
  } catch (error) {
    console.error("[cron:stalled] review sweep failed (non-fatal)", error);
  }

  // Bound hatchet_run growth: rows are never eagerly marked finished (the supersede
  // finder uses a freshness window instead), so this hourly age-based prune is the
  // only thing keeping the table finite. Fail-soft — a prune error must not skip
  // stalled recovery.
  try {
    const { pruneHatchetRuns } = await import(
      "@terragon/shared/model/hatchet-run"
    );
    const pruned = await pruneHatchetRuns({ db });
    if (pruned > 0) {
      console.log(`[cron:stalled] pruned ${pruned} aged hatchet_run rows`);
    }
  } catch (error) {
    console.error("[cron:stalled] hatchet_run prune failed (non-fatal)", error);
  }

  const stalledThreads = await getStalledThreads({
    db,
    cutoffSecs: STALLED_CUTOFF_SECS,
  });
  console.log(`[cron:stalled] found ${stalledThreads.length} stalled threads`);
  if (stalledThreads.length === 0) {
    return;
  }
  await stopStalledThreads({
    db,
    threadIds: stalledThreads.map((t) => t.id),
  });
  for (let i = 0; i < stalledThreads.length; i += 10) {
    const batch = stalledThreads.slice(i, i + 10);
    await Promise.all(
      batch.map(async (thread) => {
        if (thread.codesandboxId) {
          try {
            await maybeHibernateSandboxById({
              threadId: thread.id,
              userId: thread.userId,
              sandboxId: thread.codesandboxId,
              sandboxProvider: thread.sandboxProvider,
            });
          } catch {
            // best-effort
          }
        }
      }),
    );
    await sleep();
  }
}

/**
 * Periodic safety-net drain of the per-user concurrency/rate-limit queues. Promotes
 * IN-PROCESS (maybeStartQueuedThreadChat, which also RETIRES stale threads). This is
 * what breaks a full deadlock (all slots stuck, nothing finishing → the finish-hook
 * never fires) — the finish-hook handles the common slot-free case.
 */
export async function runQueuedTasksCron(): Promise<void> {
  const [stuck, ready] = await Promise.all([
    getUserIdsWithThreadsStuckInQueue({ db }),
    getUserIdsWithThreadsReadyToProcess({ db }),
  ]);
  const userIds = [...new Set([...stuck, ...ready])];
  console.log(`[cron:queued] draining queues for ${userIds.length} users`);
  for (let i = 0; i < userIds.length; i += 10) {
    const batch = userIds.slice(i, i + 10);
    await Promise.allSettled(
      batch.map((userId) =>
        maybeStartQueuedThreadChat({ userId }).catch((error) =>
          console.error("[cron:queued] drain failed", { userId, error }),
        ),
      ),
    );
    await sleep();
  }
}

/**
 * Fire due scheduled thread-chats (recurring/one-shot user schedules). Runs each
 * IN-PROCESS via runScheduledThread — the route used to internalPOST
 * process-scheduled-task/<user>/<thread>/<chat> per thread, which self-fetched this
 * worker's own public URL and 404'd on Workers (the last of the four dead self-fetches).
 */
export async function runScheduledTasksCron(): Promise<void> {
  const { runScheduledThread } = await import("@/server-lib/scheduled-thread");
  const dueThreadChats = await getScheduledThreadChatsDueToRun({ db });
  console.log(`[cron:scheduled] ${dueThreadChats.length} thread chats due`);
  for (let i = 0; i < dueThreadChats.length; i += BATCH_SIZE) {
    const batch = dueThreadChats.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((threadChat) =>
        runScheduledThread({
          userId: threadChat.userId,
          threadId: threadChat.threadId,
          threadChatId: threadChat.threadChatId,
        }),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[cron:scheduled] run failed", result.reason);
      }
    }
    await sleep();
  }
}

/**
 * Fire due scheduled automations (recurring event-triggered workflows). Already
 * in-process (runAutomation) — extracted here so the scheduled() worker-entry can
 * dispatch it too; on Workers the every-30m Vercel cron never fired.
 */
export async function runAutomationsCron(): Promise<void> {
  const { runAutomation } = await import("@/server-lib/automations");
  const dueAutomations = await getScheduledAutomationsDueToRun({ db });
  console.log(`[cron:automations] ${dueAutomations.length} automations due`);
  for (let i = 0; i < dueAutomations.length; i += BATCH_SIZE) {
    const batch = dueAutomations.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((automation) =>
        runAutomation({
          automationId: automation.id,
          userId: automation.userId,
          source: "automated",
        }),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[cron:automations] run failed", result.reason);
      }
    }
    await sleep();
  }
}

/**
 * Dispatch a Cloudflare scheduled() event to the right runner by its cron pattern
 * (the patterns declared in wrangler.jsonc triggers.crons — mirror of vercel.json).
 * ALL four Vercel crons must be mapped here, else scheduled-tasks/automations
 * silently never fire on Workers (same S12 bug class as the queue drain).
 */
export async function runScheduledCron(cron: string): Promise<void> {
  console.log(`[cron] scheduled trigger: ${cron}`);
  switch (cron) {
    case "0 * * * *": // hourly — stalled-task recovery
      await runStalledTasksCron();
      return;
    case "*/1 * * * *": // every 1m — fire due scheduled thread-chats
      await runScheduledTasksCron();
      return;
    case "*/10 * * * *": // every 10m — queue drain
      await runQueuedTasksCron();
      return;
    case "*/30 * * * *": // every 30m — fire due automations
      await runAutomationsCron();
      return;
    default:
      console.warn(`[cron] no runner mapped for pattern: ${cron}`);
      return;
  }
}
