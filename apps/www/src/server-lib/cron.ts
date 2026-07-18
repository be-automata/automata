import { db } from "@/lib/db";
import {
  getStalledThreads,
  stopStalledThreads,
  getUserIdsWithThreadsStuckInQueue,
  getUserIdsWithThreadsReadyToProcess,
} from "@terragon/shared/model/threads";
import { maybeHibernateSandboxById } from "@/agent/sandbox";
import { maybeStartQueuedThreadChat } from "@/server-lib/process-queued-thread";

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
  const stalledThreads = await getStalledThreads({ db });
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
 * Dispatch a Cloudflare scheduled() event to the right runner by its cron pattern
 * (the patterns declared in wrangler.jsonc triggers.crons — mirror of vercel.json).
 */
export async function runScheduledCron(cron: string): Promise<void> {
  console.log(`[cron] scheduled trigger: ${cron}`);
  switch (cron) {
    case "0 * * * *": // hourly — stalled-task recovery
      await runStalledTasksCron();
      return;
    case "*/10 * * * *": // every 10m — queue drain
      await runQueuedTasksCron();
      return;
    default:
      console.warn(`[cron] no runner mapped for pattern: ${cron}`);
      return;
  }
}
