import { describe, expect, it } from "vitest";

import {
  PayloadSealError,
  RUN_SECRET_FIELDS,
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
const THREAD_CHAT_ID = "tc_01HZX";

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

describe("payload-seal (#380)", () => {
  it("round-trips the three secrets through a fresh envelope each time (protects=secrets survive seal→unseal; fails_when=any field is lost or altered; no_claim=nothing about the wire shape under workerd)", async () => {
    const { publicKey, privateKey } = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(publicKey, SECRETS, THREAD_CHAT_ID);
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
    const out = await unsealRunSecrets([privateKey], sealed, THREAD_CHAT_ID);
    expect(out).toEqual(SECRETS);
    // Fresh ephemeral + IV per seal: a second envelope shares no field.
    const again = await sealRunSecrets(publicKey, SECRETS, THREAD_CHAT_ID);
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
    const sealed = await sealRunSecrets(publicKey, withExtra, THREAD_CHAT_ID);
    const out = await unsealRunSecrets([privateKey], sealed, THREAD_CHAT_ID);
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
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, THREAD_CHAT_ID);
    await expectSealError(
      unsealRunSecrets([b.privateKey], sealed, THREAD_CHAT_ID),
      "tag",
      "plane-a",
    );
  });

  it("a different threadChatId fails the AAD (protects=an envelope is bound to its thread chat; fails_when=a lifted envelope unseals under another thread; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, THREAD_CHAT_ID);
    await expectSealError(
      unsealRunSecrets([a.privateKey], sealed, "tc_other"),
      "tag",
      "plane-a",
    );
  });

  it("flipping one byte of ct fails (protects=integrity of the ciphertext; fails_when=a tampered ct decrypts; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, THREAD_CHAT_ID);
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, ct: flipByteOf(sealed.ct, 3) },
        THREAD_CHAT_ID,
      ),
      "tag",
      "plane-a",
    );
  });

  it("flipping one byte of iv fails (protects=integrity of the nonce; fails_when=a tampered iv decrypts; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, THREAD_CHAT_ID);
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, iv: flipByteOf(sealed.iv, 5) },
        THREAD_CHAT_ID,
      ),
      "tag",
      "plane-a",
    );
  });

  it("flipping one byte of epk fails (protects=integrity of the ephemeral key; fails_when=a tampered epk still derives the AES key; no_claim=none beyond protects)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, THREAD_CHAT_ID);
    const err = await unsealRunSecrets(
      [a.privateKey],
      { ...sealed, epk: flipByteOf(sealed.epk, 7) },
      THREAD_CHAT_ID,
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
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, THREAD_CHAT_ID);
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, kid: "plane-z" },
        THREAD_CHAT_ID,
      ),
      "unknown-kid",
      "plane-z",
    );
    const e = await unsealRunSecrets(
      [a.privateKey],
      { ...sealed, kid: "evil kid with spaces" },
      THREAD_CHAT_ID,
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
    const sealedOld = await sealRunSecrets(
      old.publicKey,
      SECRETS,
      THREAD_CHAT_ID,
    );
    const sealedNew = await sealRunSecrets(
      next.publicKey,
      SECRETS,
      THREAD_CHAT_ID,
    );
    const ring = [next.privateKey, old.privateKey];
    expect(await unsealRunSecrets(ring, sealedOld, THREAD_CHAT_ID)).toEqual(
      SECRETS,
    );
    expect(await unsealRunSecrets(ring, sealedNew, THREAD_CHAT_ID)).toEqual(
      SECRETS,
    );
    expect(
      await unsealRunSecrets([...ring].reverse(), sealedNew, THREAD_CHAT_ID),
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
        THREAD_CHAT_ID,
      ),
    ).rejects.toThrow("shape");
    const sealed = await sealRunSecrets(a.publicKey, SECRETS, THREAD_CHAT_ID);
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, v: 2 } as unknown as SealedRunSecrets,
        THREAD_CHAT_ID,
      ),
      "version",
      "plane-a",
    );
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, ct: "not*base64url" },
        THREAD_CHAT_ID,
      ),
      "malformed",
      "plane-a",
    );
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        { ...sealed, epk: sealed.epk.slice(0, 10) },
        THREAD_CHAT_ID,
      ),
      "malformed",
      "plane-a",
    );
    await expectSealError(
      unsealRunSecrets(
        [a.privateKey],
        null as unknown as SealedRunSecrets,
        THREAD_CHAT_ID,
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
      THREAD_CHAT_ID,
    );
    expect(
      await unsealRunSecrets([a.privateKey], sealed, THREAD_CHAT_ID),
    ).toEqual(SECRETS);
  });
});
