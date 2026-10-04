import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reapplyPathGrant, type AceExec } from "./agent-uid-fs";
import {
  BATTERIES_MANIFEST_REPO_PATH,
  FORBIDDEN_NAMES,
  ID_OR_NAME,
  SHA256_HEX,
  findBatteriesManifestError,
  isBatteriesManifest,
  type BatteriesManifest,
  type BatteryPack,
} from "./batteries-manifest";

/**
 * Per-run seeding of the review batteries (Phase 5, D2).
 *
 * An ORCHESTRATED review run gets the selected packs' `skills/<name>` dirs and
 * `agents/<name>.md` files symlinked into its per-run HOME at the USER setting
 * layer — the only layer the CLI loads under `--setting-sources user`
 * (02-FINDINGS Q1/Q2), which also keeps the PR's own project `.claude/` out
 * (Q3). It also writes `disableAllHooks: true` into the per-run HOME settings,
 * because user-level SubagentStart/Stop hooks would otherwise fire per
 * sub-agent.
 *
 * Source of truth is the Phase 3 install (`install-batteries.sh`):
 * `<root>/<id>@<sha>/` per pack, root-owned, 0755/0644, plus
 * `<root>/manifest.sha256` — the sha256 of batteries.json followed by every
 * overlay file. The worker recomputes that hash over ITS OWN checkout and
 * refuses to link anything on a mismatch, so a box whose install lags the
 * deployed worker runs with no packs instead of the wrong ones.
 *
 * Failure policy: a HOME write failure (the settings file) throws, exactly
 * like the trust seed does. Every battery problem — missing install, drift,
 * a pack failing a fence — degrades to fewer or no packs and a log line; it
 * never fails the review.
 *
 * Nothing is ever copied: only links, the two link dirs and settings.json are
 * written under `<home>/.claude`. `fs.rm(home, {recursive})` removes a link
 * without following it, so HOME cleanup never touches the install.
 */

export const BATTERIES_ROOT_DEFAULT = "/usr/local/lib/automata-batteries";

type LstatResult = Pick<
  Stats,
  "uid" | "mode" | "isDirectory" | "isFile" | "isSymbolicLink"
>;

export interface SeedBatteriesOptions {
  /** Install root; default BATTERIES_ROOT_DEFAULT. */
  root?: string;
  /** Repo checkout the worker runs from; default derived from this file. */
  repoRoot?: string;
  /** batteries.json; default `<repoRoot>/${BATTERIES_MANIFEST_REPO_PATH}`. */
  manifestPath?: string;
  /** Required owner of ROOT; default 0 (root). */
  rootOwnerUid?: number;
  /** Required owner of every pack dir and entry; default 0 (root). */
  packOwnerUid?: number;
  /** Test seam for ownership; default fs.lstat. */
  lstat?: (p: string) => Promise<LstatResult>;
  /** Role account the agent runs as; empty/absent = no ACL grants. */
  agentUser?: string;
  log: (line: string) => void;
  aclExec?: AceExec;
  platform?: NodeJS.Platform;
}

export interface SeedBatteriesResult {
  mode: "orchestrated";
  /** Pack ids that contributed at least one link, in MANIFEST order. */
  packs: string[];
  /** The verified manifest hash; null when the install is unavailable. */
  manifestHash: string | null;
  unavailableReason?: string;
}

/** this file: packages/worker/src/agent-run → up 2 = packages/worker → up 2 = repo. */
function defaultRepoRoot(): string {
  const workerPkgRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return path.resolve(workerPkgRoot, "..", "..");
}

/**
 * The installer's `write_manifest_hash` recipe: sha256 over the manifest
 * bytes, then each `packs[].overlays[].from` file in manifest order.
 */
