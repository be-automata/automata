import { sendDaemonMessage } from "@/agent/daemon";
import { waitUntil } from "@/lib/wait-until";
import { withThreadSandboxSession } from "@/agent/thread-resource";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { onThreadChatStopped } from "./thread-status-change";
import { db } from "@/lib/db";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { getLatestHatchetRunForThread } from "@terragon/shared/model/hatchet-run";
import { cancelAgentRun } from "@/agent/hatchet/transport";
import {
  hatchetConfig,
  hatchetDispatchEnabled,
} from "@/agent/hatchet/dispatch";

/**
 * Remote-plane threads have no sandbox session to `stop` through: the daemon
 * lives on a worker box that only polls thread-status. Cancel the engine run
 * itself so the worker tears down NOW (its poll loop also returns on
 * `stopping` — belt and braces) instead of parking the box/engine slot until
 * the task's 30-minute step timeout (observed in prod 2026-08-25: one stopped
 * review starved every queued review behind it). Best-effort: the #125 C4
 * sweep and the worker's own `stopping` handling are the backstops.
 */
async function cancelRemoteRunOnStop({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<void> {
  try {
    const thread = await getThreadMinimal({ db, userId, threadId });
    if (!thread || !hatchetDispatchEnabled(thread)) return;
    const run = await getLatestHatchetRunForThread({ db, threadId });
    const externalId =
      run?.status === "in_flight"
        ? run.externalId
        : (thread.activeRunExternalId ?? null);
    if (!externalId) return;
    await cancelAgentRun([externalId], hatchetConfig());
    console.log("[stop-thread] cancelled remote run", { threadId, externalId });
  } catch (error) {
    console.error("[stop-thread] remote run cancel failed (best-effort)", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function stopThread({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  waitUntil(
    withThreadSandboxSession({
      label: "stop-thread",
      threadId,
      userId,
      threadChatId,
      onBeforeExec: async () => {
        const { updatedStatus } = await updateThreadChatWithTransition({
          userId,
          threadId,
          threadChatId,
          eventType: "user.stop",
          chatUpdates: {
            scheduleAt: null,
          },
        });
        await onThreadChatStopped({ userId, threadId, threadChatId });
        await cancelRemoteRunOnStop({ userId, threadId });
        return updatedStatus !== "complete";
      },
      execOrThrow: async ({ session }) => {
        if (!session) {
          return;
        }
        await sendDaemonMessage({
          message: { type: "stop" },
          threadId,
          threadChatId,
          userId,
          sandboxId: session.sandboxId,
          session,
        });
      },
    }),
  );
}
