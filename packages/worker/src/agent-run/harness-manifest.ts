import fs from "node:fs";
import path from "node:path";

import {
  GITHUB_REPO,
  ID_OR_NAME,
  SEMVER,
  SHA1_HEX,
  SHA256_HEX,
  SMOKE_WORD,
  findDuplicateError,
  findListError,
  findNonEmptyError,
  findStringError,
  findUnknownKey,
  findUnsafeCharError,
  isRecord,
  isSafeRelPath,
} from "./batteries-manifest";

/**
 * Contract for packages/worker/deploy/harness.json — the HARNESS packs: full
 * upstream tool suites (gstack, GSD, ruflo) with their bin/, hooks, internal
 * symlinks and, for ruflo, an MCP server. Task and PR lanes only; a review run
 * never gets one (shared HARNESS_PACK_IDS are rejected by the review setting).
 *
 * A separate manifest from batteries.json on purpose: the review packs there
 * are vendored file-by-file under a strict profile (no symlinks, no bin/ or
 * hooks/, every grant key stripped from frontmatter), and nothing here may
 * loosen that profile or invalidate its manifest hash. The harness profile is
 * a different, explicit set of rules:
 *
 * - kinds: `git-setup` (a pinned commit plus its own setup script, run with
 *   `setupArgs`, with sha256-pinned `dependencies` such as bun) and `npm-lock`
 *   (an exact npm package version, with exact `overrides`). No ranges, no tags,
 *   no `latest`: every version is an exact semver.
 * - lockfiles: the npm-lock lockfile (and its sha256) arrives with the
 *   installer in PR3, together with the keys that pin it. Until then nothing
 *   reads this manifest to install, so no placeholder pin exists to slip
 *   through: PR3 adds the keys as REQUIRED, and this strict-key guard rejects
 *   them before that.
 * - `env` keys are confined to the battery prefixes the daemon reserves from
 *   repo env (GSTACK_, PLAYWRIGHT_, MCP_, CLAUDE_FLOW_); a value is either a
 *   plain word/number (no `/`) or a path confined to the pack:
 *   `{{packDir}}` or `{{packDir}}/<relative path>` without `..` segments.
 * - `mcpServers` commands are a wrapper inside the pack (`{{packDir}}/…`);
 *   the wrapper owns the server's env. A pack with `mcpServers` must name a
 *   `toolAllowlist`, which can never name a spawn/network/terminal/GitHub/
 *   federation tool (FORBIDDEN_MCP_TOOL_PREFIXES; ADR-007 one-agent budget).
 * - `headlessSafe` names the skills an automation prompt may invoke without a
 *   human; `frontmatterHookSkills` names the only skills whose frontmatter may
 *   declare `hooks` (every one reviewed: each runs a script inside the pack).
 *
 * validateHarnessPackTree checks an INSTALLED pack dir against the same
 * profile; the installer (PR3) and the worker preflight (PR4) call it.
 */

export const HARNESS_MANIFEST_REPO_PATH = "packages/worker/deploy/harness.json";

/** Mirror of shared HARNESS_PACK_IDS, in manifest order (deploy-assets pins them equal). */
export const HARNESS_PACK_IDS = ["gstack", "gsd", "ruflo"] as const;

/** The only placeholder a manifest value may hold; the installer substitutes the pack dir. */
export const HARNESS_PACK_DIR_PLACEHOLDER = "{{packDir}}";

/** Env keys a harness pack may set: the battery prefixes repo env can never set. */
export const HARNESS_ENV_KEY =
  /^(GSTACK|PLAYWRIGHT|MCP|CLAUDE_FLOW)_[A-Z0-9_]+$/;
/** A plain env value (or one path segment under {{packDir}}): a word or number, no `/`, no shell metacharacters. */
const ENV_VALUE_WORD = /^[A-Za-z0-9._:-]*$/;
/** An npm package name, optionally scoped. */
export const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** One MCP tool name as the server registers it. */
export const MCP_TOOL = /^[a-z][a-z0-9_-]*$/;
/** A dependency is a GitHub release download of the pinned version naming a linux asset. */
const DEPENDENCY_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9_.-]*v(\d+\.\d+\.\d+)\/[A-Za-z0-9_.-]*linux[A-Za-z0-9_.-]*$/;
const NODE_MAJOR_MIN = 20;

/**
 * MCP tools a harness pack may never expose: agent spawning, swarms and
 * federation (one agent per run), raw network, terminals, GitHub and browsers.
 * Matched as name prefixes, so `http_fetch` also covers any `http_fetch_*`.
 */
