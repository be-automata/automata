/**
 * Contract for packages/worker/deploy/batteries.json — the pinned list of review
 * "batteries" (skill/agent packs + static CLIs) the execution box installs.
 *
 * Three consumers read the same file:
 * - this guard (CI rot tests, and Phase 5's per-run seeding);
 * - packages/worker/deploy/linux/install-batteries.sh, which re-checks the
 *   same shapes in bash with jq and the same regexes (defense in depth: pack
 *   ids, CLI names and versionArgs reach a root shell and an agent shell, so a
 *   loose shape is an injection path, not a cosmetic problem). Keep the two
 *   validators in agreement: a rule added here belongs in its preflight too;
 * - the operator, who reviews pin changes in a PR.
 *
 * Pins are content addresses (commit → tree/blob ids, release tarball →
 * sha256). This guard checks SHAPE only; the installer checks CONTENT against
 * the pins before anything is written under the install root.
 *
 * Zero imports on purpose, so tests and Phase 5 can use it without adding a
 * dependency.
 */

export const BATTERIES_MANIFEST_REPO_PATH =
  "packages/worker/deploy/batteries.json";
export const BATTERIES_OVERLAY_DIR = "packages/worker/deploy/batteries/";

/** Pack id AND CLI name. Both end up in filesystem paths and shell words. */
export const ID_OR_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** A single lowercase flag or subcommand; never more than one shell word. */
export const VERSION_ARGS = /^-{0,2}[a-z]+$/;
export const SHA1_HEX = /^[0-9a-f]{40}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const GITHUB_REPO =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const SEMVER = /^\d+\.\d+\.\d+$/;
/** Where a pack may place files inside `<root>/<packId>@<sha>/`. */
export const PACK_DEST =
  /^(LICENSE|skills\/[a-z0-9-]+(\/.+)?|agents\/[a-z0-9-]+\.md)$/;

/**
 * Path segments that must never be vendored: an executable or plugin surface
 * (`hooks`, `bin`, `.claude-plugin`), or a file that would configure Claude
 * Code instead of informing it. install-batteries.sh carries the same list as
 * FORBIDDEN_NAMES, for both its preflight and its scan of the staged tree.
 */
export const FORBIDDEN_NAMES: readonly string[] = [
  "hooks",
  "bin",
  ".claude-plugin",
  "settings.json",
  "settings.local.json",
  ".mcp.json",
  "plugin.json",
];

/** Control characters split the installer's tab/line-based reads; backslashes are escaped by jq's @tsv. */
const UNSAFE_CHAR = /[\u0000-\u001f\u007f\\]/;

export interface BatteryPackSubpath {
  src: string;
  dest: string;
  gitId: string;
  exclude?: string[];
}

export interface BatteryPackOverlay {
  from: string;
  dest: string;
}

/**
 * A gstack helper reference that a vendored file may contain exactly `count`
 * times, because the adapter skill neutralises it. Any other occurrence of a
 * `forbiddenHelperTokens` entry in an installed pack fails the install.
 */
export interface AllowedHelperRef {
  /** Path inside the pack dir, e.g. `skills/gstack-review/checklist.md`. */
  file: string;
  ref: string;
  count: number;
}

export interface BatteryPack {
  id: string;
  /** `https://github.com/<owner>/<repo>`, or `"self"` for this repository. */
  repo: string;
  sha: string;
  license: string;
  subpaths: BatteryPackSubpath[];
  overlays?: BatteryPackOverlay[];
  allowedHelperRefs?: AllowedHelperRef[];
}

export interface BatteryCli {
  name: string;
  version: string;
  url: string;
  sha256: string;
  member: string;
  licenseMember: string;
  license: string;
  versionArgs: string;
}

export interface DroppedBattery {
  name: string;
  reason: string;
}

export interface BatteriesManifest {
  schemaVersion: 1;
  /** Strings no installed pack may contain outside its allowedHelperRefs. */
  forbiddenHelperTokens: string[];
  packs: BatteryPack[];
  clis: BatteryCli[];
  dropped: DroppedBattery[];
}

const TOP_KEYS = [
  "schemaVersion",
  "forbiddenHelperTokens",
  "packs",
  "clis",
  "dropped",
] as const;
const PACK_KEYS = [
  "id",
  "repo",
  "sha",
  "license",
  "subpaths",
  "overlays",
  "allowedHelperRefs",
] as const;
const SUBPATH_KEYS = ["src", "dest", "gitId", "exclude"] as const;
const OVERLAY_KEYS = ["from", "dest"] as const;
const HELPER_REF_KEYS = ["file", "ref", "count"] as const;
const CLI_KEYS = [
  "name",
  "version",
  "url",
  "sha256",
  "member",
  "licenseMember",
  "license",
  "versionArgs",
] as const;
const DROPPED_KEYS = ["name", "reason"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First key not in `allowed`, reported as `<at>.<key>`; strict shapes catch typos like `sha265`. */
function findUnknownKey(
  record: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): string | undefined {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown === undefined) return undefined;
  const where = at === "" ? unknown : `${at}.${unknown}`;
  return `${where}: unknown key`;
}

