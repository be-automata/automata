import { describe, it, expect } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { nanoid } from "nanoid";
import {
  extractTerminalAgentText,
  getMergeAuditStamp,
  isWorkFailedOutcome,
  maybePromoteSkillLastKnownGood,
  selectReviewTerminalText,
} from "./review-single-writer-finish";
import {
  F1,
  F2,
  F3,
  LEAD_RESUMED_TEXT,
  LEAD_TAGGED_TEXT,
  STAMPED_METADATA,
  UNSTAMPED_METADATA,
} from "./__fixtures__/orchestrated-terminal-messages";
import type { ReviewFromIntentOutcome } from "./execute-review-from-intent";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createRepoSkillVersion,
  getRepoSkill,
} from "@terragon/shared/model/repo-skills";
import type { DBMessage } from "@terragon/shared/db/db-message";
import { createDb, type DB } from "@terragon/shared/db";

const userMsg: DBMessage = {
  type: "user",
  model: null,
  parts: [{ type: "text", text: "review this PR" }],
};
const agent = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: null,
  parts: [{ type: "text", text }],
});

describe("extractTerminalAgentText", () => {
  it("returns the LAST agent message's text (ignoring earlier ones + non-agent)", () => {
    const msgs: DBMessage[] = [
      userMsg,
      agent("first pass"),
      { type: "tool_call" } as unknown as DBMessage,
      agent('```json\n{"verdict":"approve"}\n```'),
    ];
    expect(extractTerminalAgentText(msgs)).toContain('"verdict":"approve"');
    expect(extractTerminalAgentText(msgs)).not.toContain("first pass");
  });

  it("concatenates multiple text parts of the last agent message", () => {
    const multi: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [
        { type: "text", text: "line one" },
        { type: "thinking", text: "ignored" } as unknown as {
          type: "text";
          text: string;
        },
        { type: "text", text: "line two" },
      ],
    };
    // The thinking part is filtered (type !== "text"); only text parts join.
    expect(extractTerminalAgentText([multi])).toBe("line one\nline two");
  });

  it("returns empty string when there is no agent message", () => {
    expect(extractTerminalAgentText([userMsg])).toBe("");
  });

  it("returns empty string for null messages", () => {
    expect(extractTerminalAgentText(null)).toBe("");
  });

  // Phase 5 (02-FINDINGS Q7): a sub-agent message can arrive after the lead's
  // final text; it must never become the review.
  const subAgent = (text: string): DBMessage => ({
    type: "agent",
    parent_tool_use_id: "toolu_1",
    parts: [{ type: "text", text }],
  });

  it("skips a sub-agent message that arrives LAST and returns the lead's text", () => {
    const text = extractTerminalAgentText([
      userMsg,
      agent('lead final\n```json\n{"verdict":"approve"}\n```'),
      subAgent('sub\n```json\n{"verdict":"ZZ_SUBAGENT_VERDICT"}\n```'),
    ]);
    expect(text).toContain("approve");
    expect(text).not.toContain("ZZ_SUBAGENT_VERDICT");
  });

  it("returns empty string when only sub-agent messages exist", () => {
    expect(extractTerminalAgentText([userMsg, subAgent("sub only")])).toBe("");
  });

  it("treats a legacy agent row with no parent_tool_use_id as a lead message", () => {
    const legacy = {
      type: "agent",
      parts: [{ type: "text", text: "legacy lead" }],
    } as unknown as DBMessage;
    expect(extractTerminalAgentText([userMsg, legacy])).toBe("legacy lead");
  });
});

