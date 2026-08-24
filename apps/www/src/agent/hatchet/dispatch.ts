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
import { markThreadsSuperseded } from "@terragon/shared/model/threads";
import {
  recordHatchetRun,
  findSupersedableReviewRuns,
  markHatchetRunsSuperseded,
} from "@terragon/shared/model/hatchet-run";
import { isReviewThread } from "@/server-lib/review/review-single-writer-finish";
import type { EgressPolicyShape } from "@terragon/shared/model/egress-policy";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
import { resolveEgressPolicy } from "@/server-lib/egress/resolve-egress-policy";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  resolveSupersedePolicy,
  normalizeRepo,
  type SupersedePolicy,
} from "@terragon/shared/model/repo-review-settings";
import { setThreadActiveRun } from "@terragon/shared/model/threads";
import {
  triggerAgentRun,
  cancelAgentRun,
  workflowNameForPolicy,
  buildReviewRunMetadata,
  type TriggerOpts,
} from "./transport";

/** Trigger-fetch retry policy — a transient network blip must not fail dispatch. */
const TRIGGER_MAX_ATTEMPTS = 3;
const TRIGGER_BACKOFF_MS = 400;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The Hatchet REST transport config, read from env (shared by trigger + cancel). */
function hatchetConfig() {
  return {
    apiUrl: env.HATCHET_API_URL,
    tenantId: env.HATCHET_TENANT_ID,
    apiToken: env.HATCHET_API_TOKEN,
  };
}

/**
 * #8 supersede: before a NEW review run is dispatched for a PR, cancel any prior
 * in-flight review run for the same (org, repo, PR) so only the newest verdict posts.
 * A cancelled Hatchet run emits NO terminal daemon-event, so we ALSO transition the
 * superseded threads terminally (amendment 7) — else they zombie as "working" until
 * the 75m watchdog and keep occupying a concurrency slot.
 *
 * Entirely BEST-EFFORT: a cancel/transition failure must never block the new dispatch
 * (the stalled-thread watchdog is the backstop). Only ever called for review threads
 * in a real org (mentions and personal/no-org threads never supersede).
 */
