import { implement } from "@orpc/server";
import { cliAPIContract } from "@terragon/cli-api-contract";
import { db } from "@/lib/db";
import {
  getThread,
  getThreadMinimal,
  getThreads,
} from "@terragon/shared/model/threads";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { DBUserMessage } from "@terragon/shared";
import type { AIAgent } from "@terragon/agent/types";
import { parseModelOrNull } from "@terragon/agent/utils";
import { isAppInstalledOnRepo } from "@terragon/shared/github-app";
import { getClaudeSessionJSONLOrNull } from "@/server-lib/claude-session";
import { checkCliTaskCreationRateLimit } from "@/lib/rate-limit";
import { ensureAgent } from "@terragon/agent/utils";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { combineThreadStatuses } from "@/agent/thread-status";

const os = implement(cliAPIContract)
  .$context<{
    headers: Headers;
    userId: string;
    // Tenant from the daemon token (WI-5). Nullable during the backfill phase;
    // threaded into the thread fence on the CLI read path.
    organizationId: string | null;
  }>()
  .use(async ({ context, next, errors }) => {
    const headers = (context?.headers || new Headers()) as Headers;
    const tenant = await getDaemonTokenContext({ headers });
    if (!tenant) {
      throw errors.UNAUTHORIZED();
    }
    // ADR-003 F1: a daemon-scoped token (minted for a sandbox/worker agent run)
    // must NOT grant CLI access — threads.list/detail/CREATE + agent-spawn. A
    // compromised execution box holds a daemon token; reject it here so its blast
    // radius stays "one thread's events", not "the whole account's CLI".
    if (tenant.tokenType === "daemon") {
      throw errors.UNAUTHORIZED();
    }
    return next({
      context: {
        headers,
        userId: tenant.userId,
        organizationId: tenant.organizationId,
      },
    });
  });

// Create procedures
const listThreads = os.threads.list.handler(async ({ input, context }) => {
  console.log("cli list threads", {
    userId: context.userId,
    repo: input.repo,
  });
  const threads = await getThreads({
    db,
    userId: context.userId,
    organizationId: context.organizationId,
    limit: 50,
    archived: false,
    githubRepoFullName: input.repo || undefined,
  });

  return threads.map((thread) => {
    return {
      id: thread.id,
      name: thread.name || null,
      branchName: thread.branchName,
      githubRepoFullName: thread.githubRepoFullName,
      githubPRNumber: thread.githubPRNumber,
      updatedAt: thread.updatedAt,
      isUnread: thread.isUnread,
      hasChanges: Boolean(thread.gitDiffStats?.files),
      status: combineThreadStatuses(
        thread.threadChats.map((chat) => chat.status),
      ),
    };
  });
});

const threadDetail = os.threads.detail.handler(
  async ({ input, context, errors }) => {
    console.log("cli thread detail", {
      threadId: input.threadId,
      userId: context.userId,
    });
    const { threadId } = input;
    const thread = await getThread({
      db,
      threadId,
      userId: context.userId,
      organizationId: context.organizationId,
    });
    if (!thread) {
      throw errors.NOT_FOUND({ message: "Thread not found" });
    }
    const threadChat = getPrimaryThreadChat(thread);
    const jsonlOrNull =
      threadChat.agent === "claudeCode"
        ? await getClaudeSessionJSONLOrNull({
            userId: context.userId,
            threadId,
            threadChatId: threadChat.id,
            session: null,
          })
        : null;
    return {
      threadId: thread.id,
      sessionId: threadChat.sessionId,
      name: thread.name,
      branchName: thread.branchName,
      baseBranchName: thread.repoBaseBranchName,
      githubRepoFullName: thread.githubRepoFullName,
      githubPRNumber: thread.githubPRNumber,
      jsonl: jsonlOrNull ?? null,
      agent: ensureAgent(threadChat.agent as AIAgent | null | undefined),
      hasChanges: Boolean(thread.gitDiffStats?.files),
    };
  },
);

