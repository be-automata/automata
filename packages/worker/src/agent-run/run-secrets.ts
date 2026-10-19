import {
  sealBindingOf,
  unsealRunSecrets,
  type PlanePrivateKey,
  type RunSecrets,
} from "@terragon/utils/payload-seal";

import type { AgentRunInput, SelfHealRunShape } from "./types";

/**
 * What the engine hands the run fn (#380). The sealed shape is
 * `AgentRunInput` with `sealedSecrets`; the PR-1 rollout shape additionally
 * carries the three secrets in plain text (the control plane sends it only
 * while HATCHET_PAYLOAD_SEAL_KEY is empty). `resolveRunSecrets` is the ONE
 * place the two are told apart; after it, the run holds a clean
 * `AgentRunInput` and a separate `RunSecrets` that is passed explicitly to
 * every consumer and never logged.
 */
/** The self-heal plan as it arrives: the token is sealed, or (legacy) inside. */
export type SelfHealWireShape =
  | (Omit<Extract<SelfHealRunShape, { kind: "audit" }>, "checkToken"> & {
      checkToken?: string;
    })
  | (Omit<Extract<SelfHealRunShape, { kind: "fix" }>, "gateToken"> & {
      gateToken?: string;
    });

export type AgentRunWireInput = Omit<AgentRunInput, "selfHeal"> & {
  selfHeal?: SelfHealWireShape;
  /** Legacy window only: the owner's env in plain text at the top level. */
  repoEnv?: Record<string, string>;
} & Partial<
    Pick<RunSecrets, "installationToken" | "githubReadToken" | "daemonToken">
  >;

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
  const {
    installationToken,
    githubReadToken,
    daemonToken,
    repoEnv,
    selfHeal,
    ...rest
  } = wire;
  const legacySelfHealToken =
    selfHeal === undefined
      ? undefined
      : selfHeal.kind === "audit"
        ? selfHeal.checkToken
        : selfHeal.gateToken;
  if (rest.sealedSecrets !== undefined) {
    // Shape, kid, tag and plaintext are all unsealRunSecrets' to judge —
    // every failure is one PayloadSealError class.
    const secrets = await unsealRunSecrets(
      keys,
      rest.sealedSecrets,
      // The AAD covers the WHOLE input the worker is about to trust — the
      // self-heal plan included (as it travelled: without its token).
      sealBindingOf({
        ...rest,
        ...(selfHeal !== undefined ? { selfHeal } : {}),
      }),
    );
    // Defence in depth: a token without a plan (or the reverse, caught in
    // withSelfHealToken) is a forged input, never a run.
    if (secrets.selfHealToken !== undefined && selfHeal === undefined) {
      throw new Error(
        "payload-seal: envelope carries a self-heal token but the input has no self-heal plan",
      );
    }
    const input: AgentRunInput = {
      ...rest,
      ...(selfHeal !== undefined
        ? { selfHeal: withSelfHealToken(selfHeal, secrets.selfHealToken) }
        : {}),
    };
    return {
      input,
      secrets,
      source: "sealed",
      legacyFieldsIgnored:
        installationToken !== undefined ||
        githubReadToken !== undefined ||
        daemonToken !== undefined ||
        repoEnv !== undefined ||
        legacySelfHealToken !== undefined,
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
    ...(repoEnv !== undefined ? { repoEnv } : {}),
    ...(legacySelfHealToken !== undefined
      ? { selfHealToken: legacySelfHealToken }
      : {}),
  };
  const input: AgentRunInput = {
    ...rest,
    ...(selfHeal !== undefined
      ? { selfHeal: withSelfHealToken(selfHeal, legacySelfHealToken) }
      : {}),
  };
  return { input, secrets, source: "legacy", legacyFieldsIgnored: false };
}

/** The in-memory plan: the wire shape with its (unsealed) token back in place. */
function withSelfHealToken(
  wire: SelfHealWireShape,
  token: string | undefined,
): SelfHealRunShape {
  if (token === undefined || token === "") {
    throw new Error("payload-seal: self-heal plan arrived without its token");
  }
  if (wire.kind === "audit") {
    const { checkToken: _ignored, ...plan } = wire;
    return { ...plan, checkToken: token };
  }
  const { gateToken: _ignored, ...plan } = wire;
  return { ...plan, gateToken: token };
}
