// Multi-file unified-diff parser: one entry per changed text file of a merge diff.
//
// Contract with the caller (Phase 13 worker): the diff is produced with
//   git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv -U0 -M <from> <to>
// The engine never shells out to git. Anything outside that contract that would otherwise parse
// silently wrong (ANSI color codes, missing a/ b/ prefixes, copy detection, a section whose paths
// cannot be determined) throws MalformedDiffError instead of yielding zero hunks.
//
// Diff paths come from untrusted repositories. They are map keys and repo:// targets only, never
// filesystem paths: this module does not touch the filesystem and callers must not either.
// Header lines are read with startsWith/slice; the only regex is parseHunks' anchored, linear one.

import { parseHunks, type Hunk } from "./reanchor";

export type FileDiffStatus = "modified" | "added" | "deleted" | "renamed";

export interface ParsedFileDiff {
  /** Path in the new tree; for a deleted file, the path it had in the old tree. */
  path: string;
  /** Set for a rename only: the path in the old tree. */
  oldPath?: string;
  status: FileDiffStatus;
  hunks: Hunk[];
}

export class MalformedDiffError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`malformed diff: ${reason}`);
    this.name = "MalformedDiffError";
    this.reason = reason;
  }
}

const DIFF_HEADER = "diff --git ";
const DEV_NULL = "/dev/null";
const ESC = "\u001b";
const OCTAL_DIGIT = /^[0-7]$/;
const C_ESCAPES: ReadonlyMap<string, number> = new Map([
  ['"', 0x22],
  ["\\", 0x5c],
  ["t", 0x09],
  ["n", 0x0a],
  ["r", 0x0d],
  ["a", 0x07],
  ["b", 0x08],
  ["f", 0x0c],
  ["v", 0x0b],
]);

const stripCr = (line: string) =>
  line.endsWith("\r") ? line.slice(0, -1) : line;

/** Decode a git C-quoted path (`"a/caf\303\251.md"`): \" \\ \t \n and friends plus \ooo octal bytes. */
function unquote(quoted: string): { value: string; rest: string } {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  // Index 0 is the opening quote.
  let i = 1;
  while (i < quoted.length) {
    const ch = quoted.charAt(i);
    if (ch === '"') {
      return {
        value: new TextDecoder().decode(new Uint8Array(bytes)),
        rest: quoted.slice(i + 1),
      };
    }
    if (ch !== "\\") {
      const cp = quoted.codePointAt(i) ?? 0;
      const s = String.fromCodePoint(cp);
      bytes.push(...encoder.encode(s));
      i += s.length;
      continue;
    }
    const next = quoted.charAt(i + 1);
    const mapped = C_ESCAPES.get(next);
    if (mapped !== undefined) {
      bytes.push(mapped);
      i += 2;
      continue;
    }
    let j = i + 1;
    while (j < i + 4 && OCTAL_DIGIT.test(quoted.charAt(j))) j++;
    if (j === i + 1) {
      throw new MalformedDiffError(
        `bad escape in quoted path ${JSON.stringify(quoted)}`,
      );
    }
    const byte = parseInt(quoted.slice(i + 1, j), 8);
    if (byte > 0xff) {
      throw new MalformedDiffError(
        `bad octal escape in quoted path ${JSON.stringify(quoted)}`,
      );
    }
    bytes.push(byte);
    i = j;
  }
  throw new MalformedDiffError(
    `unterminated quoted path ${JSON.stringify(quoted)}`,
  );
}

/** A path value from a `rename from`/`rename to` line (no a/ b/ prefix). */
function plainPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const { value, rest } = unquote(raw);
  if (rest !== "")
    throw new MalformedDiffError(
      `trailing text after path ${JSON.stringify(raw)}`,
    );
  return value;
}

/** A `---`/`+++` side: null for /dev/null, else the path with its a/ or b/ prefix removed. */
function sidePath(raw: string, prefix: "a/" | "b/"): string | null {
  if (raw === DEV_NULL) return null;
  let value: string;
  if (raw.startsWith('"')) {
    const parsed = unquote(raw);
    if (parsed.rest !== "" && parsed.rest !== "\t") {
      throw new MalformedDiffError(
        `trailing text after path ${JSON.stringify(raw)}`,
      );
    }
    value = parsed.value;
  } else {
    // git appends a tab to an unquoted name that contains a space.
    value = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  }
  if (!value.startsWith(prefix)) {
    throw new MalformedDiffError(
      `path ${JSON.stringify(raw)} lacks the ${prefix} prefix`,
    );
  }
  return value.slice(prefix.length);
}

