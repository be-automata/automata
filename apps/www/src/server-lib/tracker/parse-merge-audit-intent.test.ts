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
    "../../../../../deploy/skills/github-pr-merged-youtrack/SKILL.md",
    import.meta.url,
  ),
);

const fenced = (value: unknown) =>
  "```json\n" + JSON.stringify(value, null, 2) + "\n```";

const validIntent = {
  kind: "pr-merged-audit",
  pr: 7,
  tickets: [
    {
      key: "ACME-1",
      acSource: "formal",
      criteria: [
        {
          id: "AC-1",
          text: "does the thing",
          verdict: "met",
          evidence: "a.ts:1",
        },
      ],
      taskComplete: true,
    },
  ],
};

describe("parseMergeAuditIntent", () => {
  it("parses a valid intent", () => {
    const result = parseMergeAuditIntent(
      `Audit done.\n\n${fenced(validIntent)}`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.pr).toBe(7);
      expect(result.intent.tickets[0]?.criteria[0]?.verdict).toBe("met");
    }
  });

  it("accepts an empty tickets array (nothing to audit)", () => {
    const result = parseMergeAuditIntent(
      fenced({ kind: "pr-merged-audit", pr: 1, tickets: [] }),
    );
    expect(result.ok).toBe(true);
  });

  it("takes the LAST intent block, not an earlier example", () => {
    const text = [
      "Skill example echoed back:",
      fenced({ ...validIntent, pr: 999 }),
      "Unrelated JSON from a diff:",
      fenced({ name: "pkg" }),
      "My verdict:",
      fenced({ ...validIntent, pr: 42 }),
      "And a trailing config snippet:",
      fenced({ compilerOptions: {} }),
    ].join("\n\n");
    const result = parseMergeAuditIntent(text);
    expect(result.ok && result.intent.pr).toBe(42);
  });

  it("reports a missing block", () => {
    expect(parseMergeAuditIntent("I could not finish.")).toEqual({
      ok: false,
      reason: "no audit intent block found in agent output",
    });
    expect(parseMergeAuditIntent("")).toMatchObject({ ok: false });
  });

  it("reports malformed JSON", () => {
    const result = parseMergeAuditIntent(
      '```json\n{ "kind": "pr-merged-audit", \n```',
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(/JSON parse failed/);
  });

  it.each([
    [
      "an unknown verdict",
      {
        ...validIntent,
        tickets: [
          {
            ...validIntent.tickets[0],
            criteria: [{ id: "AC-1", text: "x", verdict: "passed" }],
          },
        ],
      },
    ],
    ["a wrong kind", { ...validIntent, kind: "review" }],
    [
      "a missing taskComplete",
      {
        ...validIntent,
        tickets: [{ key: "ACME-1", acSource: "formal", criteria: [] }],
      },
    ],
    ["a non-numeric pr", { ...validIntent, pr: "7" }],
    [
      "an unknown acSource",
      {
        ...validIntent,
        tickets: [{ ...validIntent.tickets[0], acSource: "guess" }],
      },
    ],
  ])("rejects %s", (_label, intent) => {
    expect(parseMergeAuditIntent(fenced(intent)).ok).toBe(false);
  });

  it("finds the intent after a non-JSON fenced block (fences are paired, not regex-matched)", () => {
    const text = [
      "I ran:",
      "```bash",
      "gh pr diff 7",
      "```",
      "Result:",
      fenced(validIntent),
    ].join("\n");
    expect(parseMergeAuditIntent(text).ok).toBe(true);
  });

  it("ignores an intent-shaped block in a non-JSON fence", () => {
    const text = '```ts\nconst kind = "pr-merged-audit";\n```';
    expect(parseMergeAuditIntent(text).ok).toBe(false);
  });

  it("an unterminated fence yields no intent", () => {
    expect(
      parseMergeAuditIntent("```json\n" + JSON.stringify(validIntent)).ok,
    ).toBe(false);
  });

  it("over-long fields and extra criteria are truncated, never a reason to reject the audit", () => {
    const criteria = Array.from({ length: 55 }, (_, index) => ({
      id: `AC-${index + 1}`,
      text: "t".repeat(2_000),
      verdict: "met",
      evidence: "e".repeat(2_000),
    }));
    const result = parseMergeAuditIntent(
      fenced({
        ...validIntent,
        tickets: [
          {
            key: "ACME-1",
            acSource: "formal",
            criteria,
            taskComplete: false,
            remaining: "r".repeat(2_000),
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ticket = result.intent.tickets[0]!;
      expect(ticket.criteria).toHaveLength(40);
      expect(ticket.criteria[0]!.text).toHaveLength(600);
      expect(ticket.criteria[0]!.evidence).toHaveLength(600);
      expect(ticket.remaining).toHaveLength(400);
    }
  });

  it("the intent has no field that names a stage, a transition or a comment target", () => {
    // Judgement only — the executor decides every write (ADR-008). An intent
    // that smuggles a stage is still parsed, but the extra key is dropped.
    const result = parseMergeAuditIntent(
      fenced({
        ...validIntent,
        stage: "Done",
        tickets: [{ ...validIntent.tickets[0], transitionTo: "Done" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent).not.toHaveProperty("stage");
      expect(result.intent.tickets[0]).not.toHaveProperty("transitionTo");
    }
  });
});

/**
 * Anti-drift guard: the tracked skill's emit example must parse against the
 * SAME schema the executor uses, and the body must pass the validator every
 * write surface applies. A renamed field in either place would otherwise turn
 * every merge into a "no usable result" notice.
 */
describe("tracked post-merge skill ↔ parser + validator (no drift)", () => {
  const raw = readFileSync(SKILL_MD, "utf8");
  const body = stripFrontmatter(raw);

  it("the skill's fenced-json example parses as a merge-audit intent", () => {
    const result = parseMergeAuditIntent(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const verdicts = result.intent.tickets.flatMap((ticket) =>
        ticket.criteria.map((criterion) => criterion.verdict),
      );
      // The example demonstrates every verdict the rubric defines.
      expect(new Set(verdicts)).toEqual(
        new Set(["met", "partial", "not_met", "not_verifiable"]),
      );
    }
  });

  it("the body passes the validator registered for the lane", () => {
    expect(() =>
      validateSkillBody(PR_MERGED_SKILL_NAME, body, "tracked file"),
    ).not.toThrow();
  });

  it("frontmatter is stripped and only the supported placeholders appear", () => {
    expect(body.startsWith("---")).toBe(false);
    const placeholders = new Set(body.match(/\{\{[^}]+\}\}/g) ?? []);
    expect(placeholders).toEqual(
      new Set(["{{repoFullName}}", "{{baseBranch}}"]),
    );
  });

  it("the validator rejects a body without the intent contract", () => {
    expect(() =>
      validateSkillBody(
        PR_MERGED_SKILL_NAME,
        ["Audit the PR.", "", "## Hard rules", "", "- Read-only."].join("\n"),
        "test",
      ),
    ).toThrow(/no fenced-json "pr-merged-audit" intent contract/);
  });

  it("the validator rejects a truncated body (hard rules missing)", () => {
    const truncated = body.slice(0, body.indexOf("## Hard rules"));
    expect(() =>
      validateSkillBody(PR_MERGED_SKILL_NAME, truncated, "test"),
    ).toThrow(/no "## Hard rules" section/);
  });
});
