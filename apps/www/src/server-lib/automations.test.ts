import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createRepoSkillVersion,
  computeContentSha,
} from "@terragon/shared/model/repo-skills";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { automations as automationsTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { createNewThread } from "./new-thread-shared";
import { runAutomation } from "./automations";

vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));

describe("runAutomation — org inheritance (WI-5)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    user = (await createTestUser({ db })).user;
  });

  it("creates the thread with the automation's org", async () => {
    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    // An automation is org-owned; stamp its org.
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledTimes(1);
    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id }),
    );
  });

  it("passes a null org when the automation has none (nullable-safe)", async () => {
    const automation = await createTestAutomation({ db, userId: user.id });

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    const callArgs = vi.mocked(createNewThread).mock.calls[0]?.[0];
    expect(callArgs?.organizationId ?? null).toBeNull();
  });

  it("shadow: runs as a shadow thread when the org's installation is in shadow mode", async () => {
    const org = await createOrganization({
      db,
      name: "ShadowOrg",
      slug: `shadow-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: Math.floor(Math.random() * 1_000_000_000),
      organizationId: org.id,
      mode: "shadow",
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id, shadow: true }),
    );
  });

  it("active/none: runs as a non-shadow thread when the org has no shadow installation", async () => {
    const org = await createOrganization({
      db,
      name: "ActiveOrg",
      slug: `active-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: Math.floor(Math.random() * 1_000_000_000),
      organizationId: org.id,
      mode: "active",
    });
    const automation = await createTestAutomation({ db, userId: user.id });
    await db
      .update(automationsTable)
      .set({ organizationId: org.id })
      .where(eq(automationsTable.id, automation.id));

    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: org.id, shadow: false }),
    );
  });
});

describe("runAutomation — skill_message resolution (#54 C2)", () => {
  let user: User;
  let orgId: string;

  /** Valid github-ops body: fenced-json contract + both placeholders. */
  const SKILL_BODY =
    "Review {{repoFullName}} against origin/{{baseBranch}}.\n" +
    '```json\n{ "verdict": "approve" }\n```\n';

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(createNewThread).mockResolvedValue({
      threadId: "t1",
      threadChatId: "tc1",
    });
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "SkillOrg",
      slug: `skill-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function makeSkillAutomation() {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        action: {
          type: "skill_message",
          config: { skillName: "github-ops", version: "latest" },
        },
      },
    });
    await db
      .update(automationsTable)
      .set({ organizationId: orgId })
      .where(eq(automationsTable.id, automation.id));
    return automation;
  }

  it("resolves the current skill version, renders placeholders, stamps sourceMetadata", async () => {
    const automation = await makeSkillAutomation();
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });

    const result = await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });
    expect(result).toEqual({ threadId: "t1", threadChatId: "tc1" });

    expect(createNewThread).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(createNewThread).mock.calls[0]![0];
    // Placeholders rendered from the automation's repo + base branch.
    const text = (callArgs.message.parts[0] as { text: string }).text;
    expect(text).toContain("Review terragon/test-repo against origin/main.");
    expect(text).toContain('"verdict"');
    expect(text).not.toContain("{{repoFullName}}");
    // Traceability: the sha of the STORED body (pre-render), plus the tier.
    expect(callArgs.sourceMetadata).toEqual({
      type: "automation-skill",
      skillName: "github-ops",
      contentSha: computeContentSha(SKILL_BODY),
      source: "db-version",
      versionId: version.id,
    });
    expect(callArgs.organizationId).toBe(orgId);
  });

  it("{{baseBranch}} renders the PR's BASE ref, never its head (PR #59 regression)", async () => {
    // For PR events options.branchName is the HEAD ref (the sandbox
    // checkout); rendering it into {{baseBranch}} makes
    // `git diff origin/<base>...HEAD` provably empty — caught live on #59.
    const automation = await makeSkillAutomation();
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
      options: {
        branchName: "feat/some-pr-head",
        prBaseBranchName: "develop",
        prNumber: 41,
      },
    });
    const callArgs = vi.mocked(createNewThread).mock.calls[0]![0];
    const text = (callArgs.message.parts[0] as { text: string }).text;
    // The skill diffs against the PR base...
    expect(text).toContain("against origin/develop.");
    expect(text).not.toContain("origin/feat/some-pr-head");
    // ...while the thread itself still works on the PR head.
    expect(callArgs.baseBranchName).toBe("feat/some-pr-head");
  });

  it("an edit is live on the next run — no reseed, new sha stamped", async () => {
    const automation = await makeSkillAutomation();
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    const editedBody = SKILL_BODY + "\nEDITED SENTENCE.";
    const { version: v2 } = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: editedBody,
      source: "dashboard",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });

    const secondCall = vi.mocked(createNewThread).mock.calls[1]![0];
    expect((secondCall.message.parts[0] as { text: string }).text).toContain(
      "EDITED SENTENCE.",
    );
    expect(secondCall.sourceMetadata).toMatchObject({
      contentSha: computeContentSha(editedBody),
      versionId: v2.id,
    });
  });

  it("transformMessage still applies on top of the resolved skill message", async () => {
    const automation = await makeSkillAutomation();
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: automation.repoFullName,
      skillName: "github-ops",
      body: SKILL_BODY,
      source: "seed",
    });
    await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
      options: {
        transformMessage: (message) => ({
          ...message,
          parts: [{ type: "text", text: "PREPENDED EVENT." }, ...message.parts],
        }),
      },
    });
    const callArgs = vi.mocked(createNewThread).mock.calls[0]![0];
    expect((callArgs.message.parts[0] as { text: string }).text).toBe(
      "PREPENDED EVENT.",
    );
    expect((callArgs.message.parts[1] as { text: string }).text).toContain(
      "Review terragon/test-repo",
    );
  });

  it("a defaultless skill with no usable version SKIPS the run (no thread)", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        action: {
          type: "skill_message",
          config: { skillName: "github-mention", version: "latest" },
        },
      },
    });
    await db
      .update(automationsTable)
      .set({ organizationId: orgId })
      .where(eq(automationsTable.id, automation.id));

    const result = await runAutomation({
      userId: user.id,
      automationId: automation.id,
      source: "manual",
    });
    expect(result).toBeUndefined();
    expect(createNewThread).not.toHaveBeenCalled();
  });
});
