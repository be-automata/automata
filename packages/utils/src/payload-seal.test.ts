import { describe, expect, it } from "vitest";

import {
  PayloadSealError,
  RUN_SECRET_FIELDS,
  canonicalJson,
  formatPlanePublicKey,
  generatePlaneKeyPair,
  isPlanePrivateKey,
  isSealedRunSecrets,
  parsePlanePublicKey,
  publicKeyOf,
  sealRunSecrets,
  unsealRunSecrets,
  type RunSecrets,
  type SealedRunSecrets,
} from "./payload-seal";

/**
 * #380 payload seal — the Node half of AC 4/5. Every card:
 *   protects / fails_when / no_claim
 * The workerd half (seal under workerd, unseal under Node and the reverse)
 * lives in apps/www/src/agent/hatchet/payload-seal.workerd.test.ts.
 */

const SECRETS: RunSecrets = {
  installationToken: "ghs_installationTOKENvalue0123456789",
  githubReadToken: "ghs_readonlyTOKENvalue0123456789abc",
  daemonToken: "daemon_TOKEN_value_0123456789abcdefghijklmnopqrstuvwxyz",
};
const BINDING = {
  threadId: "thr_01HZX",
  threadChatId: "tc_01HZX",
  daemonCallbackUrl: "https://www.example.com",
  repoFullName: "o/r",
  orgId: "org-1",
};

function flipByteOf(field: string, at = 0): string {
  // Decode base64url → flip one byte → re-encode, so the field stays
  // well-formed base64url and the failure is the TAG, not "malformed".
  const padded =
    field.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (field.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  const idx = Math.min(at, bytes.length - 1);
  // `noUncheckedIndexedAccess`: idx is always in range for a non-empty field.
  bytes[idx] = (bytes[idx] ?? 0) ^ 0x01;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function expectSealError(
  p: Promise<unknown>,
  reason: PayloadSealError["reason"],
  kid: string,
) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PayloadSealError);
  const e = err as PayloadSealError;
  expect(e.reason).toBe(reason);
  expect(e.message).toBe(
    `payload-seal: unseal failed (kid=${kid}, reason=${reason})`,
  );
  // The message never carries plaintext or key bytes.
  for (const f of RUN_SECRET_FIELDS) {
    expect(e.message).not.toContain(SECRETS[f] ?? "<absent>");
  }
}

