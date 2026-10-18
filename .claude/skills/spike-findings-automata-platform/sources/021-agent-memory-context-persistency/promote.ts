// Spike 021 phase B: promote scoped agent memory into grounded company knowledge (spike 010 claims)
// through a human approval queue (spike 014). Memory is private to its scope; a claim is company-wide,
// so a memory record may only become a claim when a real source supports it and a human approves.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { MemoryRecord } from "./memory.ts";

export type Relation = "supports" | "contradicts";
export interface Grounding { uri: string; relation: Relation; text: string }
export type PromotionKind = "promote" | "contradiction" | "ungrounded" | "restricted";
export interface PromotionItem {
  id: string;
  kind: PromotionKind;
  memory: { id: string; scope: string; text: string; sessionId?: string; turn?: number };
  proposedClaim?: { id: string; statement: string; evidence: string[] };
  grounding: Grounding[];
  why: string;
  decision: "pending" | "approved" | "rejected";
}

const STOP = new Set(["that", "this", "with", "from", "have", "need", "every", "they", "their", "last", "lasts", "about"]);
const tokens = (t: string) => [...new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5)))];
/** Value-like numbers only: 86_400_000 (ms/day) is a constant, not a fact anyone would state. */
const values = (t: string) => (t.match(/\d[\d_]*(\.\d+)?/g) ?? []).map((n) => Number(n.replace(/_/g, ""))).filter((n) => n <= 10_000);

interface Unit { uri: string; text: string }
function units(root: string): Unit[] {
  const out: Unit[] = [];
  const repo = join(root, "repo");
  if (existsSync(repo)) for (const f of readdirSync(repo)) readFileSync(join(repo, f), "utf8").split("\n").forEach((l, i) => { if (l.trim()) out.push({ uri: `repo://${f}#L${i + 1}-L${i + 1}`, text: l }); });
  const docs = join(root, "docs");
  if (existsSync(docs)) for (const f of readdirSync(docs)) {
    const lines = readFileSync(join(docs, f), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (!/^#{2,6} /.test(l)) return;
      const end = lines.findIndex((x, j) => j > i && /^#{1,6} /.test(x));
      const slug = l.replace(/^#+ /, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      out.push({ uri: `doc://${f.replace(/\.md$/, "")}#${slug}`, text: lines.slice(i + 1, end < 0 ? undefined : end).join(" ") });
    });
  }
  return out;
}

/**
 * Deterministic stand-in for a model grounding step: a source unit is a candidate when it shares >= 2 topic
 * tokens with the memory text; it supports when it carries the same value, contradicts when it carries a different one.
 */
export function ground(root: string, text: string): Grounding[] {
  const want = tokens(text), nums = values(text);
  const out: Grounding[] = [];
  for (const u of units(root)) {
    const have = u.text.toLowerCase();
    if (want.filter((w) => have.includes(w)).length < 2) continue;
    const uv = values(u.text);
    if (nums.length && uv.some((n) => nums.includes(n))) out.push({ uri: u.uri, relation: "supports", text: u.text.trim() });
    else if (nums.length && uv.length) out.push({ uri: u.uri, relation: "contradicts", text: u.text.trim() });
  }
  return out;
}

export function proposePromotion(root: string, m: MemoryRecord): PromotionItem {
  const base = { id: `promo:${m.id}`, memory: { id: m.id, scope: m.scope, text: m.text, sessionId: m.provenance.sessionId, turn: m.provenance.turn }, decision: "pending" as const };
  if (m.sensitivity === "restricted") return { ...base, kind: "restricted", grounding: [], why: "restricted memory never leaves its scope" };
  const g = ground(root, m.text);
  const sup = g.filter((x) => x.relation === "supports"), con = g.filter((x) => x.relation === "contradicts");
  if (con.length) return { ...base, kind: "contradiction", grounding: g, why: `memory disagrees with ${con.map((c) => c.uri).join(", ")}: route to the memory owner and the source owner` };
  if (!sup.length) return { ...base, kind: "ungrounded", grounding: g, why: "no source supports this; it stays scoped memory until someone grounds it" };
  return { ...base, kind: "promote", grounding: g, proposedClaim: { id: `c-${m.id}`, statement: m.text, evidence: sup.map((s) => s.uri) }, why: `grounded on ${sup.length} source(s); needs approval` };
}
