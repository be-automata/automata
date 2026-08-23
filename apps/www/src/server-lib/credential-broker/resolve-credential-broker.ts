import { randomBytes } from "crypto";
import { env } from "@terragon/env/apps-www";
import type { SandboxProvider } from "@terragon/types/sandbox";
import type { CredentialBrokerShape } from "@terragon/sandbox/types";

/**
 * Docker credential-broker resolution (#114). Deploy-gated by
 * SANDBOX_CREDENTIAL_BROKER: only the exact value "on" enables brokering
 * (mirrors the worker's WORKER_CREDENTIAL_BROKER opt-out). Default / anything
 * else = today's exact raw-token behavior.
 */
export function isCredentialBrokerEnabled(): boolean {
  return env.SANDBOX_CREDENTIAL_BROKER === "on";
}

/**
 * Build the per-run credential-broker SHAPE for a CREATE (initial or the
 * fail-closed resume recreate). Returns null when brokering is off or the
 * provider is not Docker (E2B/Daytona have no host-reachable per-run sidecar —
 * out of scope). Mints a fresh, ephemeral per-run bearer (never persisted; the
 * guest holds only this, never the installation token). The `mode` is the
 * NON-secret provenance persisted on the thread so a later resume can fail
 * closed WITHOUT the secret.
 */
export function resolveCredentialBrokerForCreate({
  sandboxProvider,
  githubRepoFullName,
  githubAccessToken,
}: {
  sandboxProvider: SandboxProvider;
  githubRepoFullName: string;
  githubAccessToken: string;
}): { shape: CredentialBrokerShape; mode: "brokered" } | null {
  if (!isCredentialBrokerEnabled()) {
    return null;
  }
  if (sandboxProvider !== "docker") {
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
