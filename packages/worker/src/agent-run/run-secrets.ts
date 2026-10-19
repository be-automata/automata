import {
  isSealedRunSecrets,
  unsealRunSecrets,
  RUN_SECRET_FIELDS,
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
export type AgentRunWireInput = AgentRunInput & {
  installationToken?: string;
  githubReadToken?: string;
  daemonToken?: string;
};

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
}> {
  const { installationToken, githubReadToken, daemonToken, ...rest } = wire;
  const input: AgentRunInput = rest;
  if (input.sealedSecrets !== undefined) {
    if (!isSealedRunSecrets(input.sealedSecrets)) {
      throw new Error(
        "payload-seal: input.sealedSecrets is not a v1 envelope (shape)",
      );
    }
    const secrets = await unsealRunSecrets(
      keys,
      input.sealedSecrets,
      input.threadChatId,
    );
    return { input, secrets, source: "sealed" };
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
  return { input, secrets, source: "legacy" };
}

/**
 * True when `text` contains any value of `secrets` — the predicate the
 * "no secret in argv / step log / output / failure reason" tests use.
 */
export function containsRunSecret(text: string, secrets: RunSecrets): boolean {
  return RUN_SECRET_FIELDS.some((field) => {
    const value = secrets[field];
    return typeof value === "string" && value !== "" && text.includes(value);
  });
}
