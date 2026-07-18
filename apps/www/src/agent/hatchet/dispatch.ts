import { env } from "@terragon/env/apps-www";
import { getInstallationToken } from "@terragon/shared/github-app";
import { parseRepoFullName } from "@/lib/github";
import { mintDaemonToken } from "@/lib/daemon-token";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { triggerAgentRun } from "./transport";

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
 * remote agent-run. The daemon token is named by threadChatId so the terminal
 * revoke (handleThreadFinish) covers the remote run (no sandboxId on this path).
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
  const [owner, repo] = parseRepoFullName(repoFullName);
  const [installationToken, daemonToken] = await Promise.all([
    getInstallationToken(owner, repo),
    mintDaemonToken({ userId, threadId, threadChatId, name: threadChatId }),
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
  await triggerAgentRun(input, {
    apiUrl: env.HATCHET_API_URL,
    tenantId: env.HATCHET_TENANT_ID,
    apiToken: env.HATCHET_API_TOKEN,
  });
}
