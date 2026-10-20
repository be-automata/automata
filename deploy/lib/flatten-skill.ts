/**
 * Push-time flattening of a skill body (A5): shared partials and pinned
 * remote files are inlined BEFORE the body is validated and stored, so the
 * stored version is the exact, self-contained text the agent reads. The agent
 * never resolves an include itself (it has no file outside the checkout and
 * no WebFetch), so an unflattened directive would reach it as literal text.
 *
 * Two whole-line directives:
 *   `<!-- include: <name> -->`         → `<skill dir>/../_shared/<name>.md`,
 *                                        frontmatter stripped; may nest once
 *                                        more (depth ≤ MAX_INCLUDE_DEPTH).
 *   `<!-- include-pinned: <url> -->`   → the file at a raw.githubusercontent
 *                                        URL pinned to a 40-hex commit,
 *                                        fetched now and inlined verbatim
 *                                        under a `#### <file> (pinned …)`
 *                                        heading. Never processed further.
 *
 * Fail closed: a missing partial, a too-deep include, an unpinned URL, a
 * non-200 or a network error throws, and the caller writes nothing — a skill
 * never ships with half its standards. Any other line that starts with
 * `<!-- include` is a malformed directive and throws too.
 *
 * Deterministic: the output depends only on the body, the partials and the
 * pinned bytes (immutable at a commit), so the same inputs give the same
 * contentSha and a re-push is a no-op.
 *
 * Node builtins only, and the frontmatter stripper and validator are passed
 * in: CI runs deploy/*.test.ts with `node --test` (type stripping, no tsx),
 * which cannot load the www module that owns them.
 */
import { createHash } from "node:crypto";

/** A partial may include one more partial; a third level is an error. */
export const MAX_INCLUDE_DEPTH = 2;

const DIRECTIVE_PREFIX = "<!-- include";
const INCLUDE_LINE = /^<!-- include: ([a-z0-9-]+) -->[ \t]*\r?$/;
const INCLUDE_PINNED_LINE = /^<!-- include-pinned: (\S+) -->[ \t]*\r?$/;

/** The only URLs `include-pinned` accepts: raw GitHub content at a full commit sha. */
export const PINNED_URL =
  /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+\.md)$/;

/** The subset of `fetch` the flattener needs; tests pass a fake. */
export type FetchText = (
  url: string,
) => Promise<{ status: number; text(): Promise<string> }>;

export type FlattenOptions = {
  /** Returns the raw text of `_shared/<name>.md`; throws when it is missing. */
  readPartial: (name: string) => string;
  /** Fetches a pinned URL. */
  fetchText: FetchText;
  /** The skill-store frontmatter stripper (review-skill.ts `stripFrontmatter`). */
  stripFrontmatter: (md: string) => string;
};

export class FlattenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlattenError";
  }
}

/** Heading that introduces one inlined pinned file. */
export function pinnedHeading(url: string): string {
  const match = PINNED_URL.exec(url);
  if (!match) {
    throw new FlattenError(`not a pinned raw.githubusercontent URL: ${url}`);
  }
  const [, owner, repo, sha, filePath] = match;
  const basename = filePath!.split("/").pop()!;
  return `#### ${basename} (pinned ${owner}/${repo}@${sha!.slice(0, 7)})`;
}

async function fetchPinned(
  url: string,
  where: string,
  options: FlattenOptions,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(url);
  if (cached !== undefined) return cached;
  let response: Awaited<ReturnType<FetchText>>;
  try {
    response = await options.fetchText(url);
  } catch (err) {
    throw new FlattenError(
      `${where}: fetching ${url} failed: ${(err as Error).message}`,
    );
  }
  if (response.status !== 200) {
    throw new FlattenError(
      `${where}: fetching ${url} returned HTTP ${response.status} (expected 200)`,
    );
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new FlattenError(
      `${where}: reading ${url} failed: ${(err as Error).message}`,
    );
  }
  cache.set(url, text);
  return text;
}

async function expand(
  text: string,
  level: number,
  source: string,
  options: FlattenOptions,
  cache: Map<string, string>,
): Promise<string> {
  // A body with no directive comes back as the very same string.
  if (!text.includes(DIRECTIVE_PREFIX)) return text;
  const out: string[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trimStart().startsWith(DIRECTIVE_PREFIX)) {
      out.push(line);
      continue;
    }
    const where = `${source} line ${index + 1}`;
    const depth = level + 1;
    const include = INCLUDE_LINE.exec(line);
    const pinned = include ? null : INCLUDE_PINNED_LINE.exec(line);
    if (!include && !pinned) {
      throw new FlattenError(
        `${where}: malformed include directive ${JSON.stringify(line.trim())} ` +
          `(expected a whole line "<!-- include: <name> -->" with <name> in ` +
          `[a-z0-9-], or "<!-- include-pinned: <url> -->")`,
      );
    }
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new FlattenError(
        `${where}: include nested deeper than ${MAX_INCLUDE_DEPTH} levels`,
      );
    }
    if (include) {
      const name = include[1]!;
      let raw: string;
      try {
        raw = options.readPartial(name);
      } catch (err) {
        throw new FlattenError(
          `${where}: partial "${name}" not found: ${(err as Error).message}`,
        );
      }
      out.push(
        await expand(
          options.stripFrontmatter(raw),
          depth,
          `_shared/${name}.md`,
          options,
          cache,
        ),
      );
      continue;
    }
    const url = pinned![1]!;
    if (!PINNED_URL.test(url)) {
      throw new FlattenError(
        `${where}: include-pinned URL must be raw.githubusercontent.com at a ` +
          `40-hex commit sha and end in .md, got: ${url}`,
      );
    }
    const content = await fetchPinned(url, where, options, cache);
    out.push(`${pinnedHeading(url)}\n\n${content}`);
  }
  return out.join("\n");
}

/** Inline every include / include-pinned directive in `body`. */
export async function flattenSkillBody(
  body: string,
  options: FlattenOptions,
  sourceLabel = "skill body",
): Promise<string> {
  return expand(body, 0, sourceLabel, options, new Map());
}

/** The stored version's contentSha (same hash as repo-skills `computeContentSha`). */
export function skillBodySha(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export type PreparedSkillBody = {
  body: string;
  sha: string;
  bytes: number;
};

/**
 * The push pipeline up to (not including) the DB write: strip frontmatter,
 * flatten, validate, then hand the body to `writeOut` (the `--out` file).
 * Each step runs only when the previous one succeeded, so a flatten or
 * validation failure leaves nothing written anywhere.
 */
export async function prepareSkillBody({
  raw,
  skillName,
  label,
  flatten,
  validate,
  writeOut,
}: {
  raw: string;
  skillName: string;
  label: string;
  flatten: FlattenOptions;
  validate: (skillName: string, body: string, label: string) => void;
  writeOut?: (body: string) => void;
}): Promise<PreparedSkillBody> {
  const body = await flattenSkillBody(
    flatten.stripFrontmatter(raw),
    flatten,
    label,
  );
  validate(skillName, body, label);
  writeOut?.(body);
  return {
    body,
    sha: skillBodySha(body),
    bytes: Buffer.byteLength(body, "utf8"),
  };
}
