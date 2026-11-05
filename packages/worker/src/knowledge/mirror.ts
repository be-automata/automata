import fs from "node:fs/promises";
import path from "node:path";

import { withBoxLock } from "../agent-run/box-lock";
import { gitExec } from "../agent-run/provision";
import { hermeticEnv, runMirrorGit, tokenEnv } from "./hermetic-git";
import {
  normalizeRepoFullName,
  orgMirrorDirs,
  type MirrorConfig,
  type MirrorPaths,
} from "./mirror-paths";

/** Closed set; 13-07 maps these onto the wire's ReconcileWorkerErrorCode. */
export type MirrorErrorCode =
  | "disk_low"
  | "mirror_over_cap"
  | "mirror_corrupt"
  | "fetch_failed"
  | "snapshot_failed"
  | "repo_access_lost";

export class MirrorError extends Error {
  readonly code: MirrorErrorCode;
  constructor(code: MirrorErrorCode, message: string) {
    super(message);
    this.name = "MirrorError";
    this.code = code;
  }
}

const TOMBSTONE = ".tombstone-";
const SNAPSHOT_PREFIX = "snap-";
const MAX_SNAPSHOT_FILES = 5000;
const ALLOWED_CONFIG_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "remote.origin.url",
  "remote.origin.fetch",
]);

export type StatFs = (
  p: string,
) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

const defaultStatfs: StatFs = (p) => fs.statfs(p);

async function freeBytes(statfs: StatFs, p: string): Promise<number> {
  const s = await statfs(p);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Rename a path out of the way, then reap the tombstone. Only ever called on a
 * mirror, an org dir or a unique snapshot dir this module created: never a
 * live shared path, and a symlink is unlinked rather than followed.
 */
async function tombstoneAndReap(target: string): Promise<void> {
  const st = await fs.lstat(target).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink()) {
    await fs.unlink(target);
    return;
  }
  const tomb = `${target}${TOMBSTONE}${Date.now()}`;
  try {
    await fs.rename(target, tomb);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return;
    throw error;
  }
  // A tombstone a live escapee still holds stays behind for the next sweep.
  await fs.rm(tomb, { recursive: true, force: true }).catch(() => {});
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

/** Serialize work on one repo's mirror; a different repo has a different lock. */
export async function withRepoLock<T>(
  paths: MirrorPaths,
  holder: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureDir(paths.tenantDir);
  await ensureDir(paths.orgDir);
  await ensureDir(paths.lockRoot);
  return withBoxLock(
    { root: paths.lockRoot, holder, signal: AbortSignal.timeout(5 * 60_000) },
    fn,
  );
}

export type VerifyReason =
  | "not_bare"
  | "config_unreadable"
  | "config_key_not_allowed"
  | "url_credentials"
  | "refspec_mismatch"
  | "alternates"
  | "shallow"
  | "hooks_present";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyReason };

async function exists(p: string): Promise<boolean> {
  return fs
    .lstat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * The config is parsed by the real git (`config --file --list --null`), so
 * formatting cannot cause a false failure; includes are NOT followed, so an
 * `include.path` shows up as a key and fails the allowlist.
 */
export async function verifyMirror(
  bare: string,
  scratchHome: string,
  opts: { expectedFetch?: string } = {},
): Promise<VerifyResult> {
  try {
    const { stdout } = await runMirrorGit(
      bare,
      ["rev-parse", "--is-bare-repository"],
      { scratchHome },
    );
    if (stdout.trim() !== "true") return { ok: false, reason: "not_bare" };
  } catch {
    return { ok: false, reason: "not_bare" };
  }

  let listing: string;
  try {
    const res = await gitExec(
      ["config", "--file", path.join(bare, "config"), "--list", "--null"],
      { env: hermeticEnv(scratchHome), timeout: 30_000 },
    );
    listing = String(res.stdout);
  } catch {
    return { ok: false, reason: "config_unreadable" };
  }
  const values = new Map<string, string>();
  for (const entry of listing.split("\0")) {
    if (entry === "") continue;
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? "" : entry.slice(nl + 1);
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      return { ok: false, reason: "config_key_not_allowed" };
    }
    values.set(key, value);
  }
  if (/\/\/[^/]*@/.test(values.get("remote.origin.url") ?? "")) {
    return { ok: false, reason: "url_credentials" };
  }
  if (
    opts.expectedFetch !== undefined &&
    values.get("remote.origin.fetch") !== opts.expectedFetch
  ) {
    return { ok: false, reason: "refspec_mismatch" };
  }
  if (await exists(path.join(bare, "objects", "info", "alternates"))) {
    return { ok: false, reason: "alternates" };
  }
  if (await exists(path.join(bare, "shallow"))) {
    return { ok: false, reason: "shallow" };
  }
  const hooks = await fs.readdir(path.join(bare, "hooks")).catch(() => []);
  if (hooks.length > 0) return { ok: false, reason: "hooks_present" };
  return { ok: true };
}

