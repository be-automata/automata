import { describe, it, expect } from "vitest";

import {
  hasTaggedReviewIntentOpener,
  parseReviewIntent,
} from "./parse-review-intent";

/**
 * Phase 6: orchestrated reviews tag the lead's final block `json
 * review-intent`, and threads rendered with the orchestrated prompt parse with
 * { preferTaggedIntent: true } so an echoed sub-agent fence cannot win (Phase 2
 * Q7: in q4sub the lead repeated the sub-agent's fence and the LAST fence was
 * the sub-agent's). Kept in its own file so the existing parser suite stays
 * byte-for-byte untouched.
 */

const OPT = { preferTaggedIntent: true } as const;

const lead = {
  verdict: "request_changes",
  commit: "LEAD",
  summary: "The lead's consolidated verdict.",
};
const leadApprove = { verdict: "approve", commit: "LEAD", summary: "lead" };
const sub = { verdict: "approve", commit: "SUB", summary: "sub" };

function tagged(obj: unknown): string {
  return `\n\`\`\`json review-intent\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

function subFence(obj: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

function commitOf(text: string, options = {}): string | undefined {
  const res = parseReviewIntent(text, options);
  return res.ok ? res.intent.commit : undefined;
}

describe("parseReviewIntent — orchestrated tagged block (phase 6)", () => {
  it("(a1) a sub-agent fence before the lead's tagged block → the lead wins", () => {
    const text = `Sub-agent said:${subFence(sub)}Final:${tagged(leadApprove)}`;
    expect(commitOf(text, OPT)).toBe("LEAD");
  });

  it("(a2) a sub-agent fence before the lead's untagged block → the lead wins either way", () => {
    const text = `Sub-agent said:${subFence(sub)}Final:${subFence(leadApprove)}`;
    expect(commitOf(text, OPT)).toBe("LEAD");
    expect(commitOf(text)).toBe("LEAD");
  });

  it("(b1) an echoed sub-agent fence AFTER the lead's tagged block → the lead wins only with the option", () => {
    const text =
      `My review.${tagged(lead)}` +
      `**Outcome 1:** the security agent said:${subFence(sub)}`;
    const withOption = parseReviewIntent(text, OPT);
    expect(withOption.ok).toBe(true);
    if (withOption.ok) {
      expect(withOption.intent.commit).toBe("LEAD");
      expect(withOption.intent.verdict).toBe("request_changes");
    }
    // Today's last-block rule picks the sub-agent's — the regression the
    // option exists to fix.
    expect(commitOf(text)).toBe("SUB");
  });

  it("(b2) the q4sub shape: lead prose quoting a sub-agent verdict after its tagged block", () => {
    const text =
      `Consolidated.${tagged(lead)}` +
      "The spike agent reported:\n```json\n" +
      '{"verdict":"ZZ_SUBAGENT_VERDICT","commit":"SUB","summary":"s"}\n```\n';
    expect(commitOf(text, OPT)).toBe("LEAD");
  });

  it("(c) two tagged blocks → the LAST tagged wins", () => {
    const first = { ...leadApprove, commit: "FIRST" };
    const text = `Draft:${tagged(first)}Final:${tagged(lead)}`;
    expect(commitOf(text, OPT)).toBe("LEAD");
  });

  it("(d) a malformed last tagged block fails closed (no fallback to untagged)", () => {
    const text =
      "Final:\n```json review-intent\n{ verdict: 'approve', }\n```\n" +
      subFence(sub);
    const res = parseReviewIntent(text, OPT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.source).toBe("parser");
      expect(res.reason).toMatch(/parse failed/);
    }
  });

  it("(e) a tagged unable_to_review intent is the agent's no-verdict report", () => {
    const text = tagged({
      verdict: "unable_to_review",
      reason: "base ref missing",
      commit: "LEAD",
    });
    expect(parseReviewIntent(text, OPT)).toEqual({
      ok: false,
      source: "agent",
      reason: "base ref missing",
      commit: "LEAD",
    });
  });

  it("(f) the tag mid-line in prose is not an opener", () => {
    const text =
      "I will open it with ```json review-intent then the object.\n" +
      subFence(leadApprove);
    expect(hasTaggedReviewIntentOpener(text)).toBe(false);
    expect(parseReviewIntent(text, OPT)).toEqual(parseReviewIntent(text));
  });

  it("(g) CRLF tagged block parses", () => {
    const text =
      "Final:\r\n```json review-intent\r\n" +
      JSON.stringify(lead) +
      "\r\n```\r\n";
    expect(commitOf(text, OPT)).toBe("LEAD");
  });

  it("(h) with no opener the option changes nothing", () => {
    const validIntent = {
      verdict: "request_changes",
      commit: "abc123",
      summary: "Two issues found.",
      findings: [
        {
          severity: "error",
          path: "src/a.ts",
          line: 10,
          body: "off-by-one",
          quote: "i <= n",
        },
      ],
    };
    const fenced = (obj: unknown) =>
      `Here is my review.\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
    const fixtures = [
      fenced(validIntent),
      `${fenced({ verdict: "approve", commit: "OLD", summary: "e" })}\n...\n${fenced(validIntent)}`,
      `Verdict below:\n${JSON.stringify({ verdict: "approve", commit: "z9", summary: "clean" })}`,
      "I reviewed the PR and it looks fine.",
      "```json\n{ verdict: 'approve', }\n```",
      fenced({ verdict: "lgtm", commit: "x", summary: "s" }),
    ];
    for (const text of fixtures) {
      expect(hasTaggedReviewIntentOpener(text)).toBe(false);
      expect(parseReviewIntent(text, OPT)).toEqual(parseReviewIntent(text));
    }
  });

  it("(i) trailing spaces after the tag are accepted; near-miss tags are not openers", () => {
    const spaced =
      "Final:\n```json review-intent  \t\n" + JSON.stringify(lead) + "\n```\n";
    expect(commitOf(spaced, OPT)).toBe("LEAD");
    for (const nearMiss of [
      "```json review-intents\n" + JSON.stringify(lead) + "\n```\n",
      "```jsonreview-intent\n" + JSON.stringify(lead) + "\n```\n",
    ]) {
      expect(hasTaggedReviewIntentOpener(nearMiss)).toBe(false);
    }
  });

  it("(j) an incomplete tagged block fails closed", () => {
    const truncated =
      `Sub-agent:${subFence(sub)}` +
      "Final:\n```json review-intent\n" +
      JSON.stringify(lead);
    const res = parseReviewIntent(truncated, OPT);
    expect(res).toMatchObject({ ok: false, source: "parser" });
    if (!res.ok)
      expect(res.reason).toMatch(/review-intent block is incomplete/);

    const secondUnclosed =
      `Final:${tagged(lead)}` +
      "Again:\n```json review-intent\n" +
      JSON.stringify(lead);
    const res2 = parseReviewIntent(secondUnclosed, OPT);
    expect(res2).toMatchObject({ ok: false, source: "parser" });
    if (!res2.ok) {
      expect(res2.reason).toMatch(/review-intent block is incomplete/);
    }
  });

  it("hasTaggedReviewIntentOpener matches only real opener lines", () => {
    const a1 = `Sub:${subFence(sub)}Final:${tagged(leadApprove)}`;
    const b1 = `My review.${tagged(lead)}Echo:${subFence(sub)}`;
    const j = "Final:\n```json review-intent\n" + JSON.stringify(lead);
    for (const text of [a1, b1, j]) {
      expect(hasTaggedReviewIntentOpener(text)).toBe(true);
    }
    const a2 = `Sub:${subFence(sub)}Final:${subFence(leadApprove)}`;
    const f = "open it with ```json review-intent then the object.\n";
    const iNeg = "```json review-intents\n{}\n```\n";
    for (const text of [a2, f, iNeg]) {
      expect(hasTaggedReviewIntentOpener(text)).toBe(false);
    }
  });
});
