// Spike 010: cross-source grounded claims. Pure logic, no deps beyond node:*.
// A claim pins one atomic fact to hashed evidence spans in ANY source:
//   repo://<path>#L<a>-L<b>      line range in a code file
//   ticket://<id>#/<json/pointer> field of a support ticket
//   doc://<slug>#<heading-slug>   section of a human-written doc (marketing, support)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EvidencePin {
  uri: string;
  hash: string;
}
export interface Claim {
  id: string;
  statement: string;
  evidence: EvidencePin[];
}
export interface Sidecar {
  page: string;
  pageVersion: string; // sha256 of the page markdown when the agent last wrote/verified it
  claims: Claim[];
}
export type EvidenceStatus =
  | { kind: "fresh"; uri: string }
  | { kind: "relocated"; uri: string; newUri: string }
  | { kind: "stale"; uri: string; before?: string; now: string }
  | { kind: "ambiguous"; uri: string; matches: number }
  | { kind: "missing"; uri: string; reason: string };
// conflict = sources that used to agree now disagree (e.g. code says 30 days, marketing still says 14).
// degraded = some evidence vanished but the rest still holds; the fact may be fine, a human decides.
export type ClaimStatus = "fresh" | "relocated" | "stale" | "conflict" | "degraded" | "missing" | "orphaned";
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

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
// Whitespace-only edits must not flip a claim.
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function parseUri(uri: string) {
  const m = /^(repo|ticket|doc):\/\/([^#]+)#(.+)$/.exec(uri);
  if (!m) throw new Error(`bad evidence uri: ${uri}`);
  return { scheme: m[1] as "repo" | "ticket" | "doc", target: m[2]!, anchor: m[3]! };
}

/** Resolve a URI to its current text, or null with a reason. */
export function resolve(root: string, uri: string): { text: string } | { missing: string } {
  const { scheme, target, anchor } = parseUri(uri);
  if (scheme === "repo") {
    const p = join(root, "repo", target);
    if (!existsSync(p)) return { missing: "file deleted" };
    const r = /^L(\d+)-L(\d+)$/.exec(anchor);
    if (!r) throw new Error(`bad line anchor ${anchor}`);
    const lines = readFileSync(p, "utf8").split("\n");
    const [a, b] = [Number(r[1]), Number(r[2])];
    if (b > lines.length) return { missing: "range past end of file" };
    return { text: lines.slice(a - 1, b).join("\n") };
  }
  if (scheme === "ticket") {
    const p = join(root, "tickets", `${target}.json`);
    if (!existsSync(p)) return { missing: "ticket deleted" };
    let v: unknown = JSON.parse(readFileSync(p, "utf8"));
    for (const key of anchor.replace(/^\//, "").split("/")) {
      if (v === null || typeof v !== "object" || !(key in v)) return { missing: `field ${anchor} gone` };
      v = (v as Record<string, unknown>)[key];
    }
    return { text: typeof v === "string" ? v : JSON.stringify(v) };
  }
  // doc: section = heading line through the next heading of the same or higher level.
  const p = join(root, "docs", `${target}.md`);
  if (!existsSync(p)) return { missing: "doc deleted" };
  const lines = readFileSync(p, "utf8").split("\n");
  const start = lines.findIndex((l) => /^#{1,6} /.test(l) && slug(l.replace(/^#+ /, "")) === anchor);
  if (start < 0) return { missing: `heading #${anchor} gone` };
  const level = /^#+/.exec(lines[start]!)![0].length; // start was matched by /^#{1,6} /
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = /^(#+) /.exec(lines[i]!);
    if (h && h[1]!.length <= level) { end = i; break; }
  }
  return { text: lines.slice(start + 1, end).join("\n") };
}

export function pin(root: string, uri: string): EvidencePin {
  const r = resolve(root, uri);
  if ("missing" in r) throw new Error(`cannot pin ${uri}: ${r.missing}`);
  return { uri, hash: sha(norm(r.text)) };
}

// One pass per (file content, window width) instead of one full scan per claim.
const WINDOW_INDEX = new Map<string, Map<string, number[]>>();
function windowIndex(file: string, width: number): Map<string, number[]> {
  const text = readFileSync(file, "utf8");
  const key = `${file}\0${width}\0${sha(text)}`;
  const cached = WINDOW_INDEX.get(key);
  if (cached) return cached;
  const lines = text.split("\n");
  const idx = new Map<string, number[]>();
  for (let i = 0; i + width <= lines.length; i++) {
    const h = sha(norm(lines.slice(i, i + width).join("\n")));
    const list = idx.get(h);
    if (list) list.push(i + 1); else idx.set(h, [i + 1]);
  }
  WINDOW_INDEX.set(key, idx);
  return idx;
}

/** Line pins break when code above them moves. Re-find the exact span by content. */
function relocate(root: string, e: EvidencePin): EvidenceStatus | null {
  const { scheme, target, anchor } = parseUri(e.uri);
  if (scheme === "doc") return relocateDocSection(root, e, target);
  if (scheme !== "repo") return null;
  const r = /^L(\d+)-L(\d+)$/.exec(anchor)!;
  const width = Number(r[2]) - Number(r[1]) + 1;
  const file = join(root, "repo", target);
  if (!existsSync(file)) return null;
  const hits = windowIndex(file, width).get(e.hash) ?? [];
  if (hits.length === 1) {
    const a = hits[0]!;
    return { kind: "relocated", uri: e.uri, newUri: `repo://${target}#L${a}-L${a + width - 1}` };
  }
  // Two identical spans: refuse to guess, a human or the LLM decides.
  if (hits.length > 1) return { kind: "ambiguous", uri: e.uri, matches: hits.length };
  return null;
}

/** A renamed heading must not retract a true fact: find the section whose body still hashes the same. */
function relocateDocSection(root: string, e: EvidencePin, target: string): EvidenceStatus | null {
  const p = join(root, "docs", `${target}.md`);
  if (!existsSync(p)) return null;
  const heads = readFileSync(p, "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
  const hits = heads.filter((h) => {
    const r = resolve(root, `doc://${target}#${h}`);
    return "text" in r && sha(norm(r.text)) === e.hash;
  });
  if (hits.length === 1) return { kind: "relocated", uri: e.uri, newUri: `doc://${target}#${hits[0]}` };
  if (hits.length > 1) return { kind: "ambiguous", uri: e.uri, matches: hits.length };
  return null;
}

export function checkEvidence(root: string, e: EvidencePin): EvidenceStatus {
  const r = resolve(root, e.uri);
  if ("missing" in r) return relocate(root, e) ?? { kind: "missing", uri: e.uri, reason: r.missing };
  if (sha(norm(r.text)) === e.hash) return { kind: "fresh", uri: e.uri };
  return relocate(root, e) ?? { kind: "stale", uri: e.uri, now: norm(r.text) };
}

export function checkPage(root: string, pageMd: string, sc: Sidecar): PageReport {
  const humanEdited = sha(pageMd) !== sc.pageVersion;
  const body = norm(pageMd);
  const claims = sc.claims.map((c): ClaimReport => {
    const evidence = c.evidence.map((e) => checkEvidence(root, e));
    // A human rewrote the sentence: the claim no longer describes the page. Never resurrect it.
    if (humanEdited && !body.includes(norm(c.statement))) return { id: c.id, status: "orphaned", evidence };
    const kinds = evidence.map((e) => e.kind);
    const holds = (k: string) => k === "fresh" || k === "relocated";
    const status: ClaimStatus = kinds.every((k) => k === "missing")
      ? "missing"
      : kinds.includes("missing")
        ? "degraded"
        : kinds.includes("stale") && kinds.some(holds)
          ? "conflict"
          : kinds.some((k) => k === "stale" || k === "ambiguous")
            ? "stale"
            : kinds.includes("relocated")
              ? "relocated"
              : "fresh";
    return { id: c.id, status, evidence };
  });
  return { page: sc.page, humanEdited, claims };
}

// ---- reconciliation -------------------------------------------------------
// Only "repin" is mechanical (content identical, location moved) and auto-applies.
// Every op that changes what the page SAYS is a proposal a human approves.
export interface Updater {
  calls: number;
  /** One batched model call with ONLY the claims whose sources changed coherently. */
  rework(claims: { claim: Claim; evidence: EvidenceStatus[] }[]): { id: string; statement: string }[];
}
export type DraftOpKind = "repin" | "update" | "conflict" | "retract" | "review";
export interface DraftOp {
  id: string; // stable op id: approve/reject by id
  claimId: string;
  op: DraftOpKind;
  auto: boolean;
  before: string;
  after?: string;
  why: string;
  evidence: string[];
}
export interface Draft {
  page: string;
  mode: "apply" | "propose"; // propose = a human edited the page since the agent last verified it
  ops: DraftOp[];
  llmCalls: number;
}

const describe = (e: EvidenceStatus) =>
  e.kind === "relocated" ? `${e.uri} -> ${e.newUri}`
  : e.kind === "stale" ? `${e.uri} (now: "${e.now.slice(0, 60)}")`
  : e.kind === "missing" ? `${e.uri} (${e.reason})`
  : e.kind === "ambiguous" ? `${e.uri} (${e.matches} identical spans)`
  : `${e.uri} (unchanged)`;

export function reconcile(root: string, pageMd: string, sc: Sidecar, llm: Updater): Draft {
  const report = checkPage(root, pageMd, sc);
  const before = llm.calls;
  const ops: DraftOp[] = [];
  const add = (o: Omit<DraftOp, "id" | "auto">) => ops.push({ ...o, id: `${o.op}:${o.claimId}`, auto: o.op === "repin" });
  const needWork: { claim: Claim; evidence: EvidenceStatus[] }[] = [];
  for (const cr of report.claims) {
    const claim = sc.claims.find((c) => c.id === cr.id)!; // report is built from sc.claims
    const ev = cr.evidence.map(describe);
    switch (cr.status) {
      case "fresh": break;
      case "relocated": add({ claimId: cr.id, op: "repin", before: claim.statement, why: "evidence moved, content identical", evidence: ev }); break;
      case "missing": add({ claimId: cr.id, op: "retract", before: claim.statement, why: "every source for this fact is gone", evidence: ev }); break;
      case "degraded": add({ claimId: cr.id, op: "review", before: claim.statement, why: "one source vanished, the others still hold: re-ground or accept", evidence: ev }); break;
      case "orphaned": add({ claimId: cr.id, op: "review", before: claim.statement, why: "a human rewrote this sentence: re-ground the claim on the human text", evidence: ev }); break;
      // No model call: the fix is not a rewrite but deciding which department is right.
      case "conflict": add({ claimId: cr.id, op: "conflict", before: claim.statement, why: "sources that agreed now disagree; the owner of the out-of-date one must decide", evidence: ev }); break;
      case "stale": needWork.push({ claim, evidence: cr.evidence }); break;
    }
  }
  if (needWork.length > 0) {
    for (const u of llm.rework(needWork)) {
      const w = needWork.find((n) => n.claim.id === u.id)!; // rework returns ids it was given
      add({ claimId: u.id, op: "update", before: w.claim.statement, after: u.statement, why: "all sources changed consistently", evidence: w.evidence.map(describe) });
    }
  }
  return { page: sc.page, mode: report.humanEdited ? "propose" : "apply", ops, llmCalls: llm.calls - before };
}

/** Deterministic stand-in for the model: rewrites numbers in the statement from the new evidence. */
export function stubUpdater(): Updater {
  const u: Updater = {
    calls: 0,
    rework(items) {
      u.calls++;
      return items.map(({ claim, evidence }) => {
        const nowText = evidence.map((e) => (e.kind === "stale" ? e.now : "")).join(" ");
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

export function generateSidecar(root: string, page: string, pageMd: string,
  seed: { id: string; statement: string; evidence: string[] }[]): Sidecar {
  return { page, pageVersion: sha(pageMd), claims: seed.map((c) => ({ ...c, evidence: c.evidence.map((u) => pin(root, u)) })) };
}

export class HumanEditedPageError extends Error {
  readonly page: string;
  constructor(page: string) {
    super(`refusing to rewrite human-edited page ${page}; ops must be re-targeted at the human text`);
    this.name = "HumanEditedPageError";
    this.page = page;
  }
}

/**
 * Apply auto ops plus the ops a human approved. Content changes on a human-edited page are refused;
 * repins are still allowed there because they never touch the page text.
 */
export function applyDraft(root: string, pageMd: string, sc: Sidecar, d: Draft, approved: string[] = []): { md: string; sc: Sidecar } {
  const take = d.ops.filter((o) => o.auto || approved.includes(o.id));
  if (d.mode === "propose" && take.some((o) => !o.auto)) throw new HumanEditedPageError(d.page);
  let md = pageMd;
  const claims: Claim[] = [];
  for (const c of sc.claims) {
    const op = take.find((o) => o.claimId === c.id);
    if (op?.op === "retract") { md = md.replace(c.statement, `<!-- retracted: ${c.id} -->`); continue; }
    if (op?.op === "conflict" || op?.op === "review") { claims.push(c); continue; } // decided outside the page
    const statement = op?.op === "update" && op.after ? op.after : c.statement;
    if (statement !== c.statement) md = md.replace(c.statement, statement);
    const evidence = op ? c.evidence.map((e) => {
      const st = checkEvidence(root, e);
      return st.kind === "relocated" ? pin(root, st.newUri) : st.kind === "fresh" ? e : pin(root, e.uri);
    }) : c.evidence;
    claims.push({ id: c.id, statement, evidence });
  }
  // A human-edited page keeps its human version marker: repins never "launder" the human edit.
  return { md, sc: { page: sc.page, pageVersion: d.mode === "propose" ? sc.pageVersion : sha(md), claims } };
}
