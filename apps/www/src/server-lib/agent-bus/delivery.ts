import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { isAgentWorking } from "@/agent/thread-status";
import { getAccessInfoForUser } from "@/lib/subscription";
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
 * Broadcasts the queued message, then drains the target's follow-up queue unless
 * the target must not start now: tier `none`, a shadow or terminal thread, a chat
 * that is already working, or a run blocked after the send (A5). The message stays
 * queued and visible in every skip case. Never throws: delivery is committed.
 */
export async function kickTarget(threadId: string): Promise<void> {
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

    await publishBroadcastUserMessage({
      type: "user",
      id: target.userId,
      data: { threadId, threadChatId },
    });

    if (
      target.shadow ||
      target.blockedAt ||
      target.terminal ||
      isAgentWorking(status)
    ) {
      return;
    }
    const { tier } = await getAccessInfoForUser(target.userId);
    if (tier === "none") return;

    await maybeProcessFollowUpQueue({
      userId: target.userId,
      threadId,
      threadChatId,
    });
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
 * message consumed in the last minutes (a kick lost after commit, A6). Swept
 * targets are always a subset: their messages were just consumed. The kick is
 * idempotent: an empty queue returns at once.
 */
export async function runAgentBusSweep(): Promise<void> {
  await sweepUnconsumed({ db, apply: queuedFollowUpApply });
  for (const target of await recentlyDeliveredTargets({ db })) {
    await kickTarget(target);
  }
}
