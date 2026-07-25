import { env } from "@terragon/env/apps-www";
import { db } from "@/lib/db";
import { getInstallationToken } from "@terragon/shared/github-app";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
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

/** Lowercase hex for `n` random bytes (crypto.getRandomValues — Workers + Node). */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a fresh W3C `traceparent` for the #7 end-to-end trace join:
 *   `00-<32hex traceId>-<16hex spanId>-01`   (version 00, sampled flag 01).
 *
 * DELIBERATELY dependency-light: no OpenTelemetry SDK is added to www (CF Workers
 * bundle-size budget). A well-formed traceparent is enough for a collector to join
 * the dispatch → worker → daemon-event → GitHub-post spans later; full OTLP export
 * is NEEDS-INFRA (operator checklist). The traceId/spanId are just random ids here.
 */
export function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

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
  /**
   * The PR's base branch (thread.repoBaseBranchName). ADR-036 BUG-EXEC-02: the worker
   * (provision.ts) shallow-fetches `origin/<baseBranch>` + deepens to the merge-base
   * so the review agent can run `git diff origin/<baseBranch>...HEAD` OFFLINE (no
   * gh/token). Undefined → provision skips the base fetch (degrades to head-only).
   */
  baseBranch?: string;
  /** www's public base URL the daemon calls back to (events + next-message). */
  daemonCallbackUrl: string;
  /** Short-lived, installation-scoped GitHub token for the clone (x-access-token). */
  installationToken: string;
  /** Short-lived, org+thread-scoped daemon token (events + next-message auth). */
  daemonToken: string;
  /**
   * The run's org identity, NEVER null: `thread.organizationId ?? \`u:${userId}\``.
   * A concurrency CEL key on `input.orgId` (Phase 2 per-org fairness) must resolve
   * to a stable non-empty string for EVERY run — personal/no-org threads included —
   * else round-robin grouping is undefined. Dispatch computes the fallback so the
   * worker never dereferences null. Also the #7 SLO dimension.
   */
  orgId: string;
  /** The PR number when this run is a PR review (thread.githubPRNumber). #8 cancel key, #2/#7 context. */
  prNumber?: number;
  /**
   * W3C `traceparent` for the end-to-end OTel trace join (#7). Populated when #7
   * wires the tracer at dispatch; undefined for now — the field exists so the wire
   * contract (mirrored in packages/worker/src/agent-run/types.ts) is stable.
   */
  traceparent?: string;
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
  //
  // FUTURE HARDENING: one residual zombie window remains — if the process crashes
  // between minting the token and the trigger's revoke-on-final-failure, the token
  // is stale and this skip strands the thread until the 1-day token expiry. To close
  // it, add stale-token detection here (e.g. cross-check that a Hatchet run actually
  // exists for runKey, or stamp the token with a dispatch-started timestamp and treat
  // an old-but-unconfirmed token as stale → clean up + re-dispatch). Accepted for now
  // as a 1-day-bounded edge (team-lead ruling).
  if (await hasActiveDaemonToken({ userId, name: runKey })) {
    console.log("[hatchet] skipping duplicate dispatch — a run is already in flight", {
      threadId,
      threadChatId,
    });
    return;
  }

  const [owner, repo] = parseRepoFullName(repoFullName);
  const [installationToken, daemonToken, thread] = await Promise.all([
    getInstallationToken(owner, repo),
    mintDaemonToken({ userId, threadId, threadChatId, name: runKey }),
    getThreadMinimal({ db, userId, threadId }),
  ]);

  // BUG-EXEC-02: the review agent needs the PR's BASE branch to compute the delta
  // offline (`git diff origin/<base>...HEAD`). thread.repoBaseBranchName is NOT the
  // base — for a thread working on an existing branch it holds the HEAD/working branch
  // (cli-router.ts: headBranchName = createNewBranch ? null : repoBaseBranchName), so
  // sourcing from it left baseBranch undefined and the worker never fetched origin/main.
  // Resolve the REAL, per-PR base from the PR itself (App octokit). Undefined (non-PR
  // thread, fetch fails, or base==head) → provision skips the base-fetch (head-only).
  let baseBranch: string | undefined;
  if (thread?.githubPRNumber) {
    try {
      const octokit = await getOctokitForApp({ owner, repo });
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: thread.githubPRNumber,
      });
      if (pr.base?.ref && pr.base.ref !== branch) {
        baseBranch = pr.base.ref;
      }
    } catch (err) {
      console.warn("[hatchet] could not resolve PR base branch — baseBranch unset", {
        threadId,
        prNumber: thread.githubPRNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // #3/#7 wire contract: orgId is NEVER null (a personal/no-org thread falls back
  // to a per-user key) so the Phase-2 per-org concurrency CEL never dereferences
  // null. prNumber comes from the same thread row already loaded for baseBranch.
  const orgId = thread?.organizationId ?? `u:${userId}`;
  const prNumber = thread?.githubPRNumber ?? undefined;

  // #7 trace join: mint a W3C traceparent at the dispatch boundary so the worker's
  // run span and the daemon-event → GitHub-post can be stitched into one trace by a
  // collector later. Never carries the tokens/prompt — it is opaque random ids.
  const traceparent = generateTraceparent();

  const input: AgentRunInput = {
    threadId,
    threadChatId,
    repoFullName,
    branch,
    baseBranch,
    daemonCallbackUrl: nonLocalhostPublicAppUrl(),
    installationToken,
    daemonToken,
    orgId,
    prNumber,
    traceparent,
  };
  console.log("[hatchet] dispatching agent-run", {
    threadId,
    threadChatId,
    repoFullName,
    branch,
    orgId,
    prNumber,
    traceparent,
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
