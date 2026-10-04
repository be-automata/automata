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
 * `tools` (phase 7, optional, absent = none) are BUILD inputs, not packs: a
 * Dart SDK zip (build-only, never on PATH) and a CLI compiled ahead-of-time
 * from a pinned source tree with OUR committed pubspec.lock. They are
 * installed outside every pack and never linked into a run's HOME, which is
 * why FORBIDDEN_NAMES and PACK_DEST do not apply to their source subpaths
 * (`cli/bin/somnio.dart` is a legitimate build input). The dart-sdk url is an
 * exact template (`DART_SDK_URL_TEMPLATE`, linux-x64 only), not "any https".
 * The manifest hash recipe is unchanged: `lockSha256` lives in the manifest
 * bytes and the installer refuses an overlay whose sha256 differs, so the
 * drift guard covers the lock transitively.
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
/** The env var a dart-aot wrapper exports; `_ROOT`-suffixed so it can never name PATH or LD_PRELOAD. */
export const ROOT_ENV = /^[A-Z][A-Z0-9]*_ROOT$/;
/** The exact last stdout line of `<wrapper> <versionArgs>`; no shell metacharacters. */
export const VERSION_LINE = /^[A-Za-z0-9 ._-]+$/;
/** One word of a dart-aot smoke command (a flag, subcommand or plain value). */
export const SMOKE_WORD = /^-{0,2}[a-z0-9][a-z0-9_-]*$/;
const SMOKE_ARGS_MAX = 12;
/** The only platform a manifest may name; dev dry runs override it outside the manifest. */
export const DART_SDK_MANIFEST_PLATFORM = "linux-x64";

/** The official dart-archive stable zip for `version` on `platform`. */
export function DART_SDK_URL_TEMPLATE(
  version: string,
  platform: string,
): string {
  return `https://storage.googleapis.com/dart-archive/channels/stable/release/${version}/sdk/dartsdk-${platform}-release.zip`;
}
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

/** A source tree a dart-aot tool is built from (no exclude: the build needs the whole tree). */
export interface BatteryToolSubpath {
  src: string;
  dest: string;
  gitId: string;
}

/** A Dart SDK zip, sha256-pinned; build-only (no wrapper, never on PATH). */
export interface BatteryDartSdkTool {
  name: string;
  kind: "dart-sdk";
  version: string;
  url: string;
  sha256: string;
  licenseMember: string;
  license: string;
}

/** A CLI compiled with `dart compile exe` from a pinned tree and a committed lock. */
export interface BatteryDartAotTool {
  name: string;
  kind: "dart-aot";
  version: string;
  repo: string;
  sha: string;
  subpaths: BatteryToolSubpath[];
  /** The subpath dest holding pubspec.yaml. */
  packageDir: string;
  /** Relative to packageDir, ends `.dart`. */
  entrypoint: string;
  /** Repo path under BATTERIES_OVERLAY_DIR, ends `/pubspec.lock`. */
  lockOverlay: string;
  lockSha256: string;
  /** Names an EARLIER tools entry of kind dart-sdk. */
  sdk: string;
  license: string;
  /** /usr/local/bin/<wrapper>. */
  wrapper: string;
  /** Exported by the wrapper as the source tree root. */
  rootEnv: string;
  versionArgs: string;
  versionLine: string;
  smokeArgs: string[];
  /** A file the smoke command must create in a throwaway cwd. */
  smokeExpect: string;
}

export type BatteryTool = BatteryDartSdkTool | BatteryDartAotTool;

export interface BatteriesManifest {
  schemaVersion: 1;
  /** Strings no installed pack may contain outside its allowedHelperRefs. */
  forbiddenHelperTokens: string[];
  packs: BatteryPack[];
  clis: BatteryCli[];
  dropped: DroppedBattery[];
  /** Phase 7 build-time tools; absent = none. */
  tools?: BatteryTool[];
}

