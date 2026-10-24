import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";

import { loadReviewSkillBody } from "../../../../../deploy/lib/review-skill-file";
import {
  REVIEW_INTENT_FENCE_INFO,
  emittedReviewIntentSchema,
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
 * review-mode sections, while its CLASSIC render stays the reviewer body the
 * live store already serves.
 *
 * CLASSIC_SHA256 / CLASSIC_LENGTH pin the classic render of the tracked body
 * (flattened contentSha 6be9d3ea…, the version the live store serves). Its
 * text is the ported legacy reviewer (`deploy/skills/github-ops-ported/SKILL.md`
 * at origin/main @fb6e9a16, flattened sha PORT_SHA256), the body `github-ops`
 * ran before its review-mode sections were added, plus two blank lines the
 * dropped orchestrated blocks leave behind: PORT_SHA256 is the classic render
 * with blank-line runs collapsed. That port replaced the vendor's own review
 * skill (pinned here before as 47b019a8…), so the pin moved with it. NEVER
 * update these to "make the test pass": a mismatch means the classic prompt
 * every onboarded repo receives has changed.
 */
const CLASSIC_SHA256 =
  "330fdae9b1510d5cd8eaf32c799a0774b47691a994ffc92a316da558b6904c75";
const CLASSIC_LENGTH = 19952;
const PORT_SHA256 =
  "78a5faf89a8f25cd9a41468dc34aa55fa3c24c4f3dda2046517cf249b20f5276";

/** The read-only-git lines the orchestrated render swaps for its own. */
const CLASSIC_ONLY = [
  "`Bash` is for read-only git only",
  "run no shell command but the read-only git above",
];

const CLASSIC = { mode: "classic", runTests: false } as const;
const ORCH_TESTS = { mode: "orchestrated", runTests: true } as const;
const ORCH_NO_TESTS = { mode: "orchestrated", runTests: false } as const;

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const countOccurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

const raw = await loadReviewSkillBody();
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

  it("the classic render is the ported reviewer, up to blank-line runs", () => {
    expect(sha256(classic.replace(/\n{3,}/g, "\n\n"))).toBe(PORT_SHA256);
  });

  it("the classic render keeps the read-only-git rules and no sub-agents", () => {
    for (const needle of CLASSIC_ONLY) expect(classic).toContain(needle);
    expect(classic).toContain("Run dimensions 7–10 inline yourself.");
    expect(classic).not.toContain("`Agent`");
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
      // The `<!-- automata:context … -->` directive stays (the control plane
      // substitutes it later); no section marker may survive a render.
      expect(render).not.toMatch(/^<!-- automata:(?:if |endif)/m);
      for (const needle of REQUIRED) expect(render).toContain(needle);
      for (const needle of CLASSIC_ONLY) expect(render).not.toContain(needle);
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

  it("the raw body and every render end on the unable_to_review example", () => {
    // parseReviewIntent reads the LAST json block. In this body that is the
    // unable_to_review example, which must parse as the agent's no-verdict
    // report (ADR-009), never as a verdict or a parser failure.
    for (const body of [raw, classic, orchTests, orchNoTests]) {
      expect(parseReviewIntent(body)).toMatchObject({
        ok: false,
        source: "agent",
      });
    }
  });

  it("the verdict example names only fields the parser reads", () => {
    const delivery = raw.slice(raw.indexOf("## How you deliver your verdict"));
    const sketch = /```json\n([\s\S]*?)\n```/.exec(delivery)?.[1] ?? "";
    expect(sketch).toContain(
      '"verdict": "approve" | "request_changes" | "comment"',
    );
    const known = new Set<string>([
      ...Object.keys(emittedReviewIntentSchema.shape),
      "path",
      "line",
      "body",
      "severity",
      "quote",
      "inlineCommentId",
      "reply",
    ]);
    const keys = [...sketch.matchAll(/"(\w+)":/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(known).toContain(key);
    for (const verdict of emittedReviewIntentSchema.shape.verdict.options) {
      expect(sketch).toContain(`"${verdict}"`);
    }
  });

  it("the contract headings occur exactly once everywhere", () => {
    for (const body of [raw, classic, orchTests, orchNoTests]) {
      expect(countOccurrences(body, "## How you deliver your verdict")).toBe(1);
      expect(countOccurrences(body, "## Hard rules")).toBe(1);
    }
  });

  it("every render diffs against the PR base, never a fixed branch", () => {
    for (const body of [raw, classic, orchTests, orchNoTests]) {
      expect(body).toContain("git diff origin/{{baseBranch}}...HEAD");
      expect(body).not.toContain("origin/<base>");
      expect(body).not.toMatch(/origin\/(?:main|master)\b/);
    }
    expect(orchTests).toContain("the base ref `origin/{{baseBranch}}`");
    expect(classic).not.toContain("the base ref `origin/{{baseBranch}}`");
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