const createThread = os.threads.create.handler(
  async ({ input, context, errors }) => {
    console.log("cli create thread", {
      userId: context.userId,
      githubRepoFullName: input.githubRepoFullName,
      repoBaseBranchName: input.repoBaseBranchName,
      createNewBranch: input.createNewBranch,
      mode: input.mode,
      model: input.model,
    });

    // Check rate limit before proceeding
    try {
      await checkCliTaskCreationRateLimit(context.userId);
    } catch (error) {
      throw errors.RATE_LIMIT_EXCEEDED({
        message: error instanceof Error ? error.message : "Rate limit exceeded",
      });
    }

    const {
      message,
      githubRepoFullName,
      repoBaseBranchName = "main",
      createNewBranch = true,
      mode,
      model,
    } = input;

    // Validate GitHub repository format
    const repoParts = githubRepoFullName.split("/");
    if (repoParts.length !== 2) {
      throw errors.INTERNAL_ERROR({
        message: `Invalid repository format: ${githubRepoFullName}. Expected format: owner/repo`,
      });
    }

    const [owner, repo] = repoParts;
    if (!owner || !repo) {
      throw errors.INTERNAL_ERROR({
        message: `Invalid repository format: ${githubRepoFullName}. Expected format: owner/repo`,
      });
    }

    // Check if GitHub App is installed on the repository
    try {
      const isInstalled = await isAppInstalledOnRepo(owner, repo);
      if (!isInstalled) {
        throw errors.INTERNAL_ERROR({
          message: `GitHub App is not installed on repository ${githubRepoFullName}. Please install the Terragon GitHub App on this repository first.`,
        });
      }
    } catch (error) {
      // If the error is already about the app not being installed, re-throw it
      if (error instanceof Error && error.message.includes("not installed")) {
        throw errors.INTERNAL_ERROR({
          message: error.message,
        });
      }
      // Otherwise, the repository might not exist or there's a GitHub API issue
      throw errors.INTERNAL_ERROR({
        message: `Unable to access repository ${githubRepoFullName}. Please ensure the repository exists and you have access to it.`,
      });
    }

    // Exhaustive mapping from CLI mode -> permissionMode used by agent
    const toPermissionMode = (
      m: "plan" | "execute" | undefined,
    ): "allowAll" | "plan" => {
      switch (m) {
        case "plan":
          return "plan";
        case "execute":
        case undefined:
          return "allowAll";
        default: {
          const _exhaustive: never = m as never;
          return _exhaustive;
        }
      }
    };

    // Create the user message
    const userMessage: DBUserMessage = {
      type: "user",
      model: parseModelOrNull({ modelName: model }),
      parts: [{ type: "text", text: message }],
      timestamp: new Date().toISOString(),
      // Exhaustive switch ensures new modes are handled explicitly
      permissionMode: toPermissionMode(mode),
    };

    let baseBranchName = createNewBranch ? repoBaseBranchName : null;
    let headBranchName = createNewBranch ? null : repoBaseBranchName;
    try {
      const { threadId } = await newThreadInternal({
        userId: context.userId,
        organizationId: context.organizationId,
        message: userMessage,
        githubRepoFullName,
        baseBranchName,
        headBranchName,
        sourceType: "cli",
      });
      const thread = await getThreadMinimal({
        db,
        threadId,
        userId: context.userId,
        organizationId: context.organizationId,
      });
      if (!thread) {
        throw errors.INTERNAL_ERROR({ message: "Failed to create thread" });
      }
      return {
        threadId,
        branchName: thread.branchName,
      };
    } catch (error) {
      console.error("Error creating thread:", error);
      const msg =
        error instanceof Error ? error.message : "Failed to create thread";
      if (msg.includes("Task creation limit reached")) {
        throw errors.RATE_LIMIT_EXCEEDED({ message: msg });
      }
      throw errors.INTERNAL_ERROR({ message: msg });
    }
  },
);

// Auth helpers
const whoAmI = os.auth.whoami.handler(async ({ context }) => {
  return { userId: context.userId } as const;
});

// Create the router
export const cliRouter = os.router({
  threads: {
    list: listThreads,
    detail: threadDetail,
    create: createThread,
  },
  auth: {
    whoami: whoAmI,
  },
});
