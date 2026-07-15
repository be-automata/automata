import { auth } from "@/lib/auth";
import { DaemonMessage } from "@terragon/daemon/shared";
import { ISandboxSession } from "@terragon/sandbox/types";
import { sendMessage } from "@terragon/sandbox/daemon";
import { setActiveThreadChat } from "./sandbox-resource";
import { wrapError } from "./error";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import { db } from "@/lib/db";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

type DistributiveOmit<T, K extends PropertyKey> = T extends any
  ? Omit<T, K>
  : never;

export async function sendDaemonMessage({
  message,
  userId,
  threadId,
  threadChatId,
  sandboxId,
  session,
}: {
  message: DistributiveOmit<
    Extract<DaemonMessage, { type: "claude" | "stop" }>,
    "token" | "threadId" | "threadChatId" | "featureFlags"
  >;
  threadId: string;
  userId: string;
  threadChatId: string;
  sandboxId: string;
  session: ISandboxSession;
}) {
  try {
    await setActiveThreadChat({ sandboxId, threadChatId, isActive: true });
    // Derivation: the sandbox-agent proxy token acts for one thread, so it
    // carries that thread's org (WI-5 batch 1). Unambiguous. Nullable-safe.
    const [threadRow] = await db
      .select({ organizationId: threadTable.organizationId })
      .from(threadTable)
      .where(eq(threadTable.id, threadId))
      .limit(1);
    const organizationId = threadRow?.organizationId ?? null;
    const [apiKey, featureFlags] = await Promise.all([
      auth.api.createApiKey({
        body: {
          name: sandboxId,
          expiresIn: 60 * 60 * 24 * 1, // 1 day,
          userId,
          ...(organizationId ? { metadata: { organizationId } } : {}),
        },
      }),
      getFeatureFlagsForUser({ db, userId }),
    ]);

    const baseMessage = {
      ...message,
      token: apiKey.key,
      threadId,
      threadChatId,
    };

    const finalMessage: DaemonMessage =
      baseMessage.type === "claude"
        ? {
            ...baseMessage,
            featureFlags: featureFlags,
          }
        : baseMessage;

    await sendMessage({
      session,
      message: finalMessage,
    });
  } catch (error) {
    throw wrapError("agent-not-responding", error);
  }
}
