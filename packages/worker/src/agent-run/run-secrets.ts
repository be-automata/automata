import {
  unsealRunSecrets,
  type PlanePrivateKey,
  type RunSecrets,
} from "@terragon/utils/payload-seal";

import type { AgentRunInput } from "./types";

/**
 * What the engine hands the run fn (#380). The sealed shape is
 * `AgentRunInput` with `sealedSecrets`; the PR-1 rollout shape additionally
 * carries the three secrets in plain text (the control plane sends it only
 * while HATCHET_PAYLOAD_SEAL_KEY is empty). `resolveRunSecrets` is the ONE
 * place the two are told apart; after it, the run holds a clean
 * `AgentRunInput` and a separate `RunSecrets` that is passed explicitly to
 * every consumer and never logged.
 */
export type AgentRunWireInput = AgentRunInput & Partial<RunSecrets>;

export type RunSecretsSource = "sealed" | "legacy";

/**
 * Unseal (or, in the rollout window, lift) the run's secrets and strip them
 * from the input. Throws a PayloadSealError (kid + failure class only) when
 * the envelope cannot be unsealed, and a plain Error when the input carries
 * no secrets at all or, in strict mode, plain-text secret fields.
 */
export async function resolveRunSecrets({
  wire,
  keys,
  strict = false,
}: {
  wire: AgentRunWireInput;
  keys: readonly PlanePrivateKey[];
  /** Rollout step 4 (PR 2): refuse the legacy plain-text shape. */
  strict?: boolean;
}): Promise<{
  input: AgentRunInput;
  secrets: RunSecrets;
  source: RunSecretsSource;
  /** Both shapes arrived: the plain-text fields were discarded (a www defect to report). */
  legacyFieldsIgnored: boolean;
}> {
  const { installationToken, githubReadToken, daemonToken, ...rest } = wire;
  const input: AgentRunInput = rest;
  if (input.sealedSecrets !== undefined) {
    // Shape, kid, tag and plaintext are all unsealRunSecrets' to judge —
    // every failure is one PayloadSealError class.
    const secrets = await unsealRunSecrets(
      keys,
      input.sealedSecrets,
      input.threadChatId,
    );
    return {
      input,
      secrets,
      source: "sealed",
      legacyFieldsIgnored:
        installationToken !== undefined ||
        githubReadToken !== undefined ||
        daemonToken !== undefined,
    };
  }
  if (strict) {
    throw new Error(
      "payload-seal: input carries no sealedSecrets (strict mode refuses plain-text secret fields)",
    );
  }
  if (
    typeof installationToken !== "string" ||
    installationToken === "" ||
    typeof daemonToken !== "string" ||
    daemonToken === ""
  ) {
    throw new Error(
      "payload-seal: input carries neither sealedSecrets nor the legacy plain-text secret fields",
    );
  }
  const secrets: RunSecrets = {
    installationToken,
    ...(typeof githubReadToken === "string" && githubReadToken !== ""
      ? { githubReadToken }
      : {}),
    daemonToken,
  };
  return { input, secrets, source: "legacy", legacyFieldsIgnored: false };
}
