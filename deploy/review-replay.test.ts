/**
 * review-replay core — what the pre-cutover replay proves.
 *
 * protects: the replayed prompt is assembled exactly as production assembles
 *   it (placeholders, context substituted last, one-space join + trim,
 *   tolerance note after `---`), and the PR state is the state AT the legacy
 *   review (reviews and thread comments before `asOf`, resolution approximated
 *   by the bot's `Verified:` reply).
 * fails_when: a later review or comment leaks into the past, the join or the
 *   tolerance block differs, or a non-review skill is accepted.
 * no_claim: GitHub's API shapes and the agent run itself (fixtures stand in).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildReplayPrompt,
  legacyVerdict,
  resolvedTally,
  reviewsAsOf,
  threadsAsOf,
  type ReplayReview,
  type ReplayThread,
} from "./lib/review-replay-core.ts";
import {
  buildReviewToleranceDirective,
  toleranceToPolicy,
} from "../packages/review/src/review/severity-policy.ts";

const DIRECTIVE =
  "<!-- automata:context pr-view prior-reviews review-threads -->";
const SKILL = `Review {{repoFullName}} against origin/{{baseBranch}}.\n## Trigger Context\n${DIRECTIVE}\n\`\`\`json\n{ "verdict": "approve" }\n\`\`\`\n`;

describe("buildReplayPrompt", () => {
  test("placeholders, context last, one-space join, trimmed, tolerance after ---", () => {
    const prompt = buildReplayPrompt({
      flattenedSkill: SKILL,
      repoFullName: "acme/widgets",
      baseRef: "develop",
      prNumber: 7,
      event: "synchronize",
      renderedContext: "CTX {{baseBranch}}",
      tolerance: "info",
    });
    const expectedSkill = SKILL.replace("{{repoFullName}}", "acme/widgets")
      .replace("{{baseBranch}}", "develop")
      .replace(DIRECTIVE, "CTX {{baseBranch}}");
    assert.equal(
      prompt,
      `The "pull_request.synchronize" event was triggered for PR #7. ${expectedSkill}`.trim() +
        "\n\n---\n\n" +
        buildReviewToleranceDirective(toleranceToPolicy("info")) +
        "\n",
    );
    assert.ok(
      prompt.includes("CTX {{baseBranch}}"),
      "fetched text is never placeholder-rendered",
    );
  });

  test("a skill without the context directive is refused", () => {
    assert.throws(
      () =>
        buildReplayPrompt({
          flattenedSkill: "no directive",
          repoFullName: "a/b",
          baseRef: "main",
          prNumber: 1,
          event: "opened",
          renderedContext: "",
          tolerance: "warning",
        }),
      /no automata:context directive/,
    );
  });
});

describe("as-of filtering", () => {
  const AS_OF = "2026-10-10T12:00:00Z";
  const review = (
    id: number,
    at: string | null,
    state = "COMMENTED",
  ): ReplayReview => ({
    id,
    user: { login: "automata-ai-bot[bot]" },
    state,
    commit_id: "abcdef1234",
    body: `review ${id}`,
    submitted_at: at,
  });

  test("only reviews submitted before asOf are prior reviews", () => {
    const out = reviewsAsOf(
      [
        review(1, "2026-10-09T00:00:00Z", "CHANGES_REQUESTED"),
        review(2, AS_OF),
        review(3, "2026-10-11T00:00:00Z"),
        review(4, null),
      ],
      AS_OF,
    );
    assert.deepEqual(
      out.map((r) => r.body),
      ["review 1"],
    );
  });

  test("threads keep only earlier comments; resolved only by an earlier bot Verified: reply", () => {
    const thread = (comments: ReplayThread["comments"]): ReplayThread => ({
      isResolved: true,
      path: "a.ts",
      line: 3,
      comments,
    });
    const c = (id: number, login: string, body: string, at: string) => ({
      databaseId: id,
      author: { login },
      body,
      createdAt: at,
    });
    const out = threadsAsOf(
      [
        thread([
          c(1, "automata-ai-bot[bot]", "Add a guard", "2026-10-09T00:00:00Z"),
          c(
            2,
            "automata-ai-bot[bot]",
            "Verified: done",
            "2026-10-11T00:00:00Z",
          ),
        ]),
        thread([
          c(3, "automata-ai-bot[bot]", "Rename", "2026-10-09T00:00:00Z"),
          c(
            4,
            "automata-ai-bot[bot]",
            "Verified: renamed",
            "2026-10-09T06:00:00Z",
          ),
        ]),
        thread([c(5, "dev", "later thread", "2026-10-12T00:00:00Z")]),
      ],
      AS_OF,
      "automata-ai-bot[bot]",
    );
    assert.equal(out.length, 2, "a thread opened after asOf did not exist yet");
    assert.equal(out[0]?.isResolved, false, "the Verified reply came later");
    assert.deepEqual(
      out[0]?.comments.map((x) => x.databaseId),
      [1],
    );
    assert.equal(out[1]?.isResolved, true);
  });
});

describe("tallies", () => {
  test("Resolved X / Y and legacy verdict mapping", () => {
    assert.equal(resolvedTally("…\nResolved: 2 / 3\n"), "2/3");
    assert.equal(resolvedTally("none"), null);
    assert.equal(legacyVerdict("CHANGES_REQUESTED"), "request_changes");
    assert.equal(legacyVerdict("DISMISSED"), null);
  });
});