describe("isWorkFailedOutcome — which outcomes page an operator", () => {
  it("pages for every outcome that applied no review", () => {
    for (const outcome of [
      "degraded_comment",
      "post_failed",
      "skipped_stale_degrade",
      // #220 DECISION, pinned here: a SUPPRESSED duplicate degrade still pages.
      // The per-sha key suppresses the PR comment a human reads, not the
      // telemetry that an additional run emitted no verdict. Flipping this to
      // "one page per sha" would blind the only channel that can see an agent
      // failing over and over at one commit — the count #107 needs to size its
      // bounded auto-requeue.
      "skipped_duplicate_degrade_at_commit",
    ] satisfies ReviewFromIntentOutcome["outcome"][]) {
      expect(isWorkFailedOutcome(outcome)).toBe(true);
    }
  });

  it("stays silent for outcomes where a review IS in force", () => {
    for (const outcome of [
      "posted",
      "posted_stale_comment",
      "skipped_existing",
      "skipped_superseded",
      "skipped_duplicate_at_commit",
    ] satisfies ReviewFromIntentOutcome["outcome"][]) {
      expect(isWorkFailedOutcome(outcome)).toBe(false);
    }
  });
});

describe("maybePromoteSkillLastKnownGood (real test DB)", () => {
  const db = createDb(env.DATABASE_URL!);
  const REPO = "acme/widgets";
  const BODY = 'Methodology.\n```json\n{ "verdict": "approve" }\n```\n';

  async function seedSkill() {
    const org = await createOrganization({
      db,
      name: "acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: org.id,
      repoFullName: REPO,
      skillName: "github-ops",
      body: BODY,
      source: "dashboard",
    });
    return { organizationId: org.id, versionId: version.id };
  }

  function skillMeta(versionId: string | undefined) {
    return {
      type: "automation-skill" as const,
      skillName: "github-ops",
      contentSha: "abc",
      source: "db-version",
      versionId,
    };
  }

  async function lastKnownGood(organizationId: string) {
    const skill = await getRepoSkill({
      db,
      organizationId,
      repoFullName: REPO,
      skillName: "github-ops",
    });
    return skill?.lastKnownGoodVersionId ?? null;
  }

  it("promotes the thread's version to last-known-good after a clean 'posted' outcome", async () => {
    const { organizationId, versionId } = await seedSkill();
    await maybePromoteSkillLastKnownGood({
      db,
      organizationId,
      repoFullName: REPO,
      sourceMetadata: skillMeta(versionId),
      outcome: "posted",
    });
    expect(await lastKnownGood(organizationId)).toBe(versionId);
  });

  it("promotes NOTHING on non-healthy outcomes — they prove nothing about the body", async () => {
    const { organizationId, versionId } = await seedSkill();
    for (const outcome of [
      "degraded_comment",
      "post_failed",
      "skipped_existing",
      "skipped_superseded",
      "posted_stale_comment",
    ]) {
      await maybePromoteSkillLastKnownGood({
        db,
        organizationId,
        repoFullName: REPO,
        sourceMetadata: skillMeta(versionId),
        outcome,
      });
    }
    expect(await lastKnownGood(organizationId)).toBeNull();
  });

  it("no-ops for non-skill threads, legacy stamps with no versionId, and org-less threads", async () => {
    const { organizationId, versionId } = await seedSkill();
    await maybePromoteSkillLastKnownGood({
      db,
      organizationId,
      repoFullName: REPO,
      sourceMetadata: {
        type: "github-mention",
        repoFullName: REPO,
        issueOrPrNumber: 1,
      },
      outcome: "posted",
    });
    await maybePromoteSkillLastKnownGood({
      db,
      organizationId,
      repoFullName: REPO,
      sourceMetadata: skillMeta(undefined),
      outcome: "posted",
    });
    await maybePromoteSkillLastKnownGood({
      db,
      organizationId: null,
      repoFullName: REPO,
      sourceMetadata: skillMeta(versionId),
      outcome: "posted",
    });
    expect(await lastKnownGood(organizationId)).toBeNull();
  });

  it("is best-effort: a promotion failure is swallowed (the review already posted)", async () => {
    // A broken db object makes the model throw — the helper must swallow it.
    await expect(
      maybePromoteSkillLastKnownGood({
        db: {} as DB,
        organizationId: "org_x",
        repoFullName: REPO,
        sourceMetadata: skillMeta("v_x"),
        outcome: "posted",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("getMergeAuditStamp — which threads the post-merge executor acts on (ADR-008)", () => {
  const stamp = {
    type: "automation-skill" as const,
    skillName: "github-pr-merged",
    contentSha: "sha",
    source: "db-version",
    versionId: "v1",
  };

  it("returns the stamp for a merged-PR skill thread", () => {
    expect(
      getMergeAuditStamp({ sourceMetadata: stamp, terminalCause: null }),
    ).toEqual(stamp);
    expect(getMergeAuditStamp({ sourceMetadata: stamp })).toEqual(stamp);
  });

  it("ignores every other thread, so reviews and mentions are untouched", () => {
    expect(getMergeAuditStamp(null)).toBeNull();
    expect(getMergeAuditStamp({ sourceMetadata: null })).toBeNull();
    expect(
      getMergeAuditStamp({
        sourceMetadata: { ...stamp, skillName: "github-ops" },
      }),
    ).toBeNull();
    expect(
      getMergeAuditStamp({
        sourceMetadata: {
          type: "github-mention",
          repoFullName: "o/r",
          issueOrPrNumber: 1,
          commentId: 1,
        },
      }),
    ).toBeNull();
  });

  it("skips an abandoned run: it never finished its audit", () => {
    expect(
      getMergeAuditStamp({
        sourceMetadata: stamp,
        terminalCause: "superseded",
      }),
    ).toBeNull();
  });
});

describe("selectReviewTerminalText — one selector for hook and sweep (phase 6)", () => {
  it("stamped thread → the last LEAD message with a tagged opener, tag preferred", () => {
    expect(
      selectReviewTerminalText({
        thread: { sourceMetadata: STAMPED_METADATA },
        messages: F1,
      }),
    ).toEqual({ preferTaggedIntent: true, terminalText: LEAD_TAGGED_TEXT });
  });

  it("unstamped thread → exactly today's terminal text, no tag preference", () => {
    const result = selectReviewTerminalText({
      thread: { sourceMetadata: UNSTAMPED_METADATA },
      messages: F2,
    });
    expect(result).toEqual({
      preferTaggedIntent: false,
      terminalText: LEAD_RESUMED_TEXT,
    });
    expect(result.terminalText).toBe(extractTerminalAgentText(F2));
  });

  it("stamped thread without any tagged lead message → today's terminal text", () => {
    expect(
      selectReviewTerminalText({
        thread: { sourceMetadata: STAMPED_METADATA },
        messages: F3,
      }),
    ).toEqual({
      preferTaggedIntent: true,
      terminalText: extractTerminalAgentText(F3),
    });
  });

  it("detects the stamp only on an orchestrated automation-skill object", () => {
    const notStamped = [
      null,
      undefined,
      { sourceMetadata: null },
      {},
      { sourceMetadata: UNSTAMPED_METADATA },
      {
        sourceMetadata: {
          type: "www-fork" as const,
          parentThreadId: "p",
          parentThreadChatId: "c",
        },
      },
    ];
    for (const thread of notStamped) {
      expect(
        selectReviewTerminalText({ thread, messages: F1 }).preferTaggedIntent,
      ).toBe(false);
    }
  });

  it("never selects a sub-agent message, even one with a tagged opener", () => {
    const subTagged: DBMessage = {
      type: "agent",
      parent_tool_use_id: "toolu_y",
      parts: [
        {
          type: "text",
          text: '```json review-intent\n{"verdict":"approve"}\n```',
        },
      ],
    };
    const result = selectReviewTerminalText({
      thread: { sourceMetadata: STAMPED_METADATA },
      messages: [...F1, subTagged],
    });
    expect(result.terminalText).toBe(LEAD_TAGGED_TEXT);
    const noLeadTag = selectReviewTerminalText({
      thread: { sourceMetadata: STAMPED_METADATA },
      messages: [...F3, subTagged],
    });
    expect(noLeadTag.terminalText).toBe(extractTerminalAgentText(F3));
  });
});
