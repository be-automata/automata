import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { flattenSkillBody } from "../../../../../deploy/lib/flatten-skill";
import { loadReviewSkillBody } from "../../../../../deploy/lib/review-skill-file";
import { buildSeedSkillBodies } from "../../../../../deploy/lib/seed-skill-bodies";
import {
  assertReviewSkillContract,
  stripFrontmatter,
  validateSkillBody,
} from "./review-skill";
import {
  assertSkillBodyNamesPrBase,
  diffsPullRequest,
  findPrBaseViolations,
  validateSkillBodyForSave,
} from "./skill-save-checks";

const SKILLS_DIR = fileURLToPath(
  new URL("../../../../../deploy/skills/", import.meta.url),
);

/** A minimal body that passes the github-ops dispatch contract. */
const contractBody = (diffLine: string): string =>
  `Review the PR. ${diffLine}\n` +
  '```json\n{ "verdict": "approve", "commit": "abc", "summary": "ok" }\n```\n';

const BAD_BASES = [
  "Run `git diff origin/main...HEAD`.",
  "Run `git diff --stat origin/develop...HEAD`.",
  "Run `git diff origin/<base>...HEAD` where <base> is the PR base.",
  "The base ref is pre-fetched to `origin/<base>`.",
  "Only `origin/main...HEAD` is the delta.",
  "Use origin/master..HEAD.",
];

const GOOD_BASES = [
  "Run `git diff origin/{{baseBranch}}...HEAD`.",
  "Run `git diff --stat origin/{{baseBranch}}...HEAD` first.",
  "Read one file: `git diff origin/{{baseBranch}}...HEAD -- <path>`.",
  "No diff command at all.",
  "Never use `git diff HEAD~1...HEAD`.",
];

describe("findPrBaseViolations", () => {
  for (const line of BAD_BASES) {
    it(`flags ${JSON.stringify(line)}`, () => {
      expect(findPrBaseViolations(line).length).toBeGreaterThan(0);
    });
  }
  for (const line of GOOD_BASES) {
    it(`accepts ${JSON.stringify(line)}`, () => {
      expect(findPrBaseViolations(line)).toEqual([]);
    });
  }
});

describe("diffsPullRequest", () => {
  it("covers the review, mention and companion skills, by suffix too", () => {
    for (const name of [
      "github-ops",
      "flutter-pr-review",
      "github-mention",
      "flutter-pr-companion",
      "react-pr-companion",
      "angular-pr-companion",
      " GitHub-Ops ",
    ]) {
      expect(diffsPullRequest(name)).toBe(true);
    }
  });

  it("leaves skills that diff no PR alone", () => {
    for (const name of [
      "github-pr-merged",
      "audit-findings",
      "audit-fix",
      "github-deep-research",
    ]) {
      expect(diffsPullRequest(name)).toBe(false);
      expect(() =>
        assertSkillBodyNamesPrBase(name, "git diff origin/main...HEAD", "t"),
      ).not.toThrow();
    }
  });
});

describe("validateSkillBodyForSave (write paths)", () => {
  it("refuses a github-ops body that diffs against origin/main, naming the fix", () => {
    expect(() =>
      validateSkillBodyForSave(
        "github-ops",
        contractBody("Run `git diff origin/main...HEAD`."),
        "API PUT",
      ),
    ).toThrow(/origin\/\{\{baseBranch\}\}/);
  });

  it("refuses the prose <base> form for flutter-pr-review", () => {
    expect(() =>
      validateSkillBodyForSave(
        "flutter-pr-review",
        contractBody("Run `git diff origin/<base>...HEAD`."),
        "dashboard editor",
      ),
    ).toThrow(/origin\/<base>/);
  });

  it("still runs the dispatch-time contract first", () => {
    expect(() =>
      validateSkillBodyForSave(
        "github-ops",
        "Run `git diff origin/{{baseBranch}}...HEAD`.",
        "API PUT",
      ),
    ).toThrow(/fenced-json verdict contract/);
  });

  it("accepts a body that names the base as {{baseBranch}}", () => {
    expect(() =>
      validateSkillBodyForSave(
        "github-ops",
        contractBody("Run `git diff origin/{{baseBranch}}...HEAD`."),
        "API PUT",
      ),
    ).not.toThrow();
  });
});

