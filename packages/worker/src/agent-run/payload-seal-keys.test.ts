import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generatePlaneKeyPair } from "@terragon/utils/payload-seal";

import {
  PlaneKeyFileMissingError,
  assertPlaneKeysUsable,
  loadPlaneKeysAtBoot,
  planeKeysForRun,
  readPlaneKeyFile,
  resetPlaneKeyRingForTests,
} from "./payload-seal-keys";

/**
 * #380 key ring + boot self-check (AC 7b at the function level; worker.ts
 * wires `loadPlaneKeysAtBoot` into the FATAL/exit(1) boot sequence exactly
 * like the other boot asserts).
 *
 * Cards:
 *  - read/validate: protects=the ring the runs unseal with; fails_when=a
 *    malformed, empty, duplicate-kid or unreadable file is accepted;
 *    no_claim=file ownership/mode (the key script's job).
 *  - boot probe: protects=a corrupt private scalar is caught before
 *    registration; fails_when=a key that cannot unseal its own probe passes;
 *    no_claim=a mismatch with www's public key (not detectable here).
 *  - memoised ring: protects=one read per process, absent file ⇒ [];
 *    fails_when=a broken file is swallowed as "absent"; no_claim=none.
 */

const dir = () => mkdtempSync(path.join(tmpdir(), "seal-keys-"));
// `.json`, never `.key`: a sandboxed runner denies reads of *.key.
const fileIn = (d: string) => path.join(d, "payload-seal.json");

afterEach(() => {
  resetPlaneKeyRingForTests();
});

describe("readPlaneKeyFile", () => {
  it("reads a valid ring in order and keeps only kid + privateKeyJwk", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const b = await generatePlaneKeyPair("plane-b");
    const f = fileIn(dir());
    writeFileSync(
      f,
      JSON.stringify({
        keys: [{ ...a.privateKey, extra: "x" }, b.privateKey],
      }),
      { mode: 0o600 },
    );
    const ring = readPlaneKeyFile(f);
    expect(ring.map((k) => k.kid)).toEqual(["plane-a", "plane-b"]);
    expect(ring[0]).toEqual(a.privateKey);
    expect(ring[0]).not.toHaveProperty("extra");
  });

  it("ENOENT is the typed missing error; everything else names the path and the fault, never a key byte", async () => {
    const d = dir();
    expect(() => readPlaneKeyFile(fileIn(d))).toThrow(PlaneKeyFileMissingError);
    const notJson = path.join(d, "a.json");
    writeFileSync(notJson, "{nope", { mode: 0o600 });
    expect(() => readPlaneKeyFile(notJson)).toThrow("not JSON");
    const empty = path.join(d, "b.json");
    writeFileSync(empty, JSON.stringify({ keys: [] }), { mode: 0o600 });
    expect(() => readPlaneKeyFile(empty)).toThrow('non-empty "keys"');
    const shape = path.join(d, "c.json");
    writeFileSync(
      shape,
      JSON.stringify({ keys: [{ kid: "k", privateKeyJwk: { kty: "EC" } }] }),
      { mode: 0o600 },
    );
    expect(() => readPlaneKeyFile(shape)).toThrow("entry 0 is not");
    const a = await generatePlaneKeyPair("plane-a");
    const dup = path.join(d, "d.json");
    writeFileSync(dup, JSON.stringify({ keys: [a.privateKey, a.privateKey] }), {
      mode: 0o600,
    });
    const err = (() => {
      try {
        readPlaneKeyFile(dup);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toContain('duplicate kid "plane-a"');
    expect(err?.message).not.toContain(a.privateKey.privateKeyJwk.d);
  });

  it("a world-readable ring or a symlink to one is refused (guarded read), never used", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const d = dir();
    const loose = path.join(d, "loose.json");
    writeFileSync(loose, JSON.stringify({ keys: [a.privateKey] }), {
      mode: 0o644,
    });
    expect(() => readPlaneKeyFile(loose)).toThrow("world-accessible");
    const group = path.join(d, "group.json");
    writeFileSync(group, JSON.stringify({ keys: [a.privateKey] }), {
      mode: 0o640,
    });
    expect(() => readPlaneKeyFile(group)).toThrow("group-accessible");
    const tight = path.join(d, "tight.json");
    writeFileSync(tight, JSON.stringify({ keys: [a.privateKey] }), {
      mode: 0o600,
    });
    const link = path.join(d, "link.json");
    symlinkSync(tight, link);
    expect(() => readPlaneKeyFile(link)).toThrow("unreadable (ELOOP)");
    expect(readPlaneKeyFile(tight)).toEqual([a.privateKey]);
  });

  it("an unreadable file (mode 000) is reported as unreadable, not as missing", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const a = await generatePlaneKeyPair("plane-a");
    const f = fileIn(dir());
    writeFileSync(f, JSON.stringify({ keys: [a.privateKey] }), { mode: 0o600 });
    chmodSync(f, 0o000);
    expect(() => readPlaneKeyFile(f)).toThrow("unreadable");
    expect(() => readPlaneKeyFile(f)).not.toThrow(PlaneKeyFileMissingError);
  });
});

