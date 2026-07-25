/**
 * The isolated Hatchet REST v1 trigger transport (ADR-003). Workers cannot speak
 * the SDK's gRPC, so www triggers the `agent-run` workflow over REST through the
 * cloudflared tunnel. This is the ONE place the transport lives.
 */

export interface HatchetTriggerConfig {
  /** Engine REST base (via the tunnel). Changes per quick-tunnel run → from env. */
  apiUrl: string;
  /** Tenant path segment. */
  tenantId: string;
  /** Tenant-scoped Bearer token with trigger scope. */
  apiToken: string;
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
): Promise<{ externalId: string | undefined }> {
  const { apiUrl, tenantId, apiToken } = config;
  if (!apiUrl || !tenantId || !apiToken) {
    throw new Error(
      "Hatchet dispatch is enabled but HATCHET_API_URL / HATCHET_TENANT_ID / HATCHET_API_TOKEN are not all configured",
    );
  }
  const res = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/v1/stable/tenants/${tenantId}/workflow-runs/trigger`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflowName: "agent-run",
        input,
        additionalMetadata: {
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