function findNonEmptyError(value: unknown, at: string): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? undefined
    : `${at}: must be a non-empty string`;
}

/** `error` unless `value` is a string starting with `prefix`. */
function findPrefixError(
  value: unknown,
  prefix: string,
  error: string,
): string | undefined {
  return typeof value === "string" && value.startsWith(prefix)
    ? undefined
    : error;
}

/** First string anywhere in `value` holding a control character or backslash. */
function findUnsafeCharError(value: unknown, at: string): string | undefined {
  if (typeof value === "string") {
    return UNSAFE_CHAR.test(value)
      ? `${at}: contains a control character or backslash`
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const error = findUnsafeCharError(item, `${at}[${index}]`);
      if (error !== undefined) return error;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const error = findUnsafeCharError(item, at === "" ? key : `${at}.${key}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
}

/** Relative, forward-slash, no `..`/`.`/empty segments, no backslash. */
function isSafeRelPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasForbiddenName(relPath: string): boolean {
  return relPath
    .split("/")
    .some((segment) => FORBIDDEN_NAMES.includes(segment));
}

function findStringError(
  value: unknown,
  pattern: RegExp,
  at: string,
): string | undefined {
  if (typeof value !== "string" || !pattern.test(value)) {
    return `${at}: must match ${pattern.source}`;
  }
  return undefined;
}

function findPathError(
  value: unknown,
  at: string,
  { checkForbidden }: { checkForbidden: boolean },
): string | undefined {
  if (!isSafeRelPath(value)) {
    return `${at}: must be a non-empty relative path without "..", "." or backslashes`;
  }
  if (checkForbidden && hasForbiddenName(value)) {
    return `${at}: names a forbidden hook/bin/plugin/settings/.mcp.json path`;
  }
  return undefined;
}

function findDestError(value: unknown, at: string): string | undefined {
  const pathError = findPathError(value, at, { checkForbidden: true });
  if (pathError !== undefined) return pathError;
  return findStringError(value, PACK_DEST, at);
}

function findSubpathError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, SUBPATH_KEYS, at) ??
    findPathError(value.src, `${at}.src`, { checkForbidden: true }) ??
    findDestError(value.dest, `${at}.dest`) ??
    findStringError(value.gitId, SHA1_HEX, `${at}.gitId`) ??
    findExcludeError(value.exclude, `${at}.exclude`)
  );
}

function findExcludeError(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return `${at}: must be an array`;
  for (const [index, entry] of value.entries()) {
    const error = findPathError(entry, `${at}[${index}]`, {
      checkForbidden: false,
    });
    if (error !== undefined) return error;
  }
  return undefined;
}

function findOverlayError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, OVERLAY_KEYS, at) ??
    findPathError(value.from, `${at}.from`, { checkForbidden: true }) ??
    findPrefixError(
      value.from,
      BATTERIES_OVERLAY_DIR,
      `${at}.from: must live under ${BATTERIES_OVERLAY_DIR}`,
    ) ??
    findDestError(value.dest, `${at}.dest`) ??
    findPrefixError(
      value.dest,
      "skills/",
      `${at}.dest: an overlay must land under skills/`,
    )
  );
}

function findHelperRefError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, HELPER_REF_KEYS, at) ??
    findDestError(value.file, `${at}.file`) ??
    findNonEmptyError(value.ref, `${at}.ref`) ??
    (Number.isInteger(value.count) && (value.count as number) >= 1
      ? undefined
      : `${at}.count: must be an integer >= 1`)
  );
}

function findListError(
  value: unknown,
  at: string,
  findItemError: (item: unknown, itemAt: string) => string | undefined,
  { allowEmpty }: { allowEmpty: boolean },
): string | undefined {
  if (!Array.isArray(value)) return `${at}: must be an array`;
  if (!allowEmpty && value.length === 0) return `${at}: must not be empty`;
  for (const [index, item] of value.entries()) {
    const error = findItemError(item, `${at}[${index}]`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function findOptionalListError(
  value: unknown,
  at: string,
  findItemError: (item: unknown, itemAt: string) => string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return findListError(value, at, findItemError, { allowEmpty: true });
}

function findPackError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  const repoError =
    value.repo === "self" ||
    (typeof value.repo === "string" && GITHUB_REPO.test(value.repo))
      ? undefined
      : `${at}.repo: must be "self" or match ${GITHUB_REPO.source}`;
  return (
    findUnknownKey(value, PACK_KEYS, at) ??
    findStringError(value.id, ID_OR_NAME, `${at}.id`) ??
    repoError ??
    findStringError(value.sha, SHA1_HEX, `${at}.sha`) ??
    findNonEmptyError(value.license, `${at}.license`) ??
    findListError(value.subpaths, `${at}.subpaths`, findSubpathError, {
      allowEmpty: false,
    }) ??
    findOptionalListError(value.overlays, `${at}.overlays`, findOverlayError) ??
    findOptionalListError(
      value.allowedHelperRefs,
      `${at}.allowedHelperRefs`,
      findHelperRefError,
    )
  );
}

function findCliUrlError(
  url: unknown,
  version: unknown,
  at: string,
): string | undefined {
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) {
    return `${at}: must start with https://github.com/`;
  }
  if (
    typeof version !== "string" ||
    !url.includes(`/releases/download/v${version}/`)
  ) {
    return `${at}: must contain /releases/download/v<version>/`;
  }
  if (!url.includes("linux")) return `${at}: must name a linux asset`;
  return undefined;
}

function findCliError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, CLI_KEYS, at) ??
    findStringError(value.name, ID_OR_NAME, `${at}.name`) ??
    findStringError(value.version, SEMVER, `${at}.version`) ??
    findCliUrlError(value.url, value.version, `${at}.url`) ??
    findStringError(value.sha256, SHA256_HEX, `${at}.sha256`) ??
    findPathError(value.member, `${at}.member`, { checkForbidden: false }) ??
    findPathError(value.licenseMember, `${at}.licenseMember`, {
      checkForbidden: false,
    }) ??
    findNonEmptyError(value.license, `${at}.license`) ??
    findStringError(value.versionArgs, VERSION_ARGS, `${at}.versionArgs`)
  );
}

