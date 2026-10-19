import { readFileSync } from "node:fs";

import {
  generatePlaneKeyPair,
  isPlanePrivateKey,
  publicKeyOf,
  sealRunSecrets,
  unsealRunSecrets,
  type PlanePrivateKey,
} from "@terragon/utils/payload-seal";

/**
 * The execution plane's seal key ring (#380). `/etc/automata/payload-seal.key`
 * holds `{"keys":[PlanePrivateKey, ...]}`, newest first (rotation adds at the
 * front, see scripts/gen-payload-seal-key.ts). Owner = the worker service
 * user, mode 0400; never in git, never logged.
 *
 * Rollout step 1 (this PR): the file is OPTIONAL. Absent ⇒ the worker unseals
 * nothing and accepts only the legacy plain-text input. Present ⇒ it must
 * parse and every key must pass the boot probe, or the worker refuses to
 * start — a corrupt or truncated file would otherwise fail every sealed run
 * at its first step. Step 4 (PR 2) makes the file mandatory.
 */

export const DEFAULT_PAYLOAD_SEAL_KEY_FILE = "/etc/automata/payload-seal.key";

/** Thrown when the configured file does not exist (ENOENT) — the one tolerated case. */
export class PlaneKeyFileMissingError extends Error {
  constructor(readonly path: string) {
    super(`payload-seal: key file not found: ${path}`);
    this.name = "PlaneKeyFileMissingError";
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Read and validate the key file. Throws PlaneKeyFileMissingError on ENOENT,
 * and a plain Error (naming the path, never a key byte) on an unreadable
 * file, bad JSON, a wrong shape, an empty ring or a duplicate kid.
 */
export function readPlaneKeyFile(path: string): PlanePrivateKey[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) throw new PlaneKeyFileMissingError(path);
    throw new Error(
      `payload-seal: key file unreadable: ${path} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`payload-seal: key file is not JSON: ${path}`);
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(
      `payload-seal: key file must hold a non-empty "keys" array: ${path}`,
    );
  }
  const out: PlanePrivateKey[] = [];
  const seen = new Set<string>();
  keys.forEach((entry, i) => {
    if (!isPlanePrivateKey(entry)) {
      throw new Error(
        `payload-seal: key file entry ${i} is not an X25519 private key entry: ${path}`,
      );
    }
    if (seen.has(entry.kid)) {
      throw new Error(
        `payload-seal: key file has a duplicate kid "${entry.kid}": ${path}`,
      );
    }
    seen.add(entry.kid);
    // Only the two fields travel on: a stray property in the file never does.
    out.push({ kid: entry.kid, privateKeyJwk: { ...entry.privateKeyJwk } });
  });
  return out;
}

/**
 * Boot self-check: seal a probe to each key's public half and unseal it with
 * the ring. Catches a corrupt/truncated private scalar or a mismatched `x`.
 * It CANNOT catch a key pair whose public half differs from www's
 * HATCHET_PAYLOAD_SEAL_KEY — that shows up as `unseal failed
 * (reason=unknown-kid|tag)` on the first sealed run and is reconciled by
 * sweep rule (iii); rollout step 3 compares the kids logged on both planes.
 * Returns the kids, in ring order, for the boot log.
 */
export async function assertPlaneKeysUsable(
  keys: readonly PlanePrivateKey[],
): Promise<string[]> {
  for (const key of keys) {
    const probe = {
      installationToken: "probe-installation",
      daemonToken: "probe-daemon",
    };
    let roundTrip: { installationToken: string; daemonToken: string };
    try {
      const sealed = await sealRunSecrets(
        publicKeyOf(key),
        probe,
        "boot-probe",
      );
      roundTrip = await unsealRunSecrets(keys, sealed, "boot-probe");
    } catch (err) {
      throw new Error(
        `payload-seal: boot probe failed for kid "${key.kid}" (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (
      roundTrip.installationToken !== probe.installationToken ||
      roundTrip.daemonToken !== probe.daemonToken
    ) {
      throw new Error(
        `payload-seal: boot probe round-trip mismatch for kid "${key.kid}"`,
      );
    }
  }
  return keys.map((k) => k.kid);
}

/** A throwaway ring for tests and the dev launcher; never written to disk here. */
export async function generateThrowawayRing(
  kid = "plane-dev",
): Promise<PlanePrivateKey[]> {
  return [(await generatePlaneKeyPair(kid)).privateKey];
}

let ring: { path: string; keys: PlanePrivateKey[] } | null = null;

/**
 * The ring every run unseals with: read ONCE per process from the configured
 * path (rotation restarts the worker by design — see the key script), `[]`
 * when the file is absent (rollout step 1). An unreadable or malformed file
 * throws here too, so a run never silently proceeds past a broken ring the
 * boot check somehow did not see.
 */
export function planeKeysForRun(path: string): PlanePrivateKey[] {
  if (ring && ring.path === path) return ring.keys;
  let keys: PlanePrivateKey[];
  try {
    keys = readPlaneKeyFile(path);
  } catch (err) {
    if (err instanceof PlaneKeyFileMissingError) {
      keys = [];
    } else {
      throw err;
    }
  }
  ring = { path, keys };
  return keys;
}

/** Tests only: forget the memoised ring. */
export function resetPlaneKeyRingForTests(): void {
  ring = null;
}

/**
 * Boot: load the ring from `path` and prove every key. Returns the kids
 * (empty when the file is absent and `required` is false). Throws — and the
 * caller refuses to start — when the file is present but unusable, or absent
 * while `required` (strict mode, rollout step 4).
 */
export async function loadPlaneKeysAtBoot({
  path,
  required,
}: {
  path: string;
  required: boolean;
}): Promise<{ kids: string[]; present: boolean }> {
  let keys: PlanePrivateKey[];
  try {
    keys = readPlaneKeyFile(path);
  } catch (err) {
    if (err instanceof PlaneKeyFileMissingError && !required) {
      ring = { path, keys: [] };
      return { kids: [], present: false };
    }
    throw err;
  }
  const kids = await assertPlaneKeysUsable(keys);
  ring = { path, keys };
  return { kids, present: true };
}
