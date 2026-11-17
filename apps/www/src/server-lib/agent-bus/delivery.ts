import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { isAgentWorking } from "@/agent/thread-status";
import { getAccessInfoForUser } from "@/lib/subscription";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import { agentRun, thread, threadChat } from "@terragon/shared/db/schema";
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
 * the target must not start now: tier `none`, a shadow thread, a chat that is
 * already working, or a run blocked after the send (A5). The message stays
 * queued and visible in every skip case. Never throws: delivery is committed.
 */
export async function kickTarget(threadId: string): Promise<void> {
  try {
    const rows = await db
      .select({
        userId: thread.userId,
        shadow: thread.shadow,
        threadChatId: threadChat.id,
        status: threadChat.status,
        blockedAt: agentRun.blockedAt,
      })
      .from(thread)
      .innerJoin(threadChat, eq(threadChat.threadId, thread.id))
      .leftJoin(agentRun, eq(agentRun.threadId, thread.id))
      .where(eq(thread.id, threadId))
      .orderBy(asc(threadChat.createdAt))
      .limit(1);
    const target = rows[0];
    if (!target) return;

    await publishBroadcastUserMessage({
      type: "user",
      id: target.userId,
      data: { threadId, threadChatId: target.threadChatId },
    });

    if (target.shadow || target.blockedAt || isAgentWorking(target.status)) {
      return;
    }
    const { tier } = await getAccessInfoForUser(target.userId);
    if (tier === "none") return;

    await maybeProcessFollowUpQueue({
      userId: target.userId,
      threadId,
      threadChatId: target.threadChatId,
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
 * Delivers messages whose receive never ran, then kicks their targets plus the
 * targets with a message consumed in the last minutes (a kick lost after commit,
 * A6). The kick is idempotent: an empty queue returns at once.
 */
export async function runAgentBusSweep(): Promise<void> {
  const { targets } = await sweepUnconsumed({ db, apply: queuedFollowUpApply });
  const recent = await recentlyDeliveredTargets({ db });
  for (const target of new Set([...targets, ...recent])) {
    await kickTarget(target);
  }
}
