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
import { mergeForegroundOnlySettings } from "./foreground-only-hook";

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
 *
 * TASK runs (Phase 7) reuse exactly the same verified-install fences with
 * `hooksOff: false`: the admin-selected packs are linked and hooks stay on, so
 * the repo's own hooks keep today's semantics for the task lane (its argv has
 * no `--setting-sources`, so the user layer in this HOME loads alongside the
 * project layer). With `foregroundOnly: true` the user-layer settings.json
 * also gets the foreground-only PreToolUse hooks (foreground-only-hook.ts),
 * merged over whatever is there; without it no settings.json is touched.
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
  /**
   * Write `disableAllHooks: true` into `<home>/.claude/settings.json`.
   * Default true = an orchestrated review. Task runs pass false: their hook
   * semantics must stay exactly as today, so no settings file is touched.
   */
  hooksOff?: boolean;
  /**
   * Only with `hooksOff: false` (task runs): merge the foreground-only
   * PreToolUse hooks into `<home>/.claude/settings.json` (0644), blocking
   * background Bash and Monitor in the headless session. Absent/false = no
   * settings file is touched (today's task-lane behaviour). Ignored when
   * hooksOff is on: a review run's settings stay exactly as before.
   */
  foregroundOnly?: boolean;
}

/** A seeded run's outcome (orchestrated review or task packs): verified packs, or why none. */
export type SeedBatteriesResult =
  | {
      ok: true;
      /** Pack ids that contributed at least one link, in MANIFEST order. */
      packs: string[];
      /** The verified manifest hash. */
      manifestHash: string;
      /**
       * Phase 7: the union of the contributing packs' manifest `requires`
       * (manifest order, deduped). Present ONLY when non-empty, so results
       * without a requirement keep their exact shape.
       */
      requires?: string[];
    }
  | { ok: false; reason: string };

