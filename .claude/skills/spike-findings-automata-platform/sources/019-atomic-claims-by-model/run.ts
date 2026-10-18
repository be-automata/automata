// Run: node --experimental-strip-types --no-warnings run.ts   (claude CLI needed only on a cold cache)
// Scores model-seeded atomic claims against the git-diff oracle and compares them with spike 014's paragraph claims.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { replay as paragraphReplay } from "../014-knowledge-self-heal-loop/heal.ts";
import { BASE, FILE, git, MERGES, replay, type StepReport } from "./replay.ts";
import type { SeedReport } from "./seed.ts";

const HERE = import.meta.dirname;
const seed = JSON.parse(readFileSync(join(HERE, "seed.json"), "utf8")) as SeedReport;
const para = paragraphReplay();
const noInc = replay(seed.claims, seed.sentinels, false);
// Any base-seeded scheme (spike 014's paragraphs included) has these holes iff they sit in text the base never had.
const baseText = git("show", `${BASE}:${FILE}`);
const holeText = noInc.steps.flatMap((s, i) => s.uncoveredChangedLines.map((n) => git("show", `${i ? MERGES[i - 1] : BASE}:${FILE}`).split("\n")[n - 1]!.trim()));
const atomic = replay(seed.claims, seed.sentinels);

const checks: { name: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown) => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`); };
const sum = (ss: { llmCalls: number }[]) => ss.reduce((n, s) => n + s.llmCalls, 0);
const approvals = (ss: { ops: { auto: boolean }[] }[]) => ss.reduce((n, s) => n + s.ops.filter((o) => !o.auto).length, 0);
const repins = (ss: { ops: { auto: boolean }[] }[]) => ss.reduce((n, s) => n + s.ops.filter((o) => o.auto).length, 0);

for (const s of atomic.steps) {
  const kinds = s.ops.reduce<Record<string, number>>((m, o) => ({ ...m, [o.op]: (m[o.op] ?? 0) + 1 }), {});
  console.log(`${s.sha} #${s.pr ?? "-"} +claims=${s.added.claims} +sentinels=${s.added.sentinels} ${s.subject.slice(0, 44).padEnd(44)} claims=${s.claims} flagged=${s.flagged} oracle=${s.oracleTouched} FP=${s.falsePositives.length} amb=${s.ambiguous.length} FN=${s.falseNegatives.length} llm=${s.llmCalls} ops=${JSON.stringify(kinds)} drift=${s.driftAfterApprove}`);
  if (s.falsePositives.length || s.falseNegatives.length) console.log(`   FP ${s.falsePositives.join(",")}  FN ${s.falseNegatives.join(",")}`);
}
check("atomic: flags == git-diff oracle on every merge", atomic.steps.every((s) => !s.falsePositives.length && !s.falseNegatives.length), atomic.steps.map((s) => `${s.pr}:${s.flagged}/${s.oracleTouched}`));
check("atomic: zero drift after approval", atomic.steps.every((s) => s.driftAfterApprove === 0), atomic.steps.map((s) => s.driftAfterApprove));

// #287 renamed the label needs-human-approve -> needs-human-review. Atomic claims must flag exactly the
// claims that mention the label, and the proposal must carry the new label.
const rename = atomic.steps.find((s) => s.pr === "287")!;
const renameOps = rename.ops.filter((o) => !o.auto && (o.op as string) !== "reverify");
const reverifies = atomic.steps.flatMap((s) => s.ops.filter((o) => (o.op as string) === "reverify").map((o) => `${s.pr}:${o.claimId}`));
check("atomic #287: every content-changing proposal is about the renamed label", renameOps.length > 0 && renameOps.every((o) => o.before.includes("needs-human-approve")), { proposals: renameOps.map((o) => o.before.slice(0, 90)), reverifies });
check("coverage WITHOUT incremental seeding has holes (text added after the seed drifts silently)", noInc.steps.some((s) => s.uncoveredChangedLines.length > 0), noInc.steps.map((s) => `${s.pr}:${s.uncoveredChangedLines.length}`));
check("every hole is text inserted after the seed, so spike 014's paragraphs had it too (its 0 FN only scored claimed spans)", holeText.length > 0 && holeText.every((t) => !baseText.includes(t)), holeText.map((t) => t.slice(0, 60)));
check("coverage: every changed prose line was covered by a claim or a sentinel", atomic.steps.every((s) => !s.uncoveredChangedLines.length), atomic.steps.map((s) => `${s.pr}:${s.uncoveredChangedLines.join("|") || "ok"}`));
check("#306 'org owner' step change is caught by an atomic claim (paragraph baseline caught it, first seed pass missed it)", atomic.steps.find((s) => s.pr === "306")!.ops.some((o) => !o.auto && /org owner/i.test(o.before)), atomic.steps.find((s) => s.pr === "306")!.ops.filter((o) => !o.auto).map((o) => ({ op: o.op, before: o.before, after: o.after })));

