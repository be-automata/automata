import { describe, it, vi, beforeEach, expect } from "vitest";
import { createMirrorTask } from "./mirror-intake";
import { findWebhookSkip } from "./webhook-skip";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { createRepoSkillVersion } from "@terragon/shared/model/repo-skills";
import { nanoid } from "nanoid";
import { resolveTrackerConfig } from "@/server-lib/tracker/tracker-config";
import { getRepoInstallationId } from "@terragon/shared/github-app";

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi
    .fn()
    .mockResolvedValue({ threadId: "t", threadChatId: "c" }),
}));

// The repo-file override tier would call GitHub; the DB tiers are what is
// under test here.
vi.mock("@terragon/shared/github-app", () => ({
  getRepoInstallationId: vi.fn(),
}));
vi.mock("@/server-lib/review/repo-skill-override", () => ({
  buildRepoOverrideFetcher: () => async () => null,
}));

vi.mock("@/server-lib/tracker/tracker-config", () => ({
  resolveTrackerConfig: vi.fn().mockResolvedValue(null),
}));

const repoFullName = "be-automata/automata";

const MERGE_SKILL_BODY = [
  "# Post-merge audit for {{repoFullName}} (merged into {{baseBranch}})",
  "```json",
  '{ "kind": "pr-merged-audit", "pr": 1, "tickets": [{ "key": "X-1", "acSource": "formal", "criteria": [], "taskComplete": true }] }',
  "```",
  "## Hard rules",
  "- Read-only.",
].join("\n");

function installationId() {
  return Math.floor(Math.random() * 1_000_000_000);
}

async function seedBoundOrg(mode: "shadow" | "active") {
  const { user } = await createTestUser({ db });
  const org = await createOrganization({
    db,
    name: "BeAutomata",
    slug: `beautomata-${nanoid(8).toLowerCase()}`,
  });
  await addOrganizationMember({
    db,
    organizationId: org.id,
    userId: user.id,
    role: "owner",
  });
  const instId = installationId();
  await bindGithubInstallationToOrg({
    db,
    installationId: instId,
    organizationId: org.id,
    mode,
  });
  return { user, org, instId };
}

