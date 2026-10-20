/**
 * verify-before-block — the de-fang pass and its failure policy.
 *
 * protects: a blocking finding whose quote does not reproduce at the reviewed
 *   commit can never gate; an API outage never changes a verdict.
 * fails_when: an unverified blocker still blocks, a verified one is dropped, an
 *   outage softens a verdict, or a file is read twice.
 * no_claim: the GitHub contents API itself (a fake reader stands in).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyVerifyBeforeBlock,
  UNVERIFIED_ANNOTATION,
  uncheckedAnnotation,
  type VerifiableIntent,
} from "../../src/review/verify-before-block";
import {
  applyApproveSeverityFloor,
  toleranceToPolicy,
} from "../../src/review/severity-policy";
import type { FileAtCommit } from "../../src/review/finding-verifier";

const FILE = "const a = 1;\nconst b = 2;\nreturn a + b;\n";

function reader(files: Record<string, FileAtCommit>) {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path: string): Promise<FileAtCommit> => {
      reads.push(path);
      return files[path] ?? { kind: "missing" };
    },
  };
}

const WARNING = toleranceToPolicy("warning");
const INFO = toleranceToPolicy("info");
const base = { repo: "acme/widgets", prNumber: 7 };
/** Type a literal intent as the public shape (comments may carry suppressGating). */
const asIntent = (intent: VerifiableIntent): VerifiableIntent => intent;

