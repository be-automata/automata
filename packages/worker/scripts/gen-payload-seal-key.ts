#!/usr/bin/env node
/**
 * Generate the execution plane's payload seal key pair (#380).
 *
 *   pnpm --filter @terragon/worker exec tsx scripts/gen-payload-seal-key.ts [options]
 *
 * Writes `{"keys":[PlanePrivateKey, ...]}` to the key file (default
 * /etc/automata/payload-seal.key, override with --file or
 * WORKER_PAYLOAD_SEAL_KEY_FILE), mode 0400, owned by the worker service user
 * (--owner, default: the `User=` of the installed automata-worker.service,
 * else the current user). Prints EXACTLY one line to stdout:
 *
 *   <kid>:<base64url raw X25519 public key>
 *
 * which is the value of www's HATCHET_PAYLOAD_SEAL_KEY. Nothing private is
 * ever printed.
 *
 * Rotation: the script refuses to overwrite an existing file unless --rotate
 * is passed, which ADDS the new key at the FRONT of `keys[]` and keeps the
 * old ones, so in-flight runs sealed to the old key still unseal. Retire an
 * old entry by hand only when BOTH hold: ≥24h have passed since www switched
 * to the new key, and no hatchetRun row dispatched before that switch belongs
 * to a thread that is not terminal. Then remove the entry and restart the
 * worker (the ring is read once per process).
 *
 * Dev: --dev writes to `.automata/payload-seal.dev.json` under the package
 * (gitignored), chowns nothing, and is a no-op when the file exists. Each
 * developer generates their own; dev keys are never shared.
 *
 * Options: --file <path> --kid <id> --owner <user> --rotate --dev --force-kid
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatPlanePublicKey,
  generatePlaneKeyPair,
  type PlanePrivateKey,
} from "@terragon/utils/payload-seal";

import {
  DEFAULT_PAYLOAD_SEAL_KEY_FILE,
  assertPlaneKeysUsable,
  readPlaneKeyFile,
} from "../src/agent-run/payload-seal-keys";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEV_FILE = path.join(packageRoot, ".automata", "payload-seal.dev.json");
const SERVICE_UNIT = "/etc/systemd/system/automata-worker.service";

function parseArgs(argv: string[]) {
  const opts = {
    file:
      process.env.WORKER_PAYLOAD_SEAL_KEY_FILE?.trim() ||
      DEFAULT_PAYLOAD_SEAL_KEY_FILE,
    kid: "",
    owner: "",
    rotate: false,
    dev: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--file") opts.file = next();
    else if (a === "--kid") opts.kid = next();
    else if (a === "--owner") opts.owner = next();
    else if (a === "--rotate") opts.rotate = true;
    else if (a === "--dev") opts.dev = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (opts.dev) opts.file = DEV_FILE;
  return opts;
}

/** `plane-YYYY-MM`, or `plane-YYYY-MM-<n>` when that kid is already in the ring. */
function defaultKid(existing: readonly PlanePrivateKey[]): string {
  const now = new Date();
  const base = `plane-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const taken = new Set(existing.map((k) => k.kid));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new Error("could not pick a free kid");
}

/** The `User=` of the installed unit, when there is one. */
function serviceUser(): string {
  try {
    const unit = readFileSync(SERVICE_UNIT, "utf8");
    const m = /^User=(.+)$/m.exec(unit);
    const user = m?.[1]?.trim() ?? "";
    return user && !user.startsWith("__") ? user : "";
  } catch {
    return "";
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dev && existsSync(opts.file)) {
    const existing = readPlaneKeyFile(opts.file);
    const head = existing[0];
    if (!head) throw new Error("dev key file is empty");
    process.stdout.write(
      `${formatPlanePublicKey({ kid: head.kid, publicKey: head.privateKeyJwk.x })}\n`,
    );
    return;
  }
  let existing: PlanePrivateKey[] = [];
  if (existsSync(opts.file)) {
    if (!opts.rotate) {
      throw new Error(
        `${opts.file} exists; pass --rotate to add a new key at the front of the ring`,
      );
    }
    existing = readPlaneKeyFile(opts.file);
  }
  const kid = opts.kid || defaultKid(existing);
  if (existing.some((k) => k.kid === kid)) {
    throw new Error(`kid "${kid}" is already in the ring`);
  }
  const { publicKey, privateKey } = await generatePlaneKeyPair(kid);
  const ring = [privateKey, ...existing];
  await assertPlaneKeysUsable(ring);

  mkdirSync(path.dirname(opts.file), { recursive: true, mode: 0o755 });
  // Write beside, chmod, then rename: the file is never world-readable, not
  // even for an instant, and a crash mid-write leaves the old ring intact.
  const tmp = `${opts.file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ keys: ring }, null, 2) + "\n", {
    mode: 0o400,
  });
  chmodSync(tmp, 0o400);
  const owner = opts.dev ? "" : opts.owner || serviceUser();
  if (owner) {
    execFileSync("chown", [`${owner}:${owner}`, tmp], { stdio: "inherit" });
  }
  renameSync(tmp, opts.file);
  process.stderr.write(
    `[gen-payload-seal-key] wrote ${opts.file} (${ring.length} key(s): ${ring.map((k) => k.kid).join(", ")}; owner ${owner || "unchanged"}; mode 0400)\n` +
      "[gen-payload-seal-key] set the line below as HATCHET_PAYLOAD_SEAL_KEY on automata-www, then restart the worker (no run in flight)\n",
  );
  process.stdout.write(`${formatPlanePublicKey(publicKey)}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `[gen-payload-seal-key] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
