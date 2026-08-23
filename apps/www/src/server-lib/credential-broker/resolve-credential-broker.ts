import { randomBytes } from "crypto";
import { env } from "@terragon/env/apps-www";
import type { FeatureFlagName } from "@terragon/shared";
import type { SandboxProvider } from "@terragon/types/sandbox";
import type { CredentialBrokerShape } from "@terragon/sandbox/types";

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
 * fail-closed resume recreate). Returns null when the provider is not Docker
 * (E2B/Daytona have no host-reachable per-run sidecar — out of scope) or when
 * brokering is disabled for the actor (per-org flag off AND env not force-on).
 * Mints a fresh, ephemeral per-run bearer (never persisted; the guest holds only
 * this, never the installation token). The `mode` is the NON-secret provenance
 * persisted on the thread so a later resume can fail closed WITHOUT the secret.
 */
export function resolveCredentialBrokerForCreate({
  sandboxProvider,
  githubRepoFullName,
  githubAccessToken,
  featureFlags,
}: {
  sandboxProvider: SandboxProvider;
  githubRepoFullName: string;
  githubAccessToken: string;
  featureFlags: Partial<Record<FeatureFlagName, boolean>> | null | undefined;
}): { shape: CredentialBrokerShape; mode: "brokered" } | null {
  if (sandboxProvider !== "docker") {
    return null;
  }
  if (!isCredentialBrokerEnabled(featureFlags)) {
    return null;
  }
  const runBearer = randomBytes(32).toString("hex");
  return {
    shape: {
      installationToken: githubAccessToken,
      runBearer,
      repoFullName: githubRepoFullName,
    },
    mode: "brokered",
  };
}
