import {
  isPlanePrivateKey,
  publicKeyOf,
  sealRunSecrets,
  unsealRunSecrets,
  type PlanePrivateKey,
} from "@terragon/utils/payload-seal";

import { GuardedFileError, readGuardedFile } from "./guarded-file";

/**
 * The execution plane's seal key ring (#380). `/etc/automata/payload-seal.key`
 * holds `{"keys":[PlanePrivateKey, ...]}`, newest first (rotation adds at the
 * front, see scripts/gen-payload-seal-key.ts). Owner = the worker service
 * user, mode 0400; never in git, never logged.
 *
 * Strict (rollout step 4, PR 2): the file is MANDATORY. It must exist, parse
 * and every key must pass the boot probe, or the worker refuses to start —
 * a worker without a usable ring would fail every run at its first step
 * (every input is sealed and plain-text inputs are refused).
 */

export const DEFAULT_PAYLOAD_SEAL_KEY_FILE = "/etc/automata/payload-seal.key";

/** A fixed binding for the boot probe — never a real run's. */
const BOOT_PROBE_BINDING = {
  threadId: "boot-probe",
  threadChatId: "boot-probe",
  daemonCallbackUrl: "https://boot.probe.invalid",
  repoFullName: "boot/probe",
  orgId: "boot-probe",
};

/** Thrown when the configured file does not exist (ENOENT). Fatal at boot, a refused run after. */
export class PlaneKeyFileMissingError extends Error {
  constructor(readonly path: string) {
    super(`payload-seal: key file not found: ${path}`);
    this.name = "PlaneKeyFileMissingError";
  }
}

/**
 * Read and validate the key file. Throws PlaneKeyFileMissingError on ENOENT,
 * and a plain Error (naming the path, never a key byte) on an unreadable
 * file, bad JSON, a wrong shape, an empty ring or a duplicate kid.
 */
export function readPlaneKeyFile(path: string): PlanePrivateKey[] {
  let text: string;
  try {
    // Guarded like the box's other secret file: no symlink, regular file,
    // size-capped — and OWNER-ONLY: a slot account that shares the service
    // user's group must never read the ring (a 0400 ring that became 0640
    // is refused, not silently used).
    text = readGuardedFile(path, { ownerOnly: true });
  } catch (err) {
    if (err instanceof GuardedFileError && err.code === "ENOENT") {
      throw new PlaneKeyFileMissingError(path);
    }
    throw new Error(
      `payload-seal: key file unreadable: ${err instanceof Error ? err.message : String(err)}`,
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
    // Only the four JWK members travel on: a hand-edited `key_ops`/`ext`/`alg`
    // in the file would otherwise reach importKey.
    const { kty, crv, x, d } = entry.privateKeyJwk;
    out.push({ kid: entry.kid, privateKeyJwk: { kty, crv, x, d } });
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
        BOOT_PROBE_BINDING,
      );
      roundTrip = await unsealRunSecrets(keys, sealed, BOOT_PROBE_BINDING);
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
  // Strict: a missing file throws (PlaneKeyFileMissingError) and the run is
  // refused, exactly like an unusable one — there is no plain-text fallback.
  const keys = readPlaneKeyFile(path);
  ring = { path, keys };
  return keys;
}

/** Tests only: forget the memoised ring. */
export function resetPlaneKeyRingForTests(): void {
  ring = null;
}

/**
 * Boot: load the ring from `path` and prove every key. Returns the kids.
 * Throws — and the caller refuses to start — when the file is missing,
 * unparseable, or holds a key that fails its own seal→unseal probe.
 */
export async function loadPlaneKeysAtBoot({
  path,
}: {
  path: string;
}): Promise<{ kids: string[] }> {
  const keys = readPlaneKeyFile(path);
  const kids = await assertPlaneKeysUsable(keys);
  ring = { path, keys };
  return { kids };
}