describe("verify-before-block", () => {
  test("verified blocker is untouched and the same object comes back", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const intent = asIntent({
      verdict: "request_changes" as const,
      comments: [
        {
          path: "a.ts",
          line: 2,
          body: "b",
          severity: "warning" as const,
          quote: "const b = 2;",
        },
      ],
    });
    const out = await applyVerifyBeforeBlock(intent, {
      ...base,
      policy: WARNING,
      readFile: r.readFile,
    });
    assert.equal(out, intent);
  });

  test("a finding with no quote or an escaping path is never read (and is still de-fanged)", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const out = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          { path: "a.ts", line: 1, body: "x", severity: "error" as const },
          {
            path: "../etc/passwd",
            line: 1,
            body: "y",
            severity: "error" as const,
            quote: "root",
          },
        ],
      }),
      { ...base, policy: WARNING, readFile: r.readFile },
    );
    assert.deepEqual(r.reads, []);
    assert.equal(out.verdict, "comment");
    assert.ok((out.comments ?? []).every((c) => c.suppressGating === true));
  });

  test("unverified blocker → info + annotation + suppressGating; sole blocker turns request_changes into comment", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const out = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          {
            path: "a.ts",
            line: 2,
            body: "b",
            severity: "error" as const,
            quote: "const c = 3;",
          },
        ],
      }),
      { ...base, policy: WARNING, readFile: r.readFile },
    );
    assert.equal(out.verdict, "comment");
    assert.equal(out.comments?.[0]?.severity, "info");
    assert.equal(out.comments?.[0]?.suppressGating, true);
    assert.ok(out.comments?.[0]?.body.endsWith(UNVERIFIED_ANNOTATION));
  });

  test("a blocker with no quote is unverified (legacy no-quote rule)", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const out = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          { path: "a.ts", line: 2, body: "b", severity: "warning" as const },
        ],
      }),
      { ...base, policy: WARNING, readFile: r.readFile },
    );
    assert.equal(out.comments?.[0]?.suppressGating, true);
    assert.equal(out.verdict, "comment");
  });

  test("a file missing at the commit makes its blocker unverified", async () => {
    const r = reader({});
    const out = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          {
            path: "gone.ts",
            line: 1,
            body: "x",
            severity: "warning" as const,
            quote: "x",
          },
        ],
      }),
      { ...base, policy: WARNING, readFile: r.readFile },
    );
    assert.equal(out.comments?.[0]?.suppressGating, true);
  });

  test("an unchecked file keeps its blocker gating and the verdict unchanged (outage never softens)", async () => {
    const r = reader({
      "a.ts": { kind: "unchecked", reason: "HTTP 502 after retry" },
    });
    const out = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          {
            path: "a.ts",
            line: 2,
            body: "b",
            severity: "error" as const,
            quote: "anything",
          },
        ],
      }),
      { ...base, policy: WARNING, readFile: r.readFile },
    );
    assert.equal(out.verdict, "request_changes");
    assert.equal(out.comments?.[0]?.severity, "error");
    assert.equal(out.comments?.[0]?.suppressGating, undefined);
    assert.ok(
      out.comments?.[0]?.body.endsWith(
        uncheckedAnnotation("HTTP 502 after retry"),
      ),
    );
  });

  test("a throwing reader is treated as unchecked, never as a failed post", async () => {
    const out = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          {
            path: "a.ts",
            line: 2,
            body: "b",
            severity: "error" as const,
            quote: "x",
          },
        ],
      }),
      {
        ...base,
        policy: WARNING,
        readFile: async () => {
          throw new Error("socket hang up");
        },
      },
    );
    assert.equal(out.verdict, "request_changes");
    assert.ok(
      out.comments?.[0]?.body.includes("[quote not checked: socket hang up]"),
    );
  });

  test("one verified blocker keeps request_changes even when another is de-fanged", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const out = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          {
            path: "a.ts",
            line: 2,
            body: "real",
            severity: "warning" as const,
            quote: "const b = 2;",
          },
          {
            path: "a.ts",
            line: 2,
            body: "fake",
            severity: "warning" as const,
            quote: "nope",
          },
        ],
      }),
      { ...base, policy: WARNING, readFile: r.readFile },
    );
    assert.equal(out.verdict, "request_changes");
    assert.equal(out.comments?.[1]?.suppressGating, true);
  });

  test("findings below the block threshold are never read", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const intent = asIntent({
      verdict: "approve" as const,
      comments: [
        { path: "a.ts", line: 2, body: "nit", severity: "info" as const },
      ],
    });
    const out = await applyVerifyBeforeBlock(intent, {
      ...base,
      policy: WARNING,
      readFile: r.readFile,
    });
    assert.equal(out, intent);
    assert.deepEqual(r.reads, []);
  });

  test("each distinct path is read exactly once", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    await applyVerifyBeforeBlock(
      asIntent({
        verdict: "request_changes" as const,
        comments: [
          {
            path: "a.ts",
            line: 1,
            body: "1",
            severity: "warning" as const,
            quote: "const a = 1;",
          },
          {
            path: "a.ts",
            line: 2,
            body: "2",
            severity: "warning" as const,
            quote: "const b = 2;",
          },
          {
            path: "b.ts",
            line: 1,
            body: "3",
            severity: "warning" as const,
            quote: "x",
          },
        ],
      }),
      { ...base, policy: WARNING, readFile: r.readFile },
    );
    assert.deepEqual([...r.reads].sort(), ["a.ts", "b.ts"]);
  });

  test("info tolerance: an unverified info finding keeps its severity but cannot gate the floor", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const verified = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "approve" as const,
        comments: [
          {
            path: "a.ts",
            line: 2,
            body: "b",
            severity: "info" as const,
            quote: "nope",
          },
        ],
      }),
      { ...base, policy: INFO, readFile: r.readFile },
    );
    assert.equal(verified.comments?.[0]?.severity, "info");
    assert.equal(verified.comments?.[0]?.suppressGating, true);
    const floored = applyApproveSeverityFloor(verified, INFO);
    assert.equal(
      floored.verdict,
      "approve",
      "a de-fanged finding cannot lower an approve",
    );
  });

  test("info tolerance: a verified info finding lowers approve to request_changes (D11)", async () => {
    const r = reader({ "a.ts": { kind: "content", text: FILE } });
    const verified = await applyVerifyBeforeBlock(
      asIntent({
        verdict: "approve" as const,
        comments: [
          {
            path: "a.ts",
            line: 2,
            body: "b",
            severity: "info" as const,
            quote: "const b = 2;",
          },
        ],
      }),
      { ...base, policy: INFO, readFile: r.readFile },
    );
    assert.equal(
      applyApproveSeverityFloor(verified, INFO).verdict,
      "request_changes",
    );
  });
});
