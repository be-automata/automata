/**
 * finding-verifier — the quote-reproduction check, ported from orch-agents.
 *
 * The fixture is the phantom-finding incident: a `[warning]` claimed a
 * duplicated return right after the size-cap return, a sequence that existed
 * in no commit of the PR. Each line exists on its own, so only the
 * consecutive-match rule catches it. node:test + node:assert/strict only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  QUOTE_LINE_TOLERANCE,
  isRepoRelativePath,
  verifyFindingQuote,
  type FileAtCommit,
  type FileAtCommitReader,
} from "../../src/review/finding-verifier";

const RESOLVER_FIXTURE = [
  "try {",
  "  const pointer = await this.store.tryGetPointer(lease, scope, user);",
  "  if (!pointer) {",
  "    return { kind: 'none' };",
  "  }",
  "  if (pointer.sizeBytes > SUMMARY_PDF_MAX_BYTES) {",
  "    return { kind: 'skipped-size' };",
  "  }",
  "  return { kind: 'available', pointer };",
  "} catch {",
  "  return { kind: 'degraded' };",
  "}",
].join("\n");

const PATH = "src/leases/resolver.ts";

function readerFor(files: Record<string, FileAtCommit>): FileAtCommitReader {
  return async (path) => files[path] ?? { kind: "missing" };
}

const reader = readerFor({
  [PATH]: { kind: "content", text: RESOLVER_FIXTURE },
});

describe("finding-verifier — quote reproduction", () => {
  test("quote at the exact claimed line → verified", async () => {
    const r = await verifyFindingQuote(
      { path: PATH, line: 7, quote: "return { kind: 'skipped-size' };" },
      reader,
    );
    assert.equal(r.result, "verified");
  });

  test("quote within ± tolerance of the claimed line → verified", async () => {
    assert.ok(QUOTE_LINE_TOLERANCE >= 2);
    const r = await verifyFindingQuote(
      { path: PATH, line: 5, quote: "return { kind: 'skipped-size' };" },
      reader,
    );
    assert.equal(r.result, "verified");
  });

  test("whitespace differences do not defeat the match (trimmed per line)", async () => {
    const r = await verifyFindingQuote(
      {
        path: PATH,
        line: 9,
        quote: "   return { kind: 'available', pointer };  ",
      },
      reader,
    );
    assert.equal(r.result, "verified");
  });

  test("phantom: a consecutive sequence that never existed → quote-not-found", async () => {
    const r = await verifyFindingQuote(
      {
        path: PATH,
        line: 7,
        quote:
          "return { kind: 'skipped-size' };\nreturn { kind: 'available', pointer };",
      },
      reader,
    );
    assert.equal(r.result, "quote-not-found");
  });

  test("text that exists nowhere → quote-not-found", async () => {
    const r = await verifyFindingQuote(
      { path: PATH, line: 7, quote: "const totallyInvented = true;" },
      reader,
    );
    assert.equal(r.result, "quote-not-found");
  });

  test("quote outside the tolerance window → quote-not-found", async () => {
    const r = await verifyFindingQuote(
      { path: PATH, line: 1, quote: "return { kind: 'degraded' };" },
      reader,
    );
    assert.equal(r.result, "quote-not-found");
  });

  test("multi-line quote matching a real consecutive sequence → verified", async () => {
    const r = await verifyFindingQuote(
      {
        path: PATH,
        line: 6,
        quote:
          "if (pointer.sizeBytes > SUMMARY_PDF_MAX_BYTES) {\n  return { kind: 'skipped-size' };\n}",
      },
      reader,
    );
    assert.equal(r.result, "verified");
  });

  test("blank file lines inside the quoted span are skipped", async () => {
    const r = await verifyFindingQuote(
      { path: "a.ts", line: 1, quote: "const a = 1;\nconst b = 2;" },
      readerFor({
        "a.ts": { kind: "content", text: "const a = 1;\n\nconst b = 2;" },
      }),
    );
    assert.equal(r.result, "verified");
  });

  test("missing file at the commit → file-not-found", async () => {
    const r = await verifyFindingQuote(
      { path: "src/does/not/exist.ts", line: 1, quote: "x" },
      reader,
    );
    assert.equal(r.result, "file-not-found");
  });

  test("a path escaping the repo is never read → file-not-found", async () => {
    let asked = false;
    const r = await verifyFindingQuote(
      { path: "../../etc/passwd", line: 1, quote: "root" },
      async () => {
        asked = true;
        return { kind: "content", text: "root" };
      },
    );
    assert.equal(r.result, "file-not-found");
    assert.equal(asked, false);
    assert.equal(isRepoRelativePath("/etc/passwd"), false);
    assert.equal(isRepoRelativePath("src/a/../b.ts"), false);
    assert.equal(isRepoRelativePath("src/a.ts"), true);
  });

  test("absent or blank quote → no-quote, without reading", async () => {
    const r1 = await verifyFindingQuote({ path: PATH, line: 7 }, reader);
    const r2 = await verifyFindingQuote(
      { path: PATH, line: 7, quote: " \n " },
      reader,
    );
    assert.equal(r1.result, "no-quote");
    assert.equal(r2.result, "no-quote");
  });

  test("a reader that could not check → unchecked, with its reason", async () => {
    const r = await verifyFindingQuote(
      { path: PATH, line: 7, quote: "x" },
      readerFor({ [PATH]: { kind: "unchecked", reason: "HTTP 502" } }),
    );
    assert.deepEqual(r, { result: "unchecked", reason: "HTTP 502" });
  });
});
