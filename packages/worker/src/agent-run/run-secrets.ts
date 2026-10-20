import {
  sealBindingOf,
  unsealRunSecrets,
  type PlanePrivateKey,
  type RunSecrets,
} from "@terragon/utils/payload-seal";

import type { AgentRunInput, SelfHealRunShape } from "./types";

/**
 * What the engine hands the run fn (#380). Since rollout step 4 (PR 2,
 * strict mode) the ONLY accepted shape is `AgentRunInput` with
 * `sealedSecrets`. The plain-text secret fields of the PR-1 rollout shape are
 * still DECLARED here — the engine payload is untrusted input — so that
 * `resolveRunSecrets` can refuse an input that carries any of them.
 * `resolveRunSecrets` is the ONE place secrets are read; after it, the run
 * holds a clean `AgentRunInput` and a separate `RunSecrets` that is passed
 * explicitly to every consumer and never logged.
 */
/** The self-heal plan as it arrives: without its token (the token is sealed). */
export type SelfHealWireShape =
  | (Omit<Extract<SelfHealRunShape, { kind: "audit" }>, "checkToken"> & {
      checkToken?: string;
    })
  | (Omit<Extract<SelfHealRunShape, { kind: "fix" }>, "gateToken"> & {
      gateToken?: string;
    });

export type AgentRunWireInput = Omit<AgentRunInput, "selfHeal"> & {
  selfHeal?: SelfHealWireShape;
  /** Refused when present (the PR-1 plain-text shape). */
  repoEnv?: Record<string, string>;
} & Partial<
    Pick<RunSecrets, "installationToken" | "githubReadToken" | "daemonToken">
  >;

/** The plain-text secret fields a strict worker refuses, by name only. */
function plainSecretFieldsOf(wire: AgentRunWireInput): string[] {
  const found: string[] = [];
  if (wire.installationToken !== undefined) found.push("installationToken");
  if (wire.githubReadToken !== undefined) found.push("githubReadToken");
  if (wire.daemonToken !== undefined) found.push("daemonToken");
  if (wire.repoEnv !== undefined) found.push("repoEnv");
  if (
    wire.selfHeal?.kind === "audit" &&
    wire.selfHeal.checkToken !== undefined
  ) {
    found.push("selfHeal.checkToken");
  }
  if (wire.selfHeal?.kind === "fix" && wire.selfHeal.gateToken !== undefined) {
    found.push("selfHeal.gateToken");
  }
  return found;
}

/**
 * Unseal the run's secrets and strip them from the input. Strict (rollout
 * step 4): an input without `sealedSecrets`, or one that ALSO carries any
 * plain-text secret field, is refused — the plain fields would already sit in
 * the engine row, so running it would hide a control-plane defect. Throws a
 * PayloadSealError (kid + failure class only) when the envelope cannot be
 * unsealed, and a plain Error naming FIELD NAMES only (never a value) for a
 * refused shape.
 */
export async function resolveRunSecrets({
  wire,
  keys,
}: {
  wire: AgentRunWireInput;
  keys: readonly PlanePrivateKey[];
}): Promise<{ input: AgentRunInput; secrets: RunSecrets }> {
  const plainFields = plainSecretFieldsOf(wire);
  if (plainFields.length > 0) {
    throw new Error(
      `payload-seal: strict mode refuses plain-text secret fields (${plainFields.join(", ")})`,
    );
  }
  const {
    installationToken: _installationToken,
    githubReadToken: _githubReadToken,
    daemonToken: _daemonToken,
    repoEnv: _repoEnv,
    selfHeal,
    ...rest
  } = wire;
  if (rest.sealedSecrets === undefined) {
    throw new Error(
      "payload-seal: input carries no sealedSecrets (strict mode refuses an unsealed input)",
    );
  }
  // Shape, kid, tag and plaintext are all unsealRunSecrets' to judge — every
  // failure is one PayloadSealError class.
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
  return { input, secrets };
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
