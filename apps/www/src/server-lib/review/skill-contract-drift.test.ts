import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReviewIntent } from "./parse-review-intent";
import { loadReviewSkillBody, stripFrontmatter } from "./review-skill";

/**
 * Anti-drift guard (ADR-036 rider): the emit-skill's fenced-JSON EXAMPLE must parse
 * against the SAME schema the control-plane parser uses. If the SKILL.md contract and
 * emittedReviewIntentSchema drift (a renamed field, a changed verdict enum), the agent
 * would emit an intent the parser rejects → a degraded COMMENT on every review run.
 * This fails CI the instant the doc example stops parsing.
 */

const SKILL_MD = fileURLToPath(
  new URL("../../../../../deploy/skills/github-ops/SKILL.md", import.meta.url),
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

/**
 * Anti-drift guard #2: the seed must INLINE the methodology from the tracked
 * skill, never point the agent at a box-local path. The previous instruction
 * embedded `/Users/senior/.claude/skills/github-ops/SKILL.md` as literal text,
 * which (a) only resolved on the pilot box and (b) let the installed copy drift
 * from the tracked one with nothing comparing them — a silently degraded review
 * on every run. These tests fail CI the instant either regression returns.
 */
describe("seed inlines the tracked review skill (no box-local path)", () => {
  const SEED_TS = fileURLToPath(
    new URL("../../../../../deploy/seed-pilot-mirror.ts", import.meta.url),
  );

  it("the seed contains no absolute home-directory skill path", () => {
    const seed = readFileSync(SEED_TS, "utf8");
    // Any absolute /Users/... or /home/... path would be box-specific.
    const absHomePaths = seed.match(
      /["'`][^"'`\n]*\/(?:Users|home)\/[^"'`\n]*/g,
    );
    expect(
      absHomePaths,
      `seed must not hardcode a box path: ${absHomePaths}`,
    ).toBeNull();
  });

  it("the seed upserts by (name, repo) — a name-only key cross-stamps repos in one org", () => {
    // All onboarded repos live under one org with IDENTICAL automation names
    // ("Mirror: PR review (github-ops)" ×3 in production). A map keyed on name
    // alone made a re-seed of repo B find repo A's row, overwrite its action
    // with B's text, and never create B's row. Pin the composite key and that
    // repoFullName rides along in the update so a matched row can't keep a
    // stale repo.
    const seed = readFileSync(SEED_TS, "utf8");
    expect(seed).toContain("upsertKey(a.name, a.repoFullName)");
    expect(seed).toContain(
      "upsertKey(automation.name, automation.repoFullName)",
    );
    expect(seed).toMatch(/updates:\s*\{[^}]*repoFullName/s);
  });

  it("the seed references the skill via the shared loader, not a literal path", () => {
    const seed = readFileSync(SEED_TS, "utf8");
    expect(seed).toContain("loadReviewSkillBody");
    expect(seed).toContain("reviewSkillBody");
  });

  it("the loader returns the tracked methodology with its verdict contract", () => {
    const body = loadReviewSkillBody();
    expect(body.length).toBeGreaterThan(500);
    // Frontmatter stripped: no leading fence, and the registry metadata is gone.
    expect(body.startsWith("---")).toBe(false);
    expect(body).not.toContain("\nname: github-ops");
    // Still carries the wire contract the parser depends on.
    expect(parseReviewIntent(body).ok).toBe(true);
  });

  it("the loader rejects a skill missing the verdict contract", () => {
    const bogus = fileURLToPath(
      new URL("./parse-review-intent.ts", import.meta.url),
    );
    expect(() => loadReviewSkillBody(bogus)).toThrow(
      /no fenced-json verdict contract/,
    );
  });

  it("the loader reports a missing skill file rather than seeding without it", () => {
    expect(() => loadReviewSkillBody("/nonexistent/SKILL.md")).toThrow(
      /not readable/,
    );
  });

  it("stripFrontmatter does not terminate early on an inline --- in a value", () => {
    const md = [
      "---",
      "name: x",
      "desc: a --- b",
      "---",
      "# Body",
      "text",
    ].join("\n");
    expect(stripFrontmatter(md)).toBe("# Body\ntext");
  });

  /**
   * The inline case above never exercised the fence check: the old
   * `indexOf("\n---")` needs the `---` at a LINE START, which `desc: a --- b`
   * never is. The real hazard is a frontmatter line that BEGINS with `---` and
   * continues with other text — a prefix match reads it as the closing fence
   * and truncates the body. These pin the whole-line requirement.
   */
  it("stripFrontmatter does not treat a line merely STARTING with --- as the fence", () => {
    const md = [
      "---",
      "name: x",
      "summary: >-",
      "---draft, not a fence",
      "---",
      "# Body",
      "text",
    ].join("\n");
    expect(stripFrontmatter(md)).toBe("# Body\ntext");
  });

  it("stripFrontmatter keeps a --- line in the BODY intact", () => {
    const md = ["---", "name: x", "---", "# Body", "---", "after rule"].join(
      "\n",
    );
    // Only the first fence pair is frontmatter; a horizontal rule in the body
    // must survive verbatim.
    expect(stripFrontmatter(md)).toBe("# Body\n---\nafter rule");
  });

  it("stripFrontmatter accepts a fence with trailing whitespace and CRLF", () => {
    const md = ["---", "name: x", "---  ", "# Body", "text"].join("\r\n");
    expect(stripFrontmatter(md)).toBe("# Body\r\ntext");
  });
});