check("atomic #287: update proposals carry needs-human-review and drop the old label", renameOps.every((o) => o.op === "update" && o.after?.includes("needs-human-review") && !o.after.includes("needs-human-approve")), renameOps.map((o) => ({ op: o.op, after: o.after?.slice(0, 90) })));
const paraRename = para.steps.find((s) => s.pr === "287")!.ops.filter((o) => !o.auto);
check("paragraph #287 baseline: flagged statement never mentioned the label (too coarse)", paraRename.every((o) => !o.before.includes("needs-human")), paraRename.map((o) => o.before));
console.log("sentinel reviews:", JSON.stringify(atomic.steps.flatMap((s) => s.sentinelReviews.map((w) => ({ pr: s.pr, ...w, old: w.old.slice(0, 80), now: w.now.slice(0, 80) })))));
check("every update proposal clears the support floor or became a review", atomic.steps.every((s) => s.ops.filter((o) => o.op === "update").every((o) => (o.score ?? 0) >= 0.5)), atomic.steps.flatMap((s) => s.ops.filter((o) => o.op !== "repin").map((o) => `${o.op}:${o.claimId}@${o.score ?? "-"}`)));

const seedCost = seed.calls.reduce((n, c) => n + c.costUsd, 0), updCost = atomic.updateCalls.reduce((n, c) => n + c.costUsd, 0);
const comparison = {
  paragraph: { claims: para.baseClaims, flagged: para.steps.reduce((n, s) => n + s.flagged, 0), modelCalls: sum(para.steps), approvals: approvals(para.steps), autoRepins: repins(para.steps), seedModelCalls: 0 },
  atomic: {
    claims: atomic.baseClaims, rejectedAtSeed: seed.rejected.length, repairedAtSeed: seed.claims.filter((c) => c.repairedFrom).length,
    gapClaims: seed.gapClaims ?? 0, sentinels: seed.sentinels.length, sentinelReviews: atomic.steps.reduce((n, s) => n + s.sentinelReviews.length, 0), reverifies: reverifies.length,
    flagged: atomic.steps.reduce((n, s) => n + s.flagged, 0), modelCalls: sum(atomic.steps), approvals: approvals(atomic.steps), autoRepins: repins(atomic.steps),
    seedModelCalls: seed.calls.length, seedInputTokens: seed.calls.reduce((n, c) => n + c.inputTokens, 0), seedOutputTokens: seed.calls.reduce((n, c) => n + c.outputTokens, 0),
    seedCostUsd: Math.round(seedCost * 10000) / 10000, updateCostUsd: Math.round(updCost * 10000) / 10000,
    incremental: { modelCalls: atomic.addCalls.length, claimsAdded: atomic.steps.reduce((n, s) => n + s.added.claims, 0), sentinelsAdded: atomic.steps.reduce((n, s) => n + s.added.sentinels, 0), costUsd: Math.round(atomic.addCalls.reduce((n, c) => n + c.costUsd, 0) * 10000) / 10000 }, model: seed.calls[0]?.model,
  },
};
console.log(JSON.stringify(comparison, null, 2));
writeFileSync(join(HERE, "results.json"), JSON.stringify({ comparison, checks, steps: atomic.steps satisfies StepReport[], rejected: seed.rejected }, null, 2));
writeFileSync(join(HERE, "events.jsonl"), [
  ...atomic.steps.map((s) => ({ at: new Date().toISOString(), cat: "merge", sha: s.sha, pr: s.pr, flagged: s.flagged, oracle: s.oracleTouched, fp: s.falsePositives.length, fn: s.falseNegatives.length, ambiguous: s.ambiguous.length, llm: s.llmCalls, ops: s.ops.map((o) => o.id), drift: s.driftAfterApprove })),
  ...checks.map((c) => ({ at: new Date().toISOString(), cat: "check", ...c })),
].map((e) => JSON.stringify(e)).join("\n") + "\n");
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
