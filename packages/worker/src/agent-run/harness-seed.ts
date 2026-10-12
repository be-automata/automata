import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { ID_OR_NAME, SHA256_HEX } from "./batteries-manifest";
import {
  HARNESS_CLAUDE_DIR,
  HARNESS_HASH_FILE,
  HARNESS_HASH_INVALID_FILE,
  HARNESS_LINK_DIRS,
  HARNESS_MCP_TOOLS_FILE,
  HARNESS_SHARED_DIRS,
  HARNESS_STAMP_FILE,
  computeHarnessManifestHash,
  harnessPackDirName,
  harnessPackPin,
  parseHarnessStamp,
  resolvePackDirTemplate,
} from "./harness-layout";
import {
  HARNESS_ENV_KEY,
  HARNESS_MANIFEST_REPO_PATH,
  HARNESS_PACK_IDS,
  MCP_TOOL,
  findHarnessManifestError,
  isHarnessManifest,
  validateHarnessPackTree,
  type HarnessManifest,
  type HarnessPack,
} from "./harness-manifest";

/**
 * Per-run resolution of the HARNESS packs (gstack, GSD, ruflo) for a task or
 * PR run: which of the requested packs are installed, verified and safe to
 * link, and what each contributes — link entries for the run HOME, env, MCP
 * servers. seedBatteries owns the review-lane fence and the HOME writes; this
 * module only reads the install.
 *
 * Preflight, in order; any failure degrades to "no harness packs" (never a
 * failed run) while the review/somnio packs still seed:
 * 1. `<root>/harness.sha256` matches the hash recomputed over THIS checkout's
 *    harness.json (a harness install that lags the deployed worker seeds
 *    nothing rather than the wrong thing);
 * 2. per pack: root-owned, not writable, inside the root; a `.stamp` whose
 *    `node <major>` line AND this process's Node major both equal the
 *    manifest `nodeMajor` (a native module built for another ABI crashes at
 *    load, inside the agent's run, where nobody reads it);
 * 3. per pack: validateHarnessPackTree (symlink containment, discarded
 *    upstream config, frontmatter grants) — once per process per stamp, it
 *    walks node_modules;
 * 4. per pack: every `claude/` entry root-owned and not writable, every
 *    MCP wrapper a root-owned regular file, and every `pathDirs` entry a
 *    root-owned, non-writable real directory (it goes on the agent's PATH).
 *
 * Nothing here ever reads a secret, and the MCP entries carry no env: the
 * wrapper inside the pack owns its server's environment.
 */

type LstatResult = Pick<
  Stats,
  "uid" | "mode" | "isDirectory" | "isFile" | "isSymbolicLink"
>;

/** One link a harness pack contributes: `<home>/.claude/<rel>` → `target`. */
export interface HarnessLinkEntry {
  rel: string;
  target: string;
  packId: string;
}

/** A requested harness pack that passed every check. */
export interface VerifiedHarnessPack {
  id: string;
  pin: string;
  /** The real pack dir: what {{packDir}} resolves to. */
  packDir: string;
  /** Manifest env with {{packDir}} resolved; keys match HARNESS_ENV_KEY. */
  env: Record<string, string>;
  /** Manifest pathDirs with {{packDir}} resolved: prepended to the agent's PATH. */
  pathDirs: string[];
  /** Manifest MCP servers with {{packDir}} resolved; no env, ever. */
  mcpServers: Record<string, { command: string; args: string[] }>;
  /** MCP tools a server registers beyond the allowlist (mcp-tools.json); best-effort deny. */
  denyTools: string[];
  headlessSafe: string[];
  entries: HarnessLinkEntry[];
}

export type HarnessResolution =
  | { ok: true; harnessHash: string; packs: VerifiedHarnessPack[] }
  | { ok: false; reason: string };

