import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  GithubPRStatus,
  ThreadSource,
  ThreadStatus,
  ThreadVisibility,
} from "../db/types";
import {
  displayRunTitle,
  explainNeedsYou,
  RUNNING_STATUSES,
  runStateFor,
  triggerKindFor,
  WAITING_STATUSES,
  type NeedsYouExplanation,
  type RunState,
  type TriggerKind,
} from "./run-state";
import { threadEffectiveStatusIn } from "./thread-effective-status";

/** How far back finished and failed runs count for "Needs you" and "Recent". */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_LIMIT = 300;
const RECENT_LIMIT = 10;

export type ActivityStarterKind = "you" | "member" | "automation";

export interface AgentActivityRow {
  threadId: string;
  /** False when the viewer may not open this thread; title, branch and PR are then null. */
  canOpen: boolean;
  title: string | null;
  repoFullName: string;
  branchName: string | null;
  prNumber: number | null;
  prStatus: GithubPRStatus | null;
  state: RunState;
  trigger: TriggerKind;
  automationId: string | null;
  automationName: string | null;
  starter: { kind: ActivityStarterKind; name: string | null };
  startedAt: Date;
  updatedAt: Date;
  /** Only on "needs you" rows. */
  needsYou: NeedsYouExplanation | null;
}

export interface OrgAgentActivity {
  needsYou: AgentActivityRow[];
  /** Running and waiting runs, newest first; the UI groups them by repo. */
  active: AgentActivityRow[];
  recent: AgentActivityRow[];
  counts: { running: number; waiting: number; needsYou: number };
}

interface ChatSnapshot {
  threadId: string;
  status: ThreadStatus;
  errorMessage: string | null;
  terminalCause: string | null;
  updatedAt: Date;
}

/**
 * The effective status of a thread from its chat rows (chat-mode threads keep
 * status on threadChat, see thread-effective-status.ts): any live chat wins,
 * otherwise the most recently updated chat.
 */
function effectiveChat(chats: ChatSnapshot[]): ChatSnapshot | null {
  if (chats.length === 0) {
    return null;
  }
  const live = chats.find((chat) => RUNNING_STATUSES.includes(chat.status));
  if (live) {
    return live;
  }
  const waiting = chats.find((chat) => WAITING_STATUSES.includes(chat.status));
  if (waiting) {
    return waiting;
  }
  return [...chats].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  )[0]!;
}

/**
 * What every agent in an organization is doing: runs that need someone, runs
 * in flight, and the last finished runs. Fenced on `organizationId`; titles of
 * threads the viewer cannot open are masked (private visibility, or `repo`
 * visibility without repo access).
 */
