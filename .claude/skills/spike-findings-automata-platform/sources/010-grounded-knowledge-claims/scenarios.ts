// Run: ../../../packages/worker/node_modules/.bin/tsx scenarios.ts
// Each scenario: fresh copy of fixtures -> agent generates sidecar -> mutate a source -> check + reconcile.
import { cpSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyDraft, checkPage, HumanEditedPageError, generateSidecar, reconcile, stubUpdater, type ClaimStatus, type Draft, type Sidecar } from "./claims.ts";

const HERE = import.meta.dirname;
const PAGE = "billing-faq";

export interface Scenario {
  name: string;
  who: string; // which department changed something
  mutate: (root: string) => void;
  expect: Record<string, ClaimStatus>;
  expectLlmCalls: number;
  expectMode?: Draft["mode"];
  expectStatement?: Record<string, string>;
}

const edit = (root: string, rel: string, f: (s: string) => string) =>
  writeFileSync(join(root, rel), f(readFileSync(join(root, rel), "utf8")));
const ALL_FRESH = { "trial-length": "fresh", "seat-price": "fresh", "sso-workaround": "fresh", "sso-fixed-in": "fresh" } as const;

export const SCENARIOS: Scenario[] = [
  { name: "noop", who: "nobody", mutate: () => {}, expect: { ...ALL_FRESH }, expectLlmCalls: 0 },
  { name: "whitespace-only code edit", who: "engineering", mutate: (r) => edit(r, "repo/billing.ts", (s) => s.replace("TRIAL_DAYS = 14;", "TRIAL_DAYS   =   14;")),
    expect: { ...ALL_FRESH }, expectLlmCalls: 0 },
  { name: "code moved (lines inserted above)", who: "engineering", mutate: (r) => edit(r, "repo/billing.ts", (s) => `// billing constants\nimport "./x";\n\n${s}`),
    expect: { ...ALL_FRESH, "trial-length": "relocated", "seat-price": "relocated" }, expectLlmCalls: 0 },
  { name: "trial changed in code only (marketing still says 14)", who: "engineering", mutate: (r) => edit(r, "repo/billing.ts", (s) => s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30")),
    expect: { ...ALL_FRESH, "trial-length": "conflict" }, expectLlmCalls: 0 },
  { name: "trial changed in code AND marketing copy", who: "engineering+marketing",
    mutate: (r) => { edit(r, "repo/billing.ts", (s) => s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30")); edit(r, "docs/pricing.md", (s) => s.replace("14-day free trial", "30-day free trial")); },
    expect: { ...ALL_FRESH, "trial-length": "stale" }, expectLlmCalls: 1, expectStatement: { "trial-length": "Trials last 30 days and need no card." } },
  { name: "marketing edits an unrelated doc section", who: "marketing", mutate: (r) => edit(r, "docs/pricing.md", (s) => s.replace("monthly or annual.", "monthly, annual, or via invoice.")),
    expect: { ...ALL_FRESH }, expectLlmCalls: 0 },
  { name: "marketing changes the trial copy", who: "marketing", mutate: (r) => edit(r, "docs/pricing.md", (s) => s.replace("14-day free trial", "21-day free trial")),
    expect: { ...ALL_FRESH, "trial-length": "conflict" }, expectLlmCalls: 0 },
  { name: "support ticket: fix version corrected", who: "support", mutate: (r) => edit(r, "tickets/SUP-12.json", (s) => s.replace('"2.4.1"', '"2.4.2"')),
    expect: { ...ALL_FRESH, "sso-fixed-in": "stale" }, expectLlmCalls: 1 },
  { name: "support ticket deleted", who: "support", mutate: (r) => unlinkSync(join(r, "tickets/SUP-12.json")),
    expect: { ...ALL_FRESH, "sso-workaround": "missing", "sso-fixed-in": "missing" }, expectLlmCalls: 0 },
  { name: "doc heading renamed (body unchanged)", who: "marketing", mutate: (r) => edit(r, "docs/pricing.md", (s) => s.replace("## Trial", "## Free trial")),
    expect: { ...ALL_FRESH, "trial-length": "relocated" }, expectLlmCalls: 0 },
  { name: "doc heading renamed AND body rewritten", who: "marketing", mutate: (r) => edit(r, "docs/pricing.md", (s) => s.replace("## Trial\nEvery workspace starts with a 14-day free trial.", "## Try it free\nTwo weeks free on every workspace.")),
    expect: { ...ALL_FRESH, "trial-length": "degraded" }, expectLlmCalls: 0 },
  { name: "duplicated span makes relocation ambiguous", who: "engineering",
    mutate: (r) => edit(r, "repo/billing.ts", (s) => `// legacy\nexport const TRIAL_DAYS = 14;\n${s.replace("export const TRIAL_DAYS = 14;\n", "// moved\n")}export const TRIAL_DAYS_ALIAS = 0;\nexport const TRIAL_DAYS = 14;\n`),
    expect: { ...ALL_FRESH, "trial-length": "stale", "seat-price": "relocated" }, expectLlmCalls: 1 },
  { name: "human rewrites a wiki sentence", who: "support",
    mutate: (r) => edit(r, `wiki/${PAGE}.md`, (s) => s.replace("Each seat costs $29 per month; workspaces get 3 free seats.", "Seats are $29/mo each. The first 3 seats are free (great for small teams!).")),
    expect: { ...ALL_FRESH, "seat-price": "orphaned" }, expectLlmCalls: 0, expectMode: "propose" },
  { name: "human edit + code change at once", who: "support+engineering",
    mutate: (r) => { edit(r, `wiki/${PAGE}.md`, (s) => s.replace("The SSO loop was fixed in version 2.4.1.", "Fixed in 2.4.1 — upgrade if you still see it.")); edit(r, "repo/billing.ts", (s) => s.replace("TRIAL_DAYS = 14", "TRIAL_DAYS = 30")); },
    expect: { ...ALL_FRESH, "sso-fixed-in": "orphaned", "trial-length": "conflict" }, expectLlmCalls: 0, expectMode: "propose" },
  { name: "human edit + code moved (repin allowed, no rewrite)", who: "support+engineering",
    mutate: (r) => { edit(r, `wiki/${PAGE}.md`, (s) => s.replace("Trials last 14 days and need no card.", "Trials last 14 days and need no card. **No exceptions.**")); edit(r, "repo/billing.ts", (s) => `// header\n${s}`); },
    expect: { ...ALL_FRESH, "trial-length": "relocated", "seat-price": "relocated" }, expectLlmCalls: 0, expectMode: "propose" },
];

export function setup(name: string) {
  const root = join(HERE, "work", name.replace(/[^a-z0-9]+/gi, "-"));
  rmSync(root, { recursive: true, force: true });
  cpSync(join(HERE, "fixtures"), root, { recursive: true });
  const md = readFileSync(join(root, "wiki", `${PAGE}.md`), "utf8");
  const seed = JSON.parse(readFileSync(join(root, "wiki", "claims.seed.json"), "utf8"))[PAGE];
  const sc = generateSidecar(root, PAGE, md, seed);
  writeFileSync(join(root, "wiki", ".claims", `${PAGE}.json`), JSON.stringify(sc, null, 2));
  return root;
}

export function run(s: Scenario) {
  const root = setup(s.name);
  const sc: Sidecar = JSON.parse(readFileSync(join(root, "wiki", ".claims", `${PAGE}.json`), "utf8"));
  s.mutate(root);
  const md = readFileSync(join(root, "wiki", `${PAGE}.md`), "utf8");
  const report = checkPage(root, md, sc);
  const llm = stubUpdater();
  const draft = reconcile(root, md, sc, llm);
  const got = Object.fromEntries(report.claims.map((c) => [c.id, c.status]));
  const failures: string[] = [];
  for (const [id, want] of Object.entries(s.expect)) if (got[id] !== want) failures.push(`${id}: want ${want}, got ${got[id]}`);
  if (draft.llmCalls !== s.expectLlmCalls) failures.push(`llmCalls: want ${s.expectLlmCalls}, got ${draft.llmCalls}`);
  if (s.expectMode && draft.mode !== s.expectMode) failures.push(`mode: want ${s.expectMode}, got ${draft.mode}`);
  let applied: string | undefined;
  // The human reviewer approves every proposal (conflicts and reviews are decided outside the page).
  const approve = draft.ops.filter((o) => o.op === "update" || o.op === "retract").map((o) => o.id);
  for (const [id, want] of Object.entries(s.expectStatement ?? {})) {
    const got = draft.ops.find((o) => o.claimId === id && o.op === "update")?.after;
    if (got !== want) failures.push(`statement ${id}: want "${want}", got "${got}"`);
  }
  if (draft.mode === "apply") {
    const auto = applyDraft(root, md, sc, draft); // no approvals: only repins may change anything
    if (auto.md !== md) failures.push("auto-apply changed page text without approval");
    const out = applyDraft(root, md, sc, draft, approve);
    // Idempotence: after applying, a re-check needs no repins/updates and zero model calls.
    const again = reconcile(root, out.md, out.sc, stubUpdater());
    const left = again.ops.filter((o) => o.op === "repin" || o.op === "update");
    if (left.length > 0 || again.llmCalls !== 0) failures.push(`not idempotent after apply: ${JSON.stringify(left)}`);
    applied = out.md;
  } else {
    // Human text must survive byte-for-byte: propose mode never rewrites the page.
    let threw = false;
    try { applyDraft(root, md, sc, draft, approve.length ? approve : draft.ops.filter((o) => !o.auto).map((o) => o.id)); } catch (e) { threw = e instanceof HumanEditedPageError; }
    if (draft.ops.some((o) => !o.auto) && !threw) failures.push("applyDraft accepted content ops on a human-edited page");
    const repinOnly = applyDraft(root, md, sc, draft);
    if (repinOnly.md !== md) failures.push("human page text was modified");
    if (repinOnly.sc.pageVersion !== sc.pageVersion) failures.push("repin laundered the human edit (pageVersion bumped)");
  }
  return { name: s.name, who: s.who, pass: failures.length === 0, failures, report, draft, applied };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = SCENARIOS.map(run);
  const events = results.map((r) => ({ at: new Date().toISOString(), cat: "scenario", name: r.name, pass: r.pass, llmCalls: r.draft.llmCalls, mode: r.draft.mode, ops: r.draft.ops.map((o) => `${o.op}:${o.claimId}`) }));
  writeFileSync(join(HERE, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(HERE, "results.json"), JSON.stringify(results.map(({ applied: _a, ...r }) => r), null, 2));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(46)} llm=${r.draft.llmCalls} mode=${r.draft.mode} ops=[${r.draft.ops.map((o) => `${o.op}:${o.claimId}`).join(", ")}]${r.pass ? "" : "\n      " + r.failures.join("\n      ")}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed; total model calls ${results.reduce((n, r) => n + r.draft.llmCalls, 0)}`);
  process.exit(failed ? 1 : 0);
}
