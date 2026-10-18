// Spike 021: agent memory + context persistency (phase A, real `claude -p`) and memory -> knowledge promotion (phase B).
// Run (real Claude Code on subscription auth, so outside the Claude sandbox; ~10 tiny haiku calls):
//   node --experimental-strip-types --no-warnings run.ts
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { checkPage, generateSidecar } from "../010-grounded-knowledge-claims/claims.ts";
import { HumanOwnedMemoryError, MemoryConflictError, MemoryStore, ScopeError, type Sensitivity } from "./memory.ts";
import { proposePromotion, type PromotionItem } from "./promote.ts";

const HERE = import.meta.dirname;
const WORK = join(HERE, "work");
const PROJECTS = join(homedir(), ".claude", "projects");
const A = "spike021-scope-a", B = "spike021-scope-b";
const events: object[] = [];
const log = (cat: string, data: object) => { events.push({ at: new Date().toISOString(), cat, ...data }); };
interface Check { name: string; ok: boolean; detail: unknown }
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: unknown) => {
  checks.push({ name, ok, detail });
  log("check", { name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail).slice(0, 220)}`);
};
const expectThrow = (fn: () => unknown, cls: new (...a: never[]) => Error): string => {
  try { fn(); } catch (e) { if (e instanceof cls) return e.message; throw e; }
  throw new Error(`expected ${cls.name}`);
};

// ---- real harness turns ---------------------------------------------------------
interface Turn { ok: boolean; result: string; sessionId: string; ms: number; costUsd: number }
let calls = 0, costUsd = 0;
function claude(cwd: string, prompt: string, opts: { sessionId?: string; resume?: string; configDir?: string } = {}): Turn {
  const args = ["-p", prompt, "--model", "haiku", "--setting-sources", "project", "--strict-mcp-config", "--output-format", "json"];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.resume) args.push("--resume", opts.resume);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription auth only
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
  const t = performance.now();
  calls++;
  try {
    const out = execFileSync("claude", args, { cwd, env, input: "", encoding: "utf8", timeout: 180_000, maxBuffer: 1 << 24 });
    const j = JSON.parse(out) as { result?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean };
    costUsd += j.total_cost_usd ?? 0;
    const turn = { ok: !j.is_error, result: (j.result ?? "").trim(), sessionId: j.session_id ?? "", ms: Math.round(performance.now() - t), costUsd: j.total_cost_usd ?? 0 };
    log("turn", { cwd: cwd.replace(WORK, "work"), prompt: prompt.slice(0, 60), resume: opts.resume ?? null, ...turn });
    return turn;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const turn = { ok: false, result: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(0, 300), sessionId: "", ms: Math.round(performance.now() - t), costUsd: 0 };
    log("turn", { cwd: cwd.replace(WORK, "work"), prompt: prompt.slice(0, 60), resume: opts.resume ?? null, ...turn });
    return turn;
  }
}
/** Claude Code keys sessions by cwd: ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl */
const projectDir = (cwd: string) => join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
// Persistence probes use an INTERNAL fact. The restricted codeword is not a recall probe: whether the model
// discloses a restricted fact is model judgment (observed: it sometimes refuses after compaction), not persistence.
const RECALL = "What is our staging cluster named? Reply with the name only, or UNKNOWN if you were never told.";
const knows = (t: Turn) => t.ok && /HERON-7/i.test(t.result);
/** Wake preamble: the scope's durable memory rides in the turn itself. --append-system-prompt was flaky on --resume (observed UNKNOWN). */
const withMemory = (store: MemoryStore, scope: string, q: string) => `<scope-memory scope="${scope}">\n${store.render(scope) || "(none)"}\n</scope-memory>\n\n${q}`;

function cleanupSessions() {
  if (!existsSync(PROJECTS)) return;
  for (const d of readdirSync(PROJECTS)) if (d.includes("spike021-scope-")) rmSync(join(PROJECTS, d), { recursive: true, force: true });
}

const results: Record<string, unknown> = {};
try {
  cleanupSessions();
  rmSync(WORK, { recursive: true, force: true });
  const homes = join(WORK, "homes"); // each scope's $HOME volume (memory.json lives here)
  const cwdOf = (scope: string, rev = "repo") => { const d = join(WORK, scope, rev); mkdirSync(d, { recursive: true }); return d; };
  const store = new MemoryStore(homes);

  // ===== Phase A: persistence ======================================================
  const aCwd = cwdOf(A);
  const sid = randomUUID();
  const t1 = claude(aCwd, `A teammate in this channel says: "Our support escalation codeword is PELICAN-42. Our staging cluster is named HERON-7. Also, free trials last 14 days."
For each durable fact worth remembering, output one line exactly like "MEMORY[internal]: <fact>" or "MEMORY[restricted]: <fact>" (restricted = secret-like, must never leave this channel). Then a final line "OK".`, { sessionId: sid });
  const mems = [...t1.result.matchAll(/MEMORY\[(internal|restricted)\]:\s*(.+)/g)].map((m) => store.add(A, (m[2] ?? "").trim(), m[1] as Sensitivity, "agent", { sessionId: t1.sessionId, turn: 1 }));
  const codeword = mems.find((m) => /PELICAN-42/i.test(m.text));
  const trial = mems.find((m) => /14/.test(m.text) && /trial/i.test(m.text));
  const cluster = mems.find((m) => /HERON-7/i.test(m.text));
  check("turn 1 (real claude): agent proposes memory records, written to scope A with session provenance",
    t1.ok && !!codeword && !!trial && !!cluster && mems.every((m) => m.provenance.sessionId === sid), { records: mems.map((m) => `${m.sensitivity}: ${m.text}`), ms: t1.ms });
  const jsonl = join(projectDir(aCwd), `${sid}.jsonl`);
  check("session JSONL persisted under the scope's ~/.claude/projects/<cwd-slug>/", existsSync(jsonl), { jsonl: jsonl.replace(homedir(), "~") });

  // Stop: the harness process is gone (claude -p exits). Wake = resume by id.
  const r1 = claude(aCwd, RECALL, { resume: sid });
  check("after stop: --resume recalls the turn-1 fact", knows(r1), { result: r1.result, ms: r1.ms });

  // Recreate on rev N+1: rootfs/checkout wiped and recreated at the SAME path; $HOME (incl. ~/.claude) kept
  rmSync(aCwd, { recursive: true, force: true });
  mkdirSync(aCwd, { recursive: true });
  const r2 = claude(aCwd, RECALL, { resume: sid });
  check("after recreate (same workdir path): --resume still recalls", knows(r2), { result: r2.result, ms: r2.ms });

  // Recreate where rev N+1 moved the workdir: session lookup is keyed by cwd
  const movedCwd = cwdOf(A, "repo-v2");
  const r3 = claude(movedCwd, RECALL, { resume: sid });
  results.resumeFromMovedWorkdir = { ok: r3.ok, result: r3.result.slice(0, 160) };
  check("after recreate with a MOVED workdir: --resume still finds the session (lookup by id spans every project in the config dir)", knows(r3), results.resumeFromMovedWorkdir);

  // Scope isolation, part 1 (before compaction, which may drop the fact): a shared ~/.claude leaks across scopes
  const bCwd = cwdOf(B);
  const bShared = claude(bCwd, RECALL, { resume: sid });
  check("anti-pattern: scopes sharing one ~/.claude are NOT isolated - scope B resumes scope A's session by id (leak confirmed)", knows(bShared), { bShared: bShared.result.slice(0, 100) });

  // Context compaction: lossy by design. The session alone may or may not keep the fact (observed, not asserted);
  // the durable layer (scope memory re-injected at wake) must restore it either way.
  const c = claude(aCwd, "/compact", { resume: sid });
  const compacted = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).some((l) => (JSON.parse(l) as { subtype?: string }).subtype === "compact_boundary");
  const r4 = claude(aCwd, RECALL, { resume: sid });
  results.recallAfterCompactSessionOnly = r4.result;
  const r5 = claude(aCwd, withMemory(store, A, RECALL), { resume: sid });
  check("after /compact: compact_boundary written; with scope memory re-injected the fact is recalled (session-only recall is observed, not guaranteed)", c.ok && compacted && knows(r5), { compacted, sessionOnly: r4.result, withMemory: r5.result });

  // Session lost (moved workdir, corrupted JSONL...): the structured scope memory is the durable layer
  const freshNoMem = claude(movedCwd, RECALL);
  const freshMem = claude(movedCwd, withMemory(store, A, RECALL));
  check("fresh session: without memory it does not know; with scope memory injected at wake it recalls", !knows(freshNoMem) && knows(freshMem), { without: freshNoMem.result, with: freshMem.result });

  // Scope isolation
  const bConfig = join(homes, B, ".claude"); // scope B's own $HOME volume
  mkdirSync(bConfig, { recursive: true });
  const bIsolated = claude(bCwd, RECALL, { resume: sid, configDir: bConfig });
  check("per-scope config dir (scope's own $HOME/.claude): resuming scope A's session id fails - 'No conversation found'", !bIsolated.ok && /No conversation found/.test(bIsolated.result), { bIsolated: bIsolated.result.slice(0, 120) });
  const bFresh = claude(bCwd, withMemory(store, B, RECALL));
  check("scope B's own memory carries none of A's facts", !knows(bFresh) && store.list(B).length === 0, { bFresh: bFresh.result });
  check("scope ids are validated: a path-traversal scope is refused", /bad scope/.test(expectThrow(() => store.list(`../${A}`), ScopeError)), {});

  // Revision-checked writes: a concurrent human edit wins
  if (!trial) throw new Error("no trial memory record to test revisions on");
  const read = store.get(A, trial.id);
  const human = store.write(A, trial.id, "Free trials last 14 days and need no card.", "human", undefined, "support-lead");
  const conflict = expectThrow(() => store.write(A, trial.id, "Free trials are two weeks.", "agent", read?.rev), MemoryConflictError);
  const owned = expectThrow(() => store.write(A, trial.id, "Free trials are two weeks.", "agent", human.rev), HumanOwnedMemoryError);
  check("revision check: agent write with a stale rev conflicts; after re-read it is still refused (human-owned)",
    store.get(A, trial.id)?.text === "Free trials last 14 days and need no card." && /expected rev 1/.test(conflict) && /edited by a human/.test(owned), { conflict, owned });
  const other = store.add(A, "Weekly digest goes out on Mondays.", "internal", "agent", { sessionId: sid, turn: 2 });
  store.write(A, other.id, "Weekly digest goes out on Mondays at 9am.", "agent", 1);
  check("two agent writers on the same rev: the second gets a conflict", /expected rev 1, store has rev 2/.test(expectThrow(() => store.write(A, other.id, "Digest on Tuesdays.", "agent", 1), MemoryConflictError)), {});

  // ===== Phase B: promotion into grounded knowledge =================================
  const kroot = join(WORK, "kroot");
  for (const d of ["repo", "docs", "tickets"]) cpSync(join(HERE, "../010-grounded-knowledge-claims/fixtures", d), join(kroot, d), { recursive: true });
  const seat = store.add(A, "Seat price is 29 USD per month.", "internal", "agent", { sessionId: sid, turn: 3 });
  const bClaim = store.add(B, "Free trials last 21 days.", "internal", "agent", { sessionId: "sales-channel-session", turn: 4 }); // a sales channel heard it wrong
  const queue: PromotionItem[] = [...store.list(A), ...store.list(B)].map((m) => proposePromotion(kroot, m));
  const byMem = (id: string) => queue.find((q) => q.memory.id === id);
  const qTrial = byMem(trial.id), qCode = codeword ? byMem(codeword.id) : undefined, qSeat = byMem(seat.id), qB = byMem(bClaim.id);
  check("queue: grounded memory -> promote proposal citing repo + doc evidence, with memory id + session provenance",
    qTrial?.kind === "promote" && (qTrial.proposedClaim?.evidence.length ?? 0) >= 2 && qTrial.memory.sessionId === sid, { evidence: qTrial?.proposedClaim?.evidence, why: qTrial?.why });
  check("queue: the codeword never becomes company knowledge (restricted or ungrounded)", qCode?.kind === "restricted" || qCode?.kind === "ungrounded", { kind: qCode?.kind, sensitivity: codeword?.sensitivity });
  check("queue: another scope's wrong memory (21 days) is a contradiction against the sources, not a claim", qB?.kind === "contradiction" && !qB.proposedClaim, { why: qB?.why });
  check("nothing is promoted without a human: every item starts pending", queue.every((q) => q.decision === "pending"), { items: queue.length });

  // Human decisions: approve the trial fact, reject the seat price
  if (!qTrial?.proposedClaim || !qSeat) throw new Error("queue items missing");
  qTrial.decision = "approved";
  qSeat.decision = "rejected";
  const approved = queue.filter((q) => q.decision === "approved" && q.kind === "promote" && q.proposedClaim).map((q) => q.proposedClaim as NonNullable<PromotionItem["proposedClaim"]>);
  for (const q of queue.filter((x) => x.decision === "approved")) store.markPromoted(q.memory.scope, q.memory.id, q.proposedClaim?.id ?? "");
  // The claim's statement is the HUMAN's current text of the memory record (the human edit won in phase A).
  const claims = approved.map((p) => ({ ...p, statement: store.get(A, trial.id)?.text ?? p.statement }));
  const md = `# Promoted knowledge\n\n${claims.map((x) => x.statement).join("\n\n")}\n`;
  const sc = generateSidecar(kroot, "promoted-knowledge", md, claims);
  const fresh = checkPage(kroot, md, sc);
  check("approved -> exactly one grounded claim; rejected seat price is not a claim; page checks fresh",
    sc.claims.length === 1 && fresh.claims.every((x) => x.status === "fresh") && store.get(A, trial.id)?.promotedTo === `c-${trial.id}`, { claims: sc.claims.map((x) => x.statement) });

  // Self-heal: engineering changes the trial; the promoted claim enters the 010/014 loop as a CONFLICT
  const bill = join(kroot, "repo", "billing.ts");
  writeFileSync(bill, readFileSync(bill, "utf8").replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30"));
  const after = checkPage(kroot, md, sc);
  check("source changes later: the promoted claim flips to conflict (code 30 vs doc 14); the memory record is not silently rewritten",
    after.claims[0]?.status === "conflict" && /14 days/.test(store.get(A, trial.id)?.text ?? ""), { status: after.claims[0]?.status });

  results.claudeCalls = calls;
  results.claudeCostUsd = +costUsd.toFixed(4);
  results.queue = queue;
} catch (e) {
  check("runner crashed", false, e instanceof Error ? e.message : String(e));
} finally {
  cleanupSessions(); // only the spike's own ~/.claude/projects/*spike021-scope-* dirs
  rmSync(WORK, { recursive: true, force: true });
  results.checks = checks;
  writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const passed = checks.filter((x) => x.ok).length;
  console.log(`\n${passed}/${checks.length} passed; claude calls ${calls}, cost $${costUsd.toFixed(4)}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}
