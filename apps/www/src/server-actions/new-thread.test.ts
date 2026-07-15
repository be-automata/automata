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
  });
});