export interface ResolveHarnessOptions {
  /** The install root as configured (harness.sha256 and pack dirs live here). */
  root: string;
  /** realpath(root), already ownership-checked by the caller. */
  realRoot: string;
  repoRoot: string;
  /** harness.json; default `<repoRoot>/${HARNESS_MANIFEST_REPO_PATH}`. */
  manifestPath?: string;
  lstat: (p: string) => Promise<LstatResult>;
  packOwnerUid: number;
  /** The Node major the agent runs on; default this process's. */
  nodeMajor?: number;
  log: (line: string) => void;
}

const HARNESS_IDS: readonly string[] = HARNESS_PACK_IDS;

export function isHarnessPackId(id: string): boolean {
  return HARNESS_IDS.includes(id);
}

/** An `agents/` or `commands/` entry name: no leading dot, no separators. */
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class HarnessUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`harness unavailable: ${reason}`);
    this.name = "HarnessUnavailable";
  }
}

class PackSkip extends Error {
  constructor(readonly reason: string) {
    super(`harness pack skipped: ${reason}`);
    this.name = "PackSkip";
  }
}

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e
    ? String((e as NodeJS.ErrnoException).code)
    : undefined;
}

function ownershipReason(
  st: LstatResult,
  packOwnerUid: number,
): string | undefined {
  if (st.uid !== packOwnerUid) return "not-root-owned";
  if ((st.mode & 0o022) !== 0) return "writable";
  return undefined;
}

function runtimeNodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

async function readVerifiedHarnessManifest(
  root: string,
  manifestPath: string,
  repoRoot: string,
  log: (line: string) => void,
): Promise<{ manifest: HarnessManifest; harnessHash: string }> {
  let recorded: string;
  try {
    recorded = await fs.readFile(path.join(root, HARNESS_HASH_FILE), "utf8");
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") throw e;
    const invalidated = await fs
      .lstat(path.join(root, HARNESS_HASH_INVALID_FILE))
      .then(
        () => true,
        () => false,
      );
    throw new HarnessUnavailable(
      invalidated ? "harness-invalidated" : "no-harness-hash",
    );
  }
  const recordedHash = recorded.trim().split(/\s+/)[0] ?? "";
  if (!SHA256_HEX.test(recordedHash)) {
    throw new HarnessUnavailable("harness-hash-malformed");
  }
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = await fs.readFile(manifestPath);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HarnessUnavailable("harness-manifest-invalid");
  }
  if (!isHarnessManifest(parsed)) {
    log(
      `batteries: harness manifest rejected (${findHarnessManifestError(parsed) ?? "unknown"})`,
    );
    throw new HarnessUnavailable("harness-manifest-invalid");
  }
  const harnessHash = await computeHarnessManifestHash(bytes, parsed, repoRoot);
  if (harnessHash !== recordedHash) {
    throw new HarnessUnavailable("harness-drift");
  }
  return { manifest: parsed, harnessHash };
}

/**
 * The whole-tree verdict per process, keyed on the pack's real dir and its
 * stamp: a reinstall writes a new stamp and is re-checked. Caching is sound
 * because the tree is root-owned under a root-owned, non-writable pack dir
 * (re-checked every run): only root can change it, and root reinstalls.
 */
const treeCache = new Map<string, string | null>();

/** validateHarnessPackTree, then the `claude/` ownership walk: a skip reason or null. */
async function treeReason(
  pack: HarnessPack,
  realPackDir: string,
  stamp: string,
  ctx: Pick<PackCheckContext, "lstat" | "packOwnerUid">,
): Promise<string | null> {
  const key = `${realPackDir}\0${stamp}`;
  const cached = treeCache.get(key);
  if (cached !== undefined) return cached;
  const { errors } = validateHarnessPackTree(realPackDir, {
    frontmatterHookSkills: pack.frontmatterHookSkills,
  });
  let reason: string | null = errors.length > 0 ? "tree-invalid" : null;
  const claudeDir = path.join(realPackDir, HARNESS_CLAUDE_DIR);
  if (reason === null && (await readDirIfPresent(claudeDir)) !== undefined) {
    try {
      await checkClaudeTree(claudeDir, ctx.lstat, ctx.packOwnerUid);
    } catch (e) {
      if (!(e instanceof PackSkip)) throw e;
      reason = e.reason;
    }
  }
  treeCache.set(key, reason);
  return reason;
}

