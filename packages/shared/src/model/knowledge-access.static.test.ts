/**
 * protects: SC1/SC2 accessor-only access to knowledge data and model spend.
 * fails_when: a consumer bypasses forKnowledge (imports the ungated store or
 *   data-plane functions, touches the raw tables) or adds an env knob for the
 *   knowledge controls (they are DB columns, never WORKER_* env).
 * no_claim: runtime behavior (see knowledge-access.test.ts).
 *
 * Outside model/knowledge*.ts the allowed imports are knowledge-access,
 * knowledge-controls, knowledge-admin-log (read), knowledge-minimize and
 * knowledge (constants, resolvers, types only); assertion 2 constrains the
 * last one to non-data-plane identifiers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".open-next",
  ".git",
  ".turbo",
]);

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join("/");
const isTest = (p: string) => /\.test\.tsx?$/.test(p);
const isModelFile = (p: string) =>
  /^packages\/shared\/src\/model\/knowledge[^/]*\.ts$/.test(p);
const isExempt = (p: string) =>
  isTest(p) || p === "packages/shared/src/db/schema.ts" || isModelFile(p);

const files = [
  ...walk(join(ROOT, "apps"), []),
  ...walk(join(ROOT, "packages"), []),
].map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));
const deployFiles = walk(join(ROOT, "deploy"), []).map((f) => ({
  path: rel(f),
  text: readFileSync(f, "utf8"),
}));
const external = files.filter((f) => !isExempt(f.path));

// Raw-identifier allow list, built from the repo grep: none today.
const RAW_TABLE_ALLOW = new Set<string>([]);

function offenders(
  list: { path: string; text: string }[],
  re: RegExp,
): string[] {
  return list.filter((f) => re.test(f.text)).map((f) => f.path);
}

describe("knowledge accessor-only access", () => {
  it("scans the tree (walker self-test)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some(
        (f) => f.path === "packages/shared/src/model/knowledge-access.ts",
      ),
    ).toBe(true);
  });

  it("1: nothing outside the model imports knowledge-store", () => {
    expect(
      offenders(external, /model\/knowledge-store["']|\.\/knowledge-store["']/),
    ).toEqual([]);
  });

  it("2: nothing outside the model references ungated data-plane functions", () => {
    expect(
      offenders(
        external,
        /\b(reserveKnowledgeBudget|settleKnowledgeBudget|decideKnowledgeOp|advanceKnowledgeCursor|observeKnowledgeHead|getKnowledgeCursor|insertKnowledgeClaim|insertKnowledgePins|insertKnowledgeOp|loadLatestKnowledgeRejections|insertKnowledgeIntent)\b/,
      ),
    ).toEqual([]);
  });

  it("3: raw knowledge table identifiers stay inside the model and schema", () => {
    expect(
      offenders(
        external,
        /\b(knowledgeClaim|knowledgePin|knowledgeOp|knowledgeDecision|knowledgeCursor|knowledgeIntent)\b/,
      ).filter((p) => !RAW_TABLE_ALLOW.has(p)),
    ).toEqual([]);
  });

  it("4: knowledge-purge is imported only by the hourly purge sweep", () => {
    expect(
      offenders(external, /knowledge-purge["']/).filter(
        (p) => p !== "apps/www/src/server-lib/knowledge/purge-sweep.ts",
      ),
    ).toEqual([]);
  });

  it("6: no env knob for the knowledge controls", () => {
    const nonTest = [...files, ...deployFiles].filter((f) => !isTest(f.path));
    expect(
      offenders(
        nonTest,
        /WORKER_KNOWLEDGE|KNOWLEDGE_ENGINE_ENABLED|process\.env\.[A-Z_]*KNOWLEDGE/,
      ),
    ).toEqual([]);
  });
});
