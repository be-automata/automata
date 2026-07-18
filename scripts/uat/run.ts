#!/usr/bin/env -S npx tsx
// Self-contained UAT runner. Preflight (hard-stop) → run cases (self-provisioning) → results JSON + table → exit nonzero on FAIL.
// Usage:
//   pnpm uat                 # all runnable cases
//   pnpm uat S1 S2 S7        # a subset
//   pnpm uat --list          # list case ids
// Params via env (see scripts/uat/lib.ts / docs/uat/README.md): REPO, BASE, BOT_LOGIN, BOT_HANDLE, WORKER_URL, HATCHET_PG.
import { P, preflight, CaseResult, poll, botReviews, stageFixturePR, pushFixContent, FULL_FIX, cleanup } from "./lib";
import * as C from "./cases";
import { writeFileSync, mkdirSync } from "node:fs";

const ALL = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S12", "S10", "S11", "S13", "S14"];
const args = process.argv.slice(2);
if (args.includes("--list")) { console.log(ALL.join(" ")); process.exit(0); }
const want = new Set(args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase()));
const runAll = want.size === 0;
const wants = (id: string) => runAll || want.has(id);

(async () => {
  console.log(`# UAT run ${P.RUN_ID} — repo ${P.REPO} @ ${P.BASE}, bot @${P.BOT_HANDLE} (${P.BOT_LOGIN})`);
  const pf = preflight();
  pf.notes.forEach((n) => console.log(`  note: ${n}`));
  if (!pf.ok) {
    console.error("\nPREFLIGHT FAILED — fix these before running (the suite would silently no-op otherwise):");
    pf.problems.forEach((p) => console.error(`  ✗ ${p}`));
    process.exit(2);
  }
  console.log("preflight OK\n");

  const results: CaseResult[] = [];
  const add = (rs: CaseResult | CaseResult[]) => { for (const r of ([] as CaseResult[]).concat(rs)) { results.push(r); console.log(`  ${r.status.padEnd(16)} ${r.id}  ${r.reasons[0] ?? ""}`); } };

  // Review-path lifecycle (S1-S3) — one self-provisioned PR.
  if (wants("S1") || wants("S2") || wants("S3")) add(await C.S1_S3());

  // S6 — its own unfixed-defect PR.
  if (wants("S6")) add(await C.S6());

  // S12 — its own burst issues.
  if (wants("S12")) add(await C.S12());

  // Mention/command cases that need a PR context — one shared, driven through states.
  if (["S4", "S5", "S7", "S8", "S9"].some(wants)) {
    let f;
    try {
      f = stageFixturePR("mention");
      // wait for the opened auto-review so S5/S7 have a verdict to work against
      await poll(() => botReviews(f.pr), (rs) => rs.some((x) => !x.dismissed_at && (x.state === "CHANGES_REQUESTED" || x.state === "APPROVED")));
      if (wants("S4")) add(await C.S4(f.pr));
      if (wants("S9")) add(await C.S9(f.pr));
      if (wants("S7")) add(await C.S7(f.pr));
      if (wants("S5")) add(await C.S5(f.pr));
      if (wants("S8")) {
        // S8 needs a non-dismissed APPROVED: push the full fix and wait for it.
        const sha = pushFixContent(f, FULL_FIX, "uat: full fix to obtain APPROVED for S8");
        await poll(() => botReviews(f.pr), (rs) => rs.some((x) => x.commit_id === sha && x.state === "APPROVED" && !x.dismissed_at));
        add(await C.S8(f.pr));
      }
    } catch (e: any) { console.error(`mention-group setup error: ${e.message}`); }
    finally { if (f) cleanup(f); }
  }

  // Phase-2-gated.
  if (["S10", "S11", "S13", "S14"].some(wants)) add(C.phase2().filter((r) => wants(r.id)));

  // ---- summary + machine-readable results ----
  const tally = results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`\n# SUMMARY  ${Object.entries(tally).map(([k, v]) => `${k}:${v}`).join("  ")}`);
  mkdirSync("scripts/uat/results", { recursive: true });
  const out = `scripts/uat/results/uat-${P.RUN_ID}.json`;
  writeFileSync(out, JSON.stringify({ runId: P.RUN_ID, repo: P.REPO, at: new Date().toISOString(), params: { ...P }, tally, results }, null, 2));
  console.log(`results: ${out}`);

  const failed = results.filter((r) => r.status === "FAIL");
  if (failed.length) { console.error(`\nFAILED: ${failed.map((r) => r.id).join(", ")}`); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(3); });