/** lstat walk of `<pack>/claude`: ownership of every entry, never following a link. */
async function checkClaudeTree(
  dir: string,
  lstat: (p: string) => Promise<LstatResult>,
  packOwnerUid: number,
): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    const full = path.join(dir, name);
    const st = await lstat(full);
    // A symlink's own mode is meaningless and on Linux always 0777: only its
    // owner counts. Its target is an in-pack entry this walk (or
    // validateHarnessPackTree's containment check) covers on its own.
    const owner = st.isSymbolicLink()
      ? st.uid === packOwnerUid
        ? undefined
        : "not-root-owned"
      : ownershipReason(st, packOwnerUid);
    if (owner) throw new PackSkip(owner);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      await checkClaudeTree(full, lstat, packOwnerUid);
    }
  }
}

/** What `p` is once in-pack symlinks are followed: a dir, a file, or neither. */
async function resolvedKind(
  p: string,
  realPackDir: string,
): Promise<"directory" | "file" | undefined> {
  let real: string;
  try {
    real = await fs.realpath(p);
  } catch {
    throw new PackSkip("dangling-symlink");
  }
  if (!real.startsWith(realPackDir + path.sep)) {
    throw new PackSkip("symlink-escapes-pack");
  }
  const st = await fs.stat(real);
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "file";
  return undefined;
}

async function readDirIfPresent(dir: string): Promise<string[] | undefined> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (e) {
    if (errnoCode(e) === "ENOENT" || errnoCode(e) === "ENOTDIR") {
      return undefined;
    }
    throw e;
  }
}

/** The pack's link entries: skills dirs, agents/commands entries, shared dirs. */
async function collectEntries(
  pack: HarnessPack,
  realPackDir: string,
): Promise<HarnessLinkEntry[]> {
  const claudeDir = path.join(realPackDir, HARNESS_CLAUDE_DIR);
  const entries: HarnessLinkEntry[] = [];
  const add = (rel: string) =>
    entries.push({
      rel,
      target: path.join(claudeDir, rel),
      packId: pack.id,
    });
  for (const kind of HARNESS_LINK_DIRS) {
    for (const name of (await readDirIfPresent(path.join(claudeDir, kind))) ??
      []) {
      const resolved = await resolvedKind(
        path.join(claudeDir, kind, name),
        realPackDir,
      );
      if (kind === "skills") {
        if (ID_OR_NAME.test(name) && resolved === "directory") {
          add(`${kind}/${name}`);
        }
      } else if (ENTRY_NAME.test(name) && resolved !== undefined) {
        add(`${kind}/${name}`);
      }
    }
  }
  for (const dir of HARNESS_SHARED_DIRS[pack.id] ?? []) {
    const full = path.join(claudeDir, dir);
    const present = await fs.lstat(full).then(
      () => true,
      (e: unknown) => {
        if (errnoCode(e) === "ENOENT") return false;
        throw e;
      },
    );
    if (present && (await resolvedKind(full, realPackDir)) === "directory") {
      add(dir);
    }
  }
  return entries;
}

/** The unfiltered server's tool names beyond the allowlist; [] without a catalog. */
async function readDenyTools(
  realPackDir: string,
  allowlist: readonly string[],
): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await fs.readFile(path.join(realPackDir, HARNESS_MCP_TOOLS_FILE), "utf8"),
    );
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return [];
    throw new PackSkip("mcp-tools-invalid");
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((t) => typeof t === "string" && MCP_TOOL.test(t))
  ) {
    throw new PackSkip("mcp-tools-invalid");
  }
  return [...new Set(parsed as string[])]
    .filter((t) => !allowlist.includes(t))
    .sort();
}

interface PackCheckContext {
  root: string;
  realRoot: string;
  lstat: (p: string) => Promise<LstatResult>;
  packOwnerUid: number;
  nodeMajor: number;
}