function findDroppedError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, DROPPED_KEYS, at) ??
    findNonEmptyError(value.name, `${at}.name`) ??
    findNonEmptyError(value.reason, `${at}.reason`)
  );
}

/** Reports the first repeated `key` value as `<at>[i].<key>`. */
function findDuplicateError(
  items: readonly object[],
  key: string,
  at: string,
): string | undefined {
  const seen = new Set<unknown>();
  for (const [index, item] of items.entries()) {
    const value = (item as Record<string, unknown>)[key];
    if (seen.has(value)) return `${at}[${index}].${key}: duplicate`;
    seen.add(value);
  }
  return undefined;
}

/** An allowlisted ref must name a forbidden token, or allowing it is meaningless. */
function findUnusedHelperRefError(
  packs: BatteryPack[],
  tokens: string[],
): string | undefined {
  for (const [packIndex, pack] of packs.entries()) {
    for (const [refIndex, entry] of (pack.allowedHelperRefs ?? []).entries()) {
      if (!tokens.some((token) => entry.ref.includes(token))) {
        return `packs[${packIndex}].allowedHelperRefs[${refIndex}].ref: names no forbiddenHelperTokens entry`;
      }
    }
  }
  return undefined;
}

/**
 * First human-readable error in `value` as a batteries manifest, naming the
 * offending path (e.g. `packs[1].sha: must match …`), or undefined if valid.
 */
export function findBatteriesManifestError(value: unknown): string | undefined {
  if (!isRecord(value)) return "manifest: must be a JSON object";
  const shapeError =
    findUnsafeCharError(value, "") ??
    findUnknownKey(value, TOP_KEYS, "") ??
    (value.schemaVersion === 1 ? undefined : "schemaVersion: must be 1") ??
    findListError(
      value.forbiddenHelperTokens,
      "forbiddenHelperTokens",
      findNonEmptyError,
      { allowEmpty: false },
    ) ??
    findListError(value.packs, "packs", findPackError, {
      allowEmpty: false,
    }) ??
    findListError(value.clis, "clis", findCliError, { allowEmpty: true }) ??
    findListError(value.dropped, "dropped", findDroppedError, {
      allowEmpty: true,
    });
  if (shapeError !== undefined) return shapeError;
  // The shape checks above proved these types.
  const packs = value.packs as BatteryPack[];
  const clis = value.clis as BatteryCli[];
  return (
    findDuplicateError(packs, "id", "packs") ??
    findDuplicateError(clis, "name", "clis") ??
    findUnusedHelperRefError(packs, value.forbiddenHelperTokens as string[])
  );
}

export function isBatteriesManifest(
  value: unknown,
): value is BatteriesManifest {
  return findBatteriesManifestError(value) === undefined;
}
