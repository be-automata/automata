/**
 * A10: argument parsing and the rows deploy/onboard-review-repo.ts writes.
 *
 *   Run:  node --test deploy/onboard-review-repo.test.ts
 *
 * protects=the cutover command writes exactly the specified settings and
 *   automation shape, a flip touches only `enabled`, and a mistyped flag
 *   aborts instead of writing;
 * fails_when=a filter/action field drifts from the spec, an unknown flag is
 *   ignored, or a bare --enable configures instead of flipping;
 * no_claim=the DB writes themselves (no database here) and the real model
 *   list (a short list stands in for AIModelSchema.options).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  OnboardArgsError,
  REVIEW_MAX_TURNS,
  buildMentionAutomation,
  buildReviewAutomation,
  buildReviewSettingsPatch,
  diffFields,
  mentionAutomationName,
  parseOnboardArgs,
  reviewAutomationName,
  stableStringify,
} from "./lib/onboard-review-repo-args.ts";

const ALLOWED = {
  models: ["opus", "sonnet"],
  tolerances: ["info", "warning", "error"],
};
const BASE = ["example-org", "example-owner/example-repo", "flutter-pr-review"];
const parse = (...extra: string[]) =>
  parseOnboardArgs([...BASE, ...extra], ALLOWED);

describe("parseOnboardArgs", () => {
  test("configure: tolerance, drafts, model; created disabled unless --enable", () => {
    assert.deepEqual(
      parse("--tolerance", "info", "--drafts", "--model", "opus"),
      {
        kind: "configure",
        orgSlug: "example-org",
        repoFullName: "example-owner/example-repo",
        skillName: "flutter-pr-review",
        tolerance: "info",
        drafts: true,
        model: "opus",
        enabled: undefined,
        dryRun: false,
      },
    );
    const enabled = parse(
      "--model",
      "sonnet",
      "--enable",
      "--tolerance",
      "warning",
      "--dry-run",
    );
    assert.equal(enabled.kind, "configure");
    assert.equal(enabled.kind === "configure" && enabled.drafts, false);
    assert.equal(enabled.kind === "configure" && enabled.enabled, true);
    assert.equal(enabled.dryRun, true);
  });

  test("--enable / --disable alone is a flip, nothing else", () => {
    assert.deepEqual(parse("--enable"), {
      kind: "flip",
      lane: "review",
      orgSlug: "example-org",
      repoFullName: "example-owner/example-repo",
      skillName: "flutter-pr-review",
      enabled: true,
      dryRun: false,
    });
    const off = parse("--disable", "--dry-run");
    assert.equal(off.kind, "flip");
    assert.equal(off.enabled, false);
    assert.equal(off.dryRun, true);
  });

  test("--help needs no other argument", () => {
    assert.deepEqual(parseOnboardArgs(["--help"], ALLOWED), { kind: "help" });
  });

  test("rejects unknown flags, bad values and incomplete configure runs", () => {
    const cases: [string[], RegExp][] = [
      [
        ["--tolerance", "info", "--model", "opus", "--dryrun"],
        /Unknown flag: --dryrun/,
      ],
      [
        ["--tolerance", "critical", "--model", "opus"],
        /--tolerance must be one of info, warning, error/,
      ],
      [["--tolerance", "info", "--model", "gpt-4"], /not a known model: gpt-4/],
      [["--tolerance", "info"], /--model is required/],
      [["--drafts", "--model", "opus"], /--tolerance is required/],
      [["--tolerance", "--model", "opus"], /--tolerance needs a value/],
      [["--enable", "--disable"], /mutually exclusive/],
      [["--enable", "--enable"], /--enable given twice/],
      [[], /Nothing to do/],
      [["--dry-run"], /Nothing to do/],
    ];
    for (const [extra, message] of cases) {
      assert.throws(
        () => parse(...extra),
        (err: unknown) =>
          err instanceof OnboardArgsError && message.test(err.message),
        extra.join(" "),
      );
    }
    assert.throws(
      () =>
        parseOnboardArgs(
          ["example-org", "not-a-repo", "x", "--enable"],
          ALLOWED,
        ),
      /repo must be 'owner\/repo'/,
    );
    assert.throws(
      () => parseOnboardArgs(["example-org", "o/r", "--enable"], ALLOWED),
      /Expected <orgSlug> <owner\/repo> <skillName>/,
    );
  });
});

describe("rows a configure run writes", () => {
  test("settings: tolerance, drafts, classic, 120 turns, supersede inherited", () => {
    assert.deepEqual(
      buildReviewSettingsPatch({ tolerance: "info", drafts: true }),
      {
        blockTolerance: "info",
        reviewDraftPrs: true,
        reviewMode: "classic",
        reviewMaxTurns: REVIEW_MAX_TURNS,
        supersedePolicy: null,
      },
    );
    assert.equal(REVIEW_MAX_TURNS, 120);
  });

  test("automation: pull_request on open+update, all authors, no bots, skill_message with model", () => {
    assert.equal(reviewAutomationName("github-ops"), "PR review (github-ops)");
    assert.deepEqual(
      buildReviewAutomation({
        repoFullName: "example-owner/Example-Repo",
        skillName: "github-ops",
        drafts: true,
        model: "opus",
      }),
      {
        name: "PR review (github-ops)",
        triggerType: "pull_request",
        triggerConfig: {
          filter: {
            includeAllAuthors: true,
            includeDraftPRs: true,
            excludeBotSenders: true,
          },
          on: { open: true, update: true },
        },
        // GitHub casing is kept: the webhook handler matches repo names exactly.
        repoFullName: "example-owner/Example-Repo",
        branchName: "main",
        action: {
          type: "skill_message",
          config: { skillName: "github-ops", version: "latest", model: "opus" },
        },
      },
    );
    assert.equal(
      buildReviewAutomation({
        repoFullName: "o/r",
        skillName: "s",
        drafts: false,
        model: "opus",
      }).triggerConfig.filter.includeDraftPRs,
      false,
    );
  });
});

describe("--mention (the org-owned mention lane)", () => {
  const MENTION = ["example-org", "acme/widgets", "github-mention"];
  const parseMention = (...extra: string[]) =>
    parseOnboardArgs([...MENTION, ...extra], ALLOWED);

  test("configure needs only --model; created disabled unless --enable", () => {
    assert.deepEqual(parseMention("--mention", "--model", "opus"), {
      kind: "configure-mention",
      orgSlug: "example-org",
      repoFullName: "acme/widgets",
      skillName: "github-mention",
      model: "opus",
      enabled: undefined,
      dryRun: false,
    });
    const on = parseMention("--model", "sonnet", "--mention", "--enable");
    assert.equal(on.kind, "configure-mention");
    assert.equal(on.kind === "configure-mention" && on.enabled, true);
  });

  test("--mention with --enable/--disable alone flips the mention automation", () => {
    assert.deepEqual(parseMention("--mention", "--disable", "--dry-run"), {
      kind: "flip",
      lane: "mention",
      orgSlug: "example-org",
      repoFullName: "acme/widgets",
      skillName: "github-mention",
      enabled: false,
      dryRun: true,
    });
  });

  test("rejects review-lane flags, unknown models and an empty run", () => {
    const cases: [string[], RegExp][] = [
      [
        ["--mention", "--model", "opus", "--tolerance", "info"],
        /--tolerance is a review-lane flag/,
      ],
      [
        ["--mention", "--model", "opus", "--drafts"],
        /--drafts is a review-lane flag/,
      ],
      [["--mention", "--model", "gpt-4"], /not a known model: gpt-4/],
      [["--mention"], /Nothing to do/],
      [
        ["--mention", "--model", "opus", "--mentions"],
        /Unknown flag: --mentions/,
      ],
    ];
    for (const [extra, message] of cases) {
      assert.throws(
        () => parseMention(...extra),
        (err: unknown) =>
          err instanceof OnboardArgsError && message.test(err.message),
        extra.join(" "),
      );
    }
  });

  test("automation: org-lane github_mention, skill_message with model, no checkpointing", () => {
    assert.equal(
      mentionAutomationName("github-mention"),
      "GitHub mention (github-mention)",
    );
    assert.deepEqual(
      buildMentionAutomation({
        repoFullName: "acme/Widgets",
        skillName: "github-mention",
        model: "opus",
      }),
      {
        name: "GitHub mention (github-mention)",
        triggerType: "github_mention",
        triggerConfig: { filter: { orgLane: true } },
        repoFullName: "acme/Widgets",
        branchName: "main",
        action: {
          type: "skill_message",
          config: {
            skillName: "github-mention",
            version: "latest",
            model: "opus",
          },
        },
        disableGitCheckpointing: true,
      },
    );
  });
});

describe("diffFields", () => {
  test("ignores jsonb key order, reports only changed fields", () => {
    const desired = {
      action: {
        type: "skill_message",
        config: { skillName: "s", version: "latest" },
      },
      enabled: true,
    };
    // A stored jsonb row reads back with its keys reordered.
    const stored = {
      id: "a1",
      action: {
        config: { version: "latest", skillName: "s" },
        type: "skill_message",
      },
      enabled: false,
    };
    assert.deepEqual(diffFields(stored, desired), ["enabled: false → true"]);
    assert.deepEqual(diffFields({ ...stored, enabled: true }, desired), []);
  });

  test("a missing row reports every field as new", () => {
    assert.deepEqual(
      diffFields(undefined, { reviewMaxTurns: 120, supersedePolicy: null }),
      ["reviewMaxTurns: (no row) → 120", "supersedePolicy: (no row) → null"],
    );
  });

  test("stableStringify sorts keys recursively", () => {
    assert.equal(
      stableStringify({ b: 1, a: { d: 2, c: 3 } }),
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });
});