async function checkHarnessPack(
  pack: HarnessPack,
  ctx: PackCheckContext,
): Promise<VerifiedHarnessPack> {
  const packDir = path.join(ctx.root, harnessPackDirName(pack));
  let st: LstatResult;
  try {
    st = await ctx.lstat(packDir);
  } catch (e) {
    if (errnoCode(e) === "ENOENT") throw new PackSkip("missing");
    throw e;
  }
  if (st.isSymbolicLink()) throw new PackSkip("escapes-root");
  if (!st.isDirectory()) throw new PackSkip("missing");
  const owner = ownershipReason(st, ctx.packOwnerUid);
  if (owner) throw new PackSkip(owner);
  const realPackDir = await fs.realpath(packDir);
  if (!realPackDir.startsWith(ctx.realRoot + path.sep)) {
    throw new PackSkip("escapes-root");
  }

  let stampText: string;
  try {
    stampText = await fs.readFile(
      path.join(realPackDir, HARNESS_STAMP_FILE),
      "utf8",
    );
  } catch (e) {
    if (errnoCode(e) === "ENOENT") throw new PackSkip("no-stamp");
    throw e;
  }
  const stamp = parseHarnessStamp(stampText);
  if (!stamp) throw new PackSkip("stamp-malformed");
  if (stamp.nodeMajor !== pack.nodeMajor) {
    throw new PackSkip("node-abi-mismatch");
  }
  if (ctx.nodeMajor !== pack.nodeMajor) throw new PackSkip("node-mismatch");

  const tree = await treeReason(pack, realPackDir, stamp.stamp, ctx);
  if (tree !== null) throw new PackSkip(tree);

  const mcpServers: VerifiedHarnessPack["mcpServers"] = {};
  for (const [name, server] of Object.entries(pack.mcpServers ?? {})) {
    const command = resolvePackDirTemplate(server.command, realPackDir);
    let wrapper: LstatResult;
    try {
      wrapper = await ctx.lstat(command);
    } catch (e) {
      if (errnoCode(e) === "ENOENT") throw new PackSkip("mcp-wrapper-missing");
      throw e;
    }
    if (!wrapper.isFile()) throw new PackSkip("mcp-wrapper-missing");
    const wrapperOwner = ownershipReason(wrapper, ctx.packOwnerUid);
    if (wrapperOwner) throw new PackSkip(wrapperOwner);
    mcpServers[name] = { command, args: [...server.args] };
  }

  const pathDirs: string[] = [];
  for (const dir of pack.pathDirs ?? []) {
    const resolved = resolvePackDirTemplate(dir, realPackDir);
    let dirStat: LstatResult;
    try {
      dirStat = await ctx.lstat(resolved);
    } catch (e) {
      if (errnoCode(e) === "ENOENT") throw new PackSkip("path-dir-missing");
      throw e;
    }
    // A link would put whatever it names on the agent's PATH.
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new PackSkip("path-dir-missing");
    }
    const dirOwner = ownershipReason(dirStat, ctx.packOwnerUid);
    if (dirOwner) throw new PackSkip(dirOwner);
    pathDirs.push(resolved);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(pack.env)) {
    if (HARNESS_ENV_KEY.test(key)) {
      env[key] = resolvePackDirTemplate(value, realPackDir);
    }
  }
  return {
    id: pack.id,
    pin: harnessPackPin(pack),
    packDir: realPackDir,
    env,
    pathDirs,
    mcpServers,
    denyTools:
      pack.mcpServers !== undefined
        ? await readDenyTools(realPackDir, pack.toolAllowlist ?? [])
        : [],
    headlessSafe: [...pack.headlessSafe],
    entries: await collectEntries(pack, realPackDir),
  };
}

/**
 * The requested harness packs (`ids`, already filtered to harness ids) that
 * pass every check, in MANIFEST order. Never throws: a failure of the whole
 * install is `{ ok: false }`, a failing pack is logged and omitted.
 */