async function validateBranch(
  branch: string,
  scratchHome: string,
): Promise<void> {
  try {
    await gitExec(["check-ref-format", "--branch", branch], {
      env: hermeticEnv(scratchHome),
      timeout: 15_000,
    });
  } catch {
    throw new MirrorError("fetch_failed", "default branch name is not valid");
  }
  if (branch.startsWith("-")) {
    throw new MirrorError("fetch_failed", "default branch name is not valid");
  }
}

function refspecFor(branch: string): string {
  return `+refs/heads/${branch}:refs/heads/${branch}`;
}

async function createFreshMirror(
  paths: MirrorPaths,
  remoteUrl: string,
  defaultBranch: string,
): Promise<void> {
  await ensureDir(paths.bare);
  await gitExec(
    [
      "init",
      "--bare",
      "--template=",
      `--initial-branch=${defaultBranch}`,
      paths.bare,
    ],
    { env: hermeticEnv(paths.tmpDir), timeout: 30_000 },
  );
  // The config is rewritten from scratch: nothing git (or anything else) put
  // there survives, only the allowlisted keys.
  const config = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = true",
    '[remote "origin"]',
    `\turl = ${remoteUrl}`,
    `\tfetch = ${refspecFor(defaultBranch)}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(paths.bare, "config"), config, { mode: 0o600 });
}

export interface EnsureMirrorOptions {
  paths: MirrorPaths;
  repoFullName: string;
  defaultBranch: string;
  /** Tests only: a local fixture URL in place of github.com. */
  remoteUrl?: string;
}

/**
 * Make sure a verified, empty-or-populated bare mirror exists. A mirror that
 * fails verification is tombstoned and re-created ONCE; a fresh one that fails
 * verification is `mirror_corrupt` (no loop). Callers fetch afterwards: a
 * `created: true` mirror holds no objects until fetchDefaultBranch runs (always
 * a full fetch of the one branch, never shallow or partial). Hold the repo lock.
 */
export async function ensureMirror(
  opts: EnsureMirrorOptions,
): Promise<{ created: boolean }> {
  const { paths, defaultBranch } = opts;
  const repo = normalizeRepoFullName(opts.repoFullName);
  await ensureDir(paths.tenantDir);
  await ensureDir(paths.orgDir);
  await ensureDir(paths.tmpDir);
  await validateBranch(defaultBranch, paths.tmpDir);
  const expectedFetch = refspecFor(defaultBranch);

  if (await exists(paths.bare)) {
    const verdict = await verifyMirror(paths.bare, paths.tmpDir, {
      expectedFetch,
    });
    if (verdict.ok) return { created: false };
    await tombstoneAndReap(paths.bare);
  }

  await createFreshMirror(
    paths,
    opts.remoteUrl ?? `https://github.com/${repo}.git`,
    defaultBranch,
  );
  const fresh = await verifyMirror(paths.bare, paths.tmpDir, { expectedFetch });
  if (!fresh.ok) {
    throw new MirrorError(
      "mirror_corrupt",
      `a freshly written mirror failed verification (${fresh.reason})`,
    );
  }
  return { created: true };
}

async function defaultSizeOf(
  bare: string,
  scratchHome: string,
): Promise<number> {
  const { stdout } = await runMirrorGit(bare, ["count-objects", "-v"], {
    scratchHome,
  });
  let kib = 0;
  for (const line of stdout.split("\n")) {
    const m = /^(size|size-pack|size-garbage):\s*(\d+)/.exec(line);
    if (m?.[2]) kib += Number(m[2]);
  }
  return kib * 1024;
}

export interface CheckCapacityOptions {
  paths: MirrorPaths;
  config: MirrorConfig;
  statfs?: StatFs;
  sizeOf?: (bare: string) => Promise<number>;
}

