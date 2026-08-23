import { randomBytes } from "crypto";
import { env } from "@terragon/env/apps-www";
import type { FeatureFlagName } from "@terragon/shared";
import type { SandboxProvider } from "@terragon/types/sandbox";
import type {
  BrokerRefresh,
  CredentialBrokerShape,
} from "@terragon/sandbox/types";

/**
 * Global force-on kill switch for the Docker credential broker (#114). Set
 * SANDBOX_CREDENTIAL_BROKER=on to force brokering ON for EVERYONE regardless of
 * the per-org feature flag — an ops override for deploy-wide enablement /
 * emergency continuity. Anything else (default "legacy-direct") leaves the
 * decision to the `sandboxCredentialBroker` feature flag. Kept optional alongside
 * the flag so existing deployments/tests do not silently change behavior.
 */
export function isCredentialBrokerEnvForceOn(): boolean {
  return env.SANDBOX_CREDENTIAL_BROKER === "on";
}

/**
 * Whether the Docker credential broker is enabled for a given actor.
 *
 * Rollout gate (#114): the `sandboxCredentialBroker` feature flag, resolved
 * SERVER-SIDE by the caller via `getFeatureFlagsForUser` and passed in here. The
 * flag system supports only global + per-user overrides (no org-scoped overrides
 * exist), so per-org rollout is approximated at USER scope — enabling the flag
 * for an org's members is the closest fit the system offers. The env var acts as
 * an OR force-on.
 *
 * Fail-safe: defaults OFF. A missing/undefined flag value (e.g. the map could not
 * be resolved) is treated as OFF, so a lookup gap can never accidentally enable
 * brokering.
 */
export function isCredentialBrokerEnabled(
  featureFlags: Partial<Record<FeatureFlagName, boolean>> | null | undefined,
): boolean {
  // Ops force-on wins unconditionally.
  if (isCredentialBrokerEnvForceOn()) {
    return true;
  }
  return !!featureFlags?.sandboxCredentialBroker;
}

/**
 * Build the per-run credential-broker SHAPE for a CREATE (initial or the
 * fail-closed Docker resume recreate). Returns a PROVIDER-APPROPRIATE directive:
 *  - `docker`: a `docker-sidecar` shape carrying the installation token, a
 *    fresh ephemeral per-run bearer (the only thing the guest holds), and the
 *    fenced repo. The provider stands up an out-of-guest sidecar.
 *  - `e2b`: an `e2b-native` shape carrying the installation token (to SEED
 *    E2B's write-only Secret vault) and the repo. There is NO bearer and no
 *    sidecar — E2B injects the credential in its own egress plane. The per-run
 *    vault-secret NAME is derived from the sandboxId inside the provider (it
 *    does not exist until create), so it is not carried here.
 * Returns null for any other provider, or when brokering is disabled for the
 * actor (flag off AND env not force-on). The `mode` is the NON-secret provenance
 * persisted on the thread so a later resume can detect brokered-ness WITHOUT the
 * secret shape.
 */
export function resolveCredentialBrokerForCreate({
  sandboxProvider,
  githubRepoFullName,
  githubAccessToken,
  featureFlags,
  threadId,
}: {
  sandboxProvider: SandboxProvider;
  githubRepoFullName: string;
  githubAccessToken: string;
  featureFlags: Partial<Record<FeatureFlagName, boolean>> | null | undefined;
  /**
   * Stable per-run id used to derive the Daytona org-Secret name (#114). The
   * Daytona secret must exist BEFORE the sandbox (its `secrets` map references an
   * existing name), so the name cannot derive from the sandboxId; it derives
   * from this stable id, which is re-derivable on resume/teardown. The
   * Docker/E2B branches ignore it (Docker uses a fresh bearer; E2B derives its
   * vault-secret name from the sandboxId inside the provider).
   */
  threadId: string;
}): { shape: CredentialBrokerShape; mode: "brokered" } | null {
  if (!isCredentialBrokerEnabled(featureFlags)) {
    return null;
  }
  if (sandboxProvider === "docker") {
    const runBearer = randomBytes(32).toString("hex");
    return {
      shape: {
        kind: "docker-sidecar",
        installationToken: githubAccessToken,
        runBearer,
        repoFullName: githubRepoFullName,
      },
      mode: "brokered",
    };
  }
  if (sandboxProvider === "e2b") {
    return {
      shape: {
        kind: "e2b-native",
        installationToken: githubAccessToken,
        repoFullName: githubRepoFullName,
      },
      mode: "brokered",
    };
  }
  if (sandboxProvider === "daytona") {
    return {
      shape: {
        kind: "daytona-native",
        installationToken: githubAccessToken,
        repoFullName: githubRepoFullName,
        secretName: daytonaBrokerSecretName(threadId),
      },
      mode: "brokered",
    };
  }
  return null;
}

