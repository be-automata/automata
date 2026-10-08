import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import { getGithubPRStatus } from "@terragon/shared/github-api/helpers";
import { upsertGithubPR } from "@terragon/shared/model/github";
import {
  getThread,
  getThreadChat,
  updateThread,
} from "@terragon/shared/model/threads";
import { getUserSettings } from "@terragon/shared/model/user";
import { publicAppUrl } from "@terragon/env/next-public";

import {
  getOctokitForApp,
  getOctokitForUser,
  parseRepoFullName,
} from "@/lib/github";
import { generatePRContent } from "@/server-lib/generate-pr-content";

import { type AgentPrContent, parseAgentPrContent } from "./agent-pr-content";

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
 *              draft PR as the thread's user (openRemoteTaskPullRequest),
 *              titled and described by the agent's `json pull-request` block
 *              when its final message has one (agent-pr-content.ts).
 *
 * The PR is opened with the USER's GitHub token, as the sandbox checkpoint
 * does, never the App's when the user has one: GitHub refuses a formal
 * APPROVE / REQUEST_CHANGES from a PR's own author, so a PR the App opened can
 * only ever get a comment verdict from the review bot. Reads (compare, open
 * PR lookup) stay on the App token, which sees every installed repo; a user
 * token that cannot see the repo would turn a pushed branch into "no_branch".
 * The App still opens the PR when the user has no GitHub token (an org task
 * attributed to an email/password owner) or GitHub refuses theirs, so the
 * work is never stranded on an unopened branch.
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
        | "checkpointing_off"
        | "auto_create_off"
        | "no_branch"
        | "no_changes";
    };

interface CompareFile {
  filename: string;
  patch?: string;
}

interface CompareCommit {
  commit: { message: string };
}

/** The newest commit's subject: the branch's own words, never the task name. */
function latestCommitSubject(commits: readonly CompareCommit[]): string | null {
  const subject = commits.at(-1)?.commit.message.split("\n", 1)[0]?.trim();
  return subject ? subject : null;
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

function errorStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorStatus(error) === 404;
}

/**
 * GitHub refused the user's token for this repo (revoked, no write access, or
 * the repo hidden from them). Anything else, a 422 validation error included,
 * would fail the same way as the App, so it propagates.
 */
function isUserTokenRefused(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 401 || status === 403 || status === 404;
}

async function createPullRequest({
  octokit,
  fallbackOctokit,
  owner,
  repo,
  branch,
  base,
  threadId,
  repoFullName,
  taskTitle,
  draft,
  files,
  commits,
  agentContent,
  generateContent,
}: {
  /** The author: the user's client when they have one, else the App's. */
  octokit: Octokit;
  /** The App's client, used when GitHub refuses the user's token. */
  fallbackOctokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  base: string;
  threadId: string;
  repoFullName: string;
  taskTitle: string;
  draft: boolean;
  files: readonly CompareFile[];
  commits: readonly CompareCommit[];
  /** The agent's own `json pull-request` block; wins over generation. */
  agentContent: AgentPrContent | null;
  generateContent: typeof generatePRContent;
}) {
  let title = latestCommitSubject(commits) ?? taskTitle;
  let body = "Changes made by an automated task run.";
  if (agentContent) {
    ({ title, body } = agentContent);
  } else {
    try {
      const generated = await generateContent({
        gitDiff: diffFromCompare(files),
        branchName: branch,
        repoName: repoFullName,
        taskTitle,
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
  }
  body += `\n\n---\n\n📎 **Task**: ${publicAppUrl()}/task/${threadId}`;
  const params = { owner, repo, title, body, head: branch, base, draft };
  try {
    return await octokit.rest.pulls.create(params);
  } catch (error) {
    if (octokit === fallbackOctokit || !isUserTokenRefused(error)) {
      throw error;
    }
    console.warn(
      "[remote-task-pr] GitHub refused the user's token, opening the PR as the App",
      { threadId, status: errorStatus(error) },
    );
    return await fallbackOctokit.rest.pulls.create(params);
  }
}

export async function openRemoteTaskPullRequest({
  db,
  userId,
  threadId,
  threadChatId,
  octokitFor = getOctokitForApp,
  userOctokitFor = getOctokitForUser,
  generateContent = generatePRContent,
}: {
  db: DB;
  userId: string;
  threadId: string;
  /** The finished chat, whose last lead message may carry the PR content. */
  threadChatId: string;
  /** Injectable for tests. */
  octokitFor?: (args: { owner: string; repo: string }) => Promise<Octokit>;
  /** Injectable for tests. Null when the user has no usable GitHub token. */
  userOctokitFor?: (args: { userId: string }) => Promise<Octokit | null>;
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
  if (thread.disableGitCheckpointing) {
    return { status: "skipped", reason: "checkpointing_off" };
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
  const existing = open[0];
  const [threadChat, userOctokit] = existing
    ? [undefined, null]
    : await Promise.all([
        getThreadChat({ db, threadId, threadChatId, userId }),
        userOctokitFor({ userId }),
      ]);
  const pr =
    existing ??
    ((
      await createPullRequest({
        octokit: userOctokit ?? octokit,
        fallbackOctokit: octokit,
        owner,
        repo,
        branch,
        base,
        threadId,
        repoFullName: thread.githubRepoFullName,
        taskTitle: thread.name ?? "Automated task",
        draft: settings.prType !== "ready",
        files: compare.data.files ?? [],
        commits: compare.data.commits,
        agentContent: parseAgentPrContent(threadChat?.messages ?? null),
        generateContent,
      })
    ).data as unknown as NonNullable<typeof existing>);
  const status = existing ? "adopted" : "opened";

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
