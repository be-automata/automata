import { db } from "@/lib/db";
import { DB } from "@terragon/shared/db";
import { AIAgent, AIModel } from "@terragon/agent/types";
import {
  getThreadMinimal,
  updateThread,
  getThreadChat,
} from "@terragon/shared/model/threads";
import { getUser, getUserSettings } from "@terragon/shared/model/user";
import { getGitHubTokenForBackground } from "@/lib/github";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import {
  getOrCreateEnvironment,
  getDecryptedEnvironmentVariables,
  getDecryptedMcpConfig,
  getDecryptedGlobalEnvironmentVariables,
} from "@terragon/shared/model/environments";
import { env } from "@terragon/env/apps-www";
import type {
  CreateSandboxOptions,
  ISandboxSession,
} from "@terragon/sandbox/types";
import type { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import {
  getOrCreateSandbox as getOrCreateSandboxInternal,
  hibernateSandbox as hibernateSandboxInternal,
} from "@terragon/sandbox";
import { shouldHibernateSandbox } from "./sandbox-resource";
import { wrapError } from "./error";
import { getPostHogServer } from "@/lib/posthog-server";
import { trackSandboxCreation } from "@/lib/rate-limit";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { generateBranchName } from "@/server-lib/generate-branch-name";
import { sandboxTimeoutMs } from "@terragon/sandbox/constants";
import { getAndVerifyCredentials } from "./credentials";
import { DEFAULT_SANDBOX_SIZE } from "@/lib/subscription-tiers";
import type { UserSettings } from "@terragon/shared";
import { ensureAgent } from "@terragon/agent/utils";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";

async function getOrCreateSandboxWithTimeout(
  sandboxId: string | null,
  options: Parameters<typeof getOrCreateSandbox>[1],
) {
  const result = await Promise.race([
    getOrCreateSandbox(sandboxId, options),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, sandboxTimeoutMs),
    ),
  ]);
  if (result === "timeout") {
    throw new Error("Sandbox creation timed out. Please try again later.");
  }
  return result;
}

export async function getSandboxForThreadOrNull({
  db,
  threadId,
  threadChatIdOrNull,
  userId,
  createNewBranch = true,
  branchName,
  fastResume = false,
  onStatusUpdate,
}: {
  db: DB;
  threadId: string;
  threadChatIdOrNull: string | null;
  userId: string;
  createNewBranch?: boolean;
  branchName?: string;
  fastResume?: boolean;
  onStatusUpdate: CreateSandboxOptions["onStatusUpdate"];
}): Promise<ISandboxSession | null> {
  const thread = await getThreadMinimal({ db, threadId, userId });
  if (!thread?.codesandboxId) {
    return null;
  }
  try {
    return await getOrCreateSandboxForThread({
      db,
      threadId,
      threadChatIdOrNull,
      userId,
      createNewBranch,
      branchName,
      fastResume,
      onStatusUpdate,
    });
  } catch (error) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "sandbox_resume_failed",
      properties: {
        threadId,
        sandboxId: thread.codesandboxId,
        sandboxProvider: thread.sandboxProvider,
        githubRepoFullName: thread.githubRepoFullName,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
      },
    });
    throw wrapError("sandbox-resume-failed", error);
  }
}

