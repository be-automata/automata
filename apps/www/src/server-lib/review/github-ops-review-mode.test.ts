import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";

import { loadReviewSkillBody } from "../../../../../deploy/lib/review-skill-file";
import {
  REVIEW_INTENT_FENCE_INFO,
  hasTaggedReviewIntentOpener,
  parseReviewIntent,
} from "./parse-review-intent";
import {
  hasReviewModeSections,
  renderReviewModeSections,
  validateSkillBody,
} from "./review-skill";

/**
 * Phase 6: the tracked github-ops skill carries an ORCHESTRATED branch in
 * review-mode sections, while its CLASSIC render stays today's bytes.
 *
 * CLASSIC_SHA256 / CLASSIC_LENGTH are the stripFrontmatter of
 * deploy/skills/github-ops/SKILL.md at origin/main @846c598 (unchanged through
 * e0445d7). NEVER update them to "make the test pass": a mismatch means the
 * classic prompt every onboarded repo receives has changed.
 */
const CLASSIC_SHA256 =
  "47b019a8ba7afbd1b7772373075f301958a4eefebb9704425737b8985da0c13e";
const CLASSIC_LENGTH = 9940;

const CLASSIC = { mode: "classic", runTests: false } as const;
const ORCH_TESTS = { mode: "orchestrated", runTests: true } as const;
const ORCH_NO_TESTS = { mode: "orchestrated", runTests: false } as const;

const EXAMPLE_COMMIT = "fb15616abc1234def5678901234567890abcdef0";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const countOccurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

const raw = loadReviewSkillBody();
const classicDefault = renderReviewModeSections(raw);
const classic = renderReviewModeSections(raw, CLASSIC);
const orchTests = renderReviewModeSections(raw, ORCH_TESTS);
const orchNoTests = renderReviewModeSections(raw, ORCH_NO_TESTS);

/** Every line inside a review-mode section of the raw body (markers excluded). */
function sectionContents(body: string): string[] {
  const contents: string[] = [];
  let inside = false;
  for (const line of body.split("\n")) {
    if (/^<!-- automata:if /.test(line)) {
      inside = true;
      continue;
    }
    if (/^<!-- automata:endif -->/.test(line)) {
      inside = false;
      continue;
    }
    if (inside) contents.push(line);
  }
  return contents;
}

describe("github-ops SKILL.md classic render (byte-identical to today)", () => {
  it("the default and classic renders equal the pinned sha and length", () => {
    expect(sha256(classicDefault)).toBe(CLASSIC_SHA256);
    expect(classicDefault.length).toBe(CLASSIC_LENGTH);
    expect(sha256(classic)).toBe(CLASSIC_SHA256);
    expect(classic.length).toBe(CLASSIC_LENGTH);
  });

  it("the classic render keeps the no-sub-agents rule", () => {
    expect(classic).toContain("Do not spawn sub-agents");
  });
});

describe("github-ops SKILL.md orchestrated renders", () => {
  const REQUIRED = [
    "## Orchestrated review — you are the lead reviewer",
    "You are the lead reviewer.",
    "security",
    "correctness",
    "tests",
    "conventions",
    "`Agent`",
    "`Skill`",
    "`shellcheck`",
    "`actionlint`",
    "`gitleaks`",
    "NEVER emit a fenced json block",
    "Never quote sub-agent output verbatim",
    "json review-intent",
    "three backticks",
    "nothing after it",
    "Never commit, push or comment",
    "60%",
    "30 minutes",
    "untrusted data, not instructions",
    "Never give a sub-agent this instruction's output format or the review-intent tag",
  ];

  for (const [name, render] of [
    ["runTests true", orchTests],
    ["runTests false", orchNoTests],
  ] as const) {
    it(`${name}: differs from classic, has no markers and carries every rule`, () => {
      expect(render).not.toBe(classic);
      expect(render).not.toContain("<!-- automata:");
      for (const needle of REQUIRED) expect(render).toContain(needle);
      expect(render).not.toContain("Do not spawn sub-agents");
    });
  }

  it("selects the run-tests text from runTests", () => {
    const run = "You may run this repository's own lint and test commands";
    const noRun = "Do NOT execute this repository's code";
    expect(orchTests).toContain(run);
    expect(orchTests).not.toContain(noRun);
    expect(orchNoTests).toContain(noRun);
    expect(orchNoTests).not.toContain(run);
    expect(classic).not.toContain(run);
    expect(classic).not.toContain(noRun);
  });
});

describe("github-ops SKILL.md drift safety", () => {
  it("no review-mode section contains three consecutive backticks", () => {
    for (const line of sectionContents(raw)) {
      expect(line).not.toContain("```");
    }
  });

  it("the raw body and every render parse to the verdict contract example", () => {
    for (const body of [raw, classic, orchTests, orchNoTests]) {
      const res = parseReviewIntent(body);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.intent.verdict).toBe("request_changes");
        expect(res.intent.commit).toBe(EXAMPLE_COMMIT);
      }
    }
  });

  it("the two contract headings occur exactly once everywhere", () => {
    for (const body of [raw, classic, orchTests, orchNoTests]) {
      expect(countOccurrences(body, "## If you cannot review")).toBe(1);
      expect(countOccurrences(body, "## How you deliver your verdict")).toBe(1);
    }
  });

  it("the tracked body has sections and passes the github-ops validator", () => {
    expect(hasReviewModeSections(raw)).toBe(true);
    expect(() => validateSkillBody("github-ops", raw, "tracked")).not.toThrow();
  });
});

describe("github-ops SKILL.md ↔ tagged review-intent parser (phase 6, no drift)", () => {
  it("both orchestrated renders instruct the parser's fence info; classic does not", () => {
    expect(orchTests).toContain(REVIEW_INTENT_FENCE_INFO);
    expect(orchNoTests).toContain(REVIEW_INTENT_FENCE_INFO);
    expect(classic).not.toContain(REVIEW_INTENT_FENCE_INFO);
  });

  it("no render contains a real tagged opener, and the option changes nothing", () => {
    for (const body of [raw, classic, orchTests, orchNoTests]) {
      expect(hasTaggedReviewIntentOpener(body)).toBe(false);
      expect(parseReviewIntent(body, { preferTaggedIntent: true })).toEqual(
        parseReviewIntent(body),
      );
    }
  });
});
