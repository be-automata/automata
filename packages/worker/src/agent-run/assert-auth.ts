/**
 * Fail-closed auth-enabled boot gate (enterprise-hardening #5). A `-dev` /
 * auth-disabled hatchet-lite engine embeds a PUBLIC/shared JWT signing key, which
 * voids tenancy isolation entirely — the single highest-severity multi-tenancy
 * footgun. This probe runs at worker boot BEFORE `worker.start()`; on ANY failure
 * the caller logs loudly and `process.exit(1)` so such an engine never gets a worker.
 *
 * Two REST probes against a tenant-scoped endpoint, both fail-closed:
 *   1. NEGATIVE: a deliberately-invalid bearer token MUST be rejected 401/403. If a
 *      garbage token is ACCEPTED (2xx), auth is disabled → throw.
 *   2. POSITIVE: the real token MUST be accepted (2xx). If the real token is
 *      rejected, the box is misconfigured → throw.
 * Any other/ambiguous status (5xx, network) also throws — we refuse to boot unless
 * we can POSITIVELY confirm auth is both present and working.
 *
 * Config is derived from the worker's own environment: an explicit HATCHET_API_URL /
 * HATCHET_TENANT_ID when set, otherwise decoded from the HATCHET_CLIENT_TOKEN JWT
 * (the same claims the SDK's config-loader reads). Missing config → throw (never a
 * skip-with-warning — that would defeat the gate).
 */

const GARBAGE_TOKEN = "automata-auth-probe-invalid-token-do-not-accept";

export interface AuthProbeConfig {
  /** Hatchet REST base (no trailing slash required). */
  apiUrl: string;
  /** Tenant path segment. */
  tenantId: string;
  /** The real tenant-scoped bearer token (must be accepted). */
  realToken: string;
}

/** Minimal JWT claim decode (mirrors the SDK config-loader; no signature check). */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(
      parts[1]!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the probe config from env, deriving apiUrl/tenantId from the client token
 * JWT when not set explicitly. Throws (fail-closed) if any part is missing.
 */
export function loadAuthProbeConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthProbeConfig {
  const realToken =
    env.HATCHET_API_TOKEN?.trim() || env.HATCHET_CLIENT_TOKEN?.trim() || "";
  if (!realToken) {
    throw new Error(
      "auth-enabled gate: no HATCHET_API_TOKEN/HATCHET_CLIENT_TOKEN in env — refusing to boot (fail-closed)",
    );
  }
  const claims = decodeJwtClaims(realToken);
  const apiUrl =
    env.HATCHET_API_URL?.trim() ||
    (typeof claims?.server_url === "string" ? claims.server_url : "");
  const tenantId =
    env.HATCHET_TENANT_ID?.trim() ||
    (typeof claims?.sub === "string" ? claims.sub : "");
  if (!apiUrl || !tenantId) {
    throw new Error(
      "auth-enabled gate: could not resolve HATCHET_API_URL / HATCHET_TENANT_ID " +
        "(set them, or use a token that carries server_url + sub) — refusing to boot (fail-closed)",
    );
  }
  return { apiUrl, tenantId, realToken };
}

function probeEndpoint(config: AuthProbeConfig): string {
  return `${config.apiUrl.replace(/\/+$/, "")}/api/v1/stable/tenants/${config.tenantId}/workflow-runs?limit=1`;
}

/**
 * Run the negative + positive probes. Throws on any fail-closed condition. Returns
 * void on success (auth confirmed present + working).
 */
export async function assertAuthEnabled(
  config: AuthProbeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!config.apiUrl || !config.tenantId || !config.realToken) {
    throw new Error(
      "auth-enabled gate: incomplete probe config — refusing to boot (fail-closed)",
    );
  }
  const url = probeEndpoint(config);

  // 1. NEGATIVE probe — a garbage token MUST be rejected.
  let negStatus: number;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${GARBAGE_TOKEN}` },
    });
    negStatus = res.status;
  } catch (err) {
    throw new Error(
      `auth-enabled gate: negative probe request failed (${err instanceof Error ? err.message : String(err)}) — refusing to boot`,
    );
  }
  if (negStatus >= 200 && negStatus < 300) {
    throw new Error(
      "auth-enabled gate: a GARBAGE token was ACCEPTED (2xx) — the engine is auth-DISABLED " +
        "(embeds a public signing key → tenancy void). Refusing to boot.",
    );
  }
  if (negStatus !== 401 && negStatus !== 403) {
    throw new Error(
      `auth-enabled gate: negative probe returned an unexpected status ${negStatus} ` +
        "(expected 401/403) — cannot confirm auth is enforced. Refusing to boot.",
    );
  }

  // 2. POSITIVE probe — the real token MUST be accepted.
  let posStatus: number;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.realToken}` },
    });
    posStatus = res.status;
  } catch (err) {
    throw new Error(
      `auth-enabled gate: positive probe request failed (${err instanceof Error ? err.message : String(err)}) — refusing to boot`,
    );
  }
  if (posStatus < 200 || posStatus >= 300) {
    throw new Error(
      `auth-enabled gate: the REAL token was REJECTED (${posStatus}) — the box is misconfigured. Refusing to boot.`,
    );
  }
}

/** Convenience: resolve config from env then assert. Throws fail-closed. */
export async function assertAuthEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await assertAuthEnabled(loadAuthProbeConfig(env), fetchImpl);
}
