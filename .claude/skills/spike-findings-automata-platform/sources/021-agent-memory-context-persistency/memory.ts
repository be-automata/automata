// Spike 021: per-scope agent memory with qm-style revision checks.
// One JSON file per scope under <root>/<scope>/memory.json (in the product: a row per record, `rev` CAS).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Sensitivity = "internal" | "restricted";
export type Author = "agent" | "human";
export interface MemoryRecord {
  id: string;
  scope: string;
  text: string;
  sensitivity: Sensitivity;
  rev: number;
  author: Author; // who wrote the CURRENT revision
  humanEdited: boolean; // once a human has written it, agents may only propose
  provenance: { sessionId?: string; turn?: number; editedBy?: string };
  promotedTo?: string; // claim id once a promotion is approved
}

export class MemoryConflictError extends Error {
  readonly current: MemoryRecord;
  constructor(current: MemoryRecord, expected: number) {
    super(`memory ${current.id}: expected rev ${expected}, store has rev ${current.rev}; re-read before writing`);
    this.name = "MemoryConflictError";
    this.current = current;
  }
}
export class HumanOwnedMemoryError extends Error {
  constructor(id: string) {
    super(`memory ${id} was edited by a human; agents may propose a change, never overwrite it`);
    this.name = "HumanOwnedMemoryError";
  }
}
export class ScopeError extends Error {
  constructor(scope: string) {
    super(`bad scope "${scope}"`);
    this.name = "ScopeError";
  }
}

const SCOPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class MemoryStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  private file(scope: string): string {
    if (!SCOPE.test(scope)) throw new ScopeError(scope); // no "../other-scope", no absolute paths
    return join(this.root, scope, "memory.json");
  }
  list(scope: string): MemoryRecord[] {
    const f = this.file(scope);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as MemoryRecord[]) : [];
  }
  get(scope: string, id: string): MemoryRecord | undefined {
    return this.list(scope).find((r) => r.id === id);
  }
  private save(scope: string, records: MemoryRecord[]): void {
    mkdirSync(join(this.root, scope), { recursive: true });
    writeFileSync(this.file(scope), JSON.stringify(records, null, 2));
  }
  add(scope: string, text: string, sensitivity: Sensitivity, author: Author, provenance: MemoryRecord["provenance"]): MemoryRecord {
    const records = this.list(scope);
    const rec: MemoryRecord = { id: `${scope}-m${records.length + 1}`, scope, text, sensitivity, rev: 1, author, humanEdited: author === "human", provenance };
    this.save(scope, [...records, rec]);
    return rec;
  }
  /** Agents must pass the rev they read. Humans always win: their write bumps rev and locks out agent overwrites. */
  write(scope: string, id: string, text: string, author: Author, expectedRev?: number, editedBy?: string): MemoryRecord {
    const records = this.list(scope);
    const cur = records.find((r) => r.id === id);
    if (!cur) throw new Error(`memory ${id} not found in scope ${scope}`);
    if (author === "agent") {
      if (expectedRev !== cur.rev) throw new MemoryConflictError(cur, expectedRev ?? -1);
      if (cur.humanEdited) throw new HumanOwnedMemoryError(id);
    }
    const next: MemoryRecord = { ...cur, text, rev: cur.rev + 1, author, humanEdited: cur.humanEdited || author === "human", provenance: { ...cur.provenance, ...(editedBy ? { editedBy } : {}) } };
    this.save(scope, records.map((r) => (r.id === id ? next : r)));
    return next;
  }
  markPromoted(scope: string, id: string, claimId: string): void {
    this.save(scope, this.list(scope).map((r) => (r.id === id ? { ...r, promotedTo: claimId } : r)));
  }
  /** What a wake injects into a fresh harness session: this scope's records only. */
  render(scope: string): string {
    return this.list(scope).map((r) => `- ${r.text}`).join("\n");
  }
}
