import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PayloadSealError,
  generatePlaneKeyPair,
  sealBindingOf,
  sealRunSecrets,
  type RunSecrets,
} from "@terragon/utils/payload-seal";

import { resolveRunSecrets, type AgentRunWireInput } from "./run-secrets";
import type { AgentRunInput } from "./types";

/**
 * #380 secret resolution at the run boundary.
 *
 * Cards:
 *  - sealed: protects=the unsealed RunSecrets + an input with NO secret
 *    field; fails_when=the AAD does not bind the input or a missing ring
 *    falls back to anything; no_claim=the crypto vectors (utils suite).
 *  - strict: protects=rollout step 4 — no plain-text secret field is ever
 *    lifted or ignored, and an unsealed input never runs; fails_when=a plain
 *    field is accepted or its value reaches the error; no_claim=none.
 *  - AC 1 type test: protects=AgentRunInput has no installationToken /
 *    githubReadToken / daemonToken; fails_when=one is re-added to the
 *    type; no_claim=the www side (its own test).
 */

const SECRETS: RunSecrets = {
  installationToken: "ghs_wireInstallation0123456789",
  githubReadToken: "ghs_wireRead0123456789abcdef",
  daemonToken: "daemon_wire_0123456789",
};
/** True when `text` carries any value of `secrets` (the no-leak predicate). */
const containsRunSecret = (text: string, secrets: RunSecrets) =>
  Object.values(secrets).some(
    (v) => typeof v === "string" && v !== "" && text.includes(v),
  );

const BASE: AgentRunInput = {
  threadId: "thr_1",
  threadChatId: "tc_1",
  repoFullName: "o/r",
  branch: "main",
  daemonCallbackUrl: "https://www.example.com",
  orgId: "org-1",
};

describe("resolveRunSecrets (strict, rollout step 4)", () => {
  it("sealed: unseals with the ring, returns a clean input and the secrets", async () => {
    const plane = await generatePlaneKeyPair("plane-a");
    const sealedSecrets = await sealRunSecrets(
      plane.publicKey,
      SECRETS,
      sealBindingOf(BASE),
    );
    const out = await resolveRunSecrets({
      wire: { ...BASE, sealedSecrets },
      keys: [plane.privateKey],
    });
    expect(out.secrets).toEqual(SECRETS);
    expect(out.input).toEqual({ ...BASE, sealedSecrets });
    expect(containsRunSecret(JSON.stringify(out.input), SECRETS)).toBe(false);
  });

  it("sealed: a ring without the kid, a wrong threadChatId or a non-envelope shape fail closed", async () => {
    const plane = await generatePlaneKeyPair("plane-a");
    const other = await generatePlaneKeyPair("plane-b");
    const sealedSecrets = await sealRunSecrets(
      plane.publicKey,
      SECRETS,
      sealBindingOf(BASE),
    );
    await expect(
      resolveRunSecrets({
        wire: { ...BASE, sealedSecrets },
        keys: [other.privateKey],
      }),
    ).rejects.toThrow(
      "payload-seal: unseal failed (kid=plane-a, reason=unknown-kid)",
    );
    await expect(
      resolveRunSecrets({
        wire: { ...BASE, threadChatId: "tc_other", sealedSecrets },
        keys: [plane.privateKey],
      }),
    ).rejects.toBeInstanceOf(PayloadSealError);
    await expect(
      resolveRunSecrets({
        wire: {
          ...BASE,
          sealedSecrets: { v: 1, kid: "plane-a" } as never,
        },
        keys: [plane.privateKey],
      }),
    ).rejects.toThrow("reason=malformed");
    // A missing ring (no key file) is an empty key list: unknown-kid, never a fallback.
    await expect(
      resolveRunSecrets({ wire: { ...BASE, sealedSecrets }, keys: [] }),
    ).rejects.toThrow("reason=unknown-kid");
  });

  /**
   * Card: protects=AC 9 / strict worker — an input that carries ANY plain-text
   * secret field (alone, or beside a valid envelope) is refused, and the
   * error names fields, never values; fails_when=a plain field is lifted,
   * silently discarded, or its value reaches the message; no_claim=www's
   * fail-closed dispatch (its own test).
   */
  it("strict: any plain-text secret field is refused — alone or beside a valid envelope — naming the field, never the value", async () => {
    const plane = await generatePlaneKeyPair("plane-a");
    const sealedSecrets = await sealRunSecrets(
      plane.publicKey,
      SECRETS,
      sealBindingOf(BASE),
    );
    const cases: Array<[AgentRunWireInput, string]> = [
      [
        { ...BASE, ...SECRETS },
        "installationToken, githubReadToken, daemonToken",
      ],
      [
        { ...BASE, sealedSecrets, installationToken: "ghs_SHOULD_NOT_RUN" },
        "installationToken",
      ],
      [
        { ...BASE, sealedSecrets, githubReadToken: "ghs_SHOULD_NOT_RUN" },
        "githubReadToken",
      ],
      [
        { ...BASE, sealedSecrets, daemonToken: "SHOULD_NOT_RUN" },
        "daemonToken",
      ],
      [{ ...BASE, sealedSecrets, repoEnv: { K: "SHOULD_NOT_RUN" } }, "repoEnv"],
    ];
    for (const [wire, named] of cases) {
      const err = await resolveRunSecrets({
        wire,
        keys: [plane.privateKey],
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toBe(
        `payload-seal: strict mode refuses plain-text secret fields (${named})`,
      );
      expect(err?.message).not.toContain("SHOULD_NOT_RUN");
      expect(containsRunSecret(String(err?.message), SECRETS)).toBe(false);
    }
  });

  it("strict: an input with no envelope and no plain field is refused", async () => {
    await expect(resolveRunSecrets({ wire: BASE, keys: [] })).rejects.toThrow(
      "payload-seal: input carries no sealedSecrets (strict mode refuses an unsealed input)",
    );
  });
});

describe("AgentRunInput carries no secret field (#380 AC 1)", () => {
  it("installationToken / githubReadToken / daemonToken are not properties of the worker input type", () => {
    expectTypeOf<AgentRunInput>().not.toHaveProperty("installationToken");
    expectTypeOf<AgentRunInput>().not.toHaveProperty("githubReadToken");
    expectTypeOf<AgentRunInput>().not.toHaveProperty("daemonToken");
    expectTypeOf<AgentRunInput>().toHaveProperty("sealedSecrets");
    // The runtime guard matches the type: containsRunSecret finds nothing in
    // a clean input even when the secrets are the needle.
    expect(containsRunSecret(JSON.stringify(BASE), SECRETS)).toBe(false);
    expect(
      containsRunSecret(
        JSON.stringify({ ...BASE, oops: SECRETS.daemonToken }),
        SECRETS,
      ),
    ).toBe(true);
  });
});
