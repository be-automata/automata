// Run: node --experimental-strip-types --no-warnings seed-run.ts  (needs the claude CLI; cached after the first run)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { seedAtomic } from "./seed.ts";

const REPO = join(import.meta.dirname, "../../..");
const base = execFileSync("git", ["show", "75f6af8:deploy/PILOT-RUNBOOK.md"], { cwd: REPO, encoding: "utf8" });
const t = performance.now();
const r = await seedAtomic(base);
const cost = r.calls.reduce((n, c) => n + c.costUsd, 0);
console.log(`claims=${r.claims.length} gap=${r.gapClaims ?? 0} sentinels=${r.sentinels.length} (${r.sentinels.reduce((n, w) => n + w.lineEnd - w.lineStart + 1, 0)} lines) repaired=${r.claims.filter((c) => c.repairedFrom).length} rejected=${r.rejected.length} calls=${r.calls.length} cached=${r.calls.filter((c) => c.cached).length} in=${r.calls.reduce((n, c) => n + c.inputTokens, 0)} out=${r.calls.reduce((n, c) => n + c.outputTokens, 0)} cost=$${cost.toFixed(4)} ${Math.round(performance.now() - t)}ms`);
const why = r.rejected.reduce<Record<string, number>>((m, x) => { const k = x.reason.replace(/^(\w+): ([^:(]*).*/, "$1: $2").trim(); return { ...m, [k]: (m[k] ?? 0) + 1 }; }, {});
console.log("rejections:", why);
writeFileSync(join(import.meta.dirname, "seed.json"), JSON.stringify(r, null, 2));