describe("canonicalJson", () => {
  it("sorts keys recursively, keeps array order, drops undefined like JSON.stringify (protects=www and the worker digest the same input identically; fails_when=key order or an undefined member changes the digest; no_claim=none beyond protects)", () => {
    expect(
      canonicalJson({ b: [{ z: 1, a: undefined, y: [2, undefined] }], a: "x" }),
    ).toBe('{"a":"x","b":[{"y":[2,null],"z":1}]}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("payload-seal (#380)", () => {
  it("round-trips the three secrets through a fresh envelope each time (protects=secrets survive seal→unseal; fails_when=any field is lost or altered; no_claim=nothing about the wire shape under workerd)", async () => {
    const { publicKey, privateKey } = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(publicKey, SECRETS, BINDING);
    expect(isSealedRunSecrets(sealed)).toBe(true);
    expect(sealed.v).toBe(1);
    expect(sealed.kid).toBe("plane-a");
    expect(sealed.epk).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sealed.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(sealed.ct).toMatch(/^[A-Za-z0-9_-]+$/);
    // No plain-text secret survives in the envelope.
    const wire = JSON.stringify(sealed);
    for (const f of RUN_SECRET_FIELDS) {
      expect(wire).not.toContain(SECRETS[f]);
      expect(wire).not.toContain(f);
    }
    expect(wire).not.toContain("ghs_");
    const out = await unsealRunSecrets([privateKey], sealed, BINDING);
    expect(out).toEqual(SECRETS);
    // Fresh ephemeral + IV per seal: a second envelope shares no field.
    const again = await sealRunSecrets(publicKey, SECRETS, BINDING);
    expect(again.epk).not.toBe(sealed.epk);
    expect(again.iv).not.toBe(sealed.iv);
    expect(again.ct).not.toBe(sealed.ct);
  });

  it("an absent read token stays absent, and a stray property never travels (protects=the envelope carries exactly RunSecrets; fails_when=an extra or missing key appears after unseal; no_claim=none beyond protects)", async () => {
    const { publicKey, privateKey } = await generatePlaneKeyPair("plane-a");
    const withExtra = {
      installationToken: SECRETS.installationToken,
      daemonToken: SECRETS.daemonToken,
      prompt: "SHOULD-NOT-TRAVEL",
    } as RunSecrets;
    const sealed = await sealRunSecrets(publicKey, withExtra, BINDING);
    const out = await unsealRunSecrets([privateKey], sealed, BINDING);
    expect(out).toEqual({
      installationToken: SECRETS.installationToken,
      daemonToken: SECRETS.daemonToken,
    });
    expect("githubReadToken" in out).toBe(false);
    expect("prompt" in out).toBe(false);
  });

  it("another key pair under the same kid cannot unseal (protects=confidentiality against a wrong plane key; fails_when=unseal succeeds or leaks a different class; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const b = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, BINDING);
    await expectSealError(
      unsealRunSecrets([b.privateKey], sealed, BINDING),
      "tag",
      "plane-a",
    );
  });

  it("any changed binding field fails the AAD — above all the callback URL (protects=an envelope is bound to its thread, chat, callback, repo and org; fails_when=a lifted envelope unseals under another input or a re-pointed callback; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, BINDING);
    for (const changed of [
      { threadChatId: "tc_other" },
      { threadId: "thr_other" },
      { daemonCallbackUrl: "https://attacker.example" },
      { repoFullName: "o/other" },
      { orgId: "org-2" },
      // Any OTHER plain-text field is bound too (the self-heal plan fences
      // what the installation token may push; branches steer the clone).
      { branch: "attacker-branch" },
      { selfHeal: { kind: "fix", branch: "automata/fix-evil" } },
      { taskAgent: { batteries: ["evil-pack"] } },
    ]) {
      await expectSealError(
        unsealRunSecrets([a.privateKey], sealed, { ...BINDING, ...changed }),
        "tag",
        "plane-a",
      );
    }
    // The envelope itself and the plain-text secret fields are never part of
    // the binding (the worker strips them before it can compare), and key
    // order does not matter.
    expect(
      await unsealRunSecrets([a.privateKey], sealed, {
        sealedSecrets: sealed,
        installationToken: "ghs_legacy-leak",
        repoEnv: { A: "b" },
        ...Object.fromEntries(Object.entries(BINDING).reverse()),
      }),
    ).toEqual(SECRETS);
  });

  it("flipping one byte of ct fails (protects=integrity of the ciphertext; fails_when=a tampered ct decrypts; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, BINDING);
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, ct: flipByteOf(sealed.ct, 3) },
        BINDING,
      ),
      "tag",
      "plane-a",
    );
  });

  it("flipping one byte of iv fails (protects=integrity of the nonce; fails_when=a tampered iv decrypts; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, BINDING);
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, iv: flipByteOf(sealed.iv, 5) },
        BINDING,
      ),
      "tag",
      "plane-a",
    );
  });

  it("flipping one byte of epk fails (protects=integrity of the ephemeral key; fails_when=a tampered epk still derives the AES key; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, BINDING);
    const err = await unsealRunSecrets(
      [a.privateKey],
      { ...sealed, epk: flipByteOf(sealed.epk, 7) },
      BINDING,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PayloadSealError);
    // A flipped point either derives a different shared secret (→ tag) or is
    // rejected by X25519 import/derive (→ key/derive): never a success.
    expect(["tag", "derive", "key"]).toContain(
      (err as PayloadSealError).reason,
    );
  });

  it("an unknown kid is refused before any key is touched (protects=key selection by kid; fails_when=a foreign kid is tried against some key; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, BINDING);
    await expectSealError(
      unsealRunSecrets([a.privateKey], { ...sealed, kid: "plane-z" }, BINDING),
      "unknown-kid",
      "plane-z",
    );
    const e = await unsealRunSecrets(
      [a.privateKey],
      { ...sealed, kid: "evil kid with spaces" },
      BINDING,
    ).then(
      () => null,
      (x: unknown) => x,
    );
    // An out-of-charset kid is not echoed into the message.
    expect(e).toBeInstanceOf(PayloadSealError);
    expect((e as PayloadSealError).message).toContain("kid=<invalid>");
  });

  it("rotation overlap: the key is found at either position in keys[] (protects=rotation keeps old runs unsealable; fails_when=only the first key is consulted; no_claim=none beyond protects)", async () => {
    const old = await generatePlaneKeyPair("plane-2026-09");
    const next = await generatePlaneKeyPair("plane-2026-10");
    const sealedOld = await sealRunSecrets(old.publicKey, SECRETS, BINDING);
    const sealedNew = await sealRunSecrets(next.publicKey, SECRETS, BINDING);
    const ring = [next.privateKey, old.privateKey];
    expect(await unsealRunSecrets(ring, sealedOld, BINDING)).toEqual(SECRETS);
    expect(await unsealRunSecrets(ring, sealedNew, BINDING)).toEqual(SECRETS);
    expect(
      await unsealRunSecrets([...ring].reverse(), sealedNew, BINDING),
    ).toEqual(SECRETS);
  });

  it("a plaintext that is not RunSecrets, a wrong version and undecodable fields are refused (protects=the unsealed shape; fails_when=garbage is returned as secrets; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    // Malformed JSON shape: a non-string token travels only if the sealer is
    // bypassed; sealRunSecrets refuses it up front.
    await expect(
      sealRunSecrets(
        a.publicKey,
        { installationToken: 42, daemonToken: "d" } as unknown as RunSecrets,
        BINDING,
      ),
    ).rejects.toThrow("shape");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, BINDING);
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, v: 2 } as unknown as SealedRunSecrets,
        BINDING,
      ),
      "version",
      "plane-a",
    );
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, ct: "not*base64url" },
        BINDING,
      ),
      "malformed",
      "plane-a",
    );
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, epk: sealed.epk.slice(0, 10) },
        BINDING,
      ),
      "malformed",
      "plane-a",
    );
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        null as unknown as SealedRunSecrets,
        BINDING,
      ),
      "malformed",
      "<invalid>",
    );
  });

  it("public key env form parses and formats symmetrically; bad forms are refused (protects=HATCHET_PAYLOAD_SEAL_KEY parsing; fails_when=a wrong-length or wrong-charset key is accepted; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-2026-10");
    const text = formatPlanePublicKey(a.publicKey);
    expect(text).toBe(`plane-2026-10:${a.publicKey.publicKey}`);
    expect(parsePlanePublicKey(text)).toEqual(a.publicKey);
    expect(publicKeyOf(a.privateKey)).toEqual(a.publicKey);
    expect(isPlanePrivateKey(a.privateKey)).toBe(true);
    expect(isPlanePrivateKey({ kid: "x", privateKeyJwk: { kty: "EC" } })).toBe(
      false,
    );
    expect(() => parsePlanePublicKey("no-colon")).toThrow("<kid>:<base64url>");
    expect(() => parsePlanePublicKey("bad kid:AAAA")).toThrow("character set");
    expect(() => parsePlanePublicKey("plane:AAAA")).toThrow("32 raw bytes");
    expect(() => parsePlanePublicKey("plane:***")).toThrow("not base64url");
    // A parsed public key seals to the same private key.
    const sealed = await sealRunSecrets(
      parsePlanePublicKey(text),
      SECRETS,
      BINDING,
    );
    expect(await unsealRunSecrets([a.privateKey], sealed, BINDING)).toEqual(
      SECRETS,
    );
  });
});