describe("assertPlaneKeysUsable (boot probe)", () => {
  it("every key in the ring seals and unseals its own probe; the kids come back in order", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const b = await generatePlaneKeyPair("plane-b");
    await expect(
      assertPlaneKeysUsable([a.privateKey, b.privateKey]),
    ).resolves.toEqual(["plane-a", "plane-b"]);
  });

  it("a key whose private scalar was corrupted fails the probe and names only the kid", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const b = await generatePlaneKeyPair("plane-b");
    // Swap b's scalar under a's public half: a well-formed JWK whose halves
    // do not match — exactly what a truncated/edited file produces.
    const corrupt = {
      kid: "plane-a",
      privateKeyJwk: {
        ...a.privateKey.privateKeyJwk,
        d: b.privateKey.privateKeyJwk.d,
      },
    };
    const err = await assertPlaneKeysUsable([corrupt]).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('boot probe failed for kid "plane-a"');
    expect(err?.message).not.toContain(b.privateKey.privateKeyJwk.d);
  });
});

describe("planeKeysForRun / loadPlaneKeysAtBoot", () => {
  it("absent file ⇒ [] (rollout step 1), present ⇒ the ring, read once per path", async () => {
    const d = dir();
    const f = fileIn(d);
    expect(planeKeysForRun(f)).toEqual([]);
    const a = await generatePlaneKeyPair("plane-a");
    writeFileSync(f, JSON.stringify({ keys: [a.privateKey] }), { mode: 0o600 });
    // Memoised: the empty read stands until the ring is reset (a rotation
    // restarts the worker by design).
    expect(planeKeysForRun(f)).toEqual([]);
    resetPlaneKeyRingForTests();
    expect(planeKeysForRun(f)).toEqual([a.privateKey]);
  });

  it("a broken file throws from the per-run loader too (never silently 'absent')", () => {
    const f = fileIn(dir());
    writeFileSync(f, "{nope", { mode: 0o600 });
    expect(() => planeKeysForRun(f)).toThrow("not JSON");
  });

  it("boot: absent + not required ⇒ present:false; absent + required ⇒ throws; present ⇒ probed kids", async () => {
    const d = dir();
    const f = fileIn(d);
    await expect(
      loadPlaneKeysAtBoot({ path: f, required: false }),
    ).resolves.toEqual({ kids: [], present: false });
    await expect(
      loadPlaneKeysAtBoot({ path: f, required: true }),
    ).rejects.toThrow(PlaneKeyFileMissingError);
    const a = await generatePlaneKeyPair("plane-2026-10");
    writeFileSync(f, JSON.stringify({ keys: [a.privateKey] }), { mode: 0o600 });
    resetPlaneKeyRingForTests();
    await expect(
      loadPlaneKeysAtBoot({ path: f, required: false }),
    ).resolves.toEqual({ kids: ["plane-2026-10"], present: true });
    // …and the run loader now serves the same ring without re-reading.
    expect(planeKeysForRun(f)).toEqual([a.privateKey]);
  });

  it("boot: a present file whose key fails the probe throws (AC 7b: the caller exits non-zero before registering)", async () => {
    const a = await generatePlaneKeyPair("plane-a");
    const b = await generatePlaneKeyPair("plane-b");
    const f = fileIn(dir());
    writeFileSync(
      f,
      JSON.stringify({
        keys: [
          {
            kid: "plane-a",
            privateKeyJwk: {
              ...a.privateKey.privateKeyJwk,
              d: b.privateKey.privateKeyJwk.d,
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    await expect(
      loadPlaneKeysAtBoot({ path: f, required: false }),
    ).rejects.toThrow("boot probe failed");
  });
});
