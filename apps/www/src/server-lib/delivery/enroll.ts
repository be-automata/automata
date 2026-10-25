import type { DB } from "@terragon/shared/db";
import { enrollDeliveryPr } from "@terragon/shared/model/delivery-loop";
import { getThread } from "@terragon/shared/model/threads";

import { db as defaultDb } from "@/lib/db";
import { remoteTaskBranchName } from "@/server-lib/task/remote-task-pr";

import { loadDeliveryLoopMode } from "./delivery-mode";
import { evaluateDeliveryPr } from "./evaluate-delivery-pr";

/** The lane skill whose PRs the loop takes over (deploy/skills/issue-delivery). */
export const DELIVERY_SKILL_NAME = "issue-delivery";

export type DeliveryEnrollOutcome =
  | { status: "enrolled"; deliveryPrId: string; created: boolean }
  | {
      status: "skipped";
      reason:
        | "thread_missing"
        | "not_delivery"
        | "no_org"
        | "no_issue"
        | "no_automation"
        | "mode_off";
    };

/**
 * Enrolls the pull request an issue-delivery run just opened (#509), then
 * evaluates it once. Called by the remote-task-pr finish hook only for an
 * `opened` or `adopted` PR. Only a thread stamped with the issue-delivery
 * skill qualifies; a fix-cycle thread never gets here (it already has a PR,
 * so the finish hook skips it).
 */
export async function enrollDeliveryAtPrOpen({
  userId,
  threadId,
  prNumber,
  db = defaultDb,
  evaluate = evaluateDeliveryPr,
  loadMode = loadDeliveryLoopMode,
  now = () => new Date(),
}: {
  userId: string;
  threadId: string;
  prNumber: number;
  db?: DB;
  evaluate?: typeof evaluateDeliveryPr;
  loadMode?: typeof loadDeliveryLoopMode;
  now?: () => Date;
}): Promise<DeliveryEnrollOutcome> {
  const thread = await getThread({ db, threadId, userId });
  if (!thread) return { status: "skipped", reason: "thread_missing" };
  const stamp = thread.sourceMetadata;
  if (
    stamp?.type !== "automation-skill" ||
    stamp.skillName !== DELIVERY_SKILL_NAME ||
    stamp.delivery !== undefined
  ) {
    return { status: "skipped", reason: "not_delivery" };
  }
  if (!thread.organizationId) return { status: "skipped", reason: "no_org" };
  if (thread.githubIssueNumber === null) {
    return { status: "skipped", reason: "no_issue" };
  }
  if (!thread.automationId) {
    return { status: "skipped", reason: "no_automation" };
  }
  const mode = await loadMode({
    db,
    organizationId: thread.organizationId,
    repoFullName: thread.githubRepoFullName,
  });
  if (mode === "off") return { status: "skipped", reason: "mode_off" };

  const { row, created } = await enrollDeliveryPr(db, {
    organizationId: thread.organizationId,
    repoFullName: thread.githubRepoFullName,
    prNumber,
    issueNumber: thread.githubIssueNumber,
    headRef: remoteTaskBranchName(threadId),
    baseRef: thread.repoBaseBranchName,
    // The first evaluation reads the real head from GitHub.
    headSha: null,
    deliveryThreadId: threadId,
    automationId: thread.automationId,
    now: now(),
  });
  await evaluate({ deliveryPrId: row.id });
  return { status: "enrolled", deliveryPrId: row.id, created };
}
