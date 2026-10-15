import { describe, it, vi, beforeEach, expect } from "vitest";
import { newThread } from "./new-thread";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, Session, DBUserMessage } from "@terragon/shared";
import {
  mockLoggedInUser,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";
import { getThread } from "@terragon/shared/model/threads";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import { session as sessionTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { unwrapResult } from "@/lib/server-actions";

const repoFullName = "terragon/test-repo";
const mockMessage: DBUserMessage = {
  type: "user",
  parts: [{ type: "text", text: "Test task message" }],
  model: "sonnet",
};

describe("newThread", () => {
  let user: User;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;
    session = testUserResult.session;
  });

  describe("createNewBranch parameter behavior", () => {
    it("should create thread with baseBranchName when createNewBranch=true", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "develop",
        createNewBranch: true,
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("develop");
      expect(thread!.branchName).toBeNull();
    });

    it("should create thread with headBranchName when createNewBranch=false", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "feature/test-branch",
        createNewBranch: false,
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("DEFAULT_BRANCH_NAME_FOR_TESTS");
      expect(thread!.branchName).toBe("feature/test-branch");
    });

    it("should default to createNewBranch=true when not specified", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.repoBaseBranchName).toBe("main");
      expect(thread!.branchName).toBeNull();
    });
  });

  describe("organization tenant scoping (WI-5)", () => {
    it("stamps the creator's active organization onto the created thread", async () => {
      // Give the user an active org, mirroring session.activeOrganizationId set
      // by the Better Auth organization plugin after selecting an org.
      const org = await createOrganization({
        db,
        name: "Acme",
        slug: `acme-${nanoid(8).toLowerCase()}`,
      });
      await addOrganizationMember({
        db,
        organizationId: org.id,
        userId: user.id,
        role: "owner",
      });
      await db
        .update(sessionTable)
        .set({ activeOrganizationId: org.id })
        .where(eq(sessionTable.id, session.id));

      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.organizationId).toBe(org.id);
    });

    it("creates a thread without an org when the session has no active org", async () => {
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const result = await newThread({
        message: mockMessage,
        githubRepoFullName: repoFullName,
        branchName: "main",
      });
      const { threadId } = unwrapResult(result);
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread).toBeDefined();
      expect(thread!.organizationId).toBeNull();
    });

    it("drops the session's org once the creator is no longer a member", async () => {
      const org = await createOrganization({
        db,
        name: "Former",
        slug: `former-${nanoid(8).toLowerCase()}`,
      });
      // Active org on the session, but no membership row backs it.
      await db
        .update(sessionTable)
        .set({ activeOrganizationId: org.id })
        .where(eq(sessionTable.id, session.id));
      await mockWaitUntil();
      await mockLoggedInUser(session);

      const { threadId } = unwrapResult(
        await newThread({
          message: mockMessage,
          githubRepoFullName: repoFullName,
          branchName: "main",
        }),
      );
      await waitUntilResolved();

      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread!.organizationId).toBeNull();
    });
  });

  describe("the org the page showed and the org's repo scope", () => {
    let orgId: string;

    beforeEach(async () => {
      const org = await createOrganization({
        db,
        name: "Scoped",
        slug: `scoped-${nanoid(8).toLowerCase()}`,
      });
      orgId = org.id;
      await addOrganizationMember({
        db,
        organizationId: orgId,
        userId: user.id,
        role: "member",
      });
      await db
        .update(sessionTable)
        .set({ activeOrganizationId: orgId })
        .where(eq(sessionTable.id, session.id));
      await mockWaitUntil();
      await mockLoggedInUser(session);
    });

    function uniqueInstallationId() {
      return String(Math.floor(Math.random() * 1_000_000_000));
    }

    async function create(
      githubRepoFullName: string,
      expectedOrganizationId?: string | null,
    ) {
      return await newThread({
        message: mockMessage,
        githubRepoFullName,
        branchName: "main",
        expectedOrganizationId,
      });
    }

    it("refuses when the session moved off the org the page showed", async () => {
      const result = await create(repoFullName, "org_the_page_showed");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/active organization changed/);
    });

    it("refuses an expected 'no org' while the session has one", async () => {
      const result = await create(repoFullName, null);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/active organization changed/);
    });

    it("creates the task when the page showed the active org", async () => {
      const { threadId } = unwrapResult(await create(repoFullName, orgId));
      await waitUntilResolved();
      const thread = await getThread({ db, userId: user.id, threadId });
      expect(thread!.organizationId).toBe(orgId);
    });

    it("allows any repo while the org has no bound installation", async () => {
      unwrapResult(await create("someone/else-repo", orgId));
      await waitUntilResolved();
    });

    it("allows a repo whose owner's installation is bound to the org (login case-insensitive)", async () => {
      await bindGithubInstallationToOrg({
        db,
        installationId: uniqueInstallationId(),
        organizationId: orgId,
        accountLogin: "Terragon",
        accountType: "Organization",
      });
      unwrapResult(await create(repoFullName, orgId));
      await waitUntilResolved();
    });

    it("refuses a repo whose owner is not bound to the org", async () => {
      await bindGithubInstallationToOrg({
        db,
        installationId: uniqueInstallationId(),
        organizationId: orgId,
        accountLogin: "acme",
        accountType: "Organization",
      });
      const result = await create(repoFullName, orgId);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(
        /terragon\/test-repo is not in this organization's repositories/,
      );
    });

    it("refuses a repo whose owner's installation is bound to another org", async () => {
      const other = await createOrganization({
        db,
        name: "Other",
        slug: `other-${nanoid(8).toLowerCase()}`,
      });
      await bindGithubInstallationToOrg({
        db,
        installationId: uniqueInstallationId(),
        organizationId: orgId,
        accountLogin: "acme",
        accountType: "Organization",
      });
      await bindGithubInstallationToOrg({
        db,
        installationId: uniqueInstallationId(),
        organizationId: other.id,
        accountLogin: "terragon",
        accountType: "Organization",
      });
      const result = await create(repoFullName, orgId);
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/not in this organization/);
    });

    it("allows (and logs) a repo it cannot map when a bound row has no accountLogin", async () => {
      const warn = vi.spyOn(console, "warn");
      await bindGithubInstallationToOrg({
        db,
        installationId: uniqueInstallationId(),
        organizationId: orgId,
        accountLogin: "acme",
      });
      await bindGithubInstallationToOrg({
        db,
        installationId: uniqueInstallationId(),
        organizationId: orgId,
      });
      unwrapResult(await create(repoFullName, orgId));
      await waitUntilResolved();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/could not map/),
        expect.objectContaining({ organizationId: orgId }),
      );
      warn.mockRestore();
    });
  });
});