/** this file: packages/worker/src/agent-run → up 2 = packages/worker → up 2 = repo. */
export function defaultRepoRoot(): string {
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

/**
 * The task gate's decision (task-agent.ts TaskAgentGate), as far as the
 * batteries line is concerned. `none` for every run that carried no taskAgent.
 */
export type BatteriesLineGate =
  | { kind: "none" }
  | { kind: "seed"; lane: "task" | "pr" }
  | { kind: "rejected"; lane: "task" | "pr" | "review" };

/**
 * One line for the run log; ids, reasons and a 12-hex hash prefix only.
 * Owns the form selection, so every run logs exactly one line:
 * - a task/pr-lane run whose taskAgent was rejected: `unavailable lane=…
 *   reason=task-agent-invalid` (nothing was seeded for it);
 * - a task/pr-lane run that carried packs: `lane=<lane>` replaces
 *   `mode=orchestrated`, and `undefined` means the packs were never seeded;
 * - every other run (reviews, runs without taskAgent, a review-lane taskAgent
 *   that was ignored): today's review forms, `undefined` being a classic run.
 */
export function formatBatteriesLine(
  result: SeedBatteriesResult | undefined,
  taskGate: BatteriesLineGate = { kind: "none" },
): string {
  if (taskGate.kind === "rejected" && taskGate.lane !== "review") {
    return `batteries: unavailable lane=${taskGate.lane} reason=task-agent-invalid`;
  }
  if (taskGate.kind === "seed") {
    const { lane } = taskGate;
    if (!result) {
      return `batteries: unavailable lane=${lane} reason=not-seeded`;
    }
    if (!result.ok) {
      return `batteries: unavailable lane=${lane} reason=${result.reason}`;
    }
    const packs = result.packs.length > 0 ? result.packs.join(",") : "none";
    return `batteries: lane=${lane} packs=${packs} manifest=${result.manifestHash.slice(0, 12)}`;
  }
  if (!result) {
    return "batteries: mode=classic";
  }
  if (!result.ok) {
    return `batteries: unavailable mode=orchestrated reason=${result.reason}`;
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

type Grant = (target: string, kind: "file" | "directory") => Promise<void>;

/** `<home>/.claude` at 0700, granted to the agent — both seeding modes. */
async function ensureClaudeDir(claudeDir: string, grant: Grant): Promise<void> {
  await fs.mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await grant(claudeDir, "directory");
}

/** `<claudeDir>/settings.json` as an object; `{}` when absent or unusable. */
async function readExistingSettings(
  settingsPath: string,
  log: (line: string) => void,
): Promise<Record<string, unknown>> {
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
  return existing;
}

async function writeHooksOffSettings(
  claudeDir: string,
  grant: Grant,
  log: (line: string) => void,
): Promise<void> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const existing = await readExistingSettings(settingsPath, log);
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

/**
 * Task runs: merge the foreground-only PreToolUse hooks (foreground-only-hook.ts)
 * into `<home>/.claude/settings.json`, 0644, then re-grant the agent.
 */
async function writeForegroundOnlySettings(
  claudeDir: string,
  grant: Grant,
  log: (line: string) => void,
): Promise<void> {
  const settingsPath = path.join(claudeDir, "settings.json");
  const existing = await readExistingSettings(settingsPath, log);
  await fs.writeFile(
    settingsPath,
    JSON.stringify(mergeForegroundOnlySettings(existing)),
    { mode: 0o644 },
  );
  // writeFile honours `mode` only on create; a retry keeps the old mode.
  await fs.chmod(settingsPath, 0o644);
  // chmod rewrites the Linux ACL mask; restore the agent's grant.
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

interface ParsedManifest {
  manifest: BatteriesManifest;
  /** The installer recipe recomputed over this checkout. */
  computedHash: string;
}

interface ManifestCacheEntry extends ParsedManifest {
  /** size/mtime of the manifest and every overlay, taken BEFORE reading them. */
  signature: string;
  overlayPaths: string[];
}

/**
 * Per process, keyed on manifestPath + repoRoot: the parsed manifest and its
 * recomputed hash. A hit needs an unchanged stat signature for the manifest
 * AND every overlay it hashes; the install's `manifest.sha256` is still
 * re-read and compared on every run.
 */
const manifestCache = new Map<string, ManifestCacheEntry>();

async function statSignature(paths: readonly string[]): Promise<string> {
  const stats = await Promise.all(paths.map((p) => fs.stat(p)));
  return stats.map((st) => `${st.size}:${st.mtimeMs}`).join("|");
}

async function loadManifest(
  manifestPath: string,
  repoRoot: string,
  log: (line: string) => void,
): Promise<ParsedManifest> {
  const key = `${manifestPath}\0${repoRoot}`;
  const cached = manifestCache.get(key);
  if (cached) {
    // A stat failure is a miss: the read path below reports it properly.
    const signature = await statSignature([
      manifestPath,
      ...cached.overlayPaths,
    ]).catch(() => undefined);
    if (signature === cached.signature) {
      return cached;
    }
  }

  let manifestSignature: string;
  let bytes: Buffer;
  let parsed: unknown;
  try {
    manifestSignature = await statSignature([manifestPath]);
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
  const overlayPaths = parsed.packs.flatMap((pack) =>
    (pack.overlays ?? []).map((o) => path.join(repoRoot, o.from)),
  );
  const overlaySignature = await statSignature(overlayPaths);
  const entry: ManifestCacheEntry = {
    manifest: parsed,
    computedHash: await computeBatteriesManifestHash(bytes, parsed, repoRoot),
    signature:
      overlayPaths.length > 0
        ? `${manifestSignature}|${overlaySignature}`
        : manifestSignature,
    overlayPaths,
  };
  manifestCache.set(key, entry);
  return entry;
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

  const { manifest, computedHash } = await loadManifest(
    manifestPath,
    repoRoot,
    log,
  );
  if (computedHash !== recordedHash) {
    throw new BatteriesUnavailable("manifest-drift");
  }
  return { manifest, manifestHash: computedHash };
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

interface LinkEntry {
  /** `skills/<name>` or `agents/<name>.md`, relative to `<home>/.claude`. */
  rel: string;
  target: string;
  packId: string;
}

interface PackWalk extends PackCheckContext {
  pack: BatteryPack;
  realPackDir: string;
  skills: LinkEntry[];
  agents: LinkEntry[];
  /** A top-level `skills`/`agents` that is not a directory. */
  notADirectory?: string;
}

/** Only `skills/<id>` directories and `agents/<id>.md` regular files link. */
function collectLinkEntry(
  walk: PackWalk,
  rel: string,
  name: string,
  st: LstatResult,
): void {
  if (rel === "" && (name === "skills" || name === "agents")) {
    if (!st.isDirectory()) walk.notADirectory ??= name;
    return;
  }
  const entry = {
    rel: `${rel}/${name}`,
    target: path.join(walk.realPackDir, rel, name),
    packId: walk.pack.id,
  };
  if (rel === "skills" && ID_OR_NAME.test(name) && st.isDirectory()) {
    walk.skills.push(entry);
  } else if (
    rel === "agents" &&
    name.endsWith(".md") &&
    ID_OR_NAME.test(name.slice(0, -3)) &&
    st.isFile()
  ) {
    walk.agents.push(entry);
  }
}

/**
 * Full lstat walk: the first reason the pack must be skipped, or undefined,
 * collecting the link entries on the way. A directory's entries are lstat'd
 * together, but reasons are still taken in readdir order and an lstat error
 * only surfaces once its entry is reached.
 */
async function walkPack(
  dir: string,
  rel: string,
  walk: PackWalk,
): Promise<string | undefined> {
  const names = await fs.readdir(dir);
  const stats = await Promise.allSettled(
    names.map((name) => walk.lstat(path.join(dir, name))),
  );
  for (const [i, name] of names.entries()) {
    const relPath = rel ? `${rel}/${name}` : name;
    if (relPath.split("/").some((seg) => FORBIDDEN_NAMES.includes(seg))) {
      return "forbidden-entry";
    }
    const settled = stats[i]!; // allSettled keeps one result per name
    if (settled.status === "rejected") {
      throw settled.reason;
    }
    const st = settled.value;
    if (st.isSymbolicLink()) return "symlink-in-pack";
    const owner = ownershipReason(st, walk.packOwnerUid);
    if (owner) return owner;
    collectLinkEntry(walk, rel, name, st);
    if (st.isDirectory()) {
      const nested = await walkPack(path.join(dir, name), relPath, walk);
      if (nested) return nested;
    }
  }
  return undefined;
}

const byRel = (a: LinkEntry, b: LinkEntry): number =>
  a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;

/** The pack's link entries (skills, then agents, each sorted), or a skip reason. */
async function checkPack(
  pack: BatteryPack,
  packDir: string,
  ctx: PackCheckContext,
): Promise<{ reason: string } | { entries: LinkEntry[] }> {
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
  const walk: PackWalk = { ...ctx, pack, realPackDir, skills: [], agents: [] };
  const reason = await walkPack(packDir, "", walk);
  if (reason) return { reason };
  if (walk.notADirectory) {
    // Listing a non-directory fails the whole seed (seed-error-ENOTDIR), as
    // reading it as a directory always has.
    throw Object.assign(
      new Error(`batteries: ${walk.notADirectory} is not a directory`),
      { code: "ENOTDIR" },
    );
  }
  return {
    entries: [...walk.skills.sort(byRel), ...walk.agents.sort(byRel)],
  };
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

/**
 * The foreground-only guard alone, for a non-review run that links no packs:
 * creates and grants `<home>/.claude` and merges the guard into its
 * settings.json. No battery resolution, so the run's `batteries:` line and
 * seed result stay exactly as before. Errors propagate (a real HOME fault).
 */
export async function seedForegroundOnly(
  home: string,
  opts: Pick<
    SeedBatteriesOptions,
    "agentUser" | "log" | "aclExec" | "platform"
  >,
): Promise<void> {
  const users = opts.agentUser ? [opts.agentUser] : [];
  const grant: Grant = (target, kind) =>
    reapplyPathGrant({
      target,
      kind,
      users,
      exec: opts.aclExec,
      platform: opts.platform,
    });
  const claudeDir = path.join(home, ".claude");
  await ensureClaudeDir(claudeDir, grant);
  await writeForegroundOnlySettings(claudeDir, grant, opts.log);
}

export async function seedBatteries(
  home: string,
  packIds: readonly string[],
  opts: SeedBatteriesOptions,
): Promise<SeedBatteriesResult> {
  const { log } = opts;
  const users = opts.agentUser ? [opts.agentUser] : [];
  const grant: Grant = (target, kind) =>
    reapplyPathGrant({
      target,
      kind,
      users,
      exec: opts.aclExec,
      platform: opts.platform,
    });
  const claudeDir = path.join(home, ".claude");

  // (1) HOME writes: errors propagate (a real fault, like the trust seed).
  // The dir is created and granted in both modes (the credential write in
  // agent-credentials.ts relies on that); only reviews write settings.json.
  await ensureClaudeDir(claudeDir, grant);
  if (opts.hooksOff !== false) {
    await writeHooksOffSettings(claudeDir, grant, log);
  } else if (opts.foregroundOnly === true) {
    await writeForegroundOnlySettings(claudeDir, grant, log);
  }

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
        pack,
        path.join(root, `${pack.id}@${pack.sha}`),
        ctx,
      );
      if ("reason" in checked) {
        log(`batteries: skip pack ${pack.id} reason=${checked.reason}`);
        continue;
      }
      for (const entry of checked.entries) {
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

    const contributedPacks = manifest.packs.filter((p) =>
      contributed.has(p.id),
    );
    const requires = [
      ...new Set(contributedPacks.flatMap((p) => p.requires ?? [])),
    ];
    return {
      ok: true,
      packs: contributedPacks.map((p) => p.id),
      manifestHash,
      ...(requires.length > 0 ? { requires } : {}),
    };
  } catch (e) {
    const reason =
      e instanceof BatteriesUnavailable
        ? e.reason
        : `seed-error-${errnoCode(e) ?? "unknown"}`;
    log(`batteries: unavailable reason=${reason}`);
    return { ok: false, reason };
  }
}
