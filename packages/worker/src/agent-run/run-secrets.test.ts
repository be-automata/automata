import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PayloadSealError,
  generatePlaneKeyPair,
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
 *    field; fails_when=a plain-text field survives beside the envelope or
 *    the AAD is not the input's threadChatId; no_claim=the crypto vectors
 *    (utils suite).
 *  - legacy window: protects=the PR-1 plain-text shape is lifted, strict
 *    refuses it; fails_when=strict accepts plain text or an empty token is
 *    lifted; no_claim=none.
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

describe("resolveRunSecrets", () => {
  it("sealed: unseals with the ring, strips every plain-text field, keeps the envelope on the input", async () => {
    const plane = await generatePlaneKeyPair("plane-a");
    const sealedSecrets = await sealRunSecrets(
      plane.publicKey,
      SECRETS,
      BASE.threadChatId,
    );
    // A hostile/legacy sender that puts BOTH on the wire: the plain-text
    // fields are discarded, the envelope wins.
    const wire: AgentRunWireInput = {
      ...BASE,
      sealedSecrets,
      installationToken: "ghs_SHOULD_BE_IGNORED",
      daemonToken: "SHOULD_BE_IGNORED",
    };
    const out = await resolveRunSecrets({ wire, keys: [plane.privateKey] });
    expect(out.source).toBe("sealed");
    expect(out.legacyFieldsIgnored).toBe(true);
    expect(out.secrets).toEqual(SECRETS);
    expect(out.input).toEqual({ ...BASE, sealedSecrets });
    expect(JSON.stringify(out.input)).not.toContain("SHOULD_BE_IGNORED");
    expect(containsRunSecret(JSON.stringify(out.input), SECRETS)).toBe(false);
  });

  it("sealed: a ring without the kid, a wrong threadChatId or a non-envelope shape fail closed", async () => {
    const plane = await generatePlaneKeyPair("plane-a");
    const other = await generatePlaneKeyPair("plane-b");
    const sealedSecrets = await sealRunSecrets(
      plane.publicKey,
      SECRETS,
      BASE.threadChatId,
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
  });

  it("legacy window: plain-text fields are lifted when no envelope is present; strict refuses them", async () => {
    const wire: AgentRunWireInput = { ...BASE, ...SECRETS };
    const out = await resolveRunSecrets({ wire, keys: [] });
    expect(out.source).toBe("legacy");
    expect(out.secrets).toEqual(SECRETS);
    expect(out.input).toEqual(BASE);
    // An empty read token is "absent", never an empty string downstream.
    const noRead = await resolveRunSecrets({
      wire: { ...BASE, ...SECRETS, githubReadToken: "" },
      keys: [],
    });
    expect(noRead.secrets).toEqual({
      installationToken: SECRETS.installationToken,
      daemonToken: SECRETS.daemonToken,
    });
    await expect(
      resolveRunSecrets({ wire, keys: [], strict: true }),
    ).rejects.toThrow("strict mode refuses plain-text secret fields");
  });

  it("neither shape ⇒ refused", async () => {
    await expect(resolveRunSecrets({ wire: BASE, keys: [] })).rejects.toThrow(
      "neither sealedSecrets nor the legacy",
    );
    await expect(
      resolveRunSecrets({
        wire: { ...BASE, installationToken: "x" },
        keys: [],
      }),
    ).rejects.toThrow("neither sealedSecrets nor the legacy");
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
