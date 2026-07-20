import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReviewIntent } from "./parse-review-intent";

/**
 * Anti-drift guard (ADR-036 rider): the emit-skill's fenced-JSON EXAMPLE must parse
 * against the SAME schema the control-plane parser uses. If the SKILL.md contract and
 * emittedReviewIntentSchema drift (a renamed field, a changed verdict enum), the agent
 * would emit an intent the parser rejects → a degraded COMMENT on every review run.
 * This fails CI the instant the doc example stops parsing.
 */

const SKILL_MD = fileURLToPath(
  new URL(
    "../../../../../deploy/skills/github-ops/SKILL.md",
    import.meta.url,
  ),
);

describe("emit-skill contract ↔ parser (no drift)", () => {
  it("the SKILL.md fenced-JSON example parses against emittedReviewIntentSchema", () => {
    const doc = readFileSync(SKILL_MD, "utf8");
    // parseReviewIntent extracts the LAST ```json block — the contract example.
    const res = parseReviewIntent(doc);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Sanity that it's the review contract, not some other JSON.
      expect(res.intent.verdict).toBe("request_changes");
      expect(typeof res.intent.commit).toBe("string");
      expect(typeof res.intent.summary).toBe("string");
      expect(res.intent.findings?.[0]).toMatchObject({
        severity: "error",
        path: expect.any(String),
        line: expect.any(Number),
        quote: expect.any(String),
      });
    }
  });
});