export async function computeBatteriesManifestHash(
  manifestBytes: Buffer,
  manifest: BatteriesManifest,
  repoRoot: string,
): Promise<string> {
  const hash = createHash("sha256").update(manifestBytes);
  for (const pack of manifest.packs) {
    for (const overlay of pack.overlays ?? []) {
      hash.update(await fs.readFile(path.join(repoRoot, overlay.from)));
    }
  }
  return hash.digest("hex");
}

/** One line for the run log; ids, reasons and a 12-hex hash prefix only. */
export function formatBatteriesLine(
  reviewAgent: { mode: "classic" | "orchestrated" } | undefined,
  result: SeedBatteriesResult | undefined,
): string {
  if (reviewAgent?.mode !== "orchestrated") {
    return "batteries: mode=classic";
  }
  if (!result) {
    return "batteries: unavailable mode=orchestrated reason=not-seeded";
  }
  if (result.unavailableReason !== undefined || result.manifestHash === null) {
    return `batteries: unavailable mode=orchestrated reason=${result.unavailableReason ?? "unknown"}`;
  }
  const packs = result.packs.length > 0 ? result.packs.join(",") : "none";
  return `batteries: mode=orchestrated packs=${packs} manifest=${result.manifestHash.slice(0, 12)}`;
}

class BatteriesUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`batteries unavailable: ${reason}`);
    this.name = "BatteriesUnavailable";
  }
}

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e
    ? String((e as NodeJS.ErrnoException).code)
    : undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return false;
    throw e;
  }
}

function isGroupOrOtherWritable(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

/** Ids reach the log; anything that is not a plain id is not echoed. */
function safeId(id: string): string {
  return ID_OR_NAME.test(id) ? id : "<invalid-id>";
}

async function writeHooksOffSettings(
  claudeDir: string,
  grant: (target: string, kind: "file" | "directory") => Promise<void>,
  log: (line: string) => void,
): Promise<void> {
  await fs.mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await grant(claudeDir, "directory");
  const settingsPath = path.join(claudeDir, "settings.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      existing = parsed as Record<string, unknown>;
    } else {
      log("batteries: replacing non-object settings.json");
    }
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") {
      if (!(e instanceof SyntaxError)) {
        throw e;
      }
      log("batteries: replacing unparseable settings.json");
    }
  }
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ ...existing, disableAllHooks: true }),
    { mode: 0o600 },
  );
  // writeFile honours `mode` only on create; a retry keeps the old mode.
  await fs.chmod(settingsPath, 0o600);
  // The 0600 above zeroes the Linux ACL mask; restore the agent's grant.
  await grant(settingsPath, "file");
}

async function checkRoot(
  root: string,
  lstat: (p: string) => Promise<LstatResult>,
  rootOwnerUid: number,
): Promise<string> {
  let st: LstatResult;
  try {
    st = await lstat(root);
  } catch {
    throw new BatteriesUnavailable("root-not-trusted");
  }
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.uid !== rootOwnerUid ||
    isGroupOrOtherWritable(st.mode)
  ) {
    throw new BatteriesUnavailable("root-not-trusted");
  }
  return fs.realpath(root);
}

async function readVerifiedManifest(
  root: string,
  manifestPath: string,
  repoRoot: string,
  log: (line: string) => void,
): Promise<{ manifest: BatteriesManifest; manifestHash: string }> {
  let recorded: string;
  try {
    recorded = await fs.readFile(path.join(root, "manifest.sha256"), "utf8");
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") {
      throw e;
    }
    throw new BatteriesUnavailable(
      (await pathExists(path.join(root, "manifest.sha256.invalid")))
        ? "manifest-invalidated"
        : "no-manifest-hash",
    );
  }
  const recordedHash = recorded.trim().split(/\s+/)[0] ?? "";
  if (!SHA256_HEX.test(recordedHash)) {
    throw new BatteriesUnavailable("manifest-hash-malformed");
  }

  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = await fs.readFile(manifestPath);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BatteriesUnavailable("manifest-invalid");
  }
  if (!isBatteriesManifest(parsed)) {
    log(
      `batteries: manifest rejected (${findBatteriesManifestError(parsed) ?? "unknown"})`,
    );
    throw new BatteriesUnavailable("manifest-invalid");
  }
  const computed = await computeBatteriesManifestHash(bytes, parsed, repoRoot);
  if (computed !== recordedHash) {
    throw new BatteriesUnavailable("manifest-drift");
  }
  return { manifest: parsed, manifestHash: computed };
}