/**
 * CRITICAL: the base-branch rule is SAVE-time only. The resolver re-validates
 * every STORED version with validateSkillBody at dispatch
 * (resolve-review-skill.ts). Had the rule joined validateSkillBody /
 * SKILL_VALIDATORS / assertReviewSkillContract, every stored body that still
 * says `origin/main` would be disqualified at dispatch, the resolver would
 * fall back past last-known-good, and the lane would run NO review at all.
 */
describe("the base-branch rule never runs at resolve time", () => {
  const stored = contractBody("Run `git diff origin/main...HEAD`.");

  it("a body the save check refuses is still accepted by validateSkillBody", () => {
    expect(() =>
      validateSkillBodyForSave("github-ops", stored, "save"),
    ).toThrow();
    for (const name of ["github-ops", "flutter-pr-review"]) {
      expect(() => validateSkillBody(name, stored, "resolve")).not.toThrow();
    }
    expect(() => assertReviewSkillContract(stored, "resolve")).not.toThrow();
  });

  it("the same holds for the mention and companion lanes", () => {
    const mention =
      "Run `git diff origin/main...HEAD`.\n" +
      '```json mention-reply\n{ "kind": "mention-reply", "reply": "x" }\n```\n';
    expect(() =>
      validateSkillBodyForSave("github-mention", mention, "save"),
    ).toThrow();
    expect(() =>
      validateSkillBody("github-mention", mention, "resolve"),
    ).not.toThrow();
  });
});

/** Fake pinned fetch: the tracked Flutter skill inlines seven pinned files. */
const fetchText = async () => ({
  status: 200,
  text: async () => "# pinned standards file\n",
});

async function flattenTracked(dir: string): Promise<string> {
  const raw = readFileSync(path.join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  return flattenSkillBody(stripFrontmatter(raw), {
    readPartial: (name) =>
      readFileSync(path.join(SKILLS_DIR, "_shared", `${name}.md`), "utf8"),
    fetchText,
    stripFrontmatter,
  });
}

describe("every tracked PR-diffing skill passes the save check after flattening", () => {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .filter(diffsPullRequest);

  it("finds the expected skills", () => {
    expect(dirs).toEqual(
      expect.arrayContaining([
        "github-ops",
        "flutter-pr-review",
        "github-mention",
        "flutter-pr-companion",
        "react-pr-companion",
      ]),
    );
  });

  for (const dir of dirs) {
    it(`${dir} names its diff base as origin/{{baseBranch}}`, async () => {
      const body = await flattenTracked(dir);
      expect(body).not.toContain("<!-- include");
      expect(findPrBaseViolations(body)).toEqual([]);
      expect(() =>
        validateSkillBodyForSave(dir, body, `tracked ${dir}`),
      ).not.toThrow();
    });
  }
});

describe("seed bodies (deploy/seed-pilot-mirror.ts)", () => {
  it("every seed body passes the save check, and github-ops diffs against {{baseBranch}}", async () => {
    const bodies = buildSeedSkillBodies(await loadReviewSkillBody());
    for (const [name, body] of Object.entries(bodies)) {
      expect(() => validateSkillBodyForSave(name, body, "seed")).not.toThrow();
    }
    const ops = bodies["github-ops"]!;
    expect(ops).toContain("git diff origin/{{baseBranch}}...HEAD");
    expect(ops).not.toContain("origin/<base>");
    expect(ops).not.toContain("origin/main...HEAD");
  });

  it("the seed preamble leaves verdict delivery to the methodology", async () => {
    // The methodology's delivery section has a classic and an orchestrated
    // (tagged `json review-intent`) variant; a preamble restating "a single
    // ```json block … exactly once" would contradict the orchestrated one.
    const ops = buildSeedSkillBodies(await loadReviewSkillBody())[
      "github-ops"
    ]!;
    const preamble = ops.slice(
      0,
      ops.indexOf("----- BEGIN REVIEW METHODOLOGY"),
    );
    expect(preamble).not.toContain("```");
    expect(preamble).not.toMatch(/exactly once, then stop/);
    expect(ops).toContain("<!-- automata:if orchestrated -->");
  });

  it("the seed never seeds flutter-pr-review (its sections need #493 deployed)", async () => {
    const bodies = buildSeedSkillBodies(await loadReviewSkillBody());
    expect(Object.keys(bodies)).not.toContain("flutter-pr-review");
  });
});
