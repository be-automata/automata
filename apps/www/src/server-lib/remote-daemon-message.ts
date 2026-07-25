import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { getThreadChat } from "@terragon/shared/model/threads";
import { computeReviewToleranceDirective } from "@/server-lib/review/review-tolerance-directive";
import { getUserMessageToSend } from "@/lib/db-message-helpers";
import { tryAutoCompactThread } from "@/server-lib/compact";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import { getUserCredentials } from "@/server-lib/user-credentials";
import { preparePromptForModel } from "@/agent/msg/startAgentMessage";
import {
  modelToAgent,
  getDefaultModelForAgent,
  normalizedModelForDaemon,
  isConnectedCredentialsSupported,
} from "@terragon/agent/utils";

/**
 * The `claude` DaemonMessage payload a remote worker's daemon needs to run, minus
 * the fields the daemon already holds (token, threadId, threadChatId). Served by
 * GET /api/daemon/next-message (ADR-003 §2) — the remote analog of the message
 * `startAgentMessage` PUSHes to the in-sandbox daemon today.
 */
export interface RemoteDaemonMessage {
  type: "claude";
  model: string;
  agent: string;
  agentVersion: number;
  prompt: string;
  sessionId: string | null;
  permissionMode: "allowAll" | "plan" | "review";
  useCredits?: boolean;
  featureFlags: Record<string, boolean>;
}

/**
 * Build the DaemonMessage for a threadChat the same way the in-process boot path
 * does (getUserMessageToSend → compaction → preparePromptForModel → assemble),
 * but SESSION-FREE (no in-process sandbox). Pilot v1 is text-only — an image
 * attachment throws inside preparePromptForModel (session null; ADR-003 §2).
 *
 * Returns null when there is nothing to send (no threadChat, no pending user
 * message, or an empty prompt) — the caller maps that to 404/204.
 */
export async function buildRemoteDaemonMessage({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}): Promise<RemoteDaemonMessage | null> {
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat) {
    return null;
  }
  const userMessageToSend = getUserMessageToSend({
    messages: threadChat.messages ?? [],
    currentMessage: null,
  });
  if (!userMessageToSend) {
    return null;
  }

  let sessionId = threadChat.sessionId;
  const { summary, didCompact } = await tryAutoCompactThread({
    userId,
    threadId,
    threadChatId,
  });
  if (didCompact && summary) {
    userMessageToSend.parts.push({
      type: "text",
      text: `\n\n---\n\nThe user has run out of context. This is a summary of what has been done: <summary>\n${summary}\n</summary>\n\n`,
    });
    sessionId = null;
  }

  const model =
    userMessageToSend.model ??
    getDefaultModelForAgent({
      agent: threadChat.agent,
      agentVersion: threadChat.agentVersion,
    });

  const { prompt } = await preparePromptForModel({
    model,
    agent: threadChat.agent,
    agentVersion: threadChat.agentVersion,
    userMessageToSend,
    threadMessages: threadChat.messages ?? [],
    session: null,
  });
  const finalPrompt = prompt.replace(/(?:^|\s)\/compact(?=\s|$)/g, "");
  if (!finalPrompt.trim()) {
    return null;
  }

  const userCredentials = await getUserCredentials({ userId });
  const agentForModel = modelToAgent(model);
  const shouldUseCredits =
    (agentForModel === "codex" && !userCredentials.hasOpenAI) ||
    (agentForModel === "claudeCode" && !userCredentials.hasClaude) ||
    !isConnectedCredentialsSupported(agentForModel);

  const featureFlags = await getFeatureFlagsForUser({ db, userId });

  // Per-repo review tolerance (ADR-036) is MODE-AGNOSTIC: the directive telling the
  // agent which verdict its findings imply under the repo's floor is pure prompt
  // guidance, injected for EVERY review thread regardless of REVIEW_SINGLE_WRITER
  // (see computeReviewToleranceDirective — it never reads the flag).
  const { directive: reviewToleranceDirective, isReview } =
    await computeReviewToleranceDirective({ db, userId, threadId });

  // SINGLE-WRITER ONLY: permissionMode="review" makes the daemon strip all GitHub
  // credentials + apply the no-gh-write tool-policy (agent EMITs; the executor posts
  // once at thread-finish, with the server-floor approve backstop). This stays gated
  // on REVIEW_SINGLE_WRITER — it governs WHO posts, not the tolerance verdict.
  const applyReviewPolicy = env.REVIEW_SINGLE_WRITER && isReview;

  return {
    type: "claude",
    model: normalizedModelForDaemon(model),
    agent: threadChat.agent,
    agentVersion: threadChat.agentVersion,
    prompt: finalPrompt + reviewToleranceDirective,
    sessionId,
    permissionMode: applyReviewPolicy
      ? "review"
      : threadChat.permissionMode || "allowAll",
    ...(shouldUseCredits ? { useCredits: true } : {}),
    featureFlags,
  };
}
