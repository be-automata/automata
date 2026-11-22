import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";
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
import { isMentionLaneStamp } from "@/server-lib/review/review-skill";

import { type AgentPrContent, parseAgentPrContent } from "./agent-pr-content";
import { isMentionWorkBranch } from "./mention-work-branch";

/**
 * Remote-plane task runs (manual, scheduled, mention) have no control-plane
 * sandbox, so the checkpoint that commits, pushes and opens the pull request
 * for a sandbox thread never runs for them. This module is that step's
 * remote counterpart, split at the only point the timing allows: www finishes
 * the thread as soon as the agent reports done, before the worker could push
 * anything after it. So the AGENT publishes its own commits during the run,
 * and the platform does the rest:
 *
 *   dispatch → names the run's work branch (remoteTaskBranchFor); the worker
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
/** GitHub rejects a PR body longer than this (HTTP 422). */
const GITHUB_PR_BODY_MAX = 65_536;
const GENERIC_PR_BODY = "Changes made by an automated task run.";

export function remoteTaskBranchName(threadId: string): string {
  return `automata/task-${threadId.slice(0, 8).toLowerCase()}`;
}

/**
 * True for a thread an org mention on a PR started (the stamp the lane wrote,
 * `isPullRequest: true`). Such a thread checks out the PR's HEAD branch and
 * stores it as `repoBaseBranchName` (with `githubPRNumber` set), so its head is
 * the one branch it may push. Review, companion and delivery PR threads carry
 * no mention stamp and are not matched.
 */
export function isMentionPullRequestThread(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
): boolean {
  return (
    isMentionLaneStamp(sourceMetadata) &&
    sourceMetadata.mention.isPullRequest === true
  );
}

/**
 * The one branch name a thread's run pushes when it starts from the base (#752):
 * - an ISSUE mention whose stamp carries a valid `workBranch` → that
 *   convention name, with `-<thread8>` when intake found it taken;
 * - everything else (PR mentions, delivery and self-heal threads, plain
 *   tasks, a stamp that fails validation, a name equal to the base branch)
 *   → `automata/task-<id8>`.
 * Deterministic from the row, so dispatch, `cell-plan` and the PR open agree.
 */
export function remoteTaskBranchFor({
  threadId,
  sourceMetadata,
  baseBranch,
}: {
  threadId: string;
  sourceMetadata: ThreadSourceMetadata | null | undefined;
  baseBranch: string | null | undefined;
}): string {
  if (
    isMentionLaneStamp(sourceMetadata) &&
    !sourceMetadata.mention.isPullRequest &&
    typeof sourceMetadata.mention.workBranch === "string"
  ) {
    const { workBranch, workBranchTaken } = sourceMetadata.mention;
    const name =
      workBranchTaken === true
        ? `${workBranch}-${threadId.slice(0, 8).toLowerCase()}`
        : workBranch;
    if (isMentionWorkBranch(name) && name !== baseBranch) return name;
  }
  return remoteTaskBranchName(threadId);
}

/**
 * The one branch a task run may push, shared by dispatch (the worker's work
 * branch) and `cell-plan` (the step's `allowedRef`):
 * - no PR and `branch` is the base → the thread's own work branch
 *   (`remoteTaskBranchFor`);
 * - otherwise (an existing PR or a non-base branch) → `branch`;
 * - the base branch with a PR, or a blank branch → null: a run never gets its
 *   base branch as a push target;
 * - except a mention thread on a PR (read from `sourceMetadata`): its stored
 *   "base" is the PR head it checked out, which is what it pushes. The PR's
 *   real base branch is never stored on it, so it can never be returned.
 */
export function taskRunPushBranch({
  threadId,
  prNumber,
  branch,
  baseBranch,
  sourceMetadata,
}: {
  threadId: string;
  prNumber: number | undefined;
  branch: string | null | undefined;
  baseBranch: string | null | undefined;
  sourceMetadata?: ThreadSourceMetadata | null;
}): string | null {
  if (!branch || branch.trim() === "") return null;
  const isBase = branch === baseBranch;
  if (isBase) {
    if (prNumber === undefined) {
      return remoteTaskBranchFor({ threadId, sourceMetadata, baseBranch });
    }
    return isMentionPullRequestThread(sourceMetadata) ? branch : null;
  }
  return branch;
}

/**
 * The PR policy of a thread an org mention on an ISSUE started (OD-2, OD-5):
 * the issue the PR references. Null for every other thread, whose PRs keep the
 * owner's `prType` and the agent's own wording.
 */
export function mentionPullRequestPolicy(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
): { issueNumber: number } | null {
  if (!isMentionLaneStamp(sourceMetadata)) return null;
  const { mention } = sourceMetadata;
  return mention.isPullRequest
    ? null
    : { issueNumber: mention.issueOrPrNumber };
}

const ISSUE_REF =
  "https?://github\\.com/[\\w.-]+/[\\w.-]+/issues/\\d+|(?:[\\w.-]+/[\\w.-]+)?#\\d+";
