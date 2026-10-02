import type { DB } from "@terragon/shared/db";

import { getOctokitForApp, parseRepoFullName } from "@/lib/github";

import {
  type AuditCommentClient,
  executeMergeAudit,
  type MergeAuditOutcome,
} from "./execute-merge-audit";
import { createTrackerClient } from "./tracker-client";
import { resolveTrackerConfig, type TrackerConfig } from "./tracker-config";
import { describeTrackerError } from "./youtrack-client";

/**
 * Thread-finish glue for the post-merge audit (ADR-008): binds the pure
 * executor to the App octokit and the repo's tracker configuration. Called by
 * the review finish hook for a thread stamped with the `github-pr-merged`
 * skill.
 */

type Octokit = Awaited<ReturnType<typeof getOctokitForApp>>;

export type MergeAuditFinishOutcome =
  | MergeAuditOutcome
  | { outcome: "skipped_not_merged" };

/**
 * One marker comment per PR, owned by the App bot. The author check matters:
 * anyone can paste the marker into their own comment, and the App can only
 * edit its own — matching on the marker alone would turn a planted comment
 * into a permanent update failure.
 */
export function createAuditCommentClient({
  octokit,
  owner,
  repo,
  prNumber,
  botLogin,
  since,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  botLogin: string;
  /**
   * Only comments updated at or after this instant are listed. The audit
   * comment is always written after the merge, so the merge time bounds the
   * search to a handful of comments on even a very long PR.
   */
  since?: string;
}): AuditCommentClient {
  return {
    async upsertMarkerComment(marker, body, mode) {
      const existing = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: prNumber,
          per_page: 100,
          ...(since ? { since } : {}),
        },
      );
      const own = existing.find(
        (comment) =>
          comment.user?.login === botLogin &&
          (comment.body ?? "").includes(marker),
      );
      if (!own) {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
        return "created";
      }
      if (mode === "create-only") return "kept_existing";
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: own.id,
        body,
      });
      return "updated";
    },
  };
}

export async function runMergeAuditAtFinish({
  db,
  userId,
  organizationId,
  repoFullName,
  prNumber,
  terminalText,
  botLogin,
}: {
  db: DB;
  /** The thread's user — the org owner the mirror task was attributed to. */
  userId: string;
  organizationId: string | null;
  repoFullName: string;
  prNumber: number;
  terminalText: string;
  botLogin: string;
}): Promise<MergeAuditFinishOutcome> {
  const [owner, repo] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  // The lane only ever starts from a merged-PR webhook, but the thread can be
  // re-run by hand later; never move a ticket for a PR that is not merged.
  if (!pr.merged) {
    return { outcome: "skipped_not_merged" };
  }

  let config: TrackerConfig | null = null;
  try {
    config = await resolveTrackerConfig({
      db,
      userId,
      organizationId,
      repoFullName,
    });
  } catch (error) {
    // An invalid YOUTRACK_URL reads as "not configured": the executor then
    // says so on the PR instead of the audit silently vanishing.
    console.error("[merge-audit] tracker config invalid", {
      repoFullName,
      error: describeTrackerError(error),
    });
  }

  return await executeMergeAudit({
    prNumber,
    pr: {
      title: pr.title,
      body: pr.body,
      headBranch: pr.head.ref,
      htmlUrl: pr.html_url,
      mergedBy: pr.merged_by?.login ?? null,
    },
    terminalText,
    config,
    tracker: config ? createTrackerClient(config) : null,
    comments: createAuditCommentClient({
      octokit,
      owner,
      repo,
      prNumber,
      botLogin,
      since: pr.merged_at ?? undefined,
    }),
    logger: {
      info: (message, meta) => console.log(`[merge-audit] ${message}`, meta),
      warn: (message, meta) => console.warn(`[merge-audit] ${message}`, meta),
    },
  });
}