export const FORBIDDEN_MCP_TOOL_PREFIXES: readonly string[] = [
  "agent_",
  "swarm_",
  "hive-mind_",
  "managed_agent_",
  "wasm_agent_",
  "federation_",
  "x_federation_",
  "transfer_",
  "http_fetch",
  "terminal_",
  "github_",
  "browser_",
];

/** Upstream Claude Code config files: never linked into a run's HOME (reported, not failed). */
export const HARNESS_DISCARD_NAMES: readonly string[] = [
  "settings.json",
  "settings.local.json",
  ".mcp.json",
];

/** Frontmatter keys no harness markdown may declare. */
export const HARNESS_FORBIDDEN_FRONTMATTER_KEYS: readonly string[] = [
  "mcpServers",
  "permissionMode",
];

export interface HarnessDependency {
  name: string;
  version: string;
  url: string;
  sha256: string;
  license: string;
}

export interface HarnessMcpServer {
  /** `{{packDir}}/<relative path>`: a wrapper inside the pack. */
  command: string;
  args: string[];
}

interface HarnessPackBase {
  id: string;
  class: "harness";
  license: string;
  /** The Node major the pack's native modules are built for. */
  nodeMajor: number;
  env: Record<string, string>;
  /** Skills an automation may invoke without a human in the loop. */
  headlessSafe: string[];
  /** The only skills whose frontmatter may declare `hooks`. */
  frontmatterHookSkills: string[];
  mcpServers?: Record<string, HarnessMcpServer>;
  /** Present exactly when `mcpServers` is. */
  toolAllowlist?: string[];
}

export interface HarnessGitSetupPack extends HarnessPackBase {
  kind: "git-setup";
  repo: string;
  sha: string;
  setupArgs: string[];
  dependencies: HarnessDependency[];
}

export interface HarnessNpmLockPack extends HarnessPackBase {
  kind: "npm-lock";
  package: string;
  version: string;
  overrides?: Record<string, string>;
}

export type HarnessPack = HarnessGitSetupPack | HarnessNpmLockPack;

export interface HarnessManifest {
  schemaVersion: 1;
  packs: HarnessPack[];
}

const TOP_KEYS = ["schemaVersion", "packs"] as const;
const BASE_KEYS = [
  "id",
  "class",
  "kind",
  "license",
  "nodeMajor",
  "env",
  "headlessSafe",
  "frontmatterHookSkills",
  "mcpServers",
  "toolAllowlist",
] as const;
const GIT_SETUP_KEYS = [
  ...BASE_KEYS,
  "repo",
  "sha",
  "setupArgs",
  "dependencies",
] as const;
const NPM_LOCK_KEYS = [
  ...BASE_KEYS,
  "package",
  "version",
  "overrides",
] as const;
const DEPENDENCY_KEYS = [
  "name",
  "version",
  "url",
  "sha256",
  "license",
] as const;
const MCP_SERVER_KEYS = ["command", "args"] as const;
const HARNESS_KINDS = ["git-setup", "npm-lock"] as const;

/** A list of distinct strings each matching `pattern`. */
function findNameListError(
  value: unknown,
  pattern: RegExp,
  at: string,
  { allowEmpty }: { allowEmpty: boolean },
): string | undefined {
  const error = findListError(
    value,
    at,
    (item, itemAt) => findStringError(item, pattern, itemAt),
    { allowEmpty },
  );
  if (error !== undefined) return error;
  const seen = new Set<unknown>();
  for (const [index, item] of (value as unknown[]).entries()) {
    if (seen.has(item)) return `${at}[${index}]: duplicate`;
    seen.add(item);
  }
  return undefined;
}

function findEnvValueError(value: unknown, at: string): string | undefined {
  if (typeof value !== "string") return `${at}: must be a string`;
  if (!value.startsWith(HARNESS_PACK_DIR_PLACEHOLDER)) {
    // A plain value can never name a path: no `/`, so no `..` escape either.
    return ENV_VALUE_WORD.test(value) && !value.includes("..")
      ? undefined
      : `${at}: must be a plain word or number, or a path under ${HARNESS_PACK_DIR_PLACEHOLDER}`;
  }
  // A path value stays inside the pack: {{packDir}} alone, or
  // {{packDir}}/<relative path> with no `..`, `.` or empty segment.
  const rest = value.slice(HARNESS_PACK_DIR_PLACEHOLDER.length);
  if (rest === "") return undefined;
  const relPath = rest.slice(1);
  return rest.startsWith("/") &&
    isSafeRelPath(relPath) &&
    relPath.split("/").every((segment) => ENV_VALUE_WORD.test(segment))
    ? undefined
    : `${at}: must be ${HARNESS_PACK_DIR_PLACEHOLDER} or ${HARNESS_PACK_DIR_PLACEHOLDER}/<relative path inside the pack>`;
}

