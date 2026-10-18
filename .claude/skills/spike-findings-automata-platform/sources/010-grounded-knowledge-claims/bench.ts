// Cost of a no-op check and of relocation on a large file (worst case: every pin moved).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkPage, generateSidecar } from "./claims.ts";

const root = join(import.meta.dirname, "work", "bench");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "repo"), { recursive: true });
cpSync(join(import.meta.dirname, "fixtures", "docs"), join(root, "docs"), { recursive: true });
const N = 50_000, CLAIMS = 200;
const lines = Array.from({ length: N }, (_, i) => `export const K${i} = ${i * 7};`);
writeFileSync(join(root, "repo", "big.ts"), lines.join("\n"));
const seed = Array.from({ length: CLAIMS }, (_, i) => {
  const l = Math.floor((i * N) / CLAIMS) + 1;
  return { id: `c${i}`, statement: `K${l - 1} is ${(l - 1) * 7}`, evidence: [`repo://big.ts#L${l}-L${l + 2}`] };
});
const md = seed.map((c) => c.statement).join("\n");
const sc = generateSidecar(root, "big", md, seed);
let t = performance.now();
const a = checkPage(root, md, sc);
const noop = performance.now() - t;
writeFileSync(join(root, "repo", "big.ts"), ["// moved", ...lines].join("\n"));
t = performance.now();
const b = checkPage(root, md, sc);
const moved = performance.now() - t;
console.log(JSON.stringify({ lines: N, claims: CLAIMS,
  noopMs: Math.round(noop), noopFresh: a.claims.filter((c) => c.status === "fresh").length,
  allMovedMs: Math.round(moved), relocated: b.claims.filter((c) => c.status === "relocated").length }));