/** The `diff --git a/X b/X` line, trusted only when both halves are the same path. */
function equalHalves(rest: string): string {
  if (rest.startsWith('"')) {
    const a = unquote(rest);
    if (a.rest.startsWith(' "')) {
      const b = unquote(a.rest.slice(1));
      if (
        b.rest === "" &&
        a.value.startsWith("a/") &&
        b.value.startsWith("b/")
      ) {
        const x = a.value.slice(2);
        if (b.value.slice(2) === x && x !== "") return x;
      }
    }
  } else if ((rest.length - 5) % 2 === 0 && rest.length > 5) {
    const x = rest.slice(2, 2 + (rest.length - 5) / 2);
    if (rest === `a/${x} b/${x}`) return x;
  }
  throw new MalformedDiffError(
    `cannot determine the path of ${JSON.stringify(DIFF_HEADER + rest)}`,
  );
}

function parseSection([first, ...rest]: [
  string,
  ...string[],
]): ParsedFileDiff | null {
  const header = stripCr(first);
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let newFile = false;
  let deletedFile = false;
  let binary = false;
  let minus: string | null | undefined;
  let plus: string | null | undefined;
  let bodyStart = rest.length;

  for (const [i, raw] of rest.entries()) {
    if (raw.startsWith("@@")) {
      bodyStart = i;
      break;
    }
    const line = stripCr(raw);
    if (line.startsWith("rename from ")) renameFrom = plainPath(line.slice(12));
    else if (line.startsWith("rename to "))
      renameTo = plainPath(line.slice(10));
    else if (line.startsWith("new file mode")) newFile = true;
    else if (line.startsWith("deleted file mode")) deletedFile = true;
    else if (line.startsWith("--- ")) minus = sidePath(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) plus = sidePath(line.slice(4), "b/");
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      binary = true;
    } else if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
      throw new MalformedDiffError(
        "copy detection is not supported: produce the diff with -M, not -C",
      );
    }
  }

  if (binary) return null;
  const body = rest.slice(bodyStart);
  const hunks = parseHunks(body.join("\n"));
  const where = JSON.stringify(header);
  // Every @@ line must be a hunk header parseHunks read, or the file would silently lose hunks.
  if (body.filter((l) => l.startsWith("@@")).length !== hunks.length) {
    throw new MalformedDiffError(`unparseable hunk header in ${where}`);
  }
  // A context line means the diff was not produced with -U0: its hunks would cover the context too.
  if (body.some((l) => l.startsWith(" "))) {
    throw new MalformedDiffError(
      `context lines in ${where}: produce the diff with -U0`,
    );
  }
  const renamed = renameFrom !== undefined || renameTo !== undefined;
  if (hunks.length === 0 && !renamed && !newFile && !deletedFile) return null; // mode-only

  if ((minus === undefined) !== (plus === undefined)) {
    throw new MalformedDiffError(`missing ---/+++ line in ${where}`);
  }
  if (renameFrom !== undefined && renameTo !== undefined) {
    return { path: renameTo, oldPath: renameFrom, status: "renamed", hunks };
  }
  if (renamed) throw new MalformedDiffError(`incomplete rename in ${where}`);

  if (minus === undefined || plus === undefined) {
    if (hunks.length > 0) {
      throw new MalformedDiffError(`hunks without ---/+++ lines in ${where}`);
    }
    // Empty added or deleted file: git prints no ---/+++ lines, only the diff --git header.
    const path = equalHalves(header.slice(DIFF_HEADER.length));
    return { path, status: newFile ? "added" : "deleted", hunks };
  }
  if (minus === null || newFile) {
    if (plus === null) {
      throw new MalformedDiffError(`both sides are ${DEV_NULL} in ${where}`);
    }
    return { path: plus, status: "added", hunks };
  }
  if (plus === null || deletedFile)
    return { path: minus, status: "deleted", hunks };
  if (minus !== plus) {
    throw new MalformedDiffError(`paths differ without a rename in ${where}`);
  }
  return { path: plus, status: "modified", hunks };
}

/** Parse a multi-file `git diff --no-color -U0 -M` text; binary and mode-only entries are skipped. */
export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  if (text.includes(ESC)) {
    throw new MalformedDiffError(
      "colored diff: produce it with git diff --no-color",
    );
  }
  const sections: [string, ...string[]][] = [];
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith(DIFF_HEADER)) {
      const section: [string, ...string[]] = [line];
      sections.push(section);
      current = section;
    } else if (current) current.push(line);
    else if (line.trim() !== "") {
      throw new MalformedDiffError("text before the first diff --git header");
    }
  }
  const files: ParsedFileDiff[] = [];
  for (const section of sections) {
    const file = parseSection(section);
    if (file) files.push(file);
  }
  return files;
}
