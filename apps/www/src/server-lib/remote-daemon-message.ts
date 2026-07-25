import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { isReviewThread } from "@/server-lib/review/review-single-writer-finish";
import { resolveApproveFloor } from "@/server-lib/review/resolve-approve-floor";
import { buildReviewToleranceDirective } from "@terragon/review/severity-policy";
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

  // ADR-036 phase-2: under REVIEW_SINGLE_WRITER, a review thread (pull_request
  // automation) spawns with permissionMode="review" — the daemon then applies the
  // no-gh-write tool-policy + strips all GitHub credentials from the agent env, so
  // the agent can only EMIT its verdict (the executor posts it at thread-finish).
  // Gated by the flag so the extra lookups are zero-cost while deployed dark, and
  // flag-off review threads keep today's behavior (agent posts via gh + reconciler).
  let applyReviewPolicy = false;
  // The per-repo tolerance directive injected into a review agent's prompt so it
  // chooses the tolerance-correct verdict (the PRIMARY tolerance mechanism; the
  // server floor only backstops a too-generous approve and cannot relax an
  // agent's request_changes). Empty for non-review threads.
  let reviewToleranceDirective = "";
  if (env.REVIEW_SINGLE_WRITER) {
    const thread = await getThreadMinimal({ db, userId, threadId });
    applyReviewPolicy = await isReviewThread({
      db,
      userId,
      automationId: thread?.automationId ?? null,
      organizationId: thread?.organizationId ?? null,
    });
    if (applyReviewPolicy && thread?.githubRepoFullName) {
      const policy = await resolveApproveFloor({
        db,
        organizationId: thread.organizationId ?? null,
        repoFullName: thread.githubRepoFullName,
      });
      reviewToleranceDirective =
        "\n\n---\n\n" + buildReviewToleranceDirective(policy) + "\n";
    }
  }

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
