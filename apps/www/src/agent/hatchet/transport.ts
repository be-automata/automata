/**
 * The isolated Hatchet REST v1 trigger transport (ADR-003). Workers cannot speak
 * the SDK's gRPC, so www triggers the `agent-run` workflow over REST through the
 * cloudflared tunnel. This is the ONE place the transport lives.
 */

import type {
  SupersedePolicy,
  SupersedeSnapshot,
} from "@terragon/shared/model/repo-review-settings";

/**
 * #125/#127: which registered workflow VARIANT each supersede policy dispatches
 * to. STRUCTURALLY DUPLICATED (not imported) by the worker's variant table
 * (packages/worker/src/agent-run/workflow.ts, landing in C1/#126) — the planes share no imports
 * (composability invariant), so a drift between the two tables is caught by
 * C3's E2E, not the type system. The legacy 'agent-run' workflow carries NO
 * per-PR entry (flag-off dispatches keep hitting it byte-identically, #125
 * AC7), so every native policy — newest-wins included — routes to a dedicated
 * variant. 'app-side' deliberately routes to legacy 'agent-run': the control
 * plane keeps the #8 cancel rules and the engine applies no per-PR strategy.
 */
export const POLICY_TO_WORKFLOW = {
  "newest-wins": "agent-run-newest",
  "complete-run-queue": "agent-run-strict",
  "complete-run-discard": "agent-run-discard",
  "app-side": "agent-run",
} as const satisfies Record<SupersedePolicy, string>;

/**
 * Exhaustive policy → workflowName mapping. The switch (not a bare table
 * lookup) is deliberate: a policy value that escapes the union — a widened
 * type, a raw DB string — THROWS here instead of dispatching `undefined` as a
 * workflow name (fail-loud, #125 decision 4).
 */
export function workflowNameForPolicy(policy: SupersedePolicy): string {
  switch (policy) {
    case "newest-wins":
    case "complete-run-queue":
    case "complete-run-discard":
    case "app-side":
      return POLICY_TO_WORKFLOW[policy];
    default: {
      const exhaustive: never = policy;
      throw new Error(`Unknown supersede policy: ${String(exhaustive)}`);
    }
  }
}

/** Enriched-metadata hard limits (#127 AC5): schema versioned + bounded. */
const METADATA_MAX_KEYS = 12;
const METADATA_MAX_VALUE_CHARS = 256;

/**
 * Reject an over-limit metadata object AT DISPATCH (#127 AC5) — Hatchet's
 * additionalMetadata is unbounded engine-side, so the bound lives here.
 */
export function validateRunMetadata(
  metadata: Record<string, string>,
): Record<string, string> {
  const keys = Object.keys(metadata);
  if (keys.length > METADATA_MAX_KEYS) {
    throw new Error(
      `Run metadata exceeds ${METADATA_MAX_KEYS} keys (${keys.length}): ${keys.join(", ")}`,
    );
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== "string" || value.length > METADATA_MAX_VALUE_CHARS) {
      throw new Error(
        `Run metadata value for '${key}' exceeds ${METADATA_MAX_VALUE_CHARS} chars (or is not a string)`,
      );
    }
  }
  return metadata;
}

/** The wire metadata schema (metaVersion "1") stamped on a flag-ON review run. */
export const RUN_METADATA_VERSION = "1";

/**
 * Build the enriched, versioned metadata for a flag-ON review dispatch and
 * validate it against the limits above. Dispatch passes DOMAIN values; the
 * wire keys and the version live here, next to the limits they must satisfy.
 * The policy snapshot is spread whole so metadata can never drift from input.
 */
export function buildReviewRunMetadata({
  threadId,
  threadChatId,
  orgId,
  repoFullName,
  prNumber,
  snapshot,
  skillVersion,
}: {
  threadId: string;
  threadChatId: string;
  orgId: string;
  /** Already-normalized (lowercase) slug. */
  repoFullName: string;
  prNumber: number;
  snapshot: SupersedeSnapshot;
  skillVersion?: string;
}): Record<string, string> {
  return validateRunMetadata({
    metaVersion: RUN_METADATA_VERSION,
    threadId,
    threadChatId,
    orgId,
    repoFullName,
    prNumber: String(prNumber),
    lane: "review",
    supersedePolicy: snapshot.policy,
    recheckOnComplete: String(snapshot.recheckOnComplete),
    ...(skillVersion ? { skillVersion } : {}),
  });
}

/**
 * Flag-ON trigger extension. Absent → the legacy payload, byte-identical
 * (guarded by dispatch-golden.test.ts).
 */
export type TriggerOpts = {
  workflowName?: string;
  additionalMetadata?: Record<string, string>;
};