export async function getOrgAgentActivity({
  db,
  organizationId,
  viewerUserId,
  mineOnly = false,
  peopleOnly = false,
  hasRepoAccess,
  now = new Date(),
}: {
  db: DB;
  organizationId: string;
  viewerUserId: string;
  mineOnly?: boolean;
  /** Hide automation runs (qm's "Human activity"). */
  peopleOnly?: boolean;
  /** Resolves `repo` visibility for threads the viewer does not own. */
  hasRepoAccess: (repoFullName: string) => Promise<boolean>;
  now?: Date;
}): Promise<OrgAgentActivity> {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_MS);
  const candidates = await db
    .select({
      id: schema.thread.id,
      userId: schema.thread.userId,
      name: schema.thread.name,
      repoFullName: schema.thread.githubRepoFullName,
      branchName: schema.thread.branchName,
      prNumber: schema.thread.githubPRNumber,
      automationId: schema.thread.automationId,
      sourceType: schema.thread.sourceType,
      status: schema.thread.status,
      errorMessage: schema.thread.errorMessage,
      terminalCause: schema.thread.terminalCause,
      bootingSubstatus: schema.thread.bootingSubstatus,
      createdAt: schema.thread.createdAt,
      updatedAt: schema.thread.updatedAt,
      starterName: schema.user.name,
      automationName: schema.automations.name,
      prStatus: schema.githubPR.status,
      visibility: sql<ThreadVisibility>`COALESCE(${schema.threadVisibility.visibility}, ${schema.userSettings.defaultThreadVisibility}, 'private')`,
      dismissed: sql<boolean>`EXISTS (select 1 from ${schema.threadReadStatus} where ${schema.threadReadStatus.threadId} = ${schema.thread.id} and ${schema.threadReadStatus.userId} = ${schema.thread.userId} and ${schema.threadReadStatus.isRead} and ${schema.threadReadStatus.lastReadAt} >= ${schema.thread.updatedAt})`,
    })
    .from(schema.thread)
    .leftJoin(schema.user, eq(schema.user.id, schema.thread.userId))
    .leftJoin(
      schema.automations,
      eq(schema.automations.id, schema.thread.automationId),
    )
    .leftJoin(
      schema.threadVisibility,
      eq(schema.threadVisibility.threadId, schema.thread.id),
    )
    .leftJoin(
      schema.userSettings,
      eq(schema.userSettings.userId, schema.thread.userId),
    )
    .leftJoin(
      schema.githubPR,
      and(
        eq(schema.githubPR.number, schema.thread.githubPRNumber),
        eq(schema.githubPR.repoFullName, schema.thread.githubRepoFullName),
      ),
    )
    .where(
      and(
        eq(schema.thread.organizationId, organizationId),
        eq(schema.thread.archived, false),
        eq(schema.thread.shadow, false),
        mineOnly ? eq(schema.thread.userId, viewerUserId) : undefined,
        peopleOnly ? isNull(schema.thread.automationId) : undefined,
        or(
          threadEffectiveStatusIn([...RUNNING_STATUSES, ...WAITING_STATUSES]),
          gte(schema.thread.updatedAt, since),
        ),
      ),
    )
    .orderBy(desc(schema.thread.updatedAt))
    .limit(CANDIDATE_LIMIT);

  const chats: ChatSnapshot[] =
    candidates.length === 0
      ? []
      : await db
          .select({
            threadId: schema.threadChat.threadId,
            status: schema.threadChat.status,
            errorMessage: schema.threadChat.errorMessage,
            terminalCause: schema.threadChat.terminalCause,
            updatedAt: schema.threadChat.updatedAt,
          })
          .from(schema.threadChat)
          .where(
            inArray(
              schema.threadChat.threadId,
              candidates.map((c) => c.id),
            ),
          );
  const chatsByThread = new Map<string, ChatSnapshot[]>();
  for (const chat of chats) {
    const list = chatsByThread.get(chat.threadId) ?? [];
    list.push(chat);
    chatsByThread.set(chat.threadId, list);
  }

  const repoAccess = new Map<string, Promise<boolean>>();
  const canViewerOpen = async (row: (typeof candidates)[number]) => {
    if (row.userId === viewerUserId || row.visibility === "link") {
      return true;
    }
    if (row.visibility !== "repo") {
      return false;
    }
    let access = repoAccess.get(row.repoFullName);
    if (!access) {
      access = hasRepoAccess(row.repoFullName).catch(() => false);
      repoAccess.set(row.repoFullName, access);
    }
    return access;
  };

  const needsYou: AgentActivityRow[] = [];
  const active: AgentActivityRow[] = [];
  const recent: AgentActivityRow[] = [];
  let running = 0;
  let waiting = 0;

  for (const row of candidates) {
    const chat = effectiveChat(chatsByThread.get(row.id) ?? []);
    const status = chat?.status ?? row.status;
    const errorMessage = chat?.errorMessage ?? row.errorMessage ?? null;
    const terminalCause = row.terminalCause ?? chat?.terminalCause ?? null;
    const state = runStateFor({
      status,
      hasError: errorMessage !== null && !RUNNING_STATUSES.includes(status),
      terminalCause,
      bootingSubstatus: row.bootingSubstatus ?? null,
    });
    const isRecent = row.updatedAt >= since;
    const bucket =
      state.kind === "running" || state.kind === "waiting"
        ? "active"
        : state.kind === "needs-you"
          ? isRecent && !row.dismissed
            ? "needs-you"
            : null
          : isRecent && recent.length < RECENT_LIMIT
            ? "recent"
            : null;
    if (bucket === null) {
      continue;
    }
    const canOpen = await canViewerOpen(row);
    const activityRow: AgentActivityRow = {
      threadId: row.id,
      canOpen,
      title: canOpen ? displayRunTitle(row.name) : null,
      repoFullName: row.repoFullName,
      branchName: canOpen ? row.branchName : null,
      prNumber: canOpen ? row.prNumber : null,
      prStatus: canOpen ? (row.prStatus ?? null) : null,
      state,
      trigger: triggerKindFor({
        sourceType: (row.sourceType as ThreadSource | null) ?? null,
        automationId: row.automationId,
      }),
      automationId: row.automationId,
      automationName: row.automationName ?? null,
      starter: {
        kind: row.automationId
          ? "automation"
          : row.userId === viewerUserId
            ? "you"
            : "member",
        name: row.starterName ?? null,
      },
      startedAt: row.createdAt,
      updatedAt: row.updatedAt,
      needsYou:
        bucket === "needs-you"
          ? explainNeedsYou({ errorMessage, terminalCause })
          : null,
    };
    if (bucket === "active") {
      active.push(activityRow);
      if (state.kind === "running") {
        running++;
      } else {
        waiting++;
      }
    } else if (bucket === "needs-you") {
      needsYou.push(activityRow);
    } else {
      recent.push(activityRow);
    }
  }

  return {
    needsYou,
    active,
    recent,
    counts: { running, waiting, needsYou: needsYou.length },
  };
}
