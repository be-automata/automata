// Grounded claims: each claim pins one atomic fact to hashed evidence spans in any source.
//   repo://<path>#L<a>-L<b>       line range in a code or doc file
//   ticket://<id>#/<json/pointer>  field of a support ticket
//   doc://<slug>#<heading-slug>    section of a human-written doc
// Checking a page against its sources needs no model. Only claims whose sources all changed
// consistently go to the model, and every op that changes what a page says is a reviewable
// proposal keyed by opKey (page, claim and source revision).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { classifyEvidence, type EvidenceClass } from "./evidence-class";
import { assertOpKeyPart, opKey, parseOpKey } from "./op-key";
import { reanchorSpan, type Hunk, type LineSpan } from "./reanchor";

export interface EvidencePin {
  uri: string;
  /**
   * Identity of the pinned span's content, in one of two self-describing forms:
   * - bare 16 hex: whitespace-collapsed (prose pins, and legacy pins written before ENG-03; a legacy
   *   bare hash on a code file keeps verifying whitespace-tolerantly until its next repin or update);
   * - `x:` + 16 hex: the exact text, whitespace and line endings included (code and config pins).
   * The stored form, never the URI, decides how the hash is compared.
   */
  hash: string;
}
export interface Claim {
  id: string;
  statement: string;
  evidence: EvidencePin[];
}
export interface Sidecar {
  page: string;
  /** sha256 of the page markdown when the agent last wrote or verified it. */
  pageVersion: string;
  claims: Claim[];
}
/** past-eof: a line range now ends beyond the file (it may have moved up); gone: the target no longer exists. */
export type MissingCode = "past-eof" | "gone";
export type EvidenceStatus =
  | { kind: "fresh"; uri: string }
  | { kind: "relocated"; uri: string; newUri: string }
  | { kind: "stale"; uri: string; now: string }
  | { kind: "ambiguous"; uri: string; candidates: string[] }
  | { kind: "missing"; uri: string; reason: string; code: MissingCode };
// conflict  = sources that used to agree now disagree (code says 30 days, marketing still says 14).
// degraded  = some evidence vanished but the rest still holds; the fact may be fine, a human decides.
// ambiguous = the pinned text now appears in several places; re-grounding would be a guess.
export type ClaimStatus =
  | "fresh"
  | "relocated"
  | "stale"
  | "conflict"
  | "degraded"
  | "ambiguous"
  | "missing"
  | "orphaned";
export interface ClaimReport {
  id: string;
  status: ClaimStatus;
  evidence: EvidenceStatus[];
}
export interface PageReport {
  page: string;
  humanEdited: boolean;
  claims: ClaimReport[];
}
export type Resolved =
  | { text: string }
  | { missing: string; code: MissingCode }
  | { ambiguous: string[] };

export class InvalidEvidenceUriError extends Error {
  readonly uri: string;
  constructor(uri: string, reason: string) {
    super(`invalid evidence uri ${uri}: ${reason}`);
    this.name = "InvalidEvidenceUriError";
    this.uri = uri;
  }
}

const sha = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);
/** The identity of a prose span's content. Whitespace-only edits must not flip a prose claim. */
const fingerprint = (text: string) => sha(text.replace(/\s+/g, " ").trim());
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Marks a hash of the exact text (code and config), so a stored hash says how to compare it. */
const EXACT_HASH_PREFIX = "x:";
type HashMode = EvidenceClass;
function hashAs(mode: HashMode, text: string): string {
  // Exact: the text as resolved, no trim and no CRLF normalization (a line-ending change is a change).
  return mode === "exact" ? EXACT_HASH_PREFIX + sha(text) : fingerprint(text);
}
const modeOfHash = (hash: string): HashMode =>
  hash.startsWith(EXACT_HASH_PREFIX) ? "exact" : "prose";
/** The class a new pin on this URI gets. Comparing an existing pin uses modeOfHash instead. */
function classOfUri(uri: string): HashMode {
  const { scheme, target } = parseUri(uri);
  return classifyEvidence(scheme, target);
}
const matchesHash = (stored: string, text: string) =>
  hashAs(modeOfHash(stored), text) === stored;
/** A stale span as the updater sees it: exact text keeps its indentation, prose is collapsed. */
const nowText = (mode: HashMode, text: string) =>
  mode === "exact" ? text.replace(/\n$/, "") : norm(text);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const LINE_ANCHOR = /^L(\d+)-L(\d+)$/;
