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
}: {
  sandboxProvider: SandboxProvider;
  githubRepoFullName: string;
  githubAccessToken: string;
  featureFlags: Partial<Record<FeatureFlagName, boolean>> | null | undefined;
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
  return null;
}

/**
 * Build the credential-broker SHAPE for an in-place RESUME (#114). Only E2B
 * brokered sandboxes resume in place (Docker recreates on resume), so this
 * returns an `e2b-native` shape ONLY when the provider is E2B and the thread's
 * persisted provenance is `"brokered"`. It carries the FRESH installation token
 * so the provider can REFRESH E2B's vault secret (installation tokens expire
 * ~1h); the vault-secret name is re-derived from the sandboxId in the provider.
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
}: {
  sandboxProvider: SandboxProvider;
  githubRepoFullName: string;
  githubAccessToken: string;
  persistedBrokerMode: "brokered" | "legacy-direct" | null | undefined;
}): { shape: CredentialBrokerShape } | null {
  if (sandboxProvider !== "e2b") {
    return null;
  }
  if (persistedBrokerMode !== "brokered") {
    return null;
  }
  return {
    shape: {
      kind: "e2b-native",
      installationToken: githubAccessToken,
      repoFullName: githubRepoFullName,
    },
  };
}
