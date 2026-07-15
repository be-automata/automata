import { DB } from "../db";
import { ThreadInsert, ThreadChatInsert } from "../db/types";
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
  };
}
