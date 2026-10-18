// Spike 020: replay REAL Slack revisions through spike 010's claim engine. Exit 0/1.
// Run: node --experimental-strip-types --no-warnings scenarios.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyDraft, checkPage, generateSidecar, reconcile, resolve, stubUpdater, type Sidecar } from "../010-grounded-knowledge-claims/claims.ts";
import { CAPTURE, allMessages, historyAsOf, materialize, msgUri, viewUri } from "./connector.ts";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "work", "root");
const BOT = "B_AUDIT";
const TS = {
  d0911: "1789113952.495539", d0914: "1789373131.459959", d0915: "1789459341.906859",
  d0916: "1789545835.706929", d0917: "1789632201.631229", d1009: "1791533069.158119",
};
const events: object[] = [];
const results: { name: string; pass: boolean; detail: unknown }[] = [];
const check = (name: string, pass: boolean, detail: unknown) => {
  results.push({ name, pass, detail });
  events.push({ at: new Date().toISOString(), cat: "scenario", name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const gaps = (t: string) => Number(/found (\d+) gap/.exec(t)?.[1]);

/** Synthetic ops doc (marketing/support side). Its text is ours; only the Slack side is real. */
function writeDoc(n: number) {
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(join(ROOT, "docs", "ops-status.md"), `# Ops status\n\n## Audit\n\nThe nightly audit reports ${n} gaps.\n`);
}
const page = (s: string) => `${s}\n`;
const sidecarAt = (rev: string, statement: string, evidence: string[]): Sidecar => {
  materialize(ROOT, rev);
  return generateSidecar(ROOT, "ops-faq", page(statement), [{ id: "c1", statement, evidence }]);
};

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// C1. A revision id must be reproducible: two independent API reads agree on every shared ts.
{
  const [a, b] = CAPTURE.reads;
  const shared = (b?.messages ?? []).filter((m) => a?.messages.some((x) => x.ts === m.ts));
  let ok = true;
  try { allMessages(); } catch { ok = false; }
  check("C1 same ts → same bytes across independent reads", ok && shared.length === 2, { shared: shared.map((m) => m.ts) });
}

// C2. `latest` is exclusive by default: the real read with latest=T did NOT return message T.
{
  const read2 = CAPTURE.reads[1]?.messages.map((m) => m.ts) ?? [];
  const exclusive = historyAsOf(TS.d0916, false).slice(0, 2).map((m) => m.ts);
  const inclusive = historyAsOf(TS.d0916, true).slice(0, 2).map((m) => m.ts);
  check("C2 conversations.history latest is EXCLUSIVE (revision views must pass inclusive=true)",
    JSON.stringify(read2) === JSON.stringify(exclusive) && inclusive[0] === TS.d0916, { read2, exclusive, inclusive });
}

// C3. 09-14 → 09-15: count unchanged (3→3), new message ts. Fresh, 0 model calls, provenance re-observed.
{
  const s = "The nightly production PR-review audit currently reports 3 gaps.";
  const sc = sidecarAt(TS.d0914, s, [viewUri(BOT)]);
  materialize(ROOT, TS.d0915);
  const r = checkPage(ROOT, page(s), sc);
  const nowTs = resolve(ROOT, viewUri(BOT, "ts"));
  check("C3 same fact in a newer message → fresh, 0 calls, rev re-observed",
    r.claims[0]?.status === "fresh" && "text" in nowTs && nowTs.text === TS.d0915, { status: r.claims[0]?.status, observedTs: "text" in nowTs ? nowTs.text : null });
}

// C4. 09-15 → 09-16: 3→2. Stale → one batched update proposal, needs approval.
{
  const s = "The nightly production PR-review audit currently reports 3 gaps.";
  const sc = sidecarAt(TS.d0915, s, [viewUri(BOT)]);
  materialize(ROOT, TS.d0916);
  const u = stubUpdater();
  const d = reconcile(ROOT, page(s), sc, u);
  const op = d.ops[0];
  check("C4 count changed 3→2 → update proposal (1 model call, not auto)",
    d.ops.length === 1 && op?.op === "update" && op.auto === false && op.after?.includes("2 gaps") === true && d.llmCalls === 1, { op: op?.op, after: op?.after, llmCalls: d.llmCalls });
}

// C5. Cross-source: Slack moved 2→1 at 09-17, the ops doc still says 2 → conflict, 0 calls.
{
  writeDoc(2);
  const s = "The nightly audit reports 2 gaps.";
  const sc = sidecarAt(TS.d0916, s, [viewUri(BOT), "doc://ops-status#audit"]);
  materialize(ROOT, TS.d0917);
  const d = reconcile(ROOT, page(s), sc, stubUpdater());
  check("C5 Slack says 1, doc still says 2 → conflict to the doc owner, 0 calls",
    d.ops[0]?.op === "conflict" && d.llmCalls === 0, { ops: d.ops.map((o) => o.op), llmCalls: d.llmCalls });
}

// C6. The trap: pinning a "current state" fact to ONE message ts never goes stale.
{
  const s = "The nightly production PR-review audit currently reports 2 gaps.";
  const sc = sidecarAt(TS.d0916, s, [msgUri(TS.d0916)]);
  materialize(ROOT, TS.d1009);
  const viewNow = resolve(ROOT, viewUri(BOT));
  const r = checkPage(ROOT, page(s), sc);
  check("C6 message-ts pin stays fresh while the view says 1 gap (use views for current state)",
    r.claims[0]?.status === "fresh" && "text" in viewNow && gaps(viewNow.text) === 1, { status: r.claims[0]?.status, viewNow: "text" in viewNow ? gaps(viewNow.text) : null });
}

// C7. SYNTHETIC deletion (message_deleted): an immutable message pin goes missing → retract proposal.
{
  const s = "On 2026-09-16 the audit reported 2 gaps.";
  const sc = sidecarAt(TS.d0916, s, [msgUri(TS.d0916)]);
  materialize(ROOT, TS.d1009, [TS.d0916]);
  const d = reconcile(ROOT, page(s), sc, stubUpdater());
  check("C7 [synthetic] deleted message → retract proposal, not auto", d.ops[0]?.op === "retract" && d.ops[0]?.auto === false, { ops: d.ops.map((o) => `${o.op}${o.auto ? "(auto)" : ""}`) });
}

// C8. Full replay over every captured revision; oracle = did the count change between consecutive messages.
{
  const series = allMessages().slice().reverse(); // oldest first
  const first = series[0];
  if (!first) throw new Error("empty capture");
  let s = `The nightly production PR-review audit currently reports ${gaps(first.text)} gaps.`;
  let sc = sidecarAt(first.ts, s, [viewUri(BOT)]);
  let fp = 0, fn = 0, calls = 0, updates = 0;
  for (let i = 1; i < series.length; i++) {
    const m = series[i]!; // i < series.length
    const changed = gaps(m.text) !== gaps(series[i - 1]!.text); // i ≥ 1
    materialize(ROOT, m.ts);
    const u = stubUpdater();
    const d = reconcile(ROOT, page(s), sc, u);
    calls += d.llmCalls;
    const flagged = d.ops.some((o) => o.op === "update");
    if (flagged && !changed) fp++;
    if (!flagged && changed) fn++;
    if (flagged) {
      updates++;
      const applied = applyDraft(ROOT, page(s), sc, d, d.ops.map((o) => o.id)); // the human approves
      s = applied.md.trim();
      sc = applied.sc;
    }
  }
  const finalGaps = Number(/reports (\d+) gaps/.exec(s)?.[1]);
  check("C8 replay of 7 real revisions: flags == count-change oracle, page ends true",
    fp === 0 && fn === 0 && finalGaps === gaps(series.at(-1)!.text), { revisions: series.length, updates, fp, fn, modelCalls: calls, final: s }); // series non-empty
}

const passed = results.filter((r) => r.pass).length;
writeFileSync(join(HERE, "results.json"), JSON.stringify({ passed, total: results.length, results }, null, 2));
writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`\n${passed}/${results.length} passed`);
process.exitCode = passed === results.length ? 0 : 1;
