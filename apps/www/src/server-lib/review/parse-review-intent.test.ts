import { describe, it, expect } from "vitest";
import { parseReviewIntent, toExecutorIntent } from "./parse-review-intent";

const validIntent = {
  verdict: "request_changes",
  commit: "abc123",
  summary: "Two issues found.",
  findings: [
    { severity: "error", path: "src/a.ts", line: 10, body: "off-by-one", quote: "i <= n" },
    { path: "src/b.ts", line: 3, body: "nit" },
  ],
  severityFloor: "error",
};

function fenced(obj: unknown): string {
  return `Here is my review.\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

describe("parseReviewIntent", () => {
  it("parses a valid fenced-json intent", () => {
    const res = parseReviewIntent(fenced(validIntent));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.intent.verdict).toBe("request_changes");
      expect(res.intent.commit).toBe("abc123");
      expect(res.intent.findings).toHaveLength(2);
    }
  });

  it("prefers the LAST json block (an earlier example is ignored)", () => {
    const example = fenced({ verdict: "approve", commit: "OLD", summary: "example" });
    const real = fenced(validIntent);
    const res = parseReviewIntent(`${example}\n...then the real one...\n${real}`);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.commit).toBe("abc123");
  });

  it("falls back to a bare top-level object when unfenced", () => {
    const res = parseReviewIntent(
      `Verdict below:\n${JSON.stringify({ verdict: "approve", commit: "z9", summary: "clean" })}`,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intent.verdict).toBe("approve");
  });

  it("rejects when no JSON block is present (→ caller degrades, never silent)", () => {
    const res = parseReviewIntent("I reviewed the PR and it looks fine.");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no JSON intent block/);
  });

  it("rejects malformed JSON", () => {
    const res = parseReviewIntent("```json\n{ verdict: 'approve', }\n```");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/parse failed/);
  });

  it("rejects a schema violation (bad verdict enum)", () => {
    const res = parseReviewIntent(
      fenced({ verdict: "lgtm", commit: "x", summary: "s" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/schema validation failed/);
  });

  it("rejects a missing required field (no commit)", () => {
    const res = parseReviewIntent(fenced({ verdict: "approve", summary: "s" }));
    expect(res.ok).toBe(false);
  });
});

describe("toExecutorIntent", () => {
  it("maps summary→body and findings→comments", () => {
    const res = parseReviewIntent(fenced(validIntent));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const exec = toExecutorIntent(res.intent);
    expect(exec.verdict).toBe("request_changes");
    expect(exec.body).toBe("Two issues found.");
    expect(exec.comments).toHaveLength(2);
    expect(exec.comments?.[0]).toEqual({
      path: "src/a.ts",
      line: 10,
      body: "off-by-one",
      severity: "error",
      quote: "i <= n",
    });
  });

  it("maps an intent with no findings to undefined comments", () => {
    const res = parseReviewIntent(
      fenced({ verdict: "approve", commit: "x", summary: "clean" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const exec = toExecutorIntent(res.intent);
    expect(exec.comments).toBeUndefined();
  });
});
