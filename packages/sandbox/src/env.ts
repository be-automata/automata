import { AIAgentCredentials } from "@terragon/agent/types";
import type { CredentialBrokerShape } from "./types";

export function getEnv({
  userEnv,
  githubAccessToken,
  agentCredentials,
  overrides,
  credentialBroker,
}: {
  githubAccessToken: string;
  userEnv: Array<{ key: string; value: string }>;
  agentCredentials: AIAgentCredentials | null;
  overrides?: Record<string, string>;
  /**
   * Per-run credential broker (#114). When present, the guest NEVER receives
   * the installation token: `GH_TOKEN`/`GITHUB_TOKEN` carry only the per-run
   * bearer (useless off-box; git presents it to the broker sidecar which
   * verifies it) and `GH_REPO` restores gh's repo targeting under the
   * `insteadOf` rewrite. Mirrors the worker plane's `buildDaemonEnv` broker
   * branch. Absent = today's exact raw-token env (rollback contract).
   */
  credentialBroker?: CredentialBrokerShape | null;
}) {
  const env: Record<string, string> = {
    // Indicates the agent is running in a Terragon sandbox environment
    TERRAGON: "true",
  };
  if (!credentialBroker) {
    // Legacy (unbrokered): default GH_TOKEN from the installation token. This
    // can be overridden if the user provides their own GH_TOKEN.
    env.GH_TOKEN = githubAccessToken;
  }

  // User environment variables take precedence over built-in variables
  for (const { key, value } of userEnv) {
    env[key] = value;
  }

  if (agentCredentials) {
    if (agentCredentials.type === "env-var") {
      env[agentCredentials.key] = agentCredentials.value;
    }
  }

  // Brokered (#114): RESERVE GH_TOKEN/GITHUB_TOKEN/GH_REPO — written AFTER
  // userEnv/agentCredentials so a user-supplied GH_TOKEN can NOT shadow the
  // per-run bearer (still before `overrides`, which are our own trusted keys).
  // The installation token appears NOWHERE in the returned env.
  //
  // SCOPE (#114): only the GIT half is brokered on Docker. The per-run bearer
  // below is meaningful ONLY to the cred-broker sidecar's git-smart-HTTP
  // endpoints (routed via the `insteadOf`+Bearer git config in setup.ts); it is
  // deliberately NOT a valid api.github.com credential. The gh-API half — the
  // worker plane's gh-broker + GH_CONFIG_DIR/http_unix_socket routing
  // (packages/worker/src/agent-run/daemon-env.ts) — is DEFERRED (a
  // CA-terminating CONNECT proxy; tracked on #114). Consequence, by design:
  // with SANDBOX_CREDENTIAL_BROKER=on, `gh` API calls that need auth FAIL CLOSED
  // (401 against a bearer GitHub cannot honor) rather than leak the installation
  // token. Setting GH_TOKEN to the bearer (vs. leaving the raw token, or
  // unsetting it) is what keeps the raw token out of the guest while git stays
  // fully functional; the 401 is the intended fail-closed posture until the gh
  // half lands.
  if (credentialBroker) {
    env.GH_TOKEN = credentialBroker.runBearer;
    env.GITHUB_TOKEN = credentialBroker.runBearer;
    env.GH_REPO = credentialBroker.repoFullName;
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}