const TOP_KEYS = [
  "schemaVersion",
  "forbiddenHelperTokens",
  "packs",
  "clis",
  "dropped",
  "tools",
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
const TOOL_KINDS = ["dart-sdk", "dart-aot"] as const;
const DART_SDK_KEYS = [
  "name",
  "kind",
  "version",
  "url",
  "sha256",
  "licenseMember",
  "license",
] as const;
const DART_AOT_KEYS = [
  "name",
  "kind",
  "version",
  "repo",
  "sha",
  "subpaths",
  "packageDir",
  "entrypoint",
  "lockOverlay",
  "lockSha256",
  "sdk",
  "license",
  "wrapper",
  "rootEnv",
  "versionArgs",
  "versionLine",
  "smokeArgs",
  "smokeExpect",
] as const;
const TOOL_SUBPATH_KEYS = ["src", "dest", "gitId"] as const;

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

function findDartSdkUrlError(
  url: unknown,
  version: unknown,
  at: string,
): string | undefined {
  if (
    typeof version === "string" &&
    url === DART_SDK_URL_TEMPLATE(version, DART_SDK_MANIFEST_PLATFORM)
  ) {
    return undefined;
  }
  return `${at}: must equal the dart-archive ${DART_SDK_MANIFEST_PLATFORM} URL for the version`;
}

function findDartSdkToolError(
  value: Record<string, unknown>,
  at: string,
): string | undefined {
  return (
    findUnknownKey(value, DART_SDK_KEYS, at) ??
    findStringError(value.name, ID_OR_NAME, `${at}.name`) ??
    findStringError(value.version, SEMVER, `${at}.version`) ??
    findDartSdkUrlError(value.url, value.version, `${at}.url`) ??
    findStringError(value.sha256, SHA256_HEX, `${at}.sha256`) ??
    findPathError(value.licenseMember, `${at}.licenseMember`, {
      checkForbidden: false,
    }) ??
    findPrefixError(
      value.licenseMember,
      "dart-sdk/",
      `${at}.licenseMember: must live under dart-sdk/`,
    ) ??
    findNonEmptyError(value.license, `${at}.license`)
  );
}

function findToolSubpathError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, TOOL_SUBPATH_KEYS, at) ??
    findPathError(value.src, `${at}.src`, { checkForbidden: false }) ??
    findPathError(value.dest, `${at}.dest`, { checkForbidden: false }) ??
    findStringError(value.gitId, SHA1_HEX, `${at}.gitId`)
  );
}

function findPackageDirError(
  value: Record<string, unknown>,
  at: string,
): string | undefined {
  // findListError proved subpaths is a list of valid subpath objects.
  const dests = (value.subpaths as BatteryToolSubpath[]).map((s) => s.dest);
  return typeof value.packageDir === "string" &&
    dests.includes(value.packageDir)
    ? undefined
    : `${at}.packageDir: must equal one subpath dest`;
}

function findEntrypointError(value: unknown, at: string): string | undefined {
  return (
    findPathError(value, at, { checkForbidden: false }) ??
    (typeof value === "string" && value.endsWith(".dart")
      ? undefined
      : `${at}: must end with .dart`)
  );
}

function findLockOverlayError(value: unknown, at: string): string | undefined {
  return (
    findPathError(value, at, { checkForbidden: false }) ??
    findPrefixError(
      value,
      BATTERIES_OVERLAY_DIR,
      `${at}: must live under ${BATTERIES_OVERLAY_DIR}`,
    ) ??
    (typeof value === "string" && value.endsWith("/pubspec.lock")
      ? undefined
      : `${at}: must end with /pubspec.lock`)
  );
}

function findVersionLineError(
  value: unknown,
  version: unknown,
  at: string,
): string | undefined {
  return (
    findStringError(value, VERSION_LINE, at) ??
    (typeof value === "string" &&
    typeof version === "string" &&
    value.endsWith(` v${version}`)
      ? undefined
      : `${at}: must end with " v<version>"`)
  );
}

