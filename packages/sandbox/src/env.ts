import { AIAgentCredentials } from "@terragon/agent/types";
import type { CredentialBrokerShape } from "./types";

/**
 * Non-secret placeholder GH_TOKEN/GITHUB_TOKEN for the E2B native broker (#114).
 * On the E2B brokered path the guest must hold NO real credential, but `gh`
 * (and Octokit) only send an `Authorization` header when a token is present —
 * so we seed a clearly-inert sentinel. E2B's egress proxy then OVERRIDES that
 * header with `token ${e2b.secrets.<name>}` for api.github.com, so the sentinel
 * value is never used off-box and never grants anything on its own. Git needs
 * no credential at all (the header is injected on plain github.com requests).
 */
export const E2B_BROKERED_GH_TOKEN_PLACEHOLDER =
  "x-terragon-e2b-brokered-placeholder";

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
   * the installation token. Behavior depends on the broker `kind`:
   *  - `docker-sidecar`: `GH_TOKEN`/`GITHUB_TOKEN` carry only the per-run bearer
   *    (useless off-box; git presents it to the broker sidecar which verifies
   *    it) and `GH_REPO` restores gh's repo targeting under the `insteadOf`
   *    rewrite. Mirrors the worker plane's `buildDaemonEnv` broker branch.
   *  - `e2b-native`: `GH_TOKEN`/`GITHUB_TOKEN` carry only a NON-secret
   *    placeholder ({@link E2B_BROKERED_GH_TOKEN_PLACEHOLDER}); E2B's egress
   *    proxy overrides the `Authorization` header with the vault secret, so the
   *    placeholder never grants anything. No per-run bearer exists.
   *  - `daytona-native`: `GH_TOKEN`/`GITHUB_TOKEN` are NOT emitted here at all —
   *    Daytona mounts the org Secret's opaque placeholder into those vars via the
   *    create-time `secrets` map, and getEnv deletes both so nothing (raw token
   *    or user value) layers over that placeholder. No per-run bearer exists.
   * Absent = today's exact raw-token env (rollback contract).
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

  // Brokered (#114): RESERVE GH_TOKEN/GITHUB_TOKEN (+ GH_REPO on Docker) —
  // written AFTER userEnv/agentCredentials so a user-supplied GH_TOKEN can NOT
  // shadow the brokered value (still before `overrides`, which are our own
  // trusted keys). The installation token appears NOWHERE in the returned env
  // on either brokered path.
  if (credentialBroker?.kind === "docker-sidecar") {
    // Docker: only the GIT half is brokered. The per-run bearer below is
    // meaningful ONLY to the cred-broker sidecar's git-smart-HTTP endpoints
    // (routed via the `insteadOf`+Bearer git config in setup.ts); it is
    // deliberately NOT a valid api.github.com credential. The gh-API half is
    // DEFERRED (a CA-terminating CONNECT proxy; tracked on #114). Consequence,
    // by design: `gh` API calls that need auth FAIL CLOSED (401 against a bearer
    // GitHub cannot honor) rather than leak the installation token.
    env.GH_TOKEN = credentialBroker.runBearer;
    env.GITHUB_TOKEN = credentialBroker.runBearer;
    env.GH_REPO = credentialBroker.repoFullName;
  } else if (credentialBroker?.kind === "e2b-native") {
    // E2B: BOTH halves are brokered by E2B's egress proxy in ONE mechanism.
    // The guest holds only a non-secret placeholder; E2B overrides the
    // `Authorization` header with the vault secret for github.com AND
    // api.github.com. Git needs no credential (the header is injected on plain
    // requests); `gh`/Octokit send the placeholder, which E2B then overrides.
    env.GH_TOKEN = E2B_BROKERED_GH_TOKEN_PLACEHOLDER;
    env.GITHUB_TOKEN = E2B_BROKERED_GH_TOKEN_PLACEHOLDER;
  } else if (credentialBroker?.kind === "daytona-native") {
    // Daytona: the guest's GH_TOKEN/GITHUB_TOKEN are the org Secret's opaque
    // PLACEHOLDER, injected at the SANDBOX level by Daytona's create-time
    // `secrets` map (ENV → secret name) — NOT here. getEnv must therefore emit
    // NEITHER var: any value we set (the raw installation token, or a
    // user-supplied GH_TOKEN above) would layer OVER the sandbox-level
    // placeholder whenever a command runs with this env, either re-introducing a
    // resident token or defeating Daytona's header substitution. DELETE both so
    // the placeholder from the secrets map shines through untouched. This runs
    // AFTER the userEnv/agentCredentials loop, so a user-supplied GH_TOKEN cannot
    // shadow the brokered state. The installation token appears NOWHERE here.
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}