async function supersedePriorReviewRuns({
  organizationId,
  repoFullName,
  prNumber,
  currentThreadId,
}: {
  organizationId: string;
  repoFullName: string;
  prNumber: number;
  currentThreadId: string;
}): Promise<void> {
  try {
    const prior = await findSupersedableReviewRuns({
      db,
      organizationId,
      repoFullName,
      prNumber,
      excludeThreadId: currentThreadId,
    });
    if (prior.length === 0) return;

    console.log("[hatchet] superseding prior in-flight review run(s)", {
      organizationId,
      repoFullName,
      prNumber,
      currentThreadId,
      superseding: prior.map((r) => r.threadId),
    });

    // Cancel the remote runs (best-effort — a cancelled/already-finished run is a
    // harmless no-op we swallow) and mark the rows + threads terminally so the old
    // threads stop zombieing regardless of the cancel outcome. The three ops are
    // independent (neither mark depends on the cancel result or on each other), so
    // they run concurrently.
    await Promise.all([
      cancelAgentRun(
        prior.map((r) => r.externalId),
        hatchetConfig(),
      ).catch((error) => {
        console.error("[hatchet] supersede cancel failed (non-fatal)", {
          prNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
      markHatchetRunsSuperseded({ db, ids: prior.map((r) => r.id) }),
      markThreadsSuperseded({
        db,
        threadIds: prior.map((r) => r.threadId),
      }),
    ]);
  } catch (error) {
    console.error("[hatchet] supersede pass failed (non-fatal)", {
      prNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
  opts?: TriggerOpts,
): Promise<{ externalId: string | undefined }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRIGGER_MAX_ATTEMPTS; attempt++) {
    try {
      return await triggerAgentRun(input, hatchetConfig(), opts);
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
   * W3C `traceparent` for the end-to-end OTel trace join (#7). Populated by
   * generateTraceparent() on every dispatch below; the field is optional only
   * because the wire contract (mirrored in packages/worker/src/agent-run/types.ts)
   * is shared with pre-#7 / non-dispatch inputs.
   */
  traceparent?: string;
  /**
   * Per-repo egress policy SHAPE (#66, slice 1/3), resolved LIVE at dispatch
   * from the control-plane settings row. Absent = no enforcement (today's
   * behavior). The worker learns level + FINAL allowlist only — never the
   * settings table or where the policy came from (composability invariant;
   * mirrored structurally, not imported, in packages/worker types).
   * Consumed by the worker's workflow.ts: it starts the per-run filtering
   * forward proxy (egress-proxy.ts) and daemon-env points the child at it.
   */
  egressPolicy?: EgressPolicyShape;
  /**
   * #125/#127 flag-ON only: the per-PR concurrency key,
   * `${orgId}/${normalizedRepo}/${prNumber}`. The worker variants' per-PR CEL
   * entry references `input.prKey` — the field, never an interpolation. Absent
   * with the flag off (byte-identical dispatch) and for non-review runs.
   */
  prKey?: string;
  /**
   * #125/#127 flag-ON only: the run's idempotency identity. The webhook's
   * `X-GitHub-Delivery` id when the dispatch descends from a webhook, else a
   * synthetic `manual:<threadId>:<ts>` — always present under the flag, never
   * empty. Deduped by C1's `idempotency` task config (24h TTL); intentional
   * re-dispatches (recheck, redo) mint DISTINCT ids and are never deduped.
   */
  deliveryId?: string;
  /**
   * #125/#127 flag-ON only: the SNAPSHOT of the supersede policy resolved at
   * dispatch. The authority for this run's audit/recheck/cancel semantics —
   * consumers read the stamp, never the current settings row (#125 decision 5).
   */
  supersedePolicy?: SupersedePolicy;
  /** #125/#127 flag-ON only: the other half of the snapshot (discard recheck). */
  recheckOnComplete?: boolean;
}

/** True when a thread should dispatch to the remote execution plane. */
export function hatchetDispatchEnabled(thread: {
  sandboxProvider?: string | null;
}): boolean {
  return env.HATCHET_ENABLED || thread.sandboxProvider === "hatchet-remote";
}

type SupersedePlan = {
  /** Spread into the base input; empty on the legacy path (key set unchanged). */
  inputExtension: Pick<
    AgentRunInput,
    "prKey" | "deliveryId" | "supersedePolicy" | "recheckOnComplete"
  >;
  /** Trigger opts; undefined on the legacy path (byte-identical payload). */
  triggerOpts: TriggerOpts | undefined;
  /** Run the #8 control-plane cancel pass (legacy path, or explicit app-side). */
  appSideCancel: boolean;
  /** Stamp thread.activeRunExternalId for the C1 fence (flag ON only). */
  stampFence: boolean;
};

/**
 * Decide the dispatch mode ONCE (#125/#127). Legacy when the flag is off or
 * the run is not a PR review. Otherwise resolve the (org, repo) policy — an
 * unknown stored value throws here, failing the dispatch loudly — and derive
 * the variant, the input extension and the metadata from the SNAPSHOT.
 */
async function planSupersede({
  enabled,
  reviewContext,
  thread,
  threadId,
  threadChatId,
  orgId,
  repoFullName,
  deliveryId,
}: {
  enabled: boolean;
  reviewContext: { organizationId: string; prNumber: number } | null;
  thread: { sourceMetadata?: ThreadSourceMetadata | null } | null;
  threadId: string;
  threadChatId: string;
  orgId: string;
  repoFullName: string;
  deliveryId: string | undefined;
}): Promise<SupersedePlan> {
  if (!enabled) {
    return {
      inputExtension: {},
      triggerOpts: undefined,
      appSideCancel: true,
      stampFence: false,
    };
  }
  if (!reviewContext) {
    return {
      inputExtension: {},
      triggerOpts: undefined,
      appSideCancel: true,
      stampFence: true,
    };
  }
  const snapshot = await resolveSupersedePolicy({
    db,
    organizationId: reviewContext.organizationId,
    repoFullName,
  });
  const repo = normalizeRepo(repoFullName);
  const sourceMetadata = thread?.sourceMetadata;
  const skillVersion =
    sourceMetadata?.type === "automation-skill"
      ? (sourceMetadata.versionId ?? sourceMetadata.contentSha)
      : undefined;
  const triggerOpts: TriggerOpts = {
    workflowName: workflowNameForPolicy(snapshot.policy),
    additionalMetadata: buildReviewRunMetadata({
      threadId,
      threadChatId,
      orgId,
      repoFullName: repo,
      prNumber: reviewContext.prNumber,
      snapshot,
      skillVersion,
    }),
  };
  const plan: SupersedePlan = {
    inputExtension: {
      prKey: `${orgId}/${repo}/${reviewContext.prNumber}`,
      // Always present, never empty: a webhook-descended dispatch carries the
      // real X-GitHub-Delivery id; manual/scheduled paths mint a per-dispatch
      // synthetic id so intentional re-dispatches are never deduped.
      deliveryId: deliveryId || `manual:${threadId}:${Date.now()}`,
      supersedePolicy: snapshot.policy,
      recheckOnComplete: snapshot.recheckOnComplete,
    },
    triggerOpts,
    appSideCancel: snapshot.policy === "app-side",
    stampFence: true,
  };
  console.log("[hatchet] supersede policy resolved for dispatch", {
    threadId,
    ...snapshot,
    workflowName: triggerOpts.workflowName,
    deliveryId: plan.inputExtension.deliveryId,
  });
  return plan;
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
  deliveryId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  repoFullName: string;
  branch: string;
  /**
   * #127: the originating webhook's `X-GitHub-Delivery` id, when this dispatch
   * descends from a GitHub webhook (plumbed webhook → automation → thread →
   * here). Absent for manual/scheduled paths — a synthetic id is minted below.
   * Only consumed when the supersedePolicy flag is ON.
   */
  deliveryId?: string;
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
    console.log(
      "[hatchet] skipping duplicate dispatch — a run is already in flight",
      {
        threadId,
        threadChatId,
      },
    );
    return;
  }

  const [owner, repo] = parseRepoFullName(repoFullName);
  const [installationToken, daemonToken, thread, supersedeFlagOn] =
    await Promise.all([
      getInstallationToken(owner, repo),
      mintDaemonToken({ userId, threadId, threadChatId, name: runKey }),
      getThreadMinimal({ db, userId, threadId }),
      // #125/#127 rollout gate, resolved server-side for the dispatching user
      // (per-org rollout approximated at user scope, like sandboxCredentialBroker).
      getFeatureFlagForUser({ db, userId, flagName: "supersedePolicy" }),
    ]);

  // BUG-EXEC-02: the review agent needs the PR's BASE branch to compute the delta
  // offline (`git diff origin/<base>...HEAD`). thread.repoBaseBranchName is NOT the
  // base — for a thread working on an existing branch it holds the HEAD/working branch
  // (cli-router.ts: headBranchName = createNewBranch ? null : repoBaseBranchName), so
  // sourcing from it left baseBranch undefined and the worker never fetched origin/main.
  // Resolve the REAL, per-PR base from the PR itself (App octokit). Undefined (non-PR
  // thread, fetch fails, or base==head) → provision skips the base-fetch (head-only).
  const resolveBaseBranch = async (): Promise<string | undefined> => {
    if (!thread?.githubPRNumber) {
      return undefined;
    }
    try {
      const octokit = await getOctokitForApp({ owner, repo });
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: thread.githubPRNumber,
      });
      if (pr.base?.ref && pr.base.ref !== branch) {
        return pr.base.ref;
      }
    } catch (err) {
      console.warn(
        "[hatchet] could not resolve PR base branch — baseBranch unset",
        {
          threadId,
          prNumber: thread.githubPRNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return undefined;
  };

  // #66 slice 1: resolve the per-repo egress SHAPE alongside the PR base-branch
  // fetch (both depend only on the thread row already loaded — no reason to
  // serialize a DB read behind a GitHub round-trip), LIVE from the settings row
  // (a dashboard write applies on the next dispatch). null (no org / no row /
  // policy unset) → field omitted = no enforcement, today's behavior. An INVALID
  // stored policy throws here, failing the dispatch loudly rather than launching
  // with a silently-wrong policy.
  const [baseBranch, egressPolicy] = await Promise.all([
    resolveBaseBranch(),
    resolveEgressPolicy({
      db,
      organizationId: thread?.organizationId,
      repoFullName,
      plane: "worker",
    }).then((shape) => shape ?? undefined),
  ]);

  // #3/#7 wire contract: orgId is NEVER null (a personal/no-org thread falls back
  // to a per-user key) so the Phase-2 per-org concurrency CEL never dereferences
  // null. prNumber comes from the same thread row already loaded for baseBranch.
  const orgId = thread?.organizationId ?? `u:${userId}`;
  const prNumber = thread?.githubPRNumber ?? undefined;

  // #7 trace join: mint a W3C traceparent at the dispatch boundary so the worker's
  // run span and the daemon-event → GitHub-post can be stitched into one trace by a
  // collector later. Never carries the tokens/prompt — it is opaque random ids.
  const traceparent = generateTraceparent();

  const baseInput: AgentRunInput = {
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
    egressPolicy,
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

  // #8 supersede eligibility: ONLY a PR-REVIEW run (a `pull_request`-triggered
  // automation) in a REAL org supersedes a prior review. Mentions (`github_mention`)
  // and personal/no-org threads never do — and the hatchet_run FK needs a real org id,
  // not the `u:${userId}` concurrency fallback. Determined from the already-loaded
  // thread (its automationId), so no extra fetch. The narrowed object is null unless
  // all conditions hold (so `organizationId`/`prNumber` are non-null downstream).
  const reviewContext =
    thread?.organizationId != null &&
    prNumber !== undefined &&
    (await isReviewThread({
      db,
      userId,
      automationId: thread.automationId ?? null,
      organizationId: thread.organizationId,
    }))
      ? { organizationId: thread.organizationId, prNumber }
      : null;

  // #125/#127: ONE plan for the dispatch mode. Flag OFF (or a non-review run)
  // → legacy: no extension, no opts, byte-identical payload (IRON golden).
  // Flag ON on a review run → the resolved policy picks the workflow variant,
  // the input gains prKey/deliveryId + the policy SNAPSHOT, and the metadata
  // is enriched. The three native policies leave supersession to the engine's
  // per-PR strategy; only 'app-side' (and the legacy path) keeps the #8
  // control-plane cancel pass.
  const plan = await planSupersede({
    enabled: supersedeFlagOn,
    reviewContext,
    thread,
    threadId,
    threadChatId,
    orgId,
    repoFullName,
    deliveryId,
  });
  const input: AgentRunInput = { ...baseInput, ...plan.inputExtension };

  if (reviewContext && plan.appSideCancel) {
    await supersedePriorReviewRuns({
      organizationId: reviewContext.organizationId,
      repoFullName,
      prNumber: reviewContext.prNumber,
      currentThreadId: threadId,
    });
  }

  try {
    // The token is minted BEFORE the trigger (the input carries its value). Retry
    // absorbs transients; only a FINAL failure lands here.
    const { externalId } = await triggerWithRetry(
      input,
      threadId,
      threadChatId,
      plan.triggerOpts,
    );

    // Best-effort bookkeeping after a successful trigger, run concurrently —
    // neither may fail the dispatch (the run is already executing).
    await Promise.all([
      // #127: stamp the thread's ACTIVE run for the C1 generation fence.
      // Flag-ON only (legacy leaves the column NULL → fence fails open).
      plan.stampFence && externalId
        ? setThreadActiveRun({ db, threadId, externalId }).catch(
            (error: unknown) => {
              console.error("[hatchet] activeRunExternalId stamp failed", {
                threadId,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          )
        : undefined,
      // Record this review run so a LATER push can supersede it. Only reviews are
      // tracked; a missing externalId (unexpected trigger-response shape) just skips
      // tracking — the run still executes, it simply can't be superseded (watchdog
      // remains the backstop).
      reviewContext && externalId
        ? recordHatchetRun({
            db,
            threadId,
            organizationId: reviewContext.organizationId,
            repoFullName,
            prNumber: reviewContext.prNumber,
            externalId,
          }).catch((error) => {
            console.error("[hatchet] recordHatchetRun failed (non-fatal)", {
              threadId,
              prNumber,
              error: error instanceof Error ? error.message : String(error),
            });
          })
        : undefined,
    ]);
  } catch (error) {
    // Dispatch failed for good. Revoke the just-minted token so it can't block the
    // dedup guard (a retry re-dispatches cleanly), then throw so withThreadChat
    // transitions the thread to a terminal error — the remote path's equivalent of
    // in-process sandbox-creation-failed handling. Without this the thread would
    // sit in `booting` forever with no surfaced error (zombie thread).
    console.error(
      "[hatchet] dispatch failed after retries — revoking token + failing thread",
      {
        threadId,
        threadChatId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
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