const HEADING = /^(#{1,6}) /;
/** A `..` segment, an absolute path, a backslash or a NUL: anything that could name a file outside its source. */
const UNSAFE_TARGET = /(^|\/)\.\.(\/|$)|^\/|\\|\0/;
const repoUri = (target: string, [a, b]: LineSpan) =>
  `repo://${target}#L${a}-L${b}`;

export function parseUri(uri: string) {
  const m = /^(repo|ticket|doc):\/\/([^#]+)#(.+)$/.exec(uri);
  const [, scheme, target, anchor] = m ?? [];
  if (!scheme || !target || !anchor)
    throw new InvalidEvidenceUriError(
      uri,
      "expected <scheme>://<target>#<anchor>",
    );
  // URIs come from model output too: a target must never reach outside the corpus.
  if (UNSAFE_TARGET.test(target))
    throw new InvalidEvidenceUriError(
      uri,
      "target must stay inside its source",
    );
  return { scheme: scheme as "repo" | "ticket" | "doc", target, anchor };
}

/**
 * The file a URI names inside one source directory, or null when it does not exist. A symlink is followed
 * only while it stays inside that source: a committed link to a host file is not evidence.
 */
function sourceFile(
  root: string,
  dir: string,
  file: string,
  uri: string,
): string | null {
  const p = join(root, dir, file);
  if (!existsSync(p)) return null;
  const real = realpathSync(p);
  if (!real.startsWith(realpathSync(join(root, dir)) + sep))
    throw new InvalidEvidenceUriError(
      uri,
      "target resolves outside its source",
    );
  // A directory (or socket, device) holds no evidence text.
  return statSync(real).isFile() ? real : null;
}

function lineAnchor(uri: string, anchor: string): LineSpan {
  const r = LINE_ANCHOR.exec(anchor);
  const [a, b] = [Number(r?.[1]), Number(r?.[2])];
  if (!r || !(a >= 1 && a <= b))
    throw new InvalidEvidenceUriError(uri, `bad line anchor ${anchor}`);
  return [a, b];
}

interface DocSection {
  slug: string;
  body: string;
}
/** Sections in file order: the body runs from after the heading to the next heading of the same or higher level. */
function docSections(lines: string[]): DocSection[] {
  const out: DocSection[] = [];
  lines.forEach((line, start) => {
    const level = HEADING.exec(line)?.[1]?.length;
    if (level === undefined) return;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const h = HEADING.exec(lines[i] ?? "")?.[1]?.length;
      if (h !== undefined && h <= level) {
        end = i;
        break;
      }
    }
    out.push({
      slug: slug(line.replace(/^#+ /, "")),
      body: lines.slice(start + 1, end).join("\n"),
    });
  });
  return out;
}
const readSections = (root: string, target: string, uri: string) => {
  const p = sourceFile(root, "docs", `${target}.md`, uri);
  return p ? docSections(readFileSync(p, "utf8").split("\n")) : null;
};

/**
 * Resolve a URI to its current text, a reason it is gone, or the candidates when the anchor no longer
 * names one place (two doc sections share the pinned heading slug).
 */
export function resolve(root: string, uri: string): Resolved {
  const { scheme, target, anchor } = parseUri(uri);
  if (scheme === "repo") {
    const [a, b] = lineAnchor(uri, anchor);
    const p = sourceFile(root, "repo", target, uri);
    if (!p) return { missing: "file deleted", code: "gone" };
    const lines = readFileSync(p, "utf8").split("\n");
    if (b > lines.length)
      return { missing: "range past end of file", code: "past-eof" };
    return { text: lines.slice(a - 1, b).join("\n") };
  }
  if (scheme === "ticket") {
    const p = sourceFile(root, "tickets", `${target}.json`, uri);
    if (!p) return { missing: "ticket deleted", code: "gone" };
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      // One unreadable ticket loses that piece of evidence, not the whole page.
      if (e instanceof SyntaxError)
        return { missing: "ticket is not valid JSON", code: "gone" };
      throw e;
    }
    // RFC 6901: own properties only (never `constructor` off the prototype), with ~1 and ~0 decoded.
    for (const raw of anchor.replace(/^\//, "").split("/")) {
      const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (v === null || typeof v !== "object" || !Object.hasOwn(v, key))
        return { missing: `field ${anchor} gone`, code: "gone" };
      v = (v as Record<string, unknown>)[key];
    }
    // Every value reached from JSON.parse serializes back to a string.
    return { text: typeof v === "string" ? v : JSON.stringify(v) };
  }
  const sections = readSections(root, target, uri);
  if (!sections) return { missing: "doc deleted", code: "gone" };
  const same = sections.filter((s) => s.slug === anchor);
  const [only] = same;
  if (!only) return { missing: `heading #${anchor} gone`, code: "gone" };
  return same.length > 1 ? { ambiguous: [uri] } : { text: only.body };
}

export function pin(root: string, uri: string): EvidencePin {
  const r = resolve(root, uri);
  if (!("text" in r))
    throw new InvalidEvidenceUriError(
      uri,
      `cannot pin: ${"missing" in r ? r.missing : "the anchor names several places"}`,
    );
  return { uri, hash: hashAs(classOfUri(uri), r.text) };
}

// Window indexes keyed by (content, width, hash mode), least recently used evicted past the cap. Keyed by content,
// not path, so a worker that checks out every run into a fresh directory reuses them and stays bounded.
const WINDOW_INDEX_CAP = 64;
const WINDOW_INDEX = new Map<string, Map<string, number[]>>();
function windowIndex(
  text: string,
  width: number,
  mode: HashMode,
): Map<string, number[]> {
  const key = `${sha(text)}\0${width}\0${mode}`;
  const cached = WINDOW_INDEX.get(key);
  if (cached) {
    WINDOW_INDEX.delete(key);
    WINDOW_INDEX.set(key, cached);
    return cached;
  }
  const lines = text.split("\n");
  const idx = new Map<string, number[]>();
  for (let i = 0; i + width <= lines.length; i++) {
    const h = hashAs(mode, lines.slice(i, i + width).join("\n"));
    const list = idx.get(h);
    if (list) list.push(i + 1);
    else idx.set(h, [i + 1]);
  }
  WINDOW_INDEX.set(key, idx);
  const [oldest] = WINDOW_INDEX.keys();
  if (WINDOW_INDEX.size > WINDOW_INDEX_CAP && oldest !== undefined)
    WINDOW_INDEX.delete(oldest);
  return idx;
}

/** Every place in the source that holds exactly this text (same width / same section body). */
function spansWithHash(
  root: string,
  uri: string,
  hash: string,
): string[] | null {
  const { scheme, target, anchor } = parseUri(uri);
  const mode = modeOfHash(hash);
  if (scheme === "doc") {
    const sections = readSections(root, target, uri);
    return sections
      ? sections
          .filter((s) => hashAs(mode, s.body) === hash)
          .map((s) => `doc://${target}#${s.slug}`)
      : null;
  }
  if (scheme !== "repo") return null;
  const [a, b] = lineAnchor(uri, anchor);
  const width = b - a + 1;
  const file = sourceFile(root, "repo", target, uri);
  if (!file) return null;
  const text = readFileSync(file, "utf8");
  return (windowIndex(text, width, mode).get(hash) ?? []).map((s) =>
    repoUri(target, [s, s + width - 1]),
  );
}

/**
 * `matches` counts every matching span; two doc sections with the same heading slug render as one URI
 * but are still two places the fact could live, so the claim is ambiguous.
 */
function relocation(e: EvidencePin, matches: string[]): EvidenceStatus | null {
  const [only] = matches;
  if (matches.length === 1 && only)
    return { kind: "relocated", uri: e.uri, newUri: only };
  // Two identical spans: refuse to guess. Never stale, never sent to the model (a human picks the span).
  if (matches.length > 1)
    return { kind: "ambiguous", uri: e.uri, candidates: [...new Set(matches)] };
  return null;
}

export function checkEvidence(root: string, e: EvidencePin): EvidenceStatus {
  const r = resolve(root, e.uri);
  if ("ambiguous" in r)
    return { kind: "ambiguous", uri: e.uri, candidates: r.ambiguous };
  const relocated = () =>
    relocation(e, spansWithHash(root, e.uri, e.hash) ?? []);
  if ("missing" in r)
    return (
      relocated() ?? {
        kind: "missing",
        uri: e.uri,
        reason: r.missing,
        code: r.code,
      }
    );
  if (matchesHash(e.hash, r.text)) return { kind: "fresh", uri: e.uri };
  return (
    relocated() ?? {
      kind: "stale",
      uri: e.uri,
      now: nowText(modeOfHash(e.hash), r.text),
    }
  );
}

const holds = (k: EvidenceStatus["kind"]) => k === "fresh" || k === "relocated";

/**
 * Precedence: missing > degraded > ambiguous > conflict > stale > relocated > fresh (orphaned is decided
 * before this). Missing evidence is the strongest signal; an ambiguous pin outranks change detection
 * because no change can be trusted while the claim's own location is unknown.
 */
function claimStatus(kinds: EvidenceStatus["kind"][]): ClaimStatus {
  // A claim with no evidence (a hand-built sidecar) grounds nothing: review it, never retract it.
  if (kinds.length === 0) return "degraded";
  if (kinds.every((k) => k === "missing")) return "missing";
  if (kinds.includes("missing")) return "degraded";
  if (kinds.includes("ambiguous")) return "ambiguous";
  if (kinds.includes("stale") && kinds.some(holds)) return "conflict";
  if (kinds.includes("stale")) return "stale";
  if (kinds.includes("relocated")) return "relocated";
  return "fresh";
}

export function checkPage(
  root: string,
  pageMd: string,
  sc: Sidecar,
): PageReport {
  const humanEdited = sha(pageMd) !== sc.pageVersion;
  const body = norm(pageMd);
  const claims = sc.claims.map((c): ClaimReport => {
    const evidence = c.evidence.map((e) => checkEvidence(root, e));
    // A human rewrote the sentence: the claim no longer describes the page. Never resurrect it.
    if (humanEdited && !body.includes(norm(c.statement)))
      return { id: c.id, status: "orphaned", evidence };
    return {
      id: c.id,
      status: claimStatus(evidence.map((e) => e.kind)),
      evidence,
    };
  });
  return { page: sc.page, humanEdited, claims };
}

// ---- reconciliation -------------------------------------------------------
// Only "repin" is mechanical (content identical, location moved) and auto-applies.
// Every op that changes what the page SAYS is a proposal a human approves.
export interface UpdateRequest {
  claim: Claim;
  evidence: EvidenceStatus[];
  /** Where each pin lives now (same order as claim.evidence). */
  newEvidence: string[];
  /** Lowest re-anchor similarity among the pins (1 when the diff alone located them). */
  reanchorScore: number;
}
export interface UpdateResult {
  id: string;
  statement: string;
  /**
   * Optional tighter evidence chosen by the updater (same length as newEvidence). Each URI must resolve
   * and be unique in its source, otherwise the claim becomes a review.
   */
  evidence?: string[];
}
export interface Updater {
  calls: number;
  /**
   * One batched model call with ONLY the claims whose sources changed coherently. A real model client is
   * async; a deterministic stand-in may answer synchronously.
   */
  rework(claims: UpdateRequest[]): Promise<UpdateResult[]> | UpdateResult[];
}
/** "add" and "reverify" are produced by callers (incremental seeding, unchanged-fact re-pins), not by reconcile. */
export type DraftOpKind =
  | "repin"
  | "update"
  | "reverify"
  | "add"
  | "conflict"
  | "retract"
  | "review";

interface OpKindRules {
  /** Applied without approval. Only reconcile mints auto ops. */
  auto: boolean;
  /** Changes the claim's statement or evidence when applied. */
  changesClaim: boolean;
  /** Carries a proposal (after + newEvidence) that survives a retarget. */
  keepsProposal: boolean;
}
const OP_KINDS = {
  repin: { auto: true, changesClaim: true, keepsProposal: false },
  update: { auto: false, changesClaim: true, keepsProposal: true },
  reverify: { auto: false, changesClaim: true, keepsProposal: true },
  retract: { auto: false, changesClaim: true, keepsProposal: false },
  add: { auto: false, changesClaim: false, keepsProposal: false },
  conflict: { auto: false, changesClaim: false, keepsProposal: false },
  review: { auto: false, changesClaim: false, keepsProposal: false },
} satisfies Record<DraftOpKind, OpKindRules>;

export interface DraftOp {
  /** opKey(op, page, claimId, sourceRev): approve or reject by this id. */
  id: string;
  claimId: string;
  op: DraftOpKind;
  auto: boolean;
  before: string;
  after?: string;
  why: string;
  evidence: string[];
  /** For update/reverify: the evidence URIs to pin when the op is applied. */
  newEvidence?: string[];
  /** Fingerprint of each newEvidence span when proposed: applyDraft refuses the op once the source moves on. */
  newEvidenceHash?: string[];
  /** Re-anchor similarity behind an update (1 = located by the diff alone). */
  score?: number;
}
export interface Draft {
  page: string;
  /** propose = a human edited the page since the agent last verified it. Informational: applyDraft re-derives it. */
  mode: "apply" | "propose";
  ops: DraftOp[];
  llmCalls: number;
}
export interface ReconcileDiff {
  /** The repo:// target this diff covers, as a path in the NEW tree (e.g. "deploy/PILOT-RUNBOOK.md"). */
  path: string;
  /** Set for a rename: pins on oldPath are re-targeted to path. */
  oldPath?: string;
  hunks: Hunk[];
  oldText: string;
  newText: string;
  floor?: number;
}
export interface ReconcileOptions {
  /** Source commit the evidence was checked at; part of every op key. Defaults to "working". */
  sourceRev?: string;
  /**
   * The diffs that produced this state, one per changed file. With them, every stale line pin is re-anchored
   * through the diff of ITS file (reanchorSpan) before anything reaches the model: below-floor, tied or
   * narrowed spans become reviews, deleted spans become retracts or reviews, and line pins on files absent
   * from the diffs (nothing to locate them with) become reviews. A pin on a renamed file's old path is
   * re-targeted to its new path. Without diffs (or with an empty list), a stale line pin is assumed to have
   * changed in place (positional re-pin). Passing both `diff` and `diffs` is an error.
   */
  diffs?: ReconcileDiff[];
  /** @deprecated single-file form, kept for existing callers: the same as `diffs: [diff]`. */
  diff?: ReconcileDiff;
}

export class ConflictingDiffOptionsError extends Error {
  constructor() {
    super("pass either diff or diffs, not both");
    this.name = "ConflictingDiffOptionsError";
  }
}

/** Two diff entries claim the same path (as new path or rename source): which one locates a pin is unknowable. */
export class DuplicateDiffPathError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`two diff entries name the path ${JSON.stringify(path)}`);
    this.name = "DuplicateDiffPathError";
    this.path = path;
  }
}

interface DiffLines {
  diff: ReconcileDiff;
  oldLines: string[];
  newLines: string[];
}
/** Each changed file's diff, keyed by its new path and (for a rename) its old path. */
type DiffIndex = Map<string, DiffLines>;

/**
 * Index the diffs once per reconcile, splitting each file's text once. Diff paths are untrusted and are only
 * ever map keys here: they become repo:// targets through repoUri and are read only through resolve().
 */
function buildDiffIndex(options: ReconcileOptions): DiffIndex | undefined {
  if (options.diff !== undefined && options.diffs !== undefined)
    throw new ConflictingDiffOptionsError();
  const diffs = options.diffs ?? (options.diff ? [options.diff] : undefined);
  if (!diffs || diffs.length === 0) return undefined;
  const idx: DiffIndex = new Map();
  for (const diff of diffs) {
    const lines: DiffLines = {
      diff,
      oldLines: diff.oldText.split("\n"),
      newLines: diff.newText.split("\n"),
    };
    const keys =
      diff.oldPath !== undefined && diff.oldPath !== diff.path
        ? [diff.path, diff.oldPath]
        : [diff.path];
    for (const key of keys) {
      if (idx.has(key)) throw new DuplicateDiffPathError(key);
      idx.set(key, lines);
    }
  }
  return idx;
}

/** The repo:// URI of a span in a diff's new path, or null when that path could name a file outside the repo. */
function newPathUri(d: DiffLines, span: LineSpan): string | null {
  const uri = repoUri(d.diff.path, span);
  try {
    parseUri(uri);
    return uri;
  } catch (e) {
    if (e instanceof InvalidEvidenceUriError) return null;
    throw e;
  }
}

type Located =
  | { kind: "located"; uri: string; score: number }
  | { kind: "review"; why: string }
  | { kind: "deleted" };

/** Where a pin lives after the diff. Ticket and doc anchors are semantic, so they never move. */
function locate(e: EvidenceStatus, idx: DiffIndex | undefined): Located {
  if (e.kind !== "stale" || !idx)
    return { kind: "located", uri: e.uri, score: 1 };
  const { scheme, target, anchor } = parseUri(e.uri);
  if (scheme !== "repo") return { kind: "located", uri: e.uri, score: 1 };
  const d = idx.get(target);
  if (!d)
    return {
      kind: "review",
      why: `no diff for ${target}: a line pin cannot be re-anchored, a human must locate this fact`,
    };
  const r = reanchorSpan({
    hunks: d.diff.hunks,
    oldLines: d.oldLines,
    newLines: d.newLines,
    span: lineAnchor(e.uri, anchor),
    floor: d.diff.floor,
  });
  switch (r.status) {
    case "deleted":
      return { kind: "deleted" };
    case "review":
      return {
        kind: "review",
        why: `re-anchor ${r.reason} (similarity ${r.score}): a human must locate this fact`,
      };
    case "shifted":
    case "in-hunk": {
      const uri = newPathUri(d, r.span);
      return uri
        ? { kind: "located", uri, score: r.score }
        : {
            kind: "review",
            why: `the diff moves ${target} to a path outside the repository: a human must locate this fact`,
          };
    }
  }
}

/**
 * A line pin pushed past end-of-file by the diff is not gone, it moved up: with a diff for its file it is
 * a re-anchor candidate (stale), not a retraction.
 */
function inDiffContext(
  evidence: EvidenceStatus[],
  idx: DiffIndex | undefined,
): EvidenceStatus[] {
  if (!idx) return evidence;
  return evidence.map((e) =>
    e.kind === "missing" &&
    e.code === "past-eof" &&
    idx.has(parseUri(e.uri).target)
      ? { kind: "stale", uri: e.uri, now: "" }
      : e,
  );
}

/** Widest line span an updater may choose: wider overrides would make the window scan quadratic. */
const MAX_OVERRIDE_LINES = 200;

/** An updater may tighten evidence, but only onto spans that exist and are unique in their source. */
function acceptableEvidence(
  root: string,
  uris: string[],
  expected: number,
): boolean {
  if (uris.length !== expected) return false;
  return uris.every((uri) => {
    try {
      const { scheme, anchor } = parseUri(uri);
      if (scheme === "repo") {
        const [a, b] = lineAnchor(uri, anchor);
        if (b - a + 1 > MAX_OVERRIDE_LINES) return false;
      }
      const r = resolve(root, uri);
      if (!("text" in r)) return false;
      const spans = spansWithHash(root, uri, hashAs(classOfUri(uri), r.text));
      return spans === null || spans.length === 1;
    } catch (e) {
      // Malformed or out-of-corpus model output is a review, not a crash.
      if (e instanceof InvalidEvidenceUriError) return false;
      throw e;
    }
  });
}

/**
 * A stale pin as the updater must see it: the text at its re-anchored location, not at the old pin.
 * Null when the located span does not resolve (the claim then goes to review).
 */
function atLocation(
  root: string,
  e: EvidenceStatus,
  uri: string,
): EvidenceStatus | null {
  if (e.kind !== "stale") return e;
  const r = resolve(root, uri);
  return "text" in r
    ? { kind: "stale", uri: e.uri, now: nowText(classOfUri(uri), r.text) }
    : null;
}

const describe = (e: EvidenceStatus) => {
  switch (e.kind) {
    case "relocated":
      return `${e.uri} -> ${e.newUri}`;
    case "stale":
      return `${e.uri} (now: "${e.now.slice(0, 60)}")`;
    case "missing":
      return `${e.uri} (${e.reason})`;
    case "ambiguous":
      return `${e.uri} (${e.candidates.length} identical spans: ${e.candidates.join(", ")})`;
    case "fresh":
      return `${e.uri} (unchanged)`;
  }
};

/** Statuses whose op needs no model and no re-anchoring: the op and its reason follow from the status alone. */
const FIXED_OPS: Partial<
  Record<ClaimStatus, { op: DraftOpKind; why: string }>
> = {
  relocated: { op: "repin", why: "evidence moved, content identical" },
  missing: { op: "retract", why: "every source for this fact is gone" },
  degraded: {
    op: "review",
    why: "one source vanished, the others still hold: re-ground or accept",
  },
  ambiguous: {
    op: "review",
    why: "the pinned text now appears in several places: a human picks the span this fact lives in",
  },
  orphaned: {
    op: "review",
    why: "a human rewrote this sentence: re-ground the claim on the human text",
  },
  // No model call: the fix is not a rewrite but deciding which department is right.
  conflict: {
    op: "conflict",
    why: "sources that agreed now disagree; the owner of the out-of-date one must decide",
  },
};

export class UnknownOpKeyError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`not an op key: ${id}`);
    this.name = "UnknownOpKeyError";
    this.id = id;
  }
}