export async function resolveHarnessPacks(
  ids: readonly string[],
  opts: ResolveHarnessOptions,
): Promise<HarnessResolution> {
  const { log } = opts;
  try {
    const { manifest, harnessHash } = await readVerifiedHarnessManifest(
      opts.root,
      opts.manifestPath ?? path.join(opts.repoRoot, HARNESS_MANIFEST_REPO_PATH),
      opts.repoRoot,
      log,
    );
    const ctx: PackCheckContext = {
      root: opts.root,
      realRoot: opts.realRoot,
      lstat: opts.lstat,
      packOwnerUid: opts.packOwnerUid,
      nodeMajor: opts.nodeMajor ?? runtimeNodeMajor(),
    };
    const packs: VerifiedHarnessPack[] = [];
    for (const pack of manifest.packs.filter((p) => ids.includes(p.id))) {
      try {
        packs.push(await checkHarnessPack(pack, ctx));
      } catch (e) {
        const reason =
          e instanceof PackSkip
            ? e.reason
            : `seed-error-${errnoCode(e) ?? "unknown"}`;
        log(`batteries: skip pack ${pack.id} reason=${reason}`);
      }
    }
    return { ok: true, harnessHash, packs };
  } catch (e) {
    const reason =
      e instanceof HarnessUnavailable
        ? e.reason
        : `seed-error-${errnoCode(e) ?? "unknown"}`;
    log(`batteries: harness unavailable reason=${reason}`);
    return { ok: false, reason };
  }
}

/** A seeded harness pack as the run reports it: verified, with what it linked. */
export interface SeededHarnessPack
  extends Omit<VerifiedHarnessPack, "entries"> {
  /** `<home>/.claude` rels this pack's links won (first-wins across packs). */
  linked: string[];
}

/** The harness half of a seed: present only when harness ids were requested. */
export type HarnessSeedResult =
  | { ok: true; harnessHash: string; packs: SeededHarnessPack[] }
  | { ok: false; reason: string };

/** Battery state the run's tools write into the checkout; kept out of the PR. */
export const HARNESS_GIT_EXCLUDES: readonly string[] = [
  ".gstack/",
  ".claude-flow/",
  ".swarm/",
];

/** `$HOME/.gstack/config.yaml`: no telemetry, no update nag in a headless run. */
export const GSTACK_RUN_CONFIG = "telemetry: off\nupdate_check: false\n";

/** `$HOME/.automata/batteries.json`, relative to HOME. */
export const BATTERIES_BREADCRUMB_PATH = ".automata/batteries.json";

type Grant = (target: string, kind: "file" | "directory") => Promise<void>;

/** The seeded packs (empty for an unavailable harness or none requested). */
export function seededHarnessPacks(
  harness: HarnessSeedResult | undefined,
): SeededHarnessPack[] {
  return harness?.ok ? harness.packs : [];
}

/**
 * The breadcrumb an automation prompt (and a human on the box) reads to see
 * what this run actually got. Ids, pins, names and hashes only.
 */
export function harnessBreadcrumb(
  harness: HarnessSeedResult,
): Record<string, unknown> {
  if (!harness.ok) {
    return { schemaVersion: 1, harness: { ok: false, reason: harness.reason } };
  }
  return {
    schemaVersion: 1,
    harness: {
      ok: true,
      hash: harness.harnessHash,
      packs: harness.packs.map((p) => ({
        id: p.id,
        pin: p.pin,
        linked: p.linked,
        headlessSafe: p.headlessSafe,
        mcpServers: Object.keys(p.mcpServers),
      })),
    },
  };
}

async function writeHomeFile(
  file: string,
  contents: string,
  grant: Grant,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await grant(path.dirname(file), "directory");
  await fs.writeFile(file, contents, { mode: 0o644 });
  // writeFile honours `mode` only on create; a retry keeps the old mode.
  await fs.chmod(file, 0o644);
  // chmod rewrites the Linux ACL mask; restore the agent's grant.
  await grant(file, "file");
}