async function getOrCreateSandboxForThread({
  db,
  threadId,
  threadChatIdOrNull,
  userId,
  onStatusUpdate,
  createNewBranch = true,
  branchName,
  fastResume = false,
}: {
  db: DB;
  threadId: string;
  threadChatIdOrNull: string | null;
  userId: string;
  createNewBranch?: boolean;
  branchName?: string;
  fastResume?: boolean;
  onStatusUpdate: CreateSandboxOptions["onStatusUpdate"];
}): Promise<ISandboxSession> {
  const [user, thread] = await Promise.all([
    getUser({ db, userId }),
    getThreadMinimal({ db, threadId, userId }),
  ]);
  if (!user) {
    throw new Error("User not found");
  }
  if (!thread) {
    throw new Error("Thread not found");
  }
  let agentOrNull: AIAgent | null = null;
  let modelOrNull: AIModel | null = null;
  if (threadChatIdOrNull) {
    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId: threadChatIdOrNull,
      userId,
    });
    if (threadChat) {
      agentOrNull = ensureAgent(threadChat.agent);
      modelOrNull = getLastUserMessageModel(threadChat.messages ?? []);
    }
  }
  const [
    userFeatureFlags,
    userSettings,
    agentCredentialsOrNull,
    repositoryEnvironment,
  ] = await Promise.all([
    getFeatureFlagsForUser({ db, userId }),
    getUserSettings({ db, userId }),
    (async () => {
      return agentOrNull
        ? await getAndVerifyCredentials({
            agent: agentOrNull,
            model: modelOrNull,
            userId,
            organizationId: thread.organizationId,
          })
        : null;
    })(),
    // Fetch the environment to get environment variables (org-scoped)
    getOrCreateEnvironment({
      db,
      userId,
      organizationId: thread.organizationId,
      repoFullName: thread.githubRepoFullName,
    }),
  ]);
  const [
    repositoryEnvironmentVariables,
    globalEnvironmentVariables,
    mcpConfig,
    githubAccessToken,
  ] = await Promise.all([
    getDecryptedEnvironmentVariables({
      db,
      userId,
      environmentId: repositoryEnvironment.id,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    getDecryptedGlobalEnvironmentVariables({
      db,
      userId,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    getDecryptedMcpConfig({
      db,
      userId,
      environmentId: repositoryEnvironment.id,
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    }),
    // Background-capable: falls back to the App installation token for the
    // thread's repo when the owner has no GitHub identity (git clone uses it as
    // x-access-token). This is the sandbox boot path (getOrCreateSandboxForThread).
    getGitHubTokenForBackground({
      userId,
      repoFullName: thread.githubRepoFullName,
    }),
  ]);

  // Merge global and environment-specific variables
  // Environment-specific variables take precedence over global ones
  const mergedEnvironmentVariables = [
    ...globalEnvironmentVariables,
    ...repositoryEnvironmentVariables,
  ].reduce(
    (acc, variable) => {
      acc[variable.key] = variable.value;
      return acc;
    },
    {} as Record<string, string>,
  );
  const finalEnvironmentVariables = Object.entries(
    mergedEnvironmentVariables,
  ).map(([key, value]) => ({ key, value }));
  const branchPrefix = userSettings.branchNamePrefix;
  const generateBranchNameWithPrefix = (threadName: string | null) =>
    generateBranchName(threadName, branchPrefix);
  const sandboxSize = thread.sandboxSize ?? DEFAULT_SANDBOX_SIZE;
  const startTime = Date.now();
  const session = await getOrCreateSandboxWithTimeout(thread.codesandboxId, {
    threadName: thread.name,
    agent: agentOrNull,
    agentCredentials: agentCredentialsOrNull,
    userName: user.name,
    userEmail: user.email,
    githubAccessToken,
    githubRepoFullName: thread.githubRepoFullName,
    repoBaseBranchName: thread.repoBaseBranchName,
    userId,
    sandboxProvider: thread.sandboxProvider,
    sandboxSize,
    environmentVariables: finalEnvironmentVariables,
    createNewBranch,
    branchName,
    mcpConfig: mcpConfig || undefined,
    autoUpdateDaemon: !!userFeatureFlags.autoUpdateDaemon,
    customSystemPrompt: userSettings.customSystemPrompt,
    setupScript: repositoryEnvironment.setupScript,
    skipSetupScript: thread.skipSetup,
    fastResume: fastResume && !!thread.codesandboxId,
    publicUrl: nonLocalhostPublicAppUrl(),
    featureFlags: userFeatureFlags,
    generateBranchName: generateBranchNameWithPrefix,
    onStatusUpdate: async ({ sandboxId, sandboxStatus, bootingStatus }) => {
      if (sandboxId && bootingStatus === "provisioning-done") {
        getPostHogServer().capture({
          distinctId: userId,
          event: "sandbox_provisioned",
          properties: {
            threadId,
            sandboxId,
            sandboxProvider: thread.sandboxProvider,
            githubRepoFullName: thread.githubRepoFullName,
            durationMs: Date.now() - startTime,
          },
        });
      }
      await onStatusUpdate({
        sandboxId,
        sandboxStatus,
        bootingStatus,
      });
    },
  });

  if (!thread.codesandboxId) {
    await updateThread({
      db,
      userId,
      threadId,
      updates: {
        codesandboxId: session.sandboxId,
        sandboxSize,
      },
    });
  }
  return session;
}

export async function createSandboxForThread({
  db,
  threadId,
  threadChatIdOrNull,
  userId,
  onStatusUpdate,
  createNewBranch = true,
  branchName,
  fastResume = false,
}: {
  db: DB;
  threadId: string;
  threadChatIdOrNull: string | null;
  userId: string;
  onStatusUpdate: CreateSandboxOptions["onStatusUpdate"];
  createNewBranch?: boolean;
  branchName?: string;
  fastResume?: boolean;
}) {
  try {
    return await getOrCreateSandboxForThread({
      db,
      threadId,
      threadChatIdOrNull,
      userId,
      onStatusUpdate,
      createNewBranch,
      branchName,
      fastResume,
    });
  } catch (error) {
    // Check if this is a setup script failure
    if (
      error instanceof Error &&
      error.message.includes("terragon-setup.sh failed:")
    ) {
      throw wrapError("setup-script-failed", error);
    }
    throw wrapError("sandbox-creation-failed", error);
  }
}

export async function maybeHibernateSandbox({
  userId,
  threadId,
  session,
}: {
  session: ISandboxSession;
  threadId: string;
  userId: string;
}) {
  await maybeHibernateSandboxById({
    userId,
    threadId,
    sandboxId: session.sandboxId,
    sandboxProvider: session.sandboxProvider,
  });
}

export async function maybeHibernateSandboxInternal({
  sandboxId,
  sandboxProvider,
}: {
  sandboxId: string;
  sandboxProvider: SandboxProvider;
}): Promise<boolean> {
  const shouldHibernate = await shouldHibernateSandbox(sandboxId);
  console.log("shouldHibernate", sandboxId, shouldHibernate);
  if (!shouldHibernate) {
    return false;
  }
  await hibernateSandboxInternal({ sandboxProvider, sandboxId });
  return true;
}

export async function maybeHibernateSandboxById({
  userId,
  threadId,
  sandboxId,
  sandboxProvider,
}: {
  userId: string;
  threadId: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
}) {
  const didHibernate = await maybeHibernateSandboxInternal({
    sandboxId,
    sandboxProvider,
  });
  if (didHibernate) {
    await updateThread({
      db,
      userId,
      threadId,
      updates: { sandboxStatus: "paused" },
    });
  }
}

export async function getSandboxProvider({
  userSetting,
  sandboxSize,
  userId,
}: {
  userSetting: UserSettings["sandboxProvider"];
  sandboxSize: SandboxSize;
  userId: string;
}): Promise<SandboxProvider> {
  if (process.env.NODE_ENV === "test") {
    return "mock";
  }

  // Check if user has forceDaytonaSandbox feature flag enabled
  const featureFlags = await getFeatureFlagsForUser({ db, userId });
  if (featureFlags.forceDaytonaSandbox) {
    return "daytona";
  }

  switch (userSetting) {
    case "default":
      // Without an E2B key the remote provider can never work; fall back to
      // the local Docker provider so a SaaS-free install boots and runs.
      return env.E2B_API_KEY ? "e2b" : "docker";
    case "e2b":
      return "e2b";
    case "daytona":
      return "daytona";
    case "docker":
      return "docker";
    case "mock":
      return "mock";
    case "hatchet-remote":
      // ADR-003: a thread pinned to remote dispatch keeps that provider; the local
      // boot path is never taken for it.
      return "hatchet-remote";
    default:
      const _exhaustiveCheck: never = userSetting;
      throw new Error(`Unknown sandbox provider: ${_exhaustiveCheck}`);
  }
}

export async function getOrCreateSandbox(
  sandboxId: string | null,
  options: CreateSandboxOptions,
) {
  if (!sandboxId) {
    await trackSandboxCreation(options.userId);
  }
  const startTime = Date.now();
  try {
    const sandbox = await getOrCreateSandboxInternal(sandboxId, options);
    const duration = Date.now() - startTime;
    // Log sandbox creation or resume time to PostHog
    getPostHogServer().capture({
      distinctId: options.userId,
      event: sandboxId ? "sandbox_resume_time" : "sandbox_creation_time",
      properties: {
        sandboxId: sandbox.sandboxId,
        sandboxProvider: options.sandboxProvider,
        githubRepoFullName: options.githubRepoFullName,
        durationMs: duration,
      },
    });
    return sandbox;
  } catch (error) {
    const duration = Date.now() - startTime;
    // Track sandbox operation failures to PostHog
    getPostHogServer().capture({
      distinctId: options.userId,
      event: sandboxId ? "sandbox_resume_failed" : "sandbox_creation_failed",
      properties: {
        sandboxId: sandboxId || undefined,
        sandboxProvider: options.sandboxProvider,
        githubRepoFullName: options.githubRepoFullName,
        durationMs: duration,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
        isNotFoundError:
          error instanceof Error && error.message.includes("not found"),
      },
    });
    throw error;
  }
}
