import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  HARNESS_PACK_DIR_PLACEHOLDER,
  type HarnessManifest,
  type HarnessPack,
} from "./harness-manifest";

/**
 * The on-box layout of an installed harness pack: the contract between
 * install-batteries.sh (the writer) and the worker (harness-seed.ts, the
 * reader). Both sides read the names below; change them together.
 *
 *   <root>/harness.sha256          computeHarnessManifestHash over the
 *                                  installer's checkout; renamed to
 *                                  harness.sha256.invalid by a failed harness
 *                                  install (manifest.sha256 is never touched)
 *   <root>/<id>@<pin>/             {{packDir}}; pin = sha (git-setup,
 *                                  plugin-tarball) or version (npm-lock)
 *     .stamp                       `stamp <64 hex>` first, and a `node <major>`
 *                                  line: the Node major the native modules
 *                                  were built against
 *     claude/                      the only subtree linked into a run HOME:
 *       skills/<name>/             (a dir, or an in-pack symlink to one)
 *       agents/*, commands/*       files and subdirs
 *       <HARNESS_SHARED_DIRS>      pack-wide dirs the pack's own text names
 *                                  as ~/.claude/<dir> (gsd: gsd-core)
 *     bin/ruflo-mcp                ruflo's MCP wrapper (env -i + tool filter)
 *     bin/bun                      gstack's runtime (a dependency's installTo;
 *                                  bin/ is the pack's pathDirs entry, prepended
 *                                  to the agent's PATH)
 *     mcp-tools.json               optional: every tool the UNFILTERED MCP
 *                                  server registers (a JSON string array)
 *     ms-playwright/               gstack's Chromium (PLAYWRIGHT_BROWSERS_PATH)
 *     src/<paths>                  a plugin-tarball pack's verified subtrees;
 *                                  its claude/ entries are links into them
 *     bin/<wrapper>                a plugin-tarball pack's env-aliasing shims
 *
 * Everything is root-owned and not group/other-writable; symlinks resolve
 * inside their own pack dir.
 */

export const HARNESS_HASH_FILE = "harness.sha256";
export const HARNESS_HASH_INVALID_FILE = "harness.sha256.invalid";
export const HARNESS_STAMP_FILE = ".stamp";
export const HARNESS_CLAUDE_DIR = "claude";
export const HARNESS_MCP_TOOLS_FILE = "mcp-tools.json";

/** `<claude>/<dir>/<entry>` link classes: one link per entry. */
export const HARNESS_LINK_DIRS = ["skills", "agents", "commands"] as const;

/** Top-level `<claude>/<dir>` linked whole, per pack. */
export const HARNESS_SHARED_DIRS: Readonly<Record<string, readonly string[]>> =
  {
    gsd: ["gsd-core"],
  };

/** The pin in a pack dir's name: the commit for git-setup and plugin-tarball, the version for npm-lock. */
export function harnessPackPin(pack: HarnessPack): string {
  return pack.kind === "npm-lock" ? pack.version : pack.sha;
}

export function harnessPackDirName(pack: HarnessPack): string {
  return `${pack.id}@${harnessPackPin(pack)}`;
}

/** A manifest value with its leading {{packDir}} replaced by the real pack dir. */
export function resolvePackDirTemplate(value: string, packDir: string): string {
  return value.startsWith(HARNESS_PACK_DIR_PLACEHOLDER)
    ? `${packDir}${value.slice(HARNESS_PACK_DIR_PLACEHOLDER.length)}`
    : value;
}

/**
 * The installer's harness hash recipe: sha256 over the harness.json bytes,
 * then, in manifest order, each pack's repo-relative `lockOverlay` when it names
 * one (the key arrives with the npm-lock installer; a pack without it adds
 * nothing).
 */
export async function computeHarnessManifestHash(
  manifestBytes: Buffer,
  manifest: HarnessManifest,
  repoRoot: string,
): Promise<string> {
  const hash = createHash("sha256").update(manifestBytes);
  for (const pack of manifest.packs) {
    const lockOverlay = (pack as { lockOverlay?: unknown }).lockOverlay;
    if (typeof lockOverlay === "string") {
      hash.update(await fs.readFile(path.join(repoRoot, lockOverlay)));
    }
  }
  return hash.digest("hex");
}

export interface HarnessStamp {
  stamp: string;
  /** The `node <major>` line; undefined when absent or malformed. */
  nodeMajor?: number;
}

/** A `.stamp` file's text, or undefined when its first line is not `stamp <64 hex>`. */
export function parseHarnessStamp(text: string): HarnessStamp | undefined {
  const lines = text.split("\n").map((line) => line.trim());
  const first = /^stamp ([0-9a-f]{64})$/.exec(lines[0] ?? "");
  if (first?.[1] === undefined) return undefined;
  const node = lines
    .map((line) => /^node (\d+)$/.exec(line)?.[1])
    .find((major) => major !== undefined);
  return {
    stamp: first[1],
    ...(node !== undefined ? { nodeMajor: Number(node) } : {}),
  };
}