function findEnvError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  for (const [key, item] of Object.entries(value)) {
    if (!HARNESS_ENV_KEY.test(key)) {
      return `${at}.${key}: key must match ${HARNESS_ENV_KEY.source}`;
    }
    const error = findEnvValueError(item, `${at}.${key}`);
    if (error !== undefined) return error;
  }
  return undefined;
}

/** `{{packDir}}/<safe relative path>`. */
function findPackCommandError(value: unknown, at: string): string | undefined {
  const prefix = `${HARNESS_PACK_DIR_PLACEHOLDER}/`;
  return typeof value === "string" &&
    value.startsWith(prefix) &&
    isSafeRelPath(value.slice(prefix.length))
    ? undefined
    : `${at}: must be ${prefix}<relative path inside the pack>`;
}

function findMcpServerError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  return (
    findUnknownKey(value, MCP_SERVER_KEYS, at) ??
    findPackCommandError(value.command, `${at}.command`) ??
    findListError(
      value.args,
      `${at}.args`,
      (item, itemAt) => findStringError(item, SMOKE_WORD, itemAt),
      { allowEmpty: true },
    )
  );
}

function findMcpServersError(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return `${at}: must be a non-empty object`;
  }
  for (const [name, server] of Object.entries(value)) {
    if (!ID_OR_NAME.test(name)) {
      return `${at}.${name}: name must match ${ID_OR_NAME.source}`;
    }
    const error = findMcpServerError(server, `${at}.${name}`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function findToolAllowlistError(
  value: unknown,
  hasServers: boolean,
  at: string,
): string | undefined {
  if (!hasServers) {
    return value === undefined
      ? undefined
      : `${at}: only a pack with mcpServers may name a tool allowlist`;
  }
  if (value === undefined) return `${at}: required with mcpServers`;
  const error = findNameListError(value, MCP_TOOL, at, { allowEmpty: false });
  if (error !== undefined) return error;
  for (const [index, tool] of (value as string[]).entries()) {
    if (FORBIDDEN_MCP_TOOL_PREFIXES.some((prefix) => tool.startsWith(prefix))) {
      return `${at}[${index}]: ${tool} is a spawn, network, terminal, GitHub, browser or federation tool`;
    }
  }
  return undefined;
}

function findNodeMajorError(value: unknown, at: string): string | undefined {
  return Number.isInteger(value) && (value as number) >= NODE_MAJOR_MIN
    ? undefined
    : `${at}: must be an integer >= ${NODE_MAJOR_MIN}`;
}

function findDependencyError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  const match =
    typeof value.url === "string" ? DEPENDENCY_URL.exec(value.url) : null;
  return (
    findUnknownKey(value, DEPENDENCY_KEYS, at) ??
    findStringError(value.name, ID_OR_NAME, `${at}.name`) ??
    findStringError(value.version, SEMVER, `${at}.version`) ??
    (match !== null && match[1] === value.version
      ? undefined
      : `${at}.url: must be a github release download of v<version> naming a linux asset`) ??
    findStringError(value.sha256, SHA256_HEX, `${at}.sha256`) ??
    findNonEmptyError(value.license, `${at}.license`)
  );
}

function findOverridesError(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return `${at}: must be an object`;
  for (const [name, version] of Object.entries(value)) {
    if (!NPM_PACKAGE.test(name)) {
      return `${at}.${name}: must be an npm package name`;
    }
    const error = findStringError(version, SEMVER, `${at}.${name}`);
    if (error !== undefined) return error;
  }
  return undefined;
}

function findBaseError(
  value: Record<string, unknown>,
  at: string,
): string | undefined {
  return (
    findStringError(value.id, ID_OR_NAME, `${at}.id`) ??
    (value.class === "harness"
      ? undefined
      : `${at}.class: must be "harness"`) ??
    findNonEmptyError(value.license, `${at}.license`) ??
    findNodeMajorError(value.nodeMajor, `${at}.nodeMajor`) ??
    findEnvError(value.env, `${at}.env`) ??
    findNameListError(value.headlessSafe, ID_OR_NAME, `${at}.headlessSafe`, {
      allowEmpty: true,
    }) ??
    findNameListError(
      value.frontmatterHookSkills,
      ID_OR_NAME,
      `${at}.frontmatterHookSkills`,
      { allowEmpty: true },
    ) ??
    findMcpServersError(value.mcpServers, `${at}.mcpServers`) ??
    findToolAllowlistError(
      value.toolAllowlist,
      value.mcpServers !== undefined,
      `${at}.toolAllowlist`,
    )
  );
}

function findGitSetupPackError(
  value: Record<string, unknown>,
  at: string,
): string | undefined {
  return (
    findUnknownKey(value, GIT_SETUP_KEYS, at) ??
    findBaseError(value, at) ??
    findStringError(value.repo, GITHUB_REPO, `${at}.repo`) ??
    findStringError(value.sha, SHA1_HEX, `${at}.sha`) ??
    findListError(
      value.setupArgs,
      `${at}.setupArgs`,
      (item, itemAt) => findStringError(item, SMOKE_WORD, itemAt),
      { allowEmpty: true },
    ) ??
    findListError(
      value.dependencies,
      `${at}.dependencies`,
      findDependencyError,
      {
        allowEmpty: true,
      },
    )
  );
}

function findNpmLockPackError(
  value: Record<string, unknown>,
  at: string,
): string | undefined {
  return (
    findUnknownKey(value, NPM_LOCK_KEYS, at) ??
    findBaseError(value, at) ??
    findStringError(value.package, NPM_PACKAGE, `${at}.package`) ??
    findStringError(value.version, SEMVER, `${at}.version`) ??
    findOverridesError(value.overrides, `${at}.overrides`)
  );
}

function findHarnessPackError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object`;
  if (value.kind === "git-setup") return findGitSetupPackError(value, at);
  if (value.kind === "npm-lock") return findNpmLockPackError(value, at);
  return `${at}.kind: must be one of ${HARNESS_KINDS.join(", ")}`;
}

/**
 * First human-readable error in `value` as a harness manifest, naming the
 * offending path (e.g. `packs[2].toolAllowlist[0]: …`), or undefined if valid.
 */
export function findHarnessManifestError(value: unknown): string | undefined {
  if (!isRecord(value)) return "manifest: must be a JSON object";
  const shapeError =
    findUnsafeCharError(value, "") ??
    findUnknownKey(value, TOP_KEYS, "") ??
    (value.schemaVersion === 1 ? undefined : "schemaVersion: must be 1") ??
    findListError(value.packs, "packs", findHarnessPackError, {
      allowEmpty: false,
    });
  if (shapeError !== undefined) return shapeError;
  // The shape checks above proved this type.
  const packs = value.packs as HarnessPack[];
  const ids = packs.map((p) => p.id);
  return (
    findDuplicateError(packs, "id", "packs") ??
    (ids.length === HARNESS_PACK_IDS.length &&
    ids.every((id, index) => id === HARNESS_PACK_IDS[index])
      ? undefined
      : `packs: ids must be exactly ${HARNESS_PACK_IDS.join(", ")}, in that order`)
  );
}

export function isHarnessManifest(value: unknown): value is HarnessManifest {
  return findHarnessManifestError(value) === undefined;
}

/** What validateHarnessPackTree found; paths are relative to the pack dir. */
export interface HarnessTreeReport {
  /** Any entry fails the pack. */
  errors: string[];
  /** Upstream config files (HARNESS_DISCARD_NAMES) that are never linked. */
  discard: string[];
}

/**
 * A TOP-LEVEL YAML key (no indent), bare or quoted with matching quotes:
 * `hooks:`, `'hooks':`, `"hooks" :`. Indented lines are nested keys and are
 * skipped by the caller, so they can never be mistaken for one.
 */
const FRONTMATTER_KEY = /^(["']?)([A-Za-z0-9_-]+)\1[ \t]*:/;

/** A leading `---` frontmatter block, reduced to what the harness profile checks. */
export interface Frontmatter {
  /** Top-level keys, quotes removed. */
  keys: string[];
  /**
   * True when a top-level line is neither a key, a comment, a list item nor
   * an indented continuation (a flow mapping `{hooks: …}`, a `?` complex key,
   * a `<<` merge): keys could hide there, so the caller fails closed.
   */
  opaque: boolean;
}

/** A frontmatter fence as lenient parsers accept it: `---` plus trailing blanks. */
const FRONTMATTER_FENCE = /^---[ \t]*$/;

/**
 * Parses the leading `---` block. Fails closed on every variant a lenient
 * parser might still read as frontmatter: a leading BOM is stripped, CRLF and
 * CR become LF, and a fence may carry trailing blanks. A first line that
 * starts with `---` but is no fence, or a block with no closing fence, is
 * `opaque` (keys found so far are still reported). No leading `---` = none.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const first = lines[0] ?? "";
  if (!first.startsWith("---")) return { keys: [], opaque: false };
  if (!FRONTMATTER_FENCE.test(first)) return { keys: [], opaque: true };
  const keys: string[] = [];
  let opaque = false;
  for (const line of lines.slice(1)) {
    if (FRONTMATTER_FENCE.test(line)) return { keys, opaque };
    if (line.trim() === "" || /^[\s#]/.test(line) || line.startsWith("- ")) {
      continue;
    }
    const key = FRONTMATTER_KEY.exec(line)?.[2];
    if (key === undefined) {
      opaque = true;
    } else {
      keys.push(key);
    }
  }
  // No closing fence: a lenient parser may still read the block.
  return { keys, opaque: true };
}

function findFrontmatterErrors(
  relPath: string,
  text: string,
  hookSkills: readonly string[],
): string[] {
  const errors: string[] = [];
  const skill =
    path.posix.basename(relPath) === "SKILL.md"
      ? path.posix.basename(path.posix.dirname(relPath))
      : undefined;
  const { keys, opaque } = parseFrontmatter(text);
  if (opaque) {
    errors.push(
      `${relPath}: frontmatter has a top-level line that is not a plain key`,
    );
  }
  for (const key of keys) {
    if (HARNESS_FORBIDDEN_FRONTMATTER_KEYS.includes(key)) {
      errors.push(`${relPath}: frontmatter declares ${key}`);
    } else if (
      key === "hooks" &&
      (skill === undefined || !hookSkills.includes(skill))
    ) {
      errors.push(
        `${relPath}: frontmatter declares hooks outside frontmatterHookSkills`,
      );
    }
  }
  return errors;
}

/** `.md` in any case: a case-insensitive filesystem serves `X.MD` as markdown too. */
function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

/**
 * Checks an installed harness pack dir against the harness profile. Pure apart
 * from reads; never follows a symlink and never throws for a bad entry.
 *
 * - A symlink must resolve (realpath) strictly inside the pack's real dir;
 *   a dangling or escaping link is an error.
 * - `bin/` and `hooks/` are allowed, and installed files are exempt from
 *   batteries.json `forbiddenHelperTokens` (the helpers ARE the pack).
 * - HARNESS_DISCARD_NAMES outside node_modules are reported in `discard`
 *   (never linked); inside node_modules they are package data.
 * - Markdown frontmatter outside node_modules (any-case `.md`, including an
 *   in-pack symlink named `.md`, checked under the link's path): `allowed-tools`
 *   is allowed, `hooks` only in the SKILL.md of a `frontmatterHookSkills`
 *   skill, and `mcpServers`/`permissionMode` never.
 */
export function validateHarnessPackTree(
  packDir: string,
  { frontmatterHookSkills }: { frontmatterHookSkills: readonly string[] },
): HarnessTreeReport {
  const report: HarnessTreeReport = { errors: [], discard: [] };
  const realPackDir = fs.realpathSync(packDir);
  const walk = (relDir: string, inNodeModules: boolean): void => {
    const entries = fs
      .readdirSync(path.join(realPackDir, relDir), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const absPath = path.join(realPackDir, relPath);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(absPath);
        } catch {
          report.errors.push(`${relPath}: dangling symlink`);
          continue;
        }
        if (!target.startsWith(realPackDir + path.sep)) {
          report.errors.push(`${relPath}: symlink escapes the pack dir`);
        } else if (
          !inNodeModules &&
          isMarkdownName(entry.name) &&
          fs.statSync(target).isFile()
        ) {
          // Claude Code loads the file under the LINK's path, so the link's
          // skill dir decides whether its hooks are allowed.
          report.errors.push(
            ...findFrontmatterErrors(
              relPath,
              fs.readFileSync(target, "utf8"),
              frontmatterHookSkills,
            ),
          );
        }
        continue;
      }
      if (!inNodeModules && HARNESS_DISCARD_NAMES.includes(entry.name)) {
        report.discard.push(relPath);
        continue;
      }
      if (entry.isDirectory()) {
        walk(relPath, inNodeModules || entry.name === "node_modules");
        continue;
      }
      if (!inNodeModules && entry.isFile() && isMarkdownName(entry.name)) {
        report.errors.push(
          ...findFrontmatterErrors(
            relPath,
            fs.readFileSync(absPath, "utf8"),
            frontmatterHookSkills,
          ),
        );
      }
    }
  };
  walk("", false);
  return report;
}
