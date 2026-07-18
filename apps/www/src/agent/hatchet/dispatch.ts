import { env } from "@terragon/env/apps-www";
import { getInstallationToken } from "@terragon/shared/github-app";
import { parseRepoFullName } from "@/lib/github";
import {
  mintDaemonToken,
  hasActiveDaemonToken,
  revokeDaemonTokensForSandbox,
  daemonRunKey,
} from "@/lib/daemon-token";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { ThreadError } from "@/agent/error";
import { triggerAgentRun } from "./transport";

/** Trigger-fetch retry policy — a transient network blip must not fail dispatch. */
const TRIGGER_MAX_ATTEMPTS = 3;
const TRIGGER_BACKOFF_MS = 400;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Trigger the agent-run with a small bounded retry. Each failed attempt is logged
 * with the actual error; only the FINAL failure propagates (the caller then
 * revokes the token + fails the thread). A transient (cold first-dispatch, socket
 * blip) is absorbed silently.
 */
async function triggerWithRetry(
  input: AgentRunInput,
  threadId: string,
  threadChatId: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRIGGER_MAX_ATTEMPTS; attempt++) {
    try {
      await triggerAgentRun(input, {
        apiUrl: env.HATCHET_API_URL,
        tenantId: env.HATCHET_TENANT_ID,
        apiToken: env.HATCHET_API_TOKEN,
      });
      return;
    } catch (error) {
      lastError = error;
      console.error("[hatchet] trigger attempt failed", {
        threadId,
        threadChatId,
        attempt,
        maxAttempts: TRIGGER_MAX_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < TRIGGER_MAX_ATTEMPTS) {
        await sleep(TRIGGER_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * www → Hatchet dispatch (ADR-003). When HATCHET_ENABLED, a booting thread runs
 * on a remote worker instead of the in-process sandbox: www mints the short-lived
 * tokens, triggers the `agent-run` workflow with REFERENCE-ONLY input, and the
 * daemon events drive the thread state exactly like a sandbox boot. The transport
 * itself lives in transport.ts (triggerAgentRun).
 */

/**
 * Reference-only workflow input. NO long-lived secret (App private key, master
 * key) — only the two SHORT-LIVED, org-scoped tokens (ADR-002 §3; F4 accepted-
 * risk for single-org pilot). The prompt is NOT here — the worker pulls it from
 * /api/daemon/next-message with the daemon token (ADR-003 fork 3).
 */
export interface AgentRunInput {
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  branch: string;
  /** www's public base URL the daemon calls back to (events + next-message). */
  daemonCallbackUrl: string;
  /** Short-lived, installation-scoped GitHub token for the clone (x-access-token). */
  installationToken: string;
  /** Short-lived, org+thread-scoped daemon token (events + next-message auth). */
  daemonToken: string;
}

/** True when a thread should dispatch to the remote execution plane. */
export function hatchetDispatchEnabled(thread: {
  sandboxProvider?: string | null;
}): boolean {
  return env.HATCHET_ENABLED || thread.sandboxProvider === "hatchet-remote";
}

/**
 * Mint the short-lived tokens, assemble the reference-only input, and trigger the
 * remote agent-run. The daemon token is named by the per-run key (daemonRunKey) so
 * the terminal revoke (handleThreadFinish) covers the remote run (no sandboxId on
 * this path) AND the dedup guard is per-thread-unique.
 */
export async function dispatchAgentRun({
  userId,
  threadId,
  threadChatId,
  repoFullName,
  branch,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  branch: string;
}): Promise<void> {
  const runKey = daemonRunKey({ threadId, threadChatId });

  // Double-dispatch guard (idempotency): the Hatchet v1 trigger has no server-side
  // dedup. runKey is keyed on threadId, so a live token means a run for THIS thread
  // is already in flight (tokens are revoked on terminal AND on trigger failure) —
  // it will drive the thread, so skipping is correct and NOT a zombie. (This is no
  // longer the cross-thread collision that stranded threads under the shared legacy
  // sentinel — that was the per-run-key fix.) Benign: do not fail the thread here.
  if (await hasActiveDaemonToken({ userId, name: runKey })) {
    console.log("[hatchet] skipping duplicate dispatch — a run is already in flight", {
      threadId,
      threadChatId,
    });
    return;
  }

  const [owner, repo] = parseRepoFullName(repoFullName);
  const [installationToken, daemonToken] = await Promise.all([
    getInstallationToken(owner, repo),
    mintDaemonToken({ userId, threadId, threadChatId, name: runKey }),
  ]);
  const input: AgentRunInput = {
    threadId,
    threadChatId,
    repoFullName,
    branch,
    daemonCallbackUrl: nonLocalhostPublicAppUrl(),
    installationToken,
    daemonToken,
  };
  console.log("[hatchet] dispatching agent-run", {
    threadId,
    threadChatId,
    repoFullName,
    branch,
  });

  try {
    // The token is minted BEFORE the trigger (the input carries its value). Retry
    // absorbs transients; only a FINAL failure lands here.
    await triggerWithRetry(input, threadId, threadChatId);
  } catch (error) {
    // Dispatch failed for good. Revoke the just-minted token so it can't block the
    // dedup guard (a retry re-dispatches cleanly), then throw so withThreadChat
    // transitions the thread to a terminal error — the remote path's equivalent of
    // in-process sandbox-creation-failed handling. Without this the thread would
    // sit in `booting` forever with no surfaced error (zombie thread).
    console.error("[hatchet] dispatch failed after retries — revoking token + failing thread", {
      threadId,
      threadChatId,
      error: error instanceof Error ? error.message : String(error),
    });
    await revokeDaemonTokensForSandbox({ userId, sandboxId: runKey }).catch(
      () => {},
    );
    throw new ThreadError(
      "sandbox-creation-failed",
      "Failed to dispatch the remote agent run.",
      error instanceof Error ? error : null,
    );
  }
}