/**
 * Change an op's kind (e.g. a low-confidence update becomes a review), keeping page, claim and revision.
 * A retargeted op is never auto: only reconcile mints auto ops.
 */
export function retargetOp(
  op: DraftOp,
  kind: DraftOpKind,
  why: string,
): DraftOp {
  const parts = parseOpKey(op.id);
  if (!parts) throw new UnknownOpKeyError(op.id);
  const id = opKey(kind, parts.page, parts.claimId, parts.sourceRev);
  return {
    ...op,
    id,
    op: kind,
    auto: false,
    why,
    ...(OP_KINDS[kind].keepsProposal
      ? {}
      : {
          after: undefined,
          newEvidence: undefined,
          newEvidenceHash: undefined,
          score: undefined,
        }),
  };
}

export async function reconcile(
  root: string,
  pageMd: string,
  sc: Sidecar,
  llm: Updater,
  options: ReconcileOptions = {},
): Promise<Draft> {
  const report = checkPage(root, pageMd, sc);
  const before = llm.calls;
  const ops: DraftOp[] = [];
  const add = (o: Omit<DraftOp, "id" | "auto">) =>
    ops.push({
      ...o,
      id: opKey(o.op, sc.page, o.claimId, options.sourceRev),
      auto: OP_KINDS[o.op].auto,
    });
  const baseOf = (claim: Claim, ev: EvidenceStatus[]) => ({
    claimId: claim.id,
    before: claim.statement,
    evidence: ev.map(describe),
  });
  const idx = buildDiffIndex(options);
  const needWork: UpdateRequest[] = [];
  // checkPage reports claims in sc.claims order.
  sc.claims.forEach((claim, i) => {
    const cr = report.claims[i];
    if (!cr) return;
    const ev = inDiffContext(cr.evidence, idx);
    const status =
      cr.status === "orphaned" ? cr.status : claimStatus(ev.map((e) => e.kind));
    const fixed = FIXED_OPS[status];
    if (fixed) return add({ ...baseOf(claim, ev), ...fixed });
    if (status !== "stale") return; // fresh
    const located = ev.map((e) => locate(e, idx));
    const pins = located.filter(
      (l): l is Extract<Located, { kind: "located" }> => l.kind === "located",
    );
    const review = located.find(
      (l): l is Extract<Located, { kind: "review" }> => l.kind === "review",
    );
    if (located.every((l) => l.kind === "deleted"))
      return add({
        ...baseOf(claim, ev),
        op: "retract",
        why: "the merge deleted every span this fact was grounded on",
      });
    if (review || pins.length !== located.length)
      return add({
        ...baseOf(claim, ev),
        op: "review",
        why:
          review?.why ??
          "the merge deleted part of this fact's evidence: re-ground or retract",
      });
    const evidence = ev.map((e, j) => atLocation(root, e, pins[j]?.uri ?? ""));
    if (!evidence.every((e): e is EvidenceStatus => e !== null))
      return add({
        ...baseOf(claim, ev),
        op: "review",
        why: "a re-anchored span does not resolve: a human must locate this fact",
      });
    needWork.push({
      claim,
      evidence,
      newEvidence: pins.map((l) => l.uri),
      reanchorScore: Math.min(...pins.map((l) => l.score)),
    });
  });
  if (needWork.length > 0) {
    const asked = new Map(needWork.map((w) => [w.claim.id, w]));
    for (const u of await llm.rework(needWork)) {
      const w = asked.get(u.id);
      if (!w) continue; // unknown or already-answered id: an updater answers each claim at most once
      asked.delete(u.id);
      if (!isUsableAnswer(u)) {
        add({
          ...baseOf(w.claim, w.evidence),
          op: "review",
          why: "the updater returned an empty or malformed rewrite: a human must review this fact",
        });
        continue;
      }
      if (
        u.evidence !== undefined &&
        !acceptableEvidence(root, u.evidence, w.newEvidence.length)
      ) {
        add({
          ...baseOf(w.claim, w.evidence),
          op: "review",
          why: "the updater chose evidence that is missing, ambiguous or malformed: a human must locate this fact",
        });
        continue;
      }
      const newEvidence = u.evidence ?? w.newEvidence;
      add({
        ...baseOf(w.claim, w.evidence),
        op: "update",
        after: u.statement,
        why: "all sources changed consistently",
        newEvidence,
        newEvidenceHash: newEvidence.map((uri) => pin(root, uri).hash),
        score: w.reanchorScore,
      });
    }
    for (const w of asked.values())
      add({
        ...baseOf(w.claim, w.evidence),
        op: "review",
        why: "the updater returned no rewrite for this fact: a human must review it",
      });
  }
  return {
    page: sc.page,
    mode: report.humanEdited ? "propose" : "apply",
    ops,
    llmCalls: llm.calls - before,
  };
}

