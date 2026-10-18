// Spike 011: scoped, sensitivity-labelled knowledge with fail-closed disclosure.
// The principal is NOT a tool argument: it arrives as a control-plane-signed token at server launch.
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const isSensitivity = (v: unknown): v is Sensitivity => typeof v === "string" && v in RANK;

export interface KbRecord { id: string; scope: string; sensitivity?: string; title: string; text: string; provenance: string }
export interface Grant { id: string; from: string; to: string; recordIds: string[]; maxSensitivity: Sensitivity; grantedBy: string; expires: string }
export interface Store { records: KbRecord[]; grants: Grant[] }
export interface Principal { org: string; scopes: string[]; clearance: Sensitivity; runId: string; exp: number }

export class TokenError extends Error {}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export function signPrincipal(p: Principal, key: string): string {
  const body = b64(JSON.stringify(p));
  return `${body}.${b64(createHmac("sha256", key).update(body).digest())}`;
}
export function verifyPrincipal(token: string | undefined, key: string, now = Date.now()): Principal {
  if (!token) throw new TokenError("no principal token");
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new TokenError("malformed principal token");
  const want = createHmac("sha256", key).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new TokenError("bad signature");
  const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Principal;
  if (p.exp * 1000 < now) throw new TokenError("principal token expired");
  if (!isSensitivity(p.clearance)) throw new TokenError("bad clearance");
  return p;
}

/**
 * Fail closed: a record is disclosed only when it is fully labelled AND either
 * (a) its scope is one of the principal's scopes and its label is within clearance, or
 * (b) an unexpired grant from its scope to one of the principal's scopes names it, within the grant's cap.
 * Restricted records are never disclosed through a grant.
 */
export function disclosure(rec: KbRecord, p: Principal, grants: Grant[], now = Date.now()): { ok: boolean; via?: string } {
  if (!isSensitivity(rec.sensitivity) || !rec.scope) return { ok: false };
  const rank = RANK[rec.sensitivity];
  if (p.scopes.includes(rec.scope) && rank <= RANK[p.clearance]) return { ok: true, via: "scope" };
  if (rec.sensitivity === "restricted") return { ok: false };
  const g = grants.find((x) => x.from === rec.scope && p.scopes.includes(x.to) && x.recordIds.includes(rec.id)
    && Date.parse(x.expires) > now && rank <= RANK[x.maxSensitivity] && rank <= RANK[p.clearance]);
  return g ? { ok: true, via: `grant:${g.id}` } : { ok: false };
}

const NOT_FOUND = (id: string) => `no record ${id}`; // identical for "absent" and "not disclosed": no existence oracle

export class Kb {
  store: Store;
  p: Principal;
  auditPath: string;
  draftsPath: string;
  constructor(storePath: string, p: Principal, auditPath: string, draftsPath: string) {
    this.store = JSON.parse(readFileSync(storePath, "utf8")) as Store;
    this.p = p;
    this.auditPath = auditPath;
    this.draftsPath = draftsPath;
  }
  private audit(tool: string, args: unknown, result: { returned: string[]; denied: string[]; note?: string }) {
    appendFileSync(this.auditPath, JSON.stringify({ at: new Date().toISOString(), runId: this.p.runId, scopes: this.p.scopes, clearance: this.p.clearance, tool, args, ...result }) + "\n");
  }
  private visible() {
    const out: { rec: KbRecord; via: string }[] = [];
    const denied: string[] = [];
    for (const rec of this.store.records) {
      const d = disclosure(rec, this.p, this.store.grants);
      if (d.ok) out.push({ rec, via: d.via ?? "?" }); else denied.push(rec.id);
    }
    return { out, denied };
  }
  search(query: string, limit = 5) {
    const words = String(query).toLowerCase().match(/[a-z0-9-]{3,}/g) ?? [];
    const { out, denied } = this.visible(); // filter BEFORE ranking: hidden records never influence results
    const hits = out.map(({ rec, via }) => ({ rec, via, score: words.filter((w) => `${rec.title} ${rec.text}`.toLowerCase().includes(w)).length }))
      .filter((h) => h.score > 0 || words.length === 0).sort((a, b) => b.score - a.score).slice(0, limit);
    const res = hits.map((h) => ({ id: h.rec.id, title: h.rec.title, scope: h.rec.scope, sensitivity: h.rec.sensitivity, snippet: h.rec.text.slice(0, 160), provenance: h.rec.provenance, via: h.via }));
    this.audit("kb_search", { query }, { returned: res.map((r) => r.id), denied });
    return res;
  }
  read(id: string) {
    const rec = this.store.records.find((r) => r.id === id);
    const d = rec ? disclosure(rec, this.p, this.store.grants) : { ok: false };
    if (!rec || !d.ok) {
      this.audit("kb_read", { id }, { returned: [], denied: rec ? [rec.id] : [], note: rec ? "not disclosed" : "absent" });
      throw new Error(NOT_FOUND(id));
    }
    this.audit("kb_read", { id }, { returned: [rec.id], denied: [] });
    return { ...rec, via: d.via };
  }
  /** Agents propose; nothing is written to the store. A proposal into a scope the principal does not hold is refused. */
  propose(scope: string, title: string, text: string, basedOn: string[] = []) {
    if (!this.p.scopes.includes(scope)) {
      this.audit("kb_propose", { scope, title }, { returned: [], denied: [], note: "scope not held" });
      throw new Error(`cannot propose into scope ${scope}`);
    }
    for (const id of basedOn) this.read(id); // provenance must itself be disclosed to this principal
    const draft = { id: `D-${Date.now().toString(36)}`, status: "held", scope, title, text, basedOn, proposedBy: this.p.runId, at: new Date().toISOString() };
    appendFileSync(this.draftsPath, JSON.stringify(draft) + "\n");
    this.audit("kb_propose", { scope, title, basedOn }, { returned: [draft.id], denied: [], note: "held for approval" });
    return { id: draft.id, status: draft.status };
  }
}
