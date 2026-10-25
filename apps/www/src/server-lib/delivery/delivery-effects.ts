import type { Octokit } from "octokit";

import { markReadyViaApp } from "@/server-lib/audit/evaluate-fix-ci";

import type { DeliveryNeedsHumanReason } from "./decide-delivery-step";

/**
 * The delivery loop's GitHub writes (#509), mode "on" only, all as the App:
 * the ready transition and three kinds of PR comment. Never a merge: a
 * person merges (delivery-no-merge.static.test.ts).
 *
 * Every comment carries a marker naming its kind and head. Before posting,
 * the loop looks for its own marker on the PR, so a crash between the post
 * and the DB write never posts twice.
 */

export type DeliveryCommentKind = "merge-ready" | "needs-human" | "no-ci";

export function deliveryMarker(kind: DeliveryCommentKind, headSha: string) {
  return `<!-- automata:delivery-loop kind=${kind} sha=${headSha} -->`;
}

interface PrRef {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
}

/** The id of the loop's comment carrying `marker`, if one exists. */
async function findMarkedComment(
  { octokit, owner, repo, prNumber }: PrRef,
  marker: string,
): Promise<number | null> {
  for await (const page of octokit.paginate.iterator(
    octokit.rest.issues.listComments,
    { owner, repo, issue_number: prNumber, per_page: 100 },
  )) {
    const hit = page.data.find(
      (c) => typeof c.body === "string" && c.body.includes(marker),
    );
    if (hit) return hit.id;
  }
  return null;
}

/** Posts `body` with its marker once per (kind, head); returns the comment id. */
export async function postDeliveryComment(
  ref: PrRef,
  {
    kind,
    headSha,
    body,
  }: { kind: DeliveryCommentKind; headSha: string; body: string },
): Promise<number> {
  const marker = deliveryMarker(kind, headSha);
  const existing = await findMarkedComment(ref, marker);
  if (existing !== null) return existing;
  const { data } = await ref.octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.prNumber,
    body: `${body}\n\n${marker}`,
  });
  return data.id;
}

/** The ready transition: GitHub then emits one ready_for_review (one review). */
export async function markDeliveryPrReady(
  octokit: Octokit,
  prNodeId: string,
): Promise<void> {
  await markReadyViaApp(octokit, prNodeId);
}

export function renderMergeReady({
  prNumber,
  headSha,
  approver,
}: {
  prNumber: number;
  headSha: string;
  approver: string;
}): string {
  return [
    `**Ready to merge.** @${approver} approved \`${headSha.slice(0, 7)}\` and every check is green at that commit.`,
    "",
    "The delivery loop never merges. When you are ready:",
    "",
    "```sh",
    `gh pr merge ${prNumber} --squash`,
    "```",
  ].join("\n");
}

export function renderNoCi(): string {
  return "**Marked ready without repo CI.** No check ran on this commit within 10 minutes, so the only gates were the ones the delivery run ran on the box (listed in the PR body).";
}

const NEEDS_HUMAN_TEXT: Record<DeliveryNeedsHumanReason, string> = {
  app_authored_pr:
    "This pull request was opened by the App itself, and the review bot cannot approve or request changes on its own App's pull request, so the delivery loop cannot finish it.",
  fix_cap_reached:
    "The delivery loop used all of its fix cycles on this pull request and the review or a check is still not green.",
  cycle_pushed_nothing:
    "The last fix cycle finished without pushing a commit, so the findings it was given are still open.",
  no_bot_review:
    "No review from the bot arrived for this commit within 45 minutes, and every check is green.",
  human_changes_requested:
    "The bot approved this commit, but a reviewer's request for changes is still standing.",
};

export function renderNeedsHuman({
  reason,
  headSha,
  cyclesUsed,
}: {
  reason: DeliveryNeedsHumanReason;
  headSha: string;
  cyclesUsed: number;
}): string {
  return [
    `**The delivery loop stopped at \`${headSha.slice(0, 7)}\`.** ${NEEDS_HUMAN_TEXT[reason]}`,
    "",
    `Fix cycles used: ${cyclesUsed}. A new push to this branch resumes the loop.`,
  ].join("\n");
}