/** Updater answers are model output: a usable one has a non-blank statement and, if any, string evidence. */
function isUsableAnswer(u: UpdateResult): boolean {
  const { statement, evidence } = u as {
    statement: unknown;
    evidence: unknown;
  };
  return (
    typeof statement === "string" &&
    statement.trim() !== "" &&
    (evidence === undefined ||
      (Array.isArray(evidence) && evidence.every((e) => typeof e === "string")))
  );
}

/** Deterministic stand-in for the model: rewrites numbers in the statement from the new evidence. */
export function stubUpdater(): Updater {
  const u: Updater = {
    calls: 0,
    rework(items) {
      u.calls++;
      return items.map(({ claim, evidence }) => {
        const nowText = evidence
          .map((e) => (e.kind === "stale" ? e.now : ""))
          .join(" ");
        const nums = nowText.match(/\d+(\.\d+)*/g) ?? [];
        let i = 0;
        const statement = nums.length
          ? claim.statement.replace(/\d+(\.\d+)*/g, (m) => nums[i++] ?? m)
          : `${claim.statement} [NEEDS REVIEW]`;
        return { id: claim.id, statement };
      });
    },
  };
  return u;
}

export function generateSidecar(
  root: string,
  page: string,
  pageMd: string,
  seed: { id: string; statement: string; evidence: string[] }[],
): Sidecar {
  // Ids end up in op keys: reject one that cannot be keyed now, not at the first reconcile.
  assertOpKeyPart("page", page);
  return {
    page,
    pageVersion: sha(pageMd),
    claims: seed.map((c) => {
      assertOpKeyPart("claimId", c.id);
      if (c.evidence.length === 0) throw new UngroundedClaimError(c.id);
      return { ...c, evidence: c.evidence.map((u) => pin(root, u)) };
    }),
  };
}