export interface HatchetTriggerConfig {
  /** Engine REST base (via the tunnel). Changes per quick-tunnel run → from env. */
  apiUrl: string;
  /** Tenant path segment. */
  tenantId: string;
  /** Tenant-scoped Bearer token with trigger scope. */
  apiToken: string;
}

/**
 * Fail loudly when Hatchet is enabled but the transport env is incomplete —
 * shared by trigger and cancel so the two error messages can't drift.
 */
function requireHatchetConfig(
  config: HatchetTriggerConfig,
  verb: "dispatch" | "cancel" | "status",
): HatchetTriggerConfig {
  const { apiUrl, tenantId, apiToken } = config;
  if (!apiUrl || !tenantId || !apiToken) {
    throw new Error(
      `Hatchet ${verb} is enabled but HATCHET_API_URL / HATCHET_TENANT_ID / HATCHET_API_TOKEN are not all configured`,
    );
  }
  return config;
}

/**
 * POST the v1 stable trigger. `input` is the reference-only workflow input; the
 * caller guarantees it holds no long-lived secret. `additionalMetadata` carries
 * the ids for traceability (the REST v1 trigger has no idempotency-key field —
 * double-dispatch is guarded by the caller). Returns the created run's externalId.
 *
 * The v1 stable trigger responds with a `V1WorkflowRunDetails` body, whose run id
 * lives at `run.metadata.id` — NOT a top-level `externalId` (the old cast to
 * `{externalId?}` always read undefined). This id is the handle #8 uses to cancel
 * a superseded in-flight review, so parse it correctly from first dispatch.
 */
export async function triggerAgentRun<
  T extends { threadId: string; threadChatId: string },
>(
  input: T,
  config: HatchetTriggerConfig,
  opts?: TriggerOpts,
): Promise<{ externalId: string | undefined }> {
  const { apiUrl, tenantId, apiToken } = requireHatchetConfig(
    config,
    "dispatch",
  );
  const res = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflowName: opts?.workflowName ?? "agent-run",
        input,
        additionalMetadata: opts?.additionalMetadata ?? {
          threadId: input.threadId,
          threadChatId: input.threadChatId,
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Hatchet trigger failed: ${res.status} ${body}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    run?: { metadata?: { id?: string } };
  };
  return { externalId: json.run?.metadata?.id };
}

/**
 * Cancel one or more in-flight workflow runs by their externalId (#8 supersede). The
 * REST v1 stable cancel endpoint takes a batch of externalIds — the same
 * `run.metadata.id` values `triggerAgentRun` returns. Used when a NEW review run is
 * dispatched for a PR that already has a live review in flight: the prior run is
 * cancelled so only the newest verdict is posted (a cancelled run emits no terminal
 * daemon-event, so it never posts a stale verdict — dispatch transitions the
 * superseded thread terminally itself).
 *
 * A no-op when `externalIds` is empty (nothing to cancel). Throws on a non-2xx so the
 * caller can log/decide; the caller MUST NOT let a cancel failure block the new
 * dispatch — superseding is best-effort (the watchdog is the backstop).
 */
export async function cancelAgentRun(
  externalIds: string[],
  config: HatchetTriggerConfig,
): Promise<void> {
  if (externalIds.length === 0) {
    return;
  }
  const { apiUrl, tenantId, apiToken } = requireHatchetConfig(config, "cancel");
  const res = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/v1/stable/tenants/${tenantId}/tasks/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ externalIds }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Hatchet cancel failed: ${res.status} ${body}`);
  }
}

/** Engine run status as the v1 REST API reports it, plus NOT_FOUND for a vanished run. */
export type AgentRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "NOT_FOUND";

/**
 * Read one run's status by externalId (#125 C4 sweep). 404 → NOT_FOUND (the
 * engine pruned it, or it never existed — both are "not live"). Any other
 * non-2xx throws so the sweep skips the run this tick rather than guessing.
 */
export async function getAgentRunStatus(
  externalId: string,
  config: HatchetTriggerConfig,
): Promise<AgentRunStatus> {
  const { apiUrl, tenantId, apiToken } = requireHatchetConfig(config, "status");
  const res = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/v1/stable/tenants/${tenantId}/workflow-runs/${encodeURIComponent(externalId)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (res.status === 404) return "NOT_FOUND";
  if (!res.ok) {
    throw new Error(`Hatchet run status failed: ${res.status}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    run?: { status?: string };
  };
  const status = json.run?.status;
  switch (status) {
    case "QUEUED":
    case "RUNNING":
    case "COMPLETED":
    case "CANCELLED":
    case "FAILED":
      return status;
    default:
      throw new Error(`Hatchet run status unrecognised: ${String(status)}`);
  }
}