interface PackCheckContext {
  realRoot: string;
  lstat: (p: string) => Promise<LstatResult>;
  packOwnerUid: number;
}

/** Owner / writability of one path; a reason or undefined. */
function ownershipReason(
  st: LstatResult,
  packOwnerUid: number,
): string | undefined {
  if (st.uid !== packOwnerUid) return "not-root-owned";
  if (isGroupOrOtherWritable(st.mode)) return "writable";
  return undefined;
}

/** Full lstat walk: a reason the pack must be skipped, or undefined. */
async function walkPack(
  dir: string,
  rel: string,
  ctx: PackCheckContext,
): Promise<string | undefined> {
  for (const name of await fs.readdir(dir)) {
    const relPath = rel ? `${rel}/${name}` : name;
    if (relPath.split("/").some((seg) => FORBIDDEN_NAMES.includes(seg))) {
      return "forbidden-entry";
    }
    const full = path.join(dir, name);
    const st = await ctx.lstat(full);
    if (st.isSymbolicLink()) return "symlink-in-pack";
    const owner = ownershipReason(st, ctx.packOwnerUid);
    if (owner) return owner;
    if (st.isDirectory()) {
      const nested = await walkPack(full, relPath, ctx);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function checkPack(
  packDir: string,
  ctx: PackCheckContext,
): Promise<{ reason?: string; realPackDir?: string }> {
  let st: LstatResult;
  try {
    st = await ctx.lstat(packDir);
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return { reason: "missing" };
    throw e;
  }
  if (st.isSymbolicLink()) return { reason: "escapes-root" };
  if (!st.isDirectory()) return { reason: "missing" };
  const owner = ownershipReason(st, ctx.packOwnerUid);
  if (owner) return { reason: owner };
  const realPackDir = await fs.realpath(packDir);
  if (!realPackDir.startsWith(ctx.realRoot + path.sep)) {
    return { reason: "escapes-root" };
  }
  const walked = await walkPack(packDir, "", ctx);
  if (walked) return { reason: walked };
  return { realPackDir };
}

interface LinkEntry {
  /** `skills/<name>` or `agents/<name>.md`, relative to `<home>/.claude`. */
  rel: string;
  target: string;
  packId: string;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return [];
    throw e;
  }
}

/** Only `skills/<id>` directories and `agents/<id>.md` regular files. */
async function collectEntries(
  pack: BatteryPack,
  realPackDir: string,
  lstat: (p: string) => Promise<LstatResult>,
): Promise<LinkEntry[]> {
  const entries: LinkEntry[] = [];
  for (const name of await listDir(path.join(realPackDir, "skills"))) {
    const full = path.join(realPackDir, "skills", name);
    if (ID_OR_NAME.test(name) && (await lstat(full)).isDirectory()) {
      entries.push({ rel: `skills/${name}`, target: full, packId: pack.id });
    }
  }
  for (const name of await listDir(path.join(realPackDir, "agents"))) {
    const full = path.join(realPackDir, "agents", name);
    const base = name.endsWith(".md") ? name.slice(0, -3) : "";
    if (ID_OR_NAME.test(base) && (await lstat(full)).isFile()) {
      entries.push({ rel: `agents/${name}`, target: full, packId: pack.id });
    }
  }
  return entries;
}

/** Replace an existing link; leave anything else alone. Returns whether linked. */
async function placeLink(
  claudeDir: string,
  entry: LinkEntry,
  log: (line: string) => void,
): Promise<boolean> {
  const link = path.join(claudeDir, entry.rel);
  try {
    const existing = await fs.lstat(link);
    if (!existing.isSymbolicLink()) {
      log(`batteries: keep existing ${entry.rel} (not a link)`);
      return false;
    }
    await fs.unlink(link);
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") throw e;
  }
  await fs.symlink(entry.target, link);
  return true;
}

export async function seedBatteries(
  home: string,
  packIds: readonly string[],
  opts: SeedBatteriesOptions,
): Promise<SeedBatteriesResult> {
  const { log } = opts;
  const users = opts.agentUser ? [opts.agentUser] : [];
  const grant = (target: string, kind: "file" | "directory") =>
    reapplyPathGrant({
      target,
      kind,
      users,
      exec: opts.aclExec,
      platform: opts.platform,
    });
  const claudeDir = path.join(home, ".claude");

  // (1) HOME writes: errors propagate (a real fault, like the trust seed).
  await writeHooksOffSettings(claudeDir, grant, log);

  // (2..8) Battery resolution: every failure degrades, nothing throws.
  try {
    const lstat = opts.lstat ?? fs.lstat;
    const root = opts.root ?? BATTERIES_ROOT_DEFAULT;
    const repoRoot = opts.repoRoot ?? defaultRepoRoot();
    const manifestPath =
      opts.manifestPath ?? path.join(repoRoot, BATTERIES_MANIFEST_REPO_PATH);

    const realRoot = await checkRoot(root, lstat, opts.rootOwnerUid ?? 0);
    const { manifest, manifestHash } = await readVerifiedManifest(
      root,
      manifestPath,
      repoRoot,
      log,
    );

    const known = new Set(manifest.packs.map((p) => p.id));
    for (const id of packIds) {
      if (!known.has(id)) {
        log(`batteries: skip pack ${safeId(id)} reason=unknown-id`);
      }
    }
    const selected = manifest.packs.filter((p) => packIds.includes(p.id));

    const ctx: PackCheckContext = {
      realRoot,
      lstat,
      packOwnerUid: opts.packOwnerUid ?? 0,
    };
    const winners = new Map<string, LinkEntry>();
    for (const pack of selected) {
      const checked = await checkPack(
        path.join(root, `${pack.id}@${pack.sha}`),
        ctx,
      );
      if (checked.reason || !checked.realPackDir) {
        log(
          `batteries: skip pack ${pack.id} reason=${checked.reason ?? "missing"}`,
        );
        continue;
      }
      for (const entry of await collectEntries(
        pack,
        checked.realPackDir,
        lstat,
      )) {
        const first = winners.get(entry.rel);
        if (first) {
          log(
            `batteries: drop ${entry.rel} from ${pack.id} (already provided by ${first.packId})`,
          );
          continue;
        }
        winners.set(entry.rel, entry);
      }
    }

    const contributed = new Set<string>();
    for (const kind of ["skills", "agents"] as const) {
      const entries = [...winners.values()].filter((e) =>
        e.rel.startsWith(`${kind}/`),
      );
      if (entries.length === 0) continue;
      const dir = path.join(claudeDir, kind);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await grant(dir, "directory");
      for (const entry of entries) {
        if (await placeLink(claudeDir, entry, log)) {
          contributed.add(entry.packId);
        }
      }
    }

    return {
      mode: "orchestrated",
      packs: manifest.packs
        .map((p) => p.id)
        .filter((id) => contributed.has(id)),
      manifestHash,
      unavailableReason: undefined,
    };
  } catch (e) {
    const reason =
      e instanceof BatteriesUnavailable
        ? e.reason
        : `seed-error-${errnoCode(e) ?? "unknown"}`;
    log(`batteries: unavailable reason=${reason}`);
    return {
      mode: "orchestrated",
      packs: [],
      manifestHash: null,
      unavailableReason: reason,
    };
  }
}