export class UngroundedClaimError extends Error {
  readonly claimId: string;
  constructor(claimId: string) {
    super(
      `claim ${claimId} has no evidence: every claim must pin at least one source span`,
    );
    this.name = "UngroundedClaimError";
    this.claimId = claimId;
  }
}

export class HumanEditedPageError extends Error {
  readonly page: string;
  constructor(page: string) {
    super(
      `refusing to rewrite human-edited page ${page}; ops must be re-targeted at the human text`,
    );
    this.name = "HumanEditedPageError";
    this.page = page;
  }
}

export class AmbiguousEvidenceError extends Error {
  readonly claimId: string;
  constructor(claimId: string) {
    super(
      `refusing to change claim ${claimId}: its evidence is ambiguous, a human must pick the span first`,
    );
    this.name = "AmbiguousEvidenceError";
    this.claimId = claimId;
  }
}

/** An approved op that cannot be applied safely as it stands (missing proposal, or nothing to re-pin onto). */
export class UnappliableOpError extends Error {
  readonly opId: string;
  constructor(opId: string, reason: string) {
    super(`refusing to apply ${opId}: ${reason}`);
    this.name = "UnappliableOpError";
    this.opId = opId;
  }
}

/**
 * Replace the claim's one occurrence on the page. Matching is whitespace-tolerant, the same rule checkPage
 * uses to decide the claim is still on the page (a re-wrapped sentence is the same sentence); a statement
 * that occurs twice names no single place.
 */