/** Disk floor, then per-mirror cap. Never evicts another org's mirror (D-10). */
export async function checkCapacity(opts: CheckCapacityOptions): Promise<void> {
  const { paths, config } = opts;
  const free = await freeBytes(opts.statfs ?? defaultStatfs, paths.orgDir);
  if (free < config.minFreeBytes) {
    throw new MirrorError("disk_low", "free disk is below the mirror floor");
  }
  const size = await (opts.sizeOf ?? ((b) => defaultSizeOf(b, paths.tmpDir)))(
    paths.bare,
  ).catch(() => 0);
  if (size > config.maxBytes) {
    throw new MirrorError("mirror_over_cap", "mirror is over its size cap");
  }
}

export interface FetchDefaultBranchOptions {
  paths: MirrorPaths;
  config: MirrorConfig;
  defaultBranch: string;
  token: string;
  statfs?: StatFs;
  sizeOf?: (bare: string) => Promise<number>;
  /** Tests only. */
  allowFileProtocolForTests?: boolean;
}

const ACCESS_LOST =
  /Authentication failed|\b403\b|\b404\b|Repository not found/i;

/** Fetch only the default branch, full history, token via env for this one process. */
export async function fetchDefaultBranch(
  opts: FetchDefaultBranchOptions,
): Promise<void> {
  const { paths, config, defaultBranch } = opts;
  await validateBranch(defaultBranch, paths.tmpDir);
  const capacity = {
    paths,
    config,
    statfs: opts.statfs,
    sizeOf: opts.sizeOf,
  };
  await checkCapacity(capacity);
  try {
    await runMirrorGit(
      paths.bare,
      [
        "fetch",
        "--no-tags",
        "--prune",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "origin",
        refspecFor(defaultBranch),
      ],
      {
        env: tokenEnv(opts.token),
        scratchHome: paths.tmpDir,
        timeout: 10 * 60_000,
        allowFileProtocolForTests: opts.allowFileProtocolForTests,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "git fetch failed";
    throw new MirrorError(
      ACCESS_LOST.test(message) ? "repo_access_lost" : "fetch_failed",
      message,
    );
  }
  const verdict = await verifyMirror(paths.bare, paths.tmpDir, {
    expectedFetch: refspecFor(defaultBranch),
  });
  if (!verdict.ok) {
    throw new MirrorError(
      "mirror_corrupt",
      `mirror failed verification after fetch (${verdict.reason})`,
    );
  }
  await checkCapacity(capacity);
}

const SHA1 = /^[0-9a-f]{40}$/;

function checkRelativePath(rel: string): void {
  if (
    rel === "" ||
    rel.startsWith("/") ||
    rel.includes("\\") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(rel) ||
    rel
      .split("/")
      .some((s) => s === "" || s === ".." || s === "." || s === ".git")
  ) {
    throw new MirrorError(
      "snapshot_failed",
      "path is not a repo-relative path",
    );
  }
}

interface TreeEntry {
  oid: string;
  size: number;
  path: string;
}

export interface SnapshotOptions {
  paths: MirrorPaths;
  config: MirrorConfig;
  target: string;
  relPaths: string[];
  statfs?: StatFs;
  writeFile?: (file: string, data: Buffer) => Promise<void>;
}

export interface Snapshot {
  /** The engine root: repo files live under `<root>/repo/<path>`. */
  root: string;
  /** Repo-relative paths actually written. */
  written: string[];
  cleanup: () => Promise<void>;
}

/**
 * Export the listed paths at `target` as plain files. Blobs only (symlinks and
 * submodules are skipped); the budget and the disk are checked BEFORE anything
 * is written; a failure mid-way removes the partial directory. Hold the lock.
 */
export async function snapshotPaths(opts: SnapshotOptions): Promise<Snapshot> {
  const { paths, config, target } = opts;
  if (!SHA1.test(target)) {
    throw new MirrorError("snapshot_failed", "target is not a 40-hex commit");
  }
  for (const rel of opts.relPaths) checkRelativePath(rel);
  if (opts.relPaths.length === 0) {
    throw new MirrorError("snapshot_failed", "no paths to export");
  }
  await ensureDir(paths.tmpDir);

  let listing: string;
  try {
    const res = await runMirrorGit(
      paths.bare,
      [
        "ls-tree",
        "-r",
        "-z",
        "-l",
        "--full-tree",
        target,
        "--",
        ...opts.relPaths,
      ],
      { scratchHome: paths.tmpDir, maxBuffer: 64 * 1024 * 1024 },
    );
    listing = res.stdout;
  } catch (error) {
    throw new MirrorError(
      "snapshot_failed",
      error instanceof Error ? error.message : "git ls-tree failed",
    );
  }

  const entries: TreeEntry[] = [];
  let total = 0;
  for (const line of listing.split("\0")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\s+(\d+|-)$/.exec(
      tab === -1 ? "" : line.slice(0, tab),
    );
    if (!m || tab === -1) {
      throw new MirrorError("snapshot_failed", "unreadable tree listing");
    }
    const [, mode, type, oid, size] = m;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    const entryPath = line.slice(tab + 1);
    checkRelativePath(entryPath);
    entries.push({ oid: oid ?? "", size: Number(size), path: entryPath });
    total += Number(size);
    if (entries.length > MAX_SNAPSHOT_FILES) {
      throw new MirrorError(
        "snapshot_failed",
        "too many files in the snapshot",
      );
    }
  }
  if (total > config.snapshotMaxBytes) {
    throw new MirrorError(
      "snapshot_failed",
      "snapshot is over its byte budget",
    );
  }
  const free = await freeBytes(opts.statfs ?? defaultStatfs, paths.tmpDir);
  if (free - total < config.minFreeBytes) {
    throw new MirrorError("disk_low", "snapshot would leave too little disk");
  }

  const dir = await fs.mkdtemp(path.join(paths.tmpDir, SNAPSHOT_PREFIX));
  await fs.chmod(dir, 0o700);
  const repoRoot = path.join(dir, "repo");
  const write =
    opts.writeFile ??
    ((file: string, data: Buffer) =>
      fs.writeFile(file, data, { mode: 0o600, flag: "wx" }));
  const written: string[] = [];
  try {
    await fs.mkdir(repoRoot, { mode: 0o700 });
    for (const entry of entries) {
      const dest = path.resolve(repoRoot, entry.path);
      if (!dest.startsWith(repoRoot + path.sep)) {
        throw new MirrorError(
          "snapshot_failed",
          "tree path escapes the snapshot",
        );
      }
      // latin1 round-trips the blob's bytes exactly through a string stdout.
      const { stdout } = await gitExec(
        [
          "--git-dir",
          paths.bare,
          "-c",
          "core.fsmonitor=false",
          "cat-file",
          "blob",
          entry.oid,
        ],
        {
          env: hermeticEnv(paths.tmpDir),
          encoding: "latin1",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 60_000,
        },
      );
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await write(dest, Buffer.from(stdout, "latin1"));
      written.push(entry.path);
    }
  } catch (error) {
    await tombstoneAndReap(dir).catch(() => {});
    if (error instanceof MirrorError) throw error;
    throw new MirrorError(
      "snapshot_failed",
      error instanceof Error ? error.message : "snapshot extraction failed",
    );
  }
  return { root: dir, written, cleanup: () => tombstoneAndReap(dir) };
}

/**
 * Reap snapshot dirs a crashed reconcile left behind. Touches only `snap-*`
 * directories older than the cutoff, so it is safe without the repo lock.
 */
export async function sweepSnapshotLeftovers(
  tmpDir: string,
  opts: { olderThanMs: number; now?: number },
): Promise<void> {
  const now = opts.now ?? Date.now();
  const names = await fs.readdir(tmpDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    const full = path.join(tmpDir, name);
    const st = await fs.lstat(full).catch(() => null);
    if (!st?.isDirectory()) continue;
    if (now - st.mtimeMs < opts.olderThanMs) continue;
    if (name.includes(TOMBSTONE)) {
      await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    } else {
      await tombstoneAndReap(full).catch(() => {});
    }
  }
}

/** D-11: tombstone-rename the org's directory, then reap it. A second call is a no-op. */
export async function purgeOrgMirrors(opts: {
  root: string;
  tenantId: string;
  organizationId: string;
}): Promise<void> {
  const { orgDir } = orgMirrorDirs(
    opts.root,
    opts.tenantId,
    opts.organizationId,
  );
  await tombstoneAndReap(orgDir);
}

/** Reap tombstones an earlier purge or re-create could not free. */
export async function sweepMirrorTombstones(tenantDir: string): Promise<void> {
  const top = await fs.readdir(tenantDir).catch(() => [] as string[]);
  for (const name of top) {
    const full = path.join(tenantDir, name);
    if (name.includes(TOMBSTONE)) {
      await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    const st = await fs.lstat(full).catch(() => null);
    if (!st?.isDirectory() || name.startsWith(".")) continue;
    const inner = await fs.readdir(full).catch(() => [] as string[]);
    for (const child of inner) {
      if (!child.includes(TOMBSTONE)) continue;
      await fs
        .rm(path.join(full, child), { recursive: true, force: true })
        .catch(() => {});
    }
  }
}