/**
 * HOME writes for a non-review run that asked for harness packs: the
 * breadcrumb always (it says why when nothing seeded), gstack's per-run
 * config when gstack seeded. Errors propagate: a HOME write fault is real.
 */
export async function writeHarnessHomeFiles(
  home: string,
  harness: HarnessSeedResult,
  grant: Grant,
): Promise<void> {
  if (seededHarnessPacks(harness).some((p) => p.id === "gstack")) {
    await writeHomeFile(
      path.join(home, ".gstack", "config.yaml"),
      GSTACK_RUN_CONFIG,
      grant,
    );
  }
  await writeHomeFile(
    path.join(home, BATTERIES_BREADCRUMB_PATH),
    `${JSON.stringify(harnessBreadcrumb(harness), null, 2)}\n`,
    grant,
  );
}

/**
 * Append HARNESS_GIT_EXCLUDES to `<repo>/.git/info/exclude` (each once), so
 * gstack/ruflo state never reaches a commit. `.planning/` is deliberately NOT
 * excluded: GSD plans ship in the PR. A checkout without a `.git` dir (a
 * worktree's `.git` file) is left alone.
 */
export async function excludeHarnessState(
  repo: string,
  grant: Grant,
): Promise<void> {
  const gitDir = path.join(repo, ".git");
  const st = await fs.lstat(gitDir).catch(() => undefined);
  if (!st?.isDirectory()) return;
  const infoDir = path.join(gitDir, "info");
  const exclude = path.join(infoDir, "exclude");
  await fs.mkdir(infoDir, { recursive: true });
  let current = "";
  try {
    current = await fs.readFile(exclude, "utf8");
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") throw e;
  }
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = HARNESS_GIT_EXCLUDES.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await fs.appendFile(exclude, `${separator}${missing.join("\n")}\n`);
  await grant(exclude, "file");
}

/**
 * `.claude.json` mcpServers for the seeded packs: stdio, the pack's own
 * wrapper, and no env (the wrapper owns it; a secret never lands here).
 */
export function harnessMcpServers(
  harness: HarnessSeedResult | undefined,
): Record<string, { type: "stdio"; command: string; args: string[] }> {
  const servers: Record<
    string,
    { type: "stdio"; command: string; args: string[] }
  > = {};
  for (const pack of seededHarnessPacks(harness)) {
    for (const [name, server] of Object.entries(pack.mcpServers)) {
      servers[name] ??= {
        type: "stdio",
        command: server.command,
        args: [...server.args],
      };
    }
  }
  return servers;
}

/**
 * `permissions.deny` entries for MCP tools a seeded server registers beyond
 * its allowlist. BEST-EFFORT ONLY: task runs pass
 * --dangerously-skip-permissions (packages/daemon/src/claude.ts), which skips
 * permission rules; the real fence is the pack's wrapper, which filters the
 * server's tool list down to the allowlist.
 */
export function harnessDenyRules(
  harness: HarnessSeedResult | undefined,
): string[] {
  return seededHarnessPacks(harness).flatMap((pack) =>
    Object.keys(pack.mcpServers).flatMap((server) =>
      pack.denyTools.map((tool) => `mcp__${server}__${tool}`),
    ),
  );
}

/** The agent env the seeded packs contribute (daemon-env applies it after repoEnv). */
export function harnessRunEnv(harness: HarnessSeedResult | undefined): {
  env: Record<string, string>;
  /** The seeded packs' PATH dirs, in manifest order (daemon-env prepends them). */
  pathDirs: string[];
  /** gstack seeded: browse's Chromium must be pointed at the run proxy. */
  browseProxy: boolean;
} {
  const packs = seededHarnessPacks(harness);
  return {
    env: Object.assign({}, ...packs.map((p) => p.env)) as Record<
      string,
      string
    >,
    pathDirs: packs.flatMap((p) => p.pathDirs),
    browseProxy: packs.some((p) => p.id === "gstack"),
  };
}
