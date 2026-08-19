import { describe, it, expect } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { nanoid } from "nanoid";
import {
  extractTerminalAgentText,
  maybePromoteSkillLastKnownGood,
} from "./review-single-writer-finish";
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

  it("no-ops for non-skill threads, tracked-default runs (no versionId), and org-less threads", async () => {
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
