import { vi } from "vitest";
import { createMockNextRequest } from "./mock-next";
import { POST as processThreadQueuePOST } from "@/app/api/internal/process-thread-queue/[userId]/route";
import { POST as processScheduledTaskPOST } from "@/app/api/internal/process-scheduled-task/[userId]/[threadId]/[threadChatId]/route";
import { GET as cronScheduledTasksGET } from "@/app/api/internal/cron/scheduled-tasks/route";
import { env } from "@terragon/env/apps-www";

vi.mock("next/headers", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    cookies: vi.fn(async () => ({
      get: vi.fn(),
    })),
    headers: vi.fn(),
  };
});
// Background work now flows through the local waitUntil shim (@/lib/wait-until),
// so that is the seam tests mock/drain — see mockWaitUntil/waitUntilResolved.
vi.mock("@/lib/wait-until", () => ({
  waitUntil: vi.fn(),
  // No-op: the promise passed to it is already executing (its own chain runs to
  // completion in the microtask queue), so background work still happens — tests
  // that assert on it drain via vi.waitFor on the observable effect.
  waitUntilOutlivesRequest: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    cache: (fn: any) => fn,
  };
});
vi.mock("@/lib/github", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    ensureBranchExists: vi.fn().mockResolvedValue(undefined),
    updateGitHubPR: vi.fn(),
    getOctokitForApp: vi.fn(),
    getOctokitForUser: vi.fn(),
    getOctokitForBackground: vi.fn(),
    getIsPRAuthor: vi.fn(),
    getIsIssueAuthor: vi.fn(),
    getPRAuthorGitHubUsername: vi.fn(),
    getIssueAuthorGitHubUsername: vi.fn(),
    getDefaultBranchForRepo: vi
      .fn()
      .mockResolvedValue("DEFAULT_BRANCH_NAME_FOR_TESTS"),
    findAndAssociatePR: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("@/agent/daemon", () => ({
  sendDaemonMessage: vi.fn(),
}));
vi.mock("@/agent/pull-request", () => ({
  openPullRequestForThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/server-lib/claude-session-internal", () => {
  return {
    getRawJSONLOrNullFromSandbox: vi.fn().mockResolvedValue({
      sessionId: "test-session-id",
      contents: "[]",
    }),
  };
});
// Mock for internalPOST with the ability to call underlying routes
vi.mock("@/server-lib/internal-request", () => ({
  internalPOST: vi.fn().mockImplementation(async (path: string) => {
    console.log("internalPOST", path);
    if (path.startsWith("process-thread-queue/")) {
      const userId = path.split("/")[1];
      if (!userId) {
        throw new Error(`Invalid userId in path: ${path}`);
      }
      return processThreadQueuePOST(
        await createMockNextRequest(
          {},
          {
            "Content-Type": "application/json",
            "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
          },
        ),
        { params: Promise.resolve({ userId }) },
      );
    }
    if (path.startsWith("cron/scheduled-tasks")) {
      return cronScheduledTasksGET(
        await createMockNextRequest(
          {},
          {
            "Content-Type": "application/json",
            "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
          },
        ),
      );
    }
    if (path.startsWith("process-scheduled-task/")) {
      const [_, userId, threadId, threadChatId] = path.split("/");
      return processScheduledTaskPOST(
        await createMockNextRequest(
          {},
          {
            "Content-Type": "application/json",
            "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
          },
        ),
        {
          params: Promise.resolve({
            userId: userId!,
            threadId: threadId!,
            threadChatId: threadChatId!,
          }),
        },
      );
    }
    throw new Error(`Unhandled internalPOST path: ${path}`);
  }),
}));
vi.mock("@/server-lib/generate-thread-name", () => ({
  generateThreadName: vi.fn().mockResolvedValue("test-thread-name"),
}));
vi.mock("@/server-lib/generate-session-summary", () => ({
  generateSessionSummary: vi.fn().mockResolvedValue("test-summary"),
}));
vi.mock("@terragon/shared/github-app", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("mock-github-token"),
  getSandboxGithubToken: vi.fn().mockResolvedValue("mock-github-token"),
}));
vi.mock("@terragon/sandbox", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    hibernateSandbox: vi.fn().mockResolvedValue(undefined),
    getOrCreateSandbox: vi.fn(async (sandboxId: string | null) => {
      const mockSession = await actual.getSandboxOrNull({
        sandboxProvider: "mock",
        sandboxId: sandboxId ?? "mock-sandbox-id",
      });
      return mockSession!;
    }),
  };
});
vi.mock("@terragon/sandbox/commands", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  const mockGitDiff = `
diff --git a/test.txt b/test.txt
index 1234567..89abcdef 100644
--- a/test.txt
+++ b/test.txt
@@ -1 +1 @@
-Hello, world!
+Hello, world!
`;
  return {
    ...actual,
    getGitDiffMaybeCutoff: vi.fn().mockResolvedValue(mockGitDiff),
    gitDiffStats: vi.fn().mockResolvedValue({
      files: 1,
      additions: 1,
      deletions: 0,
    }),
    gitPullUpstream: vi.fn().mockResolvedValue(undefined),
    gitCommitAndPushBranch: vi.fn().mockResolvedValue({
      branchName: "terragon/test-branch",
    }),
  };
});
vi.mock("@terragon/shared/github-app", () => ({
  getInstallationToken: vi.fn().mockResolvedValue("mock-github-token"),
  getSandboxGithubToken: vi.fn().mockResolvedValue("mock-github-token"),
}));
vi.mock("@/server-lib/claude-session.ts", () => ({
  maybeSaveClaudeSessionToR2: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("stripe", () => {
  class MockStripeCardError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  }
  const StripeMock = vi.fn().mockImplementation(() => ({
    invoices: {
      create: vi.fn(),
      finalizeInvoice: vi.fn(),
      pay: vi.fn(),
    },
    customers: {
      create: vi.fn().mockResolvedValue({ id: "mock-customer-id" }),
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "cs_test_123",
          url: "https://stripe.test/session/cs_test_123",
        }),
      },
    },
    invoiceItems: {
      create: vi.fn(),
    },
  }));
  // @ts-expect-error - StripeMock is a mock object
  StripeMock.errors = {
    StripeCardError: MockStripeCardError,
  };
  return { default: StripeMock };
});
