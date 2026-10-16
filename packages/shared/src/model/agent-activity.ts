import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import type { DB } from "../db";
import * as schema from "../db/schema";
import type {
  GithubPRStatus,
  ThreadSource,
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
import {
  threadEffectiveErrorSql,
  threadEffectiveStatusIn,
  threadEffectiveStatusSql,
} from "./thread-effective-status";

/** How far back finished and failed runs count for "Needs you" and "Recent". */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIVE_LIMIT = 200;
const WINDOW_LIMIT = 300;
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
  // Chat-mode threads only touch threadChat, so the latest activity is the
  // newer of the thread row and its chats.
  const lastActivityAt = sql<Date>`GREATEST(${schema.thread.updatedAt}, COALESCE((select max(${schema.threadChat.updatedAt}) from ${schema.threadChat} where ${schema.threadChat.threadId} = ${schema.thread.id}), ${schema.thread.updatedAt}))`;
  const fence = and(
    eq(schema.thread.organizationId, organizationId),
    eq(schema.thread.archived, false),
    eq(schema.thread.shadow, false),
    mineOnly ? eq(schema.thread.userId, viewerUserId) : undefined,
    peopleOnly ? isNull(schema.thread.automationId) : undefined,
  );
  const select = () =>
    db
      .select({
        id: schema.thread.id,
        userId: schema.thread.userId,
        name: schema.thread.name,
        repoFullName: schema.thread.githubRepoFullName,
        branchName: schema.thread.branchName,
        prNumber: schema.thread.githubPRNumber,
        automationId: schema.thread.automationId,
        sourceType: schema.thread.sourceType,
        status: threadEffectiveStatusSql(),
        errorMessage: threadEffectiveErrorSql(),
        terminalCause: schema.thread.terminalCause,
        bootingSubstatus: schema.thread.bootingSubstatus,
        createdAt: schema.thread.createdAt,
        lastActivityAt: lastActivityAt.mapWith(schema.thread.updatedAt),
        starterName: schema.user.name,
        automationName: schema.automations.name,
        prStatus: schema.githubPR.status,
        visibility: sql<ThreadVisibility>`COALESCE(${schema.threadVisibility.visibility}, ${schema.userSettings.defaultThreadVisibility}, 'private')`,
        dismissed: sql<boolean>`EXISTS (select 1 from ${schema.threadReadStatus} where ${schema.threadReadStatus.threadId} = ${schema.thread.id} and ${schema.threadReadStatus.userId} = ${schema.thread.userId} and ${schema.threadReadStatus.isRead} and ${schema.threadReadStatus.lastReadAt} >= ${lastActivityAt})`,
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
      );

  // Live runs are never cut by the window limit; the window feeds Needs you
  // and Recent.
  const [live, windowed] = await Promise.all([
    select()
      .where(
        and(
          fence,
          threadEffectiveStatusIn([...RUNNING_STATUSES, ...WAITING_STATUSES]),
        ),
      )
      .orderBy(desc(schema.thread.createdAt))
      .limit(LIVE_LIMIT),
    select()
      .where(and(fence, gte(lastActivityAt, since)))
      .orderBy(desc(lastActivityAt))
      .limit(WINDOW_LIMIT),
  ]);
  const seen = new Set<string>();
  const candidates = [...live, ...windowed].filter((row) => {
    if (seen.has(row.id)) {
      return false;
    }
    seen.add(row.id);
    return true;
  });

  const reposToCheck = [
    ...new Set(
      candidates
        .filter((r) => r.userId !== viewerUserId && r.visibility === "repo")
        .map((r) => r.repoFullName),
    ),
  ];
  const repoAccess = new Map(
    await Promise.all(
      reposToCheck.map(
        async (repo) =>
          [repo, await hasRepoAccess(repo).catch(() => false)] as const,
      ),
    ),
  );
  const canViewerOpen = (row: (typeof candidates)[number]) =>
    row.userId === viewerUserId ||
    row.visibility === "link" ||
    (row.visibility === "repo" && repoAccess.get(row.repoFullName) === true);

  const needsYou: AgentActivityRow[] = [];
  const active: AgentActivityRow[] = [];
  const recent: AgentActivityRow[] = [];

  for (const row of candidates) {
    const state = runStateFor({
      status: row.status,
      hasError: row.errorMessage !== null,
      terminalCause: row.terminalCause,
      bootingSubstatus: row.bootingSubstatus ?? null,
    });
    const canOpen = canViewerOpen(row);
    const isRecent = row.lastActivityAt >= since;
    const toRow = (withExplanation: boolean): AgentActivityRow => ({
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
      updatedAt: row.lastActivityAt,
      needsYou: withExplanation
        ? explainNeedsYou({
            errorMessage: row.errorMessage,
            terminalCause: row.terminalCause,
          })
        : null,
    });

    if (state.kind === "running" || state.kind === "waiting") {
      active.push(toRow(false));
    } else if (!isRecent) {
      continue;
    } else if (state.kind === "needs-you" && !row.dismissed && canOpen) {
      // Only failures the viewer can act on; a masked teammate failure is
      // still listed under Recent with its error word.
      needsYou.push(toRow(true));
    } else if (recent.length < RECENT_LIMIT) {
      recent.push(toRow(false));
    }
  }

  return {
    needsYou,
    active,
    recent,
    counts: {
      running: active.filter((r) => r.state.kind === "running").length,
      waiting: active.filter((r) => r.state.kind === "waiting").length,
      needsYou: needsYou.length,
    },
  };
}
