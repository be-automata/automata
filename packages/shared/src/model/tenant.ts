import { DB } from "../db";
import {
  ThreadInsert,
  ThreadChatInsert,
  Environment,
  ThreadVisibility,
} from "../db/types";
import {
  getThread,
  getThreads,
  getThreadMinimal,
  getThreadChat,
  createThread,
  updateThread,
  updateThreadChat,
  deleteThreadById,
} from "./threads";
import {
  getEnvironments,
  getEnvironment,
  getOrCreateEnvironment,
  getOrCreateGlobalEnvironment,
  updateEnvironment,
  deleteEnvironmentById,
  getEnvironmentForUserRepo,
} from "./environments";
import { updateThreadVisibility } from "./thread-visibility";
import { getThreadForGithubPRAndUser } from "./github";
import {
  getAutomation,
  getAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
} from "./automations";
import { AccessTier, Automation, AutomationInsert } from "../db/types";

/**
 * Tenant-scoped repository accessor (ADR-001, WI-5 step 3).
 *
 * `forTenant({ db, organizationId, userId })` binds a tenant context and returns
 * the thread model surface with the org fence applied on every call. This is the
 * single seam the query sweep migrates onto: a caller cannot invoke a scoped
 * thread operation without providing an organization, so the tenant predicate is
 * structurally present rather than hand-copied at ~96 call sites.
 *
 * Semantics: threads are **private-to-creator within an org** — the fence is
 * `and(userId, organizationId)`. A co-member of the same org does not see your
 * threads (preserving today's per-user task list); another org never sees them
 * (the new tenant boundary). See model/threads.ts `threadOrgFence`.
 *
 * The underlying threads.ts functions accept `organizationId` as an optional
 * argument (nullable-backfill back-compat); the accessor always supplies it, so
 * everything reached through `forTenant` is org-fenced by construction.
 *
 * Org-derivation rules for callers that create/mint WITHOUT a user session
 * (WI-5 sweep batch 1) — each derives the tenant from its own context:
 *   - Session request paths (dashboard actions, CLI): session.activeOrganizationId
 *     / daemon-token metadata org, via getTenantContextOrNull / getDaemonTokenContext.
 *   - Automation runs (runAutomation): the automation is org-owned → automation.organizationId.
 *   - Slack webhook mentions: the workspace maps to one org → slackInstallation.organizationId
 *     (teamId → one installation).
 *   - Sandbox-agent proxy token (daemon.ts): acts for one thread → thread.organizationId.
 *   - GitHub app-mention webhook: the payload's installation id → githubInstallation
 *     row → organizationId (getOrganizationIdForInstallation). One installation
 *     binds to one org, so this is unambiguous; an unmapped installation → null.
 *     An org admin binds the installation via bindGithubInstallation.
 * All rules are nullable-safe: a null derivation = today's user-only fence.
 */
export type TenantContext = {
  db: DB;
  organizationId: string;
  userId: string;
};

export type TenantAccessor = ReturnType<typeof forTenant>;

export function forTenant({ db, organizationId, userId }: TenantContext) {
  return {
    organizationId,
    userId,

    getThread(threadId: string) {
      return getThread({ db, threadId, userId, organizationId });
    },

    getThreadMinimal(threadId: string) {
      return getThreadMinimal({ db, threadId, userId, organizationId });
    },

    getThreadChat(threadId: string, threadChatId: string) {
      return getThreadChat({
        db,
        threadId,
        threadChatId,
        userId,
        organizationId,
      });
    },

    listThreads(
      opts: {
        limit?: number;
        offset?: number;
        archived?: boolean;
        githubRepoFullName?: string;
        automationId?: string;
        githubPRNumber?: number;
      } = {},
    ) {
      return getThreads({ db, userId, organizationId, ...opts });
    },

    createThread(args: {
      threadValues: Omit<ThreadInsert, "userId" | "organizationId">;
      initialChatValues: Omit<ThreadChatInsert, "userId" | "threadId">;
      enableThreadChatCreation?: boolean;
    }) {
      // Stamp the tenant onto the new thread; createThread propagates it to the
      // thread's chat row.
      return createThread({
        db,
        userId,
        threadValues: { ...args.threadValues, organizationId },
        initialChatValues: args.initialChatValues,
        enableThreadChatCreation: args.enableThreadChatCreation,
      });
    },

    updateThread(threadId: string, updates: Partial<ThreadInsert>) {
      return updateThread({ db, userId, threadId, updates, organizationId });
    },

    updateThreadChat(args: {
      threadId: string;
      threadChatId: string;
      updates: Omit<ThreadChatInsert, "threadChatId" | "status">;
    }) {
      return updateThreadChat({
        db,
        userId,
        organizationId,
        threadId: args.threadId,
        threadChatId: args.threadChatId,
        updates: args.updates,
      });
    },

    deleteThread(threadId: string) {
      return deleteThreadById({ db, threadId, userId, organizationId });
    },

    // --- Environments (WI-5 step 3, second reference port) ---

    listEnvironments(includeGlobal = false) {
      return getEnvironments({ db, userId, organizationId, includeGlobal });
    },

    getEnvironment(environmentId: string) {
      return getEnvironment({ db, userId, environmentId, organizationId });
    },

    getEnvironmentForRepo(repoFullName: string) {
      return getEnvironmentForUserRepo({
        db,
        userId,
        organizationId,
        repoFullName,
      });
    },

    getOrCreateEnvironment(repoFullName: string, isGlobal = false) {
      return getOrCreateEnvironment({
        db,
        userId,
        organizationId,
        repoFullName,
        isGlobal,
      });
    },

    getOrCreateGlobalEnvironment() {
      return getOrCreateGlobalEnvironment({ db, userId, organizationId });
    },

    updateEnvironment(
      environmentId: string,
      updates: Partial<
        Omit<Environment, "id" | "userId" | "repoFullName" | "organizationId">
      >,
    ) {
      return updateEnvironment({
        db,
        userId,
        organizationId,
        environmentId,
        updates,
      });
    },

    deleteEnvironment(environmentId: string) {
      return deleteEnvironmentById({ db, userId, organizationId, environmentId });
    },

    // --- Thread visibility + GitHub PR (WI-5 batch 2, slice 1) ---

    setThreadVisibility(threadId: string, visibility: ThreadVisibility) {
      return updateThreadVisibility({
        db,
        userId,
        organizationId,
        threadId,
        visibility,
      });
    },

    getThreadForGithubPR(repoFullName: string, prNumber: number) {
      return getThreadForGithubPRAndUser({
        db,
        userId,
        organizationId,
        repoFullName,
        prNumber,
      });
    },

    // --- Automations (WI-5 batch 2, slice 2) ---

    listAutomations(opts: { limit?: number; offset?: number } = {}) {
      return getAutomations({ db, userId, organizationId, ...opts });
    },

    getAutomation(automationId: string) {
      return getAutomation({ db, userId, organizationId, automationId });
    },

    createAutomation(
      accessTier: AccessTier,
      automation: Omit<AutomationInsert, "userId" | "organizationId">,
    ) {
      return createAutomation({
        db,
        userId,
        organizationId,
        accessTier,
        automation,
      });
    },

    updateAutomation(
      accessTier: AccessTier,
      automationId: string,
      updates: Partial<
        Omit<Automation, "id" | "userId" | "organizationId" | "createdAt" | "updatedAt">
      >,
    ) {
      return updateAutomation({
        db,
        userId,
        organizationId,
        accessTier,
        automationId,
        updates,
      });
    },

    deleteAutomation(automationId: string) {
      return deleteAutomation({ db, userId, organizationId, automationId });
    },
  };
}