describe("createMirrorTask (mirror-intake)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shadow-bound: creates a shadow task attributed to the org owner, prompt names the intent", async () => {
    const { user, org, instId } = await seedBoundOrg("shadow");

    await createMirrorTask({
      repoFullName,
      installationId: instId,
      accountLogin: "be-automata",
      intent: {
        kind: "pr-review-requested",
        prNumber: 42,
        headBranch: "feature",
        baseBranch: "main",
      },
    });

    expect(newThreadInternal).toHaveBeenCalledTimes(1);
    const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
    expect(args.userId).toBe(user.id);
    expect(args.organizationId).toBe(org.id);
    expect(args.shadow).toBe(true);
    expect(args.githubPRNumber).toBe(42);
    expect(args.sourceType).toBe("automation");
    const text = args.message.parts.map((p: any) => p.text ?? "").join(" ");
    expect(text).toContain("Review requested on PR #42");
  });

  it("active-bound: creates a non-shadow task", async () => {
    const { instId } = await seedBoundOrg("active");
    await createMirrorTask({
      repoFullName,
      installationId: instId,
      intent: { kind: "pr-merged", prNumber: 7, baseBranch: "main" },
    });
    const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
    expect(args.shadow).toBe(false);
    expect(args.githubPRNumber).toBe(7);
    const text = args.message.parts.map((p: any) => p.text ?? "").join(" ");
    expect(text).toContain("was merged");
  });

  it("issue intent maps to githubIssueNumber and names the label", async () => {
    const { instId } = await seedBoundOrg("shadow");
    await createMirrorTask({
      repoFullName,
      installationId: instId,
      intent: { kind: "issue-labeled", issueNumber: 99, label: "bug" },
    });
    const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
    expect(args.githubIssueNumber).toBe(99);
    expect(args.githubPRNumber).toBeUndefined();
    const text = args.message.parts.map((p: any) => p.text ?? "").join(" ");
    expect(text).toContain("labeled 'bug'");
  });

  it("unbound installation: raises an unmapped_installation skip (WI-8) with id + account, no task", async () => {
    await expect(
      createMirrorTask({
        repoFullName,
        installationId: 999_999_999,
        accountLogin: "be-automata",
        intent: { kind: "ci-failure", runName: "CI", runId: 5 },
      }),
    ).rejects.toSatisfy((e: unknown) => {
      const skip = findWebhookSkip(e);
      return (
        skip?.category === "unmapped_installation" &&
        skip.detail?.installationId === 999_999_999 &&
        skip.detail?.accountLogin === "be-automata"
      );
    });
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  it("bound org with no members: raises a no_mapped_users skip, no task", async () => {
    const org = await createOrganization({
      db,
      name: "Ownerless",
      slug: `ownerless-${nanoid(8).toLowerCase()}`,
    });
    const instId = installationId();
    await bindGithubInstallationToOrg({
      db,
      installationId: instId,
      organizationId: org.id,
      mode: "shadow",
    });

    await expect(
      createMirrorTask({
        repoFullName,
        installationId: instId,
        intent: { kind: "issue-labeled", issueNumber: 1, label: "bug" },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => findWebhookSkip(e)?.category === "no_mapped_users",
    );
    expect(newThreadInternal).not.toHaveBeenCalled();
  });

  describe("pr-merged with a live github-pr-merged skill (ADR-008)", () => {
    async function seedSkill(orgId: string, userId: string, repo: string) {
      return await createRepoSkillVersion({
        db,
        organizationId: orgId,
        repoFullName: repo,
        skillName: "github-pr-merged",
        body: MERGE_SKILL_BODY,
        source: "api",
        createdByUserId: userId,
      });
    }

    const mergedIntent = {
      kind: "pr-merged" as const,
      prNumber: 7,
      baseBranch: "develop",
      headBranch: "ACME-812-void",
      title: "feat(ACME-812): void predictions",
      body: "Implements the void flow.",
      htmlUrl: "https://github.com/acme-inc/acme-core/pull/7",
      mergedBy: "octocat",
      mergeCommitSha: "abc123",
    };

    it("the skill body IS the task: rendered, with the trigger block, and stamped for the finish hook", async () => {
      const { user, org, instId } = await seedBoundOrg("active");
      const repo = `acme-inc/core-${nanoid(6).toLowerCase()}`;
      const { version } = await seedSkill(org.id, user.id, repo);

      await createMirrorTask({
        repoFullName: repo,
        installationId: instId,
        intent: mergedIntent,
      });

      const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
      const text = args.message.parts.map((p: any) => p.text ?? "").join("");
      // Placeholders rendered: repo, and the PR BASE as {{baseBranch}}.
      expect(text).toContain(
        `# Post-merge audit for ${repo} (merged into develop)`,
      );
      expect(text).not.toContain("{{");
      expect(text).toContain("## Trigger");
      expect(text).toContain("- Pull request: #7");
      expect(text).toContain("title: feat(ACME-812): void predictions");
      expect(text).toContain("## Tracker context");
      expect(text).toContain("No tracker is configured");
      // Not the legacy prompt.
      expect(text).not.toContain("prod skill: github-pr-merged-jira");

      expect(args.sourceMetadata).toEqual({
        type: "automation-skill",
        skillName: "github-pr-merged",
        contentSha: version.contentSha,
        source: "db-version",
        versionId: version.id,
      });
      expect(args.githubPRNumber).toBe(7);
      expect(args.baseBranchName).toBe("develop");
    });

    describe("a repo-level webhook delivery (no installation in the payload)", () => {
      it("resolves the installation from the App and runs the configured audit", async () => {
        const { user, org, instId } = await seedBoundOrg("active");
        const repo = `acme-inc/core-${nanoid(6).toLowerCase()}`;
        await seedSkill(org.id, user.id, repo);
        vi.mocked(getRepoInstallationId).mockResolvedValueOnce(instId);

        await createMirrorTask({
          repoFullName: repo,
          installationId: undefined,
          intent: mergedIntent,
        });

        const [owner, name] = repo.split("/");
        expect(getRepoInstallationId).toHaveBeenCalledWith(owner, name);
        const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
        expect(args.organizationId).toBe(org.id);
        expect(args.sourceMetadata).toMatchObject({
          skillName: "github-pr-merged",
        });
      });

      it("a repo without the skill stays a skip, as before", async () => {
        const { instId } = await seedBoundOrg("active");
        vi.mocked(getRepoInstallationId).mockResolvedValueOnce(instId);

        await expect(
          createMirrorTask({
            repoFullName,
            installationId: undefined,
            intent: mergedIntent,
          }),
        ).rejects.toMatchObject({ category: "unconfigured_repo" });
        expect(newThreadInternal).not.toHaveBeenCalled();
      });

      it("an App that is not installed on the repo stays unmapped", async () => {
        vi.mocked(getRepoInstallationId).mockResolvedValueOnce(null);
        await expect(
          createMirrorTask({
            repoFullName,
            installationId: undefined,
            intent: mergedIntent,
          }),
        ).rejects.toMatchObject({ category: "unmapped_installation" });
      });

      it("a failed lookup fails the delivery instead of skipping it", async () => {
        vi.mocked(getRepoInstallationId).mockRejectedValueOnce(
          new Error("GitHub 503"),
        );
        const error = await createMirrorTask({
          repoFullName,
          installationId: undefined,
          intent: mergedIntent,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(findWebhookSkip(error)).toBeNull();
        expect(newThreadInternal).not.toHaveBeenCalled();
      });

      it("the other mirror rows are not revived", async () => {
        await expect(
          createMirrorTask({
            repoFullName,
            installationId: undefined,
            intent: { kind: "pr-review-requested", prNumber: 7 },
          }),
        ).rejects.toMatchObject({ category: "unmapped_installation" });
        expect(getRepoInstallationId).not.toHaveBeenCalled();
      });
    });

    it("a repo WITHOUT the skill keeps the legacy prompt and no stamp", async () => {
      const { user, org, instId } = await seedBoundOrg("active");
      // Same org, skill pushed for a DIFFERENT repo: opt-in is per repo.
      await seedSkill(
        org.id,
        user.id,
        `acme-inc/other-${nanoid(6).toLowerCase()}`,
      );

      await createMirrorTask({
        repoFullName,
        installationId: instId,
        intent: mergedIntent,
      });

      const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
      const text = args.message.parts.map((p: any) => p.text ?? "").join("");
      expect(text).toContain("was merged");
      expect(text).not.toContain("## Trigger");
      expect(args.sourceMetadata).toBeUndefined();
      expect(resolveTrackerConfig).not.toHaveBeenCalled();
    });

    it("a tracker failure at intake never loses the task", async () => {
      const { user, org, instId } = await seedBoundOrg("active");
      const repo = `acme-inc/core-${nanoid(6).toLowerCase()}`;
      await seedSkill(org.id, user.id, repo);
      vi.mocked(resolveTrackerConfig).mockRejectedValueOnce(
        new Error("tracker base URL must use https"),
      );

      await createMirrorTask({
        repoFullName: repo,
        installationId: instId,
        intent: mergedIntent,
      });

      expect(newThreadInternal).toHaveBeenCalledTimes(1);
      const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
      const text = args.message.parts.map((p: any) => p.text ?? "").join("");
      expect(text).toContain("Tracker unavailable");
      expect(args.sourceMetadata?.type).toBe("automation-skill");
    });

    it("shadow installation: stamped task, but the tracker is never contacted", async () => {
      const { user, org, instId } = await seedBoundOrg("shadow");
      const repo = `acme-inc/core-${nanoid(6).toLowerCase()}`;
      await seedSkill(org.id, user.id, repo);

      await createMirrorTask({
        repoFullName: repo,
        installationId: instId,
        intent: mergedIntent,
      });

      const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
      expect(args.shadow).toBe(true);
      expect(resolveTrackerConfig).not.toHaveBeenCalled();
      const text = args.message.parts.map((p: any) => p.text ?? "").join("");
      expect(text).toContain("shadow mode");
    });

    it("other mirror intents never resolve the merged-PR skill", async () => {
      const { user, org, instId } = await seedBoundOrg("active");
      const repo = `acme-inc/core-${nanoid(6).toLowerCase()}`;
      await seedSkill(org.id, user.id, repo);

      await createMirrorTask({
        repoFullName: repo,
        installationId: instId,
        intent: {
          kind: "pr-review-requested",
          prNumber: 7,
          baseBranch: "main",
        },
      });

      const args = vi.mocked(newThreadInternal).mock.calls[0]![0];
      expect(args.sourceMetadata).toBeUndefined();
      const text = args.message.parts.map((p: any) => p.text ?? "").join("");
      expect(text).toContain("Review requested on PR #7");
    });
  });
});