function replaceStatement(md: string, from: string, to: string, opId: string) {
  const words = norm(from).split(" ").filter(Boolean);
  const pattern = new RegExp(
    words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
    "g",
  );
  const [first, second] = words.length ? md.matchAll(pattern) : [];
  if (!first)
    throw new UnappliableOpError(
      opId,
      "the claim's statement is not on the page",
    );
  if (second)
    throw new UnappliableOpError(
      opId,
      "the claim's statement occurs more than once on the page: a human must apply this edit",
    );
  return (
    md.slice(0, first.index) + to + md.slice(first.index + first[0].length)
  );
}

/** Re-pin without a proposal: only a pin that relocated or still holds may be kept; anything else is a guess. */
function keepOrRelocate(
  root: string,
  e: EvidencePin,
  opId: string,
): EvidencePin {
  const st = checkEvidence(root, e);
  if (st.kind === "relocated") return pin(root, st.newUri);
  if (st.kind === "fresh") return e;
  throw new UnappliableOpError(
    opId,
    `evidence ${e.uri} is ${st.kind}; it can only be re-pinned by a located update`,
  );
}

/**
 * Apply auto ops plus the ops a human approved. Content changes on a human-edited page are refused;
 * repins are still allowed there because they never touch the page text. Nothing on the draft is
 * trusted: the op kind caps `auto`, the page is re-hashed rather than reading `mode`, every op id must
 * name its own op, page and claim, and every claim-changing op is re-checked against the sources.
 */
