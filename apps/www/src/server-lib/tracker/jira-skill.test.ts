import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PR_MERGED_SKILL_NAME,
  stripFrontmatter,
  validateSkillBody,
} from "../review/review-skill";
import { parseMergeAuditIntent } from "./parse-merge-audit-intent";

const SKILL_MD = fileURLToPath(
  new URL(
    "../../../../../deploy/skills/github-pr-merged-jira/SKILL.md",
    import.meta.url,
  ),
);

/** The Jira skill keeps the YouTrack skill's emit-only contract (ADR-008). */
describe("tracked Jira post-merge skill ↔ parser + validator (no drift)", () => {
  const raw = readFileSync(SKILL_MD, "utf8");
  const body = stripFrontmatter(raw);

  it("the body passes the validator registered for the lane", () => {
    expect(PR_MERGED_SKILL_NAME).toBe("github-pr-merged");
    expect(() =>
      validateSkillBody(PR_MERGED_SKILL_NAME, body, "tracked file"),
    ).not.toThrow();
  });

  it("the skill's fenced-json example parses as a merge-audit intent", () => {
    const result = parseMergeAuditIntent(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        new Set(
          result.intent.tickets.flatMap((ticket) =>
            ticket.criteria.map((criterion) => criterion.verdict),
          ),
        ),
      ).toEqual(new Set(["met", "partial", "not_met", "not_verifiable"]));
    }
  });

  it("uses Jira vocabulary and only the supported placeholders", () => {
    expect(raw).toMatch(/^name: github-pr-merged$/m);
    expect(body).toContain("Jira");
    expect(body).not.toMatch(/YouTrack/);
    expect(new Set(body.match(/\{\{[^}]+\}\}/g) ?? [])).toEqual(
      new Set(["{{repoFullName}}", "{{baseBranch}}"]),
    );
  });
});
