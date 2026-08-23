import { db } from "@/lib/db";
import { DB } from "@terragon/shared/db";
import { AIAgent, AIModel } from "@terragon/agent/types";
import {
  getThreadMinimal,
  updateThread,
  getThreadChat,
  claimBrokeredSandboxRecreate,
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
  shutdownSandboxById,
  BrokeredSandboxNotResumableError,
} from "@terragon/sandbox";
import { resolveCredentialBrokerForCreate } from "@/server-lib/credential-broker/resolve-credential-broker";
import { shouldHibernateSandbox } from "./sandbox-resource";
import { wrapError } from "./error";
import { getPostHogServer } from "@/lib/posthog-server";
import { trackSandboxCreation } from "@/lib/rate-limit";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { resolveEgressPolicy } from "@/server-lib/egress/resolve-egress-policy";
import { generateBranchName } from "@/server-lib/generate-branch-name";
import { sandboxTimeoutMs } from "@terragon/sandbox/constants";
import { getAndVerifyCredentials } from "./credentials";
import { DEFAULT_SANDBOX_SIZE } from "@/lib/subscription-tiers";
import type { UserSettings } from "@terragon/shared";
import { ensureAgent } from "@terragon/agent/utils";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";

// #114: distinguishable timeout so a CREATE caller can tell a non-cancelling
// timeout (the underlying create/setup promise is abandoned mid-flight, still
// possibly holding a guest + broker sidecar) apart from a create/setup throw
// (the source-level teardown in @terragon/sandbox already swept the guest).
class SandboxCreationTimeoutError extends Error {
  constructor() {
    super("Sandbox creation timed out. Please try again later.");
    this.name = "SandboxCreationTimeoutError";
  }
}

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
    throw new SandboxCreationTimeoutError();
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

  const statusUpdateHandler: CreateSandboxOptions["onStatusUpdate"] = async ({
    sandboxId,
    sandboxStatus,
    bootingStatus,
  }) => {
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
    await onStatusUpdate({ sandboxId, sandboxStatus, bootingStatus });
  };

  // #114: build the per-run broker SHAPE for any CREATE (initial or the
  // fail-closed resume recreate). Docker + flag on only. The `mode` is the
  // NON-secret provenance persisted on the thread; the shape (secret) is never
  // persisted. Also carry the persisted mode on resume so the provider can fail
  // closed on a stale brokered guest without the secret.
  const brokerCreate = resolveCredentialBrokerForCreate({
    sandboxProvider: thread.sandboxProvider,
    githubRepoFullName: thread.githubRepoFullName,
    githubAccessToken,
  });
  const persistedBrokerMode = thread.credentialBrokerMode ?? undefined;

  // #66: resolve the per-repo egress SHAPE only when we CREATE (providers apply
  // it at create time). Recomputed on the recreate path too.
  const resolveEgressForCreate = async () =>
    (await resolveEgressPolicy({
      db,
      organizationId: thread.organizationId,
      repoFullName: thread.githubRepoFullName,
      plane: "sandbox",
    })) ?? undefined;

  const makeOptions = (args: {
    forCreate: boolean;
    egressPolicy: Awaited<ReturnType<typeof resolveEgressForCreate>>;
  }): CreateSandboxOptions => ({
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
    fastResume: fastResume && !args.forCreate,
    publicUrl: nonLocalhostPublicAppUrl(),
    egressPolicy: args.forCreate ? args.egressPolicy : undefined,
    // Secret shape only on CREATE; NON-secret mode on both so a brokered resume
    // fails closed at the provider.
    credentialBroker: args.forCreate ? (brokerCreate?.shape ?? undefined) : undefined,
    credentialBrokerMode: args.forCreate
      ? (brokerCreate?.mode ?? undefined)
      : persistedBrokerMode,
    featureFlags: userFeatureFlags,
    generateBranchName: generateBranchNameWithPrefix,
    onStatusUpdate: statusUpdateHandler,
  });

  const persistCreated = async (sandboxId: string) => {
    await updateThread({
      db,
      userId,
      threadId,
      updates: {
        codesandboxId: sandboxId,
        sandboxSize,
        // #114 (LOW): record the NON-secret provenance ONLY when actually
        // brokering, so a later resume fails closed. When brokering is off /
        // provider ≠ docker, leave the column NULL — flag-off is then
        // byte-identical to pre-#114 behavior (no "legacy-direct" written).
        credentialBrokerMode: brokerCreate ? brokerCreate.mode : null,
      },
    });
  };

  // #114: run a CREATE (never a resume) under the non-cancelling timeout and
  // guarantee no orphaned guest/broker-sidecar/network/secret on failure.
  //
  // Two failure classes:
  //  - create/setup THROW: @terragon/sandbox's getOrCreateSandbox tears the
  //    fresh guest down at the source (provider create-phase try/catch + the
  //    setup-phase teardown) before rethrowing, so nothing orphans and this
  //    layer must NOT re-destroy (the id may already be gone).
  //  - TIMEOUT: the underlying promise is abandoned mid-flight and is NOT
  //    cancellable, so the source teardown cannot run for it. We capture the
  //    fresh sandbox id from the provider's `provisioning-done` status update
  //    (emitted right after the guest + sidecar are up, before setup) and
  //    force-destroy that id here — sidecar + network + secret file included.
  //
  // If the timeout fires BEFORE the provider publishes an id (still inside the
  // initial `docker run`), the id is unknowable at this layer and the abandoned
  // create is not cancellable, so it cannot be swept by id from here. Such a
  // guest carries a fresh per-create nanoid name (no collision with a retry, so
  // a re-attempt never adopts or double-creates it) and is reclaimed by the
  // provider's prefix-scoped container/network sweep, not this path.
  const createSandboxSweepingOnTimeout = async (
    egressPolicy: Awaited<ReturnType<typeof resolveEgressForCreate>>,
  ): Promise<ISandboxSession> => {
    const options = makeOptions({ forCreate: true, egressPolicy });
    let createdSandboxId: string | null = null;
    const capturingOptions: CreateSandboxOptions = {
      ...options,
      onStatusUpdate: async (update) => {
        if (update.sandboxId) {
          createdSandboxId = update.sandboxId;
        }
        await options.onStatusUpdate(update);
      },
    };
    try {
      return await getOrCreateSandboxWithTimeout(null, capturingOptions);
    } catch (error) {
      // Only the timeout needs compensation here: create/setup throws are
      // already swept at the source. Destroying on a non-timeout throw would
      // double-destroy an already-removed guest (docker rm -f then errors).
      if (error instanceof SandboxCreationTimeoutError && createdSandboxId) {
        await shutdownSandboxById({
          sandboxProvider: thread.sandboxProvider,
          sandboxId: createdSandboxId,
        }).catch((teardownError) => {
          console.error(
            "Failed to sweep fresh sandbox after create timeout",
            teardownError,
          );
        });
      }
      throw error;
    }
  };

  // #114 fail-closed recreate: a brokered thread is NEVER resumed in place, so
  // a resume must destroy the stale sandbox and create a fresh brokered one. A
  // CAS lease ensures exactly ONE concurrent resume wins the recreate; losers
  // do NOT reconnect to the winner's fresh brokered sandbox (that would re-run
  // the raw-token resume setup) and do NOT destroy it (the winner is using it)
  // — they ask the caller to retry, converging once the winner has published.
  const recreateBrokeredSandbox = async (
    staleSandboxId: string,
  ): Promise<ISandboxSession> => {
    const claim = await claimBrokeredSandboxRecreate({
      db,
      userId,
      threadId,
      expectedSandboxId: staleSandboxId,
    });
    if (!claim.claimed) {
      // Loser: the winner cleared codesandboxId and is recreating. Never
      // reconnect (re-leak) or destroy (the winner owns it) — retry instead.
      throw new Error(
        "Brokered sandbox recreate in progress; please retry the request.",
      );
    }
    // Winner. The CAS already cleared codesandboxId (recoverable NULL state: a
    // failure below leaves the thread able to CREATE fresh on the next resume).
    // Destroy the stale sandbox (+ its sidecar/network/secret file) WITHOUT
    // unpausing it. If that destroy FAILS we must NOT proceed to create a
    // second guest (that orphans the stale one whose id we just cleared):
    // restore the stale id so a later resume can retry the recreate, then fail
    // the run loudly instead of silently swallowing the error.
    try {
      await shutdownSandboxById({
        sandboxProvider: thread.sandboxProvider,
        sandboxId: staleSandboxId,
      });
    } catch (destroyError) {
      console.error("Failed to destroy stale brokered sandbox", destroyError);
      await updateThread({
        db,
        userId,
        threadId,
        updates: { codesandboxId: staleSandboxId },
      }).catch((restoreError) => {
        console.error(
          "Failed to restore stale brokered sandbox id after destroy failure",
          restoreError,
        );
      });
      throw new Error(
        `Failed to destroy stale brokered sandbox ${staleSandboxId} during recreate: ${
          destroyError instanceof Error
            ? destroyError.message
            : String(destroyError)
        }`,
        { cause: destroyError },
      );
    }
    // Create the fresh brokered sandbox. On a create/setup THROW the source
    // teardown in @terragon/sandbox sweeps the guest + broker sidecar/network/
    // secret; on a non-cancelling TIMEOUT createSandboxSweepingOnTimeout
    // force-destroys the freshly-created id. Either way codesandboxId stays NULL
    // (recoverable). On a persist failure the guest exists but is untracked —
    // tear it down so nothing (including the token-holding sidecar) is orphaned.
    const egressPolicy = await resolveEgressForCreate();
    const session = await createSandboxSweepingOnTimeout(egressPolicy);
    try {
      await persistCreated(session.sandboxId);
    } catch (persistError) {
      await shutdownSandboxById({
        sandboxProvider: thread.sandboxProvider,
        sandboxId: session.sandboxId,
      }).catch((teardownError) => {
        console.error(
          "Failed to tear down fresh brokered sandbox after persist failure",
          teardownError,
        );
      });
      throw persistError;
    }
    return session;
  };

  // Initial call: CREATE when no sandbox yet, else RESUME the existing one.
  // The first create can also be brokered (Docker + flag on), so it runs through
  // the same timeout-sweeping create path — no orphaned broker sidecar on a
  // create/setup failure (swept at the source) or a non-cancelling timeout.
  if (!thread.codesandboxId) {
    const egressPolicy = await resolveEgressForCreate();
    const session = await createSandboxSweepingOnTimeout(egressPolicy);
    // #114: on a persist failure the freshly-created guest exists but is
    // untracked (its id was never written) — tear it down (guest + broker
    // sidecar/network/secret) so nothing (including the token-holding sidecar)
    // is orphaned, mirroring recreateBrokeredSandbox's persist-failure
    // compensation above. A create/setup throw or non-cancelling timeout is
    // already swept before we reach here, so this only compensates the persist.
    try {
      await persistCreated(session.sandboxId);
    } catch (persistError) {
      await shutdownSandboxById({
        sandboxProvider: thread.sandboxProvider,
        sandboxId: session.sandboxId,
      }).catch((teardownError) => {
        console.error(
          "Failed to tear down fresh sandbox after initial-create persist failure",
          teardownError,
        );
      });
      throw persistError;
    }
    return session;
  }

  const existingSandboxId = thread.codesandboxId;

  // #114 CRITICAL: a brokered thread is NEVER resumed in place — running OR
  // paused. An in-place resume runs setupSandboxEveryTime → setupGitCredentials
  // WITHOUT the create-only broker shape, so it takes the legacy branch and
  // writes the raw installation token to ~/.git-credentials (and can restart
  // the daemon with it), re-leaking the token the broker exists to withhold. So
  // refuse BEFORE any resume setup / cred write / daemon restart / unpause and
  // route to the fail-closed CAS recreate. This is decided HERE (control plane)
  // by the NON-secret persisted provenance; the provider fails closed too
  // (defense in depth). Legacy threads (mode null/undefined) are unaffected and
  // take the normal in-place resume below.
  if (persistedBrokerMode === "brokered") {
    return await recreateBrokeredSandbox(existingSandboxId);
  }

  try {
    return await getOrCreateSandboxWithTimeout(
      existingSandboxId,
      makeOptions({ forCreate: false, egressPolicy: undefined }),
    );
  } catch (error) {
    // Defense in depth: if a provider still signals a brokered sandbox as
    // non-resumable (e.g. provenance drift), converge on the same fail-closed
    // recreate rather than surfacing a raw resume error.
    if (!(error instanceof BrokeredSandboxNotResumableError)) {
      throw error;
    }
    return await recreateBrokeredSandbox(existingSandboxId);
  }
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
