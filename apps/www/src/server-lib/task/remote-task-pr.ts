import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import { getGithubPRStatus } from "@terragon/shared/github-api/helpers";
import { upsertGithubPR } from "@terragon/shared/model/github";
import { getThread, updateThread } from "@terragon/shared/model/threads";
import { getUserSettings } from "@terragon/shared/model/user";
import { publicAppUrl } from "@terragon/env/next-public";

import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { generatePRContent } from "@/server-lib/generate-pr-content";

/**
 * Remote-plane task runs (manual, scheduled, mention) have no control-plane
 * sandbox, so the checkpoint that commits, pushes and opens the pull request
 * for a sandbox thread never runs for them. This module is that step's
 * remote counterpart, split at the only point the timing allows: www finishes
 * the thread as soon as the agent reports done, before the worker could push
 * anything after it. So the AGENT publishes its own commits during the run,
 * and the platform does the rest:
 *
 *   dispatch → names the run's work branch (remoteTaskBranchName); the worker
 *              checks it out right after the clone, so `git push origin HEAD`
 *              publishes exactly this branch.
 *   finish   → if that branch is on GitHub and ahead of the base, open a
 *              draft PR as the App (openRemoteTaskPullRequest).
 *
 * The branch name derives from the thread id, so nothing is stored at
 * dispatch: a run that never pushed leaves no name behind that a later
 * dispatch would try to clone, and a later run of a thread whose branch was
 * pushed but never got a PR continues that remote branch (the worker checks
 * it out when it exists) instead of restarting it from the base.
 */

const DIFF_CHAR_LIMIT = 60_000;

export function remoteTaskBranchName(threadId: string): string {
  return `automata/task-${threadId.slice(0, 8).toLowerCase()}`;
}

export type RemoteTaskPrOutcome =
  | { status: "opened" | "adopted"; prNumber: number }
  | {
      status: "skipped";
      reason:
        | "thread_missing"
        | "has_pr"
        | "auto_create_off"
        | "no_branch"
        | "no_changes";
    };

interface CompareFile {
  filename: string;
  patch?: string;
}

function diffFromCompare(files: readonly CompareFile[]): string {
  const text = files
    .map(
      (file) =>
        `--- ${file.filename}\n${file.patch ?? "(binary or too large)"}`,
    )
    .join("\n");
  return text.length > DIFF_CHAR_LIMIT
    ? `${text.slice(0, DIFF_CHAR_LIMIT)}\n… (diff cut)`
    : text;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}

export async function openRemoteTaskPullRequest({
  db,
  userId,
  threadId,
  octokitFor = getOctokitForApp,
  generateContent = generatePRContent,
}: {
  db: DB;
  userId: string;
  threadId: string;
  /** Injectable for tests. */
  octokitFor?: (args: { owner: string; repo: string }) => Promise<Octokit>;
  /** Injectable for tests. */
  generateContent?: typeof generatePRContent;
}): Promise<RemoteTaskPrOutcome> {
  const [thread, settings] = await Promise.all([
    getThread({ db, threadId, userId }),
    getUserSettings({ db, userId }),
  ]);
  if (!thread) {
    return { status: "skipped", reason: "thread_missing" };
  }
  if (thread.githubPRNumber) {
    return { status: "skipped", reason: "has_pr" };
  }
  if (!settings.autoCreatePRs) {
    return { status: "skipped", reason: "auto_create_off" };
  }
  const branch = remoteTaskBranchName(threadId);
  const base = thread.repoBaseBranchName;
  const [owner, repo] = parseRepoFullName(thread.githubRepoFullName);
  const octokit = await octokitFor({ owner, repo });

  let compare;
  try {
    compare = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${branch}`,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return { status: "skipped", reason: "no_branch" };
    }
    throw error;
  }
  if (compare.data.ahead_by === 0) {
    return { status: "skipped", reason: "no_changes" };
  }

  const { data: open } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    base,
    state: "open",
  });
  let pr = open[0];
  let status: "opened" | "adopted" = "adopted";
  if (!pr) {
    let title = thread.name ?? "Automated task";
    let body = "Changes made by an automated task run.";
    try {
      const generated = await generateContent({
        gitDiff: diffFromCompare(compare.data.files ?? []),
        branchName: branch,
        repoName: thread.githubRepoFullName,
        taskTitle: thread.name ?? "Automated task",
      });
      title = generated.title;
      body = generated.body;
    } catch (error) {
      console.warn(
        "[remote-task-pr] PR content generation failed, using fallbacks",
        {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    body += `\n\n---\n\n📎 **Task**: ${publicAppUrl()}/task/${threadId}`;
    const created = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body,
      head: branch,
      base,
      draft: settings.prType !== "ready",
    });
    pr = created.data as unknown as (typeof open)[number];
    status = "opened";
  }

  await Promise.all([
    upsertGithubPR({
      db,
      repoFullName: thread.githubRepoFullName,
      number: pr.number,
      threadId,
      updates: { status: getGithubPRStatus(pr) },
    }),
    updateThread({
      db,
      userId,
      threadId,
      updates: { branchName: branch, githubPRNumber: pr.number },
    }),
  ]);
  return { status, prNumber: pr.number };
}
