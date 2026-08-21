import { db } from "@/lib/db";
import { getThreadChat } from "@terragon/shared/model/threads";
import { computeReviewToleranceDirective } from "@/server-lib/review/review-tolerance-directive";
import { resolvePermissionModeForDispatch } from "@/server-lib/review/resolve-permission-mode";
import type { ThreadTrustContext } from "@terragon/shared/db/types";
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
  thread,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  /**
   * The already-fetched thread (getThreadMinimal), when the caller loaded it just
   * before calling here (the next-message route does, for its ownership check).
   * Passed to computeReviewToleranceDirective so the always-on directive adds no
   * extra read. Omitted → the directive helper fetches the thread itself.
   */
  thread?: {
    automationId: string | null;
    organizationId: string | null;
    githubRepoFullName: string;
    trustContext?: ThreadTrustContext | null;
  } | null;
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
  // (see computeReviewToleranceDirective — it never reads the flag). This call is
  // ALSO the ONE `getAutomation` read the permission-mode resolver below reuses
  // (ADR-005 §3b: one read, not two) — the automation it returns carries the
  // trigger type + configured permissionMode.
  const {
    directive: reviewToleranceDirective,
    automation,
    thread: resolvedThread,
  } = await computeReviewToleranceDirective({ db, userId, threadId, thread });

  // The permission-mode FLOOR (ADR-005 §2/§3/§3b, #82): the ONE shared resolver
  // both dispatch seams call. PR-family events default/cap to "review" (emit-only,
  // ADR-004) unless the content is trust-verified (server-derived trustContext,
  // never caller-supplied); non-PR events are uncapped, reproducing today's
  // "allowAll" default exactly (AC4 regression). This REPLACES the old
  // `applyReviewPolicy ? "review" : threadChat.permissionMode || "allowAll"`
  // ad-hoc check — that check only ever considered `isReview`, never a
  // configured trigger permissionMode nor the trust floor.
  const permissionMode = await resolvePermissionModeForDispatch({
    db,
    organizationId: resolvedThread?.organizationId ?? null,
    repoFullName: resolvedThread?.githubRepoFullName,
    automation,
    thread: { trustContext: resolvedThread?.trustContext ?? null },
    threadChatPermissionMode: threadChat.permissionMode,
  });

  return {
    type: "claude",
    model: normalizedModelForDaemon(model),
    agent: threadChat.agent,
    agentVersion: threadChat.agentVersion,
    prompt: finalPrompt + reviewToleranceDirective,
    sessionId,
    permissionMode,
    ...(shouldUseCredits ? { useCredits: true } : {}),
    featureFlags,
  };
}