/** GitHub's closing keywords in front of an issue reference. */
const CLOSING_REF = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b(?::[ \\t]*|[ \\t]+)(${ISSUE_REF})`,
  "gi",
);
/**
 * An inline code span: a backtick run closed by a run of the same length,
 * within one paragraph (a blank line ends it, so a stray backtick never pairs
 * with one paragraphs later and hides the prose between them).
 */
const INLINE_CODE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

type Piece = [text: string, isCode: boolean];

function splitInline(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_CODE)) {
    pieces.push([text.slice(last, m.index), false], [m[0], true]);
    last = m.index + m[0].length;
  }
  pieces.push([text.slice(last), false]);
  return pieces;
}

function closesFence(line: string, fence: string): boolean {
  const t = line.trim();
  return t.length >= fence.length && t === fence[0]?.repeat(t.length);
}

/** Splits a body into pieces (fenced blocks, inline code, prose) that rejoin to it. */
function splitCode(body: string): Piece[] {
  const groups: Array<{ lines: string[]; code: boolean }> = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    let code = fence !== null;
    if (fence === null) {
      fence = FENCE_OPEN.exec(line)?.[1] ?? null;
      code = fence !== null;
    } else if (closesFence(line, fence)) {
      fence = null;
    }
    const last = groups.at(-1);
    if (last && last.code === code) last.lines.push(line);
    else groups.push({ lines: [line], code });
  }
  return groups.flatMap((g, i) => {
    const text = g.lines.join("\n") + (i < groups.length - 1 ? "\n" : "");
    return g.code ? [[text, true] as Piece] : splitInline(text);
  });
}

/**
 * A mention PR never auto-closes its issue on merge (OD-5): every closing
 * keyword before an issue reference becomes `Refs <ref>` (prose only, never in
 * a code fence or inline code), and `Refs #<issueNumber>` is appended when no
 * such line is left, whatever the agent's own body said.
 */
export function withIssueReference(body: string, issueNumber: number): string {
  const pieces = splitCode(body).map(
    ([text, isCode]): Piece => [
      isCode ? text : text.replace(CLOSING_REF, "Refs $1"),
      isCode,
    ],
  );
  const rewritten = pieces.map(([text]) => text).join("");
  const prose = pieces
    .filter(([, isCode]) => !isCode)
    .map(([text]) => text)
    .join("");
  const hasRef = new RegExp(
    `(?<![\\w/])(?:refs|closes|fixes|resolves):?[ \\t]+#${issueNumber}(?!\\d)`,
    "i",
  ).test(prose);
  return hasRef ? rewritten : `${rewritten}\n\nRefs #${issueNumber}`;
}

export type RemoteTaskPrOutcome =
  | {
      status: "opened" | "adopted";
      prNumber: number;
      /** False when the PR exists on GitHub but recording it on the thread failed. */
      recorded: boolean;
    }
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
  issueNumber,
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
  /** A mention PR's issue: the body is made to reference it, never close it. */
  issueNumber?: number;
  files: readonly CompareFile[];
  commits: readonly CompareCommit[];
  /** The agent's own `json pull-request` block; wins over generation. */
  agentContent: AgentPrContent | null;
  generateContent: typeof generatePRContent;
}) {
  let title = latestCommitSubject(commits) ?? taskTitle;
  let body = GENERIC_PR_BODY;
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
  const footer = `\n\n---\n\n📎 **Task**: ${publicAppUrl()}/task/${threadId}`;
  const compose = (text: string) =>
    (issueNumber !== undefined ? withIssueReference(text, issueNumber) : text) +
    footer;
  body = compose(body);
  if (body.length > GITHUB_PR_BODY_MAX) {
    // Rewriting closing keywords and the footer can push a body under the
    // agent cap past GitHub's, which answers 422 and opens no PR (#752 D4).
    console.warn("[remote-task-pr] agent body over GitHub's cap", {
      threadId,
      length: body.length,
    });
    body = compose(GENERIC_PR_BODY);
  }
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
  const mentionPolicy = mentionPullRequestPolicy(thread.sourceMetadata);
  const base = thread.repoBaseBranchName;
  const branch = remoteTaskBranchFor({
    threadId,
    sourceMetadata: thread.sourceMetadata,
    baseBranch: base,
  });
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
        // A mention PR is always a draft (OD-2); a task run follows the owner.
        draft: mentionPolicy !== null || settings.prType !== "ready",
        issueNumber: mentionPolicy?.issueNumber,
        files: compare.data.files ?? [],
        commits: compare.data.commits,
        agentContent: parseAgentPrContent(threadChat?.messages ?? null),
        generateContent,
      })
    ).data as unknown as NonNullable<typeof existing>);
  const status = existing ? "adopted" : "opened";

  try {
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
  } catch (error) {
    // The PR exists (a later run adopts the open PR), so the outcome still
    // names it; the caller skips what depends on the record. No untrusted text.
    console.error("[remote-task-pr] PR opened but not recorded", {
      threadId,
      prNumber: pr.number,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status, prNumber: pr.number, recorded: false };
  }
  return { status, prNumber: pr.number, recorded: true };
}
