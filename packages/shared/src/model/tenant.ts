import { DB } from "../db";
import { ThreadInsert, ThreadChatInsert, Environment } from "../db/types";
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
 *   - GitHub app-mention webhook: NOT yet derivable — there is no schema-backed
 *     repo→org or GitHub-installation→org mapping, so a user in multiple orgs
 *     sharing a repo is ambiguous. Left nullable (user-only fence, today's
 *     behavior) pending a product-semantics decision on the mapping.
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
  };
}
