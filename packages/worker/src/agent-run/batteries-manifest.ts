/**
 * Contract for packages/worker/deploy/batteries.json — the pinned list of review
 * "batteries" (skill/agent packs + static CLIs) the execution box installs.
 *
 * Three consumers read the same file:
 * - this guard (CI rot tests, and Phase 5's per-run seeding);
 * - packages/worker/deploy/linux/install-batteries.sh, which re-checks the
 *   same shapes in bash with jq and the same regexes (defense in depth: pack
 *   ids, CLI names and versionArgs reach a root shell and an agent shell, so a
 *   loose shape is an injection path, not a cosmetic problem);
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

/** A path segment that must never be vendored (executable or config surface). */
const FORBIDDEN_SEGMENTS: readonly string[] = [
  "hooks",
  "bin",
  ".claude-plugin",
];
/** A file name that would configure Claude Code instead of informing it. */
const FORBIDDEN_BASENAMES: readonly string[] = [
  "settings.json",
  "settings.local.json",
  ".mcp.json",
  "plugin.json",
];

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

export interface BatteryPack {
  id: string;
  /** `https://github.com/<owner>/<repo>`, or `"self"` for this repository. */
  repo: string;
  sha: string;
  license: string;
  subpaths: BatteryPackSubpath[];
  overlays?: BatteryPackOverlay[];
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
  packs: BatteryPack[];
  clis: BatteryCli[];
  dropped: DroppedBattery[];
}

const TOP_KEYS = ["schemaVersion", "packs", "clis", "dropped"] as const;
const PACK_KEYS = [
  "id",
  "repo",
  "sha",
  "license",
  "subpaths",
  "overlays",
] as const;
const SUBPATH_KEYS = ["src", "dest", "gitId", "exclude"] as const;
const OVERLAY_KEYS = ["from", "dest"] as const;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
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
  const segments = relPath.split("/");
  const basename = segments[segments.length - 1] ?? "";
  return (
    segments.some((segment) => FORBIDDEN_SEGMENTS.includes(segment)) ||
    FORBIDDEN_BASENAMES.includes(basename)
  );
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
  const fromError =
    findPathError(value.from, `${at}.from`, { checkForbidden: true }) ??
    (typeof value.from === "string" &&
    value.from.startsWith(BATTERIES_OVERLAY_DIR)
      ? undefined
      : `${at}.from: must live under ${BATTERIES_OVERLAY_DIR}`);
  const destError =
    findDestError(value.dest, `${at}.dest`) ??
    (typeof value.dest === "string" && value.dest.startsWith("skills/")
      ? undefined
      : `${at}.dest: an overlay must land under skills/`);
  return findUnknownKey(value, OVERLAY_KEYS, at) ?? fromError ?? destError;
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
    (isNonEmptyString(value.license)
      ? undefined
      : `${at}.license: must be a non-empty string`) ??
    findListError(value.subpaths, `${at}.subpaths`, findSubpathError, {
      allowEmpty: false,
    }) ??
    (value.overlays === undefined
      ? undefined
      : findListError(value.overlays, `${at}.overlays`, findOverlayError, {
          allowEmpty: true,
        }))
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
    (isNonEmptyString(value.license)
      ? undefined
      : `${at}.license: must be a non-empty string`) ??
    findStringError(value.versionArgs, VERSION_ARGS, `${at}.versionArgs`)
  );
}

function findDroppedError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, DROPPED_KEYS, at) ??
    (isNonEmptyString(value.name)
      ? undefined
      : `${at}.name: must be a non-empty string`) ??
    (isNonEmptyString(value.reason)
      ? undefined
      : `${at}.reason: must be a non-empty string`)
  );
}

/** Reports the first repeated `key` value as `<at>[i].<key>`. */
function findDuplicateError(
  items: unknown[],
  key: string,
  at: string,
): string | undefined {
  const seen = new Set<unknown>();
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) continue;
    const value = item[key];
    if (seen.has(value)) return `${at}[${index}].${key}: duplicate`;
    seen.add(value);
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
    findUnknownKey(value, TOP_KEYS, "") ??
    (value.schemaVersion === 1 ? undefined : "schemaVersion: must be 1") ??
    findListError(value.packs, "packs", findPackError, {
      allowEmpty: false,
    }) ??
    findListError(value.clis, "clis", findCliError, { allowEmpty: true }) ??
    findListError(value.dropped, "dropped", findDroppedError, {
      allowEmpty: true,
    });
  if (shapeError !== undefined) return shapeError;
  // The list checks above proved these are arrays.
  const packs = value.packs as unknown[];
  const clis = value.clis as unknown[];
  return (
    findDuplicateError(packs, "id", "packs") ??
    findDuplicateError(clis, "name", "clis")
  );
}

export function isBatteriesManifest(
  value: unknown,
): value is BatteriesManifest {
  return findBatteriesManifestError(value) === undefined;
}
