import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isAgentWorking } from "@/agent/thread-status";
import { getAccessInfoForUser } from "@/lib/subscription";
import { waitUntil } from "@/lib/wait-until";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import { agentRun, thread, threadChat } from "@terragon/shared/db/schema";
import { threadIsTerminal } from "@terragon/shared/model/thread-effective-status";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import {
  queuedFollowUpApply,
  recentlyDeliveredTargets,
  sendMessage,
  sweepUnconsumed,
  type SendResult,
} from "@terragon/shared/model/agent-bus/messages";

import { maybeProcessFollowUpQueue } from "../process-follow-up-queue";

/**
 * www binding of the agent bus (#660, S2). The shared module commits and applies
 * a message (a queued user message in the target's primary chat); this file
 * wakes the target afterwards ("kick") and drives the sweeper.
 */

/**
 * Broadcasts the queued message (unless `broadcast: false`: a re-kick of a message
 * already broadcast), then schedules the drain of the target's follow-up queue unless
 * the target must not start now: tier `none`, a shadow or terminal thread, a chat
 * that is already working, or a run blocked after the send (A5). The message stays
 * queued and visible in every skip case. Never throws: delivery is committed.
 */
export async function kickTarget(
  threadId: string,
  { broadcast: shouldBroadcast = true }: { broadcast?: boolean } = {},
): Promise<void> {
  try {
    const rows = await db
      .select({
        userId: thread.userId,
        shadow: thread.shadow,
        threadChatId: threadChat.id,
        chatStatus: threadChat.status,
        threadStatus: thread.status,
        terminal: sql<boolean>`${threadIsTerminal()}`,
        blockedAt: agentRun.blockedAt,
      })
      .from(thread)
      .leftJoin(threadChat, eq(threadChat.threadId, thread.id))
      .leftJoin(agentRun, eq(agentRun.threadId, thread.id))
      .where(eq(thread.id, threadId))
      .orderBy(asc(threadChat.createdAt))
      .limit(1);
    const target = rows[0];
    if (!target) return;

    // A legacy thread has no thread_chat row: its queue lives on the thread.
    const threadChatId = target.threadChatId ?? LEGACY_THREAD_CHAT_ID;
    const status = target.chatStatus ?? target.threadStatus;

    // A UI refresh only: its failure must never keep the queue from draining.
    const broadcast = shouldBroadcast
      ? publishBroadcastUserMessage({
          type: "user",
          id: target.userId,
          data: { threadId, threadChatId },
        }).catch((error: unknown) => {
          console.error("[agent-bus] broadcast failed (non-fatal)", {
            threadId,
            error,
          });
        })
      : undefined;
    const mustSkip =
      target.shadow ||
      target.blockedAt ||
      target.terminal ||
      isAgentWorking(status);
    // The tier lookup only matters when no other skip applies; it runs beside the broadcast.
    const [, access] = await Promise.all([
      broadcast,
      mustSkip ? null : getAccessInfoForUser(target.userId),
    ]);
    if (!access || access.tier === "none") return;

    // The drain can boot a sandbox: like queueFollowUpInternal (follow-up.ts), it
    // starts now and outlives the response via waitUntil, so neither a send nor
    // the cron tick waits on it (sweep drains run concurrently, one per thread).
    waitUntil(
      maybeProcessFollowUpQueue({
        userId: target.userId,
        threadId,
        threadChatId,
      }).catch((error: unknown) => {
        console.error("[agent-bus] drain failed (non-fatal)", {
          threadId,
          error,
        });
      }),
    );
  } catch (error) {
    console.error("[agent-bus] kick failed (non-fatal)", { threadId, error });
  }
}

/** Sends one message, then kicks the target when it was applied. */
export async function sendAgentMessage(
  args: Omit<Parameters<typeof sendMessage>[0], "db" | "apply">,
): Promise<SendResult> {
  const result = await sendMessage({ ...args, db, apply: queuedFollowUpApply });
  if (result.ok && result.applied > 0) {
    await kickTarget(args.to);
  }
  return result;
}

/**
 * Delivers messages whose receive never ran, then kicks every target with a
 * message consumed in the last minutes (a kick lost after commit, A6). Only the
 * targets this sweep applied to are broadcast; the re-kick of an earlier delivery
 * is silent. The kick is idempotent: an empty queue returns at once.
 */
export async function runAgentBusSweep(): Promise<void> {
  const { targets } = await sweepUnconsumed({ db, apply: queuedFollowUpApply });
  const swept = new Set(targets);
  const recent = await recentlyDeliveredTargets({ db });
  // Broadcast only where this sweep applied a message; a re-kick is silent.
  for (const target of new Set([...targets, ...recent])) {
    await kickTarget(target, { broadcast: swept.has(target) });
  }
}
