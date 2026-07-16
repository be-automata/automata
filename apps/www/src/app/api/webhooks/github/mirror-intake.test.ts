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
import { nanoid } from "nanoid";

vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi
    .fn()
    .mockResolvedValue({ threadId: "t", threadChatId: "c" }),
}));

const repoFullName = "somnio-projects/marketplace-monorepo";

function installationId() {
  return Math.floor(Math.random() * 1_000_000_000);
}

async function seedBoundOrg(mode: "shadow" | "active") {
  const { user } = await createTestUser({ db });
  const org = await createOrganization({
    db,
    name: "Somnio Software",
    slug: `somnio-${nanoid(8).toLowerCase()}`,
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

describe("createMirrorTask (Somnio mirror-intake)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shadow-bound: creates a shadow task attributed to the org owner, prompt names the intent", async () => {
    const { user, org, instId } = await seedBoundOrg("shadow");

    await createMirrorTask({
      repoFullName,
      installationId: instId,
      accountLogin: "somnio-projects",
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
        accountLogin: "somnio-projects",
        intent: { kind: "ci-failure", runName: "CI", runId: 5 },
      }),
    ).rejects.toSatisfy((e: unknown) => {
      const skip = findWebhookSkip(e);
      return (
        skip?.category === "unmapped_installation" &&
        skip.detail?.installationId === 999_999_999 &&
        skip.detail?.accountLogin === "somnio-projects"
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
});