/**
 * Deterministic Daytona org-Secret name for a run's native credential broker
 * (#114), derived from the STABLE thread id. Prefixed with a letter and
 * sanitized to Daytona's `^[a-zA-Z_][a-zA-Z0-9_-]*$` secret-name charset so the
 * same name is re-derivable on create, resume-refresh, and teardown with NO new
 * persistence. Case is preserved (Daytona allows mixed case).
 */
export function daytonaBrokerSecretName(threadId: string): string {
  return `gh-inst-${threadId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Build the credential-broker SHAPE for an in-place RESUME (#114). E2B AND
 * Daytona brokered sandboxes resume in place (Docker recreates on resume), so
 * this returns an `e2b-native` / `daytona-native` shape when the provider is
 * E2B/Daytona and the thread's persisted provenance is `"brokered"`. It carries
 * the FRESH installation token so the provider can REFRESH its secret
 * (installation tokens expire ~1h); the E2B vault-secret name is re-derived from
 * the sandboxId in the provider, while the Daytona secret name is re-derived
 * from the stable `threadId` here.
 *
 * Gated on the PERSISTED mode, NOT the current flag: a sandbox created brokered
 * still has live E2B egress rules + a vault entry after pause, so it must stay
 * brokered on resume even if the flag was since turned off — otherwise the
 * legacy env/setup path would write a resident raw token into a guest whose
 * egress still injects, defeating never-residency. Returns null otherwise
 * (Docker, non-brokered threads, or a legacy thread with no provenance).
 */
export function resolveCredentialBrokerForResume({
  sandboxProvider,
  githubRepoFullName,
  githubAccessToken,
  persistedBrokerMode,
  threadId,
}: {
  sandboxProvider: SandboxProvider;
  githubRepoFullName: string;
  githubAccessToken: string;
  persistedBrokerMode: "brokered" | "legacy-direct" | null | undefined;
  /**
   * Stable per-run id used to re-derive the Daytona org-Secret name on resume
   * (#114) — the SAME derivation used at create. Ignored on the E2B path (which
   * re-derives from the sandboxId inside the provider).
   */
  threadId: string;
}): { shape: CredentialBrokerShape } | null {
  if (persistedBrokerMode !== "brokered") {
    return null;
  }
  if (sandboxProvider === "e2b") {
    return {
      shape: {
        kind: "e2b-native",
        installationToken: githubAccessToken,
        repoFullName: githubRepoFullName,
      },
    };
  }
  if (sandboxProvider === "daytona") {
    return {
      shape: {
        kind: "daytona-native",
        installationToken: githubAccessToken,
        repoFullName: githubRepoFullName,
        secretName: daytonaBrokerSecretName(threadId),
      },
    };
  }
  return null;
}

/**
 * Build the LAZY broker-secret refresh handle for a SECONDARY connect path
 * (#114 §7a) — the keepalive `extendSandboxLife` and the admin-view
 * `getSandboxOrNull`. Both `Sandbox.connect` (auto-resuming the guest), so on a
 * brokered E2B sandbox they must rotate the vault secret before connect.
 *
 * Returns a handle ONLY for a brokered E2B thread (persisted provenance
 * `"brokered"` + provider `"e2b"`); otherwise `undefined` (Docker recreates;
 * non-brokered / non-E2B keep today's behavior byte-for-byte — no refresh arg).
 *
 * The handle is a LAZY resolver: `mintToken` is not called here — it is a
 * callback the provider invokes ONLY when the vaulted secret is actually stale
 * (near-expiry throttle in e2b-provider.ts). So a keepalive on a still-fresh
 * secret mints no installation token. Mirrors the primary resume's token seam
 * (`getGitHubTokenForBackground` → repo→installation-token).
 */
export function resolveBrokerRefreshForConnect({
  sandboxProvider,
  persistedBrokerMode,
  mintToken,
  threadId,
}: {
  sandboxProvider: SandboxProvider;
  persistedBrokerMode: "brokered" | "legacy-direct" | null | undefined;
  mintToken: () => Promise<string>;
  /**
   * Stable per-run id used to re-derive the Daytona org-Secret name (#114) on
   * the secondary connect paths, which see only a sandboxId. Ignored on the E2B
   * path (it re-derives from the sandboxId inside the provider).
   */
  threadId: string;
}): BrokerRefresh | undefined {
  if (persistedBrokerMode !== "brokered") {
    return undefined;
  }
  if (sandboxProvider === "e2b") {
    return { mintToken };
  }
  if (sandboxProvider === "daytona") {
    // Daytona has no by-name freshness read keyed on the sandboxId, so carry the
    // thread-derived secret name the provider must rotate.
    return { mintToken, secretName: daytonaBrokerSecretName(threadId) };
  }
  return undefined;
}