function findSmokeArgsError(value: unknown, at: string): string | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > SMOKE_ARGS_MAX
  ) {
    return `${at}: must be a list of 1 to ${SMOKE_ARGS_MAX} words`;
  }
  for (const [index, word] of value.entries()) {
    const error = findStringError(word, SMOKE_WORD, `${at}[${index}]`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function findDartAotToolError(
  value: Record<string, unknown>,
  at: string,
): string | undefined {
  return (
    findUnknownKey(value, DART_AOT_KEYS, at) ??
    findStringError(value.name, ID_OR_NAME, `${at}.name`) ??
    findStringError(value.version, SEMVER, `${at}.version`) ??
    findStringError(value.repo, GITHUB_REPO, `${at}.repo`) ??
    findStringError(value.sha, SHA1_HEX, `${at}.sha`) ??
    findListError(value.subpaths, `${at}.subpaths`, findToolSubpathError, {
      allowEmpty: false,
    }) ??
    findDuplicateError(
      value.subpaths as BatteryToolSubpath[],
      "dest",
      `${at}.subpaths`,
    ) ??
    findPackageDirError(value, at) ??
    findEntrypointError(value.entrypoint, `${at}.entrypoint`) ??
    findLockOverlayError(value.lockOverlay, `${at}.lockOverlay`) ??
    findStringError(value.lockSha256, SHA256_HEX, `${at}.lockSha256`) ??
    findStringError(value.sdk, ID_OR_NAME, `${at}.sdk`) ??
    findNonEmptyError(value.license, `${at}.license`) ??
    findStringError(value.wrapper, ID_OR_NAME, `${at}.wrapper`) ??
    findStringError(value.rootEnv, ROOT_ENV, `${at}.rootEnv`) ??
    findStringError(value.versionArgs, VERSION_ARGS, `${at}.versionArgs`) ??
    findVersionLineError(
      value.versionLine,
      value.version,
      `${at}.versionLine`,
    ) ??
    findSmokeArgsError(value.smokeArgs, `${at}.smokeArgs`) ??
    findPathError(value.smokeExpect, `${at}.smokeExpect`, {
      checkForbidden: false,
    })
  );
}

function findToolError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  if (value.kind === "dart-sdk") return findDartSdkToolError(value, at);
  if (value.kind === "dart-aot") return findDartAotToolError(value, at);
  return `${at}.kind: must be one of ${TOOL_KINDS.join(", ")}`;
}

/**
 * Tools share the install root's `<name>@…` namespace with packs and CLIs,
 * and wrappers share /usr/local/bin with the CLIs: no collisions. A dart-aot
 * tool builds with an SDK installed before it.
 */
function findToolCrossError(
  tools: BatteryTool[],
  packs: BatteryPack[],
  clis: BatteryCli[],
): string | undefined {
  const duplicateName = findDuplicateError(tools, "name", "tools");
  if (duplicateName !== undefined) return duplicateName;
  const taken = new Set([
    ...packs.map((p) => p.id),
    ...clis.map((c) => c.name),
  ]);
  const cliNames = new Set(clis.map((c) => c.name));
  const wrappers = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    const at = `tools[${index}]`;
    if (taken.has(tool.name)) {
      return `${at}.name: collides with a pack id or CLI name`;
    }
    if (tool.kind !== "dart-aot") continue;
    if (cliNames.has(tool.wrapper)) {
      return `${at}.wrapper: collides with a CLI name`;
    }
    if (wrappers.has(tool.wrapper)) return `${at}.wrapper: duplicate`;
    wrappers.add(tool.wrapper);
    const sdkIndex = tools.findIndex((t) => t.name === tool.sdk);
    if (
      sdkIndex === -1 ||
      sdkIndex >= index ||
      tools[sdkIndex]?.kind !== "dart-sdk"
    ) {
      return `${at}.sdk: must name an earlier tools entry of kind dart-sdk`;
    }
  }
  return undefined;
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
    }) ??
    findOptionalListError(value.tools, "tools", findToolError);
  if (shapeError !== undefined) return shapeError;
  // The shape checks above proved these types.
  const packs = value.packs as BatteryPack[];
  const clis = value.clis as BatteryCli[];
  const tools = (value.tools ?? []) as BatteryTool[];
  return (
    findDuplicateError(packs, "id", "packs") ??
    findDuplicateError(clis, "name", "clis") ??
    findUnusedHelperRefError(packs, value.forbiddenHelperTokens as string[]) ??
    findToolCrossError(tools, packs, clis)
  );
}

export function isBatteriesManifest(
  value: unknown,
): value is BatteriesManifest {
  return findBatteriesManifestError(value) === undefined;
}
