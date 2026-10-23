/**
 * OPS-04 / SC4: knowledge fixtures are committed to a public repository, so
 * every org, repo and email identity in them must be synthetic.
 *
 *   Run:  node --test deploy/knowledge-fixture-guard.test.ts
 *
 * protects=public repo hygiene for knowledge test fixtures and migrations;
 * fails_when=a guarded file uses an owner outside the synthetic allowlist, a
 *   non-example email, or (locally) a term from the out-of-band terms file;
 * no_claim=files outside the guarded set. Failures print file:line and the
 *   check name only, never the matched text.
 *
 * Optional second net: set KNOWLEDGE_PARTNER_TERMS_FILE to a local file of
 * terms (one per line, # comments). That file is never committed.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SYNTHETIC_OWNERS = new Set(["acme", "globex", "initech", "example"]);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function walk(dir: string): string[] {
  const absolute = path.join(REPO_ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(absolute, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (entry.split(path.sep).includes("node_modules")) continue;
    const full = path.join(absolute, entry);
    if (statSync(full).isFile()) out.push(path.join(dir, entry));
  }
  return out;
}

function guardedFiles(): string[] {
  const files = new Set<string>(["packages/knowledge/src/test-fixtures.ts"]);
  for (const f of walk("packages/knowledge/src")) {
    if (f.endsWith(".test.ts")) files.add(f);
  }
  for (const f of walk("packages/shared/src/model")) {
    if (/\/knowledge[^/]*\.test\.ts$/.test(f)) files.add(f);
  }
  for (const f of walk("apps/www/src")) {
    if (
      /knowledge[^/]*\.test\.tsx?$/.test(f) ||
      /\/knowledge[^/]*\/.*\.test\.tsx?$/.test(f)
    ) {
      files.add(f);
    }
  }
  for (const f of walk("deploy/migrations")) {
    if (/knowledge[^/]*\.sql$/.test(f)) files.add(f);
  }
  return [...files].filter((f) => existsSync(path.join(REPO_ROOT, f))).sort();
}

const OWNER_LINE = /repoFullName|repo_full_name|owner|repo:/;
const OWNER_LITERAL = /["'`]([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+["'`]/g;
const ORG_NAME =
  /createTest(?:Org|Organization)\([^)]*?name:\s*["'`]([^"'`]+)["'`]/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function structuralFailures(file: string, text: string): string[] {
  const failures: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!OWNER_LINE.test(line)) return;
    for (const match of line.matchAll(OWNER_LITERAL)) {
      const owner = (match[1] ?? "").toLowerCase();
      if (!SYNTHETIC_OWNERS.has(owner)) {
        failures.push(`${file}:${i + 1} non-synthetic owner`);
      }
    }
  });
  for (const match of text.matchAll(ORG_NAME)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!SYNTHETIC_OWNERS.has(name)) {
      failures.push(
        `${file}:${lineOf(text, match.index ?? 0)} non-synthetic org name`,
      );
    }
  }
  for (const match of text.matchAll(EMAIL)) {
    const domain = (match[1] ?? "").toLowerCase();
    const ok =
      domain === "example.com" ||
      domain === "example.org" ||
      domain.endsWith(".test");
    if (!ok) {
      failures.push(
        `${file}:${lineOf(text, match.index ?? 0)} non-example email`,
      );
    }
  }
  return failures;
}

function loadTerms(): string[] | null {
  const file = process.env["KNOWLEDGE_PARTNER_TERMS_FILE"];
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.toLowerCase());
}

function termFailures(file: string, text: string, terms: string[]): string[] {
  const failures: string[] = [];
  text.split("\n").forEach((line, i) => {
    const lower = line.toLowerCase();
    if (terms.some((term) => lower.includes(term))) {
      failures.push(`${file}:${i + 1} local terms list match`);
    }
  });
  return failures;
}

describe("knowledge fixture guard", () => {
  test("every guarded fixture uses synthetic identities only", () => {
    const failures = guardedFiles().flatMap((file) =>
      structuralFailures(
        file,
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
      ),
    );
    assert.deepEqual(failures, []);
  });

  test("no guarded file matches the local terms list", (t) => {
    const terms = loadTerms();
    if (!terms) {
      t.skip("no local terms file");
      return;
    }
    const failures = guardedFiles().flatMap((file) =>
      termFailures(
        file,
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
        terms,
      ),
    );
    assert.deepEqual(failures, []);
  });

  test("self-test: the allowlist, the file list and this file are sound", () => {
    for (const owner of SYNTHETIC_OWNERS) {
      assert.match(owner, /^[a-z][a-z0-9-]*$/);
    }
    const files = guardedFiles();
    assert.ok(files.length > 0);
    assert.ok(files.includes("packages/knowledge/src/test-fixtures.ts"));

    const terms = loadTerms();
    if (terms) {
      const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
      assert.deepEqual(termFailures("guard", self, terms), []);
    }

    const bad = structuralFailures(
      "scratch.ts",
      'const a = { repoFullName: "other-co/docs" };\nconst e = "x@corp.io";',
    );
    assert.equal(bad.length, 2);
    for (const message of bad) assert.ok(!message.includes("other-co"));
  });
});