export function applyDraft(
  root: string,
  pageMd: string,
  sc: Sidecar,
  d: Draft,
  approved: string[] = [],
): { md: string; sc: Sidecar } {
  const auto = (o: DraftOp) => o.auto && OP_KINDS[o.op].auto;
  const take = d.ops.filter((o) => auto(o) || approved.includes(o.id));
  for (const o of take) {
    const k = parseOpKey(o.id);
    if (!k) throw new UnknownOpKeyError(o.id);
    if (k.op !== o.op || k.page !== sc.page || k.claimId !== o.claimId)
      throw new UnappliableOpError(
        o.id,
        `the op key does not name ${o.op} on ${sc.page}/${o.claimId}`,
      );
  }
  const humanEdited = sha(pageMd) !== sc.pageVersion;
  if (humanEdited && take.some((o) => !auto(o)))
    throw new HumanEditedPageError(sc.page);
  let md = pageMd;
  const claims: Claim[] = [];
  for (const c of sc.claims) {
    const op = take.find((o) => o.claimId === c.id);
    if (!op || !OP_KINDS[op.op].changesClaim) {
      claims.push(c);
      continue;
    }
    const now = c.evidence.map((e) => checkEvidence(root, e).kind);
    if (now.includes("ambiguous")) throw new AmbiguousEvidenceError(c.id);
    if (op.op === "retract") {
      // The evidence came back (a restored ticket, a re-added file): the reason to retract is gone.
      if (now.some(holds))
        throw new UnappliableOpError(
          op.id,
          "evidence for this fact holds again since the retract was proposed: reconcile again",
        );
      md = replaceStatement(
        md,
        c.statement,
        `<!-- retracted: ${c.id} -->`,
        op.id,
      );
      continue;
    }
    if (op.op === "repin") {
      claims.push({
        ...c,
        evidence: c.evidence.map((e) => keepOrRelocate(root, e, op.id)),
      });
      continue;
    }
    // update / reverify: a located proposal is required, still grounded on the text it was built from.
    const { after, newEvidence = [], newEvidenceHash = [] } = op;
    if (
      after === undefined ||
      newEvidence.length !== c.evidence.length ||
      newEvidenceHash.length !== newEvidence.length
    )
      throw new UnappliableOpError(
        op.id,
        "an update needs a proposed statement and one located, fingerprinted span per evidence pin",
      );
    const evidence = newEvidence.map((uri) => pin(root, uri));
    if (evidence.some((e, j) => e.hash !== newEvidenceHash[j]))
      throw new UnappliableOpError(
        op.id,
        "the proposed evidence changed since the proposal was made: reconcile again",
      );
    if (after !== c.statement)
      md = replaceStatement(md, c.statement, after, op.id);
    claims.push({ id: c.id, statement: after, evidence });
  }
  // A human-edited page keeps its human version marker: repins never "launder" the human edit.
  return {
    md,
    sc: {
      page: sc.page,
      pageVersion: humanEdited ? sc.pageVersion : sha(md),
      claims,
    },
  };
}
