import { db } from "@/lib/db";
import {
  updateGitHubPR,
  getOctokitForApp,
  getIsPRAuthor,
  getIsIssueAuthor,
  parseRepoFullName,
} from "@/lib/github";
import { getGithubPR } from "@terragon/shared/model/github";
import { handleAppMention } from "./handle-app-mention";
import { resolveReviewDraftPolicy } from "@/server-lib/review/resolve-review-draft-policy";
import {
  isAppMentioned,
  getDiffContextStr,
  fetchReviewCommentThreadContext,
} from "./utils";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import {
  getPullRequestAutomationsForRepo,
  getIssueAutomationsForRepo,
} from "@terragon/shared/model/automations";
import {
  PullRequestTriggerConfig,
  IssueTriggerConfig,
} from "@terragon/shared/automations";
import {
  runPullRequestAutomation,
  runIssueAutomation,
} from "@/server-lib/automations";
import { Automation } from "@terragon/shared/db/types";
import {
  buildPrKey,
  upsertDesiredHead,
} from "@terragon/shared/model/supersede-recheck";
import { createMirrorTask } from "./mirror-intake";
// publicAppUrl is used within utils via postBillingLinkComment
export type PullRequestEvent = EmitterWebhookEvent<"pull_request">["payload"];
export type IssueEvent = EmitterWebhookEvent<"issues">["payload"];
export type IssueCommentEvent = EmitterWebhookEvent<"issue_comment">["payload"];
export type PullRequestReviewCommentEvent =
  EmitterWebhookEvent<"pull_request_review_comment">["payload"];
export type PullRequestReviewEvent =
  EmitterWebhookEvent<"pull_request_review">["payload"];
export type CheckRunEvent = EmitterWebhookEvent<"check_run">["payload"];
export type CheckSuiteEvent = EmitterWebhookEvent<"check_suite">["payload"];
export type WorkflowRunEvent = EmitterWebhookEvent<"workflow_run">["payload"];

// Issue labels prod's WORKFLOW.md routes to a task (mirror-intake, pilot).
const MIRRORED_ISSUE_LABELS = new Set(["bug", "enhancement"]);

// octokit types `installation` on some event payloads but not others (e.g. it's
// on issue_comment but not issues/pull_request); it is present on every real
// delivery from a GitHub App install. Read it uniformly.
function installationIdOf(event: unknown): number | undefined {
  return (event as { installation?: { id?: number } } | null)?.installation?.id;
}

// Handle pull request events
export async function handlePullRequestStatusChange(
  event: PullRequestEvent,
): Promise<void> {
  try {
    const repoName = event.repository.full_name;
    const prNumber = event.pull_request.number;
    const pr = await getGithubPR({ db, repoFullName: repoName, prNumber });
    if (!pr) {
      return;
    }
    console.log(
      `Processing ${event.action} event for PR #${prNumber} in ${repoName}`,
    );
    // Update the PR status
    await updateGitHubPR({
      repoFullName: repoName,
      prNumber,
      createIfNotFound: false,
    });
    console.log(`Successfully updated PR #${prNumber} status in ${repoName}`);
    return;
  } catch (error) {
    console.error("Error updating pull request status:", error);
    throw error;
  }
}

export async function handlePullRequestUpdated(
  event: PullRequestEvent,
  /** #127: the webhook's X-GitHub-Delivery id, threaded to the dispatch. */
  deliveryId?: string,
): Promise<void> {
  const repoFullName = event.repository.full_name;
  const prNumber = event.pull_request.number;
  console.log(
    `Pull request updated: ${event.action} for PR #${prNumber} in ${repoFullName}`,
  );
  try {
    // Get all pull request automations for this repository
    const automations = await getPullRequestAutomationsForRepo({
      db,
      repoFullName,
    });
    if (automations.length === 0) {
      return;
    }
    console.log(
      `Found ${automations.length} pull request automations for ${repoFullName}`,
    );
    // Process each automation
    for (let i = 0; i < automations.length; i += BATCH_SIZE) {
      const batch = automations.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((automation) =>
          handlePullRequestAutomation(event, automation, deliveryId),
        ),
      );
      const failed = results.filter((result) => result.status === "rejected");
      const succeeded = results.filter(
        (result) => result.status === "fulfilled",
      );
      console.log(
        `Successfully handled ${succeeded.length} pull request automations`,
      );
      if (failed.length > 0) {
        console.error(
          `Error handling ${failed.length} pull request automations: ${failed.map((result) => result.reason).join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error("Error handling pull request updated event:", error);
  }
}

const BATCH_SIZE = 5;

async function handlePullRequestAutomation(
  event: PullRequestEvent,
  automation: Automation,
  deliveryId?: string,
): Promise<void> {
  const prNumber = event.pull_request.number;
  const repoFullName = event.repository.full_name;
  if (automation.repoFullName !== repoFullName) {
    return;
  }
  // #125 C5: record the newest head for this PR (durable desired head) —
  // compare-and-set on GitHub's timestamp so an out-of-order delivery never
  // moves it backwards. Best-effort; a bookkeeping failure never blocks the run.
  if (automation.organizationId && deliveryId) {
    await upsertDesiredHead({
      db,
      prKey: buildPrKey({
        orgId: automation.organizationId,
        repoFullName,
        prNumber,
      }),
      sha: event.pull_request.head.sha,
      webhookAt: new Date(event.pull_request.updated_at),
      deliveryId,
    }).catch((error) =>
      console.error("[github webhook] desired-head upsert failed (non-fatal)", {
        repoFullName,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  const config = automation.triggerConfig as PullRequestTriggerConfig;
  // Check if this automation should trigger for the current event
  let shouldTrigger = false;
  switch (event.action) {
    case "opened":
    case "ready_for_review": {
      shouldTrigger = !!config.on.open;
      break;
    }
    case "synchronize": {
      shouldTrigger = !!config.on.update;
      break;
    }
    default: {
      shouldTrigger = false;
    }
  }
  if (!shouldTrigger) {
    console.log(
      `Automation ${automation.id} not configured to trigger on ${event.action}`,
    );
    return;
  }
  // Draft-PR gate. Automata works on drafts by DEFAULT; a repo is opted out via
  // the dashboard per-repo setting (or, legacy, the automation's includeDraftPRs
  // filter). Resolved live so a dashboard change applies to the next webhook.
  if (event.pull_request.draft) {
    const reviewDrafts = await resolveReviewDraftPolicy({
      db,
      organizationId: automation.organizationId,
      repoFullName,
      automationIncludeDraftPrs: config.filter.includeDraftPRs,
    });
    if (!reviewDrafts) {
      console.log(
        `Skipping automation ${automation.id} for draft PR #${prNumber} in ${repoFullName} (repo draft policy = ignore)`,
      );
      return;
    }
  }
  const prAuthorUserName = event.pull_request.user?.login;
  // Unconditional routing (mirror parity): match every PR regardless of author.
  if (config.filter.includeAllAuthors) {
    console.log(
      `Triggering automation ${automation.id} for PR #${prNumber} in ${repoFullName} (${event.action}, all-authors)`,
    );
    await runPullRequestAutomation({
      automationId: automation.id,
      userId: automation.userId,
      prEventAction: event.action,
      repoFullName,
      prNumber,
      source: "automated",
      deliveryId,
    }).catch((error) => {
      console.error(
        `Error running automation ${automation.id} for PR #${prNumber} in ${repoFullName}:`,
        error,
      );
    });
    return;
  }
  const isPRAuthor = await getIsPRAuthor({
    userId: automation.userId,
    repoFullName,
    prNumber,
  });

  let authorMatches = isPRAuthor;
  if (
    !authorMatches &&
    config.filter.includeOtherAuthors &&
    prAuthorUserName &&
    config.filter.otherAuthors
  ) {
    const allowedAuthors = config.filter.otherAuthors
      .split(",")
      .map((author) => author.trim().toLowerCase());
    if (allowedAuthors.includes(prAuthorUserName.toLowerCase())) {
      authorMatches = true;
    }
  }
  if (!authorMatches) {
    console.log(
      `Skipping automation ${automation.id} - PR author ${prAuthorUserName} not in allowed list`,
    );
    return;
  }
  console.log(
    `Triggering automation ${automation.id} for PR #${prNumber} in ${repoFullName} (${event.action})`,
  );
  await runPullRequestAutomation({
    automationId: automation.id,
    userId: automation.userId,
    prEventAction: event.action,
    repoFullName,
    prNumber,
    source: "automated",
    deliveryId,
  }).catch((error) => {
    console.error(
      `Error running automation ${automation.id} for PR #${prNumber} in ${repoFullName}:`,
      error,
    );
  });
}

// Handle issue comment events
export async function handleIssueCommentEvent(
  event: IssueCommentEvent,
): Promise<void> {
  try {
    // Only process newly created comments
    if (event.action !== "created") {
      console.log(`Ignoring issue_comment action: ${event.action}`);
      return;
    }
    if (event.comment.user === null) {
      console.log("Ignoring issue comment event: Comment user is null");
      return;
    }
    const commentBody = event.comment.body;
    const issueNumber = event.issue.number;
    const issueType = event.issue.pull_request ? "pull_request" : "issue";
    const commentUsername = event.comment.user.login;
    const commentUserId = event.comment.user.id;
    const repoFullName = event.repository.full_name;
    // Check if the comment mentions our app
    if (!isAppMentioned(commentBody)) {
      console.log(
        `Comment on ${issueType} #${issueNumber} does not mention the app`,
      );
      return;
    }
    console.log(
      `Processing app mention in comment on ${issueType} #${issueNumber} in ${repoFullName} by ${commentUsername}`,
    );
    // Handle the app mention (this will check for automations internally)
    await handleAppMention({
      repoFullName,
      installationId: installationIdOf(event),
      issueOrPrType: issueType,
      issueOrPrNumber: issueNumber,
      commentId: event.comment.id,
      commentBody,
      commentGitHubAccountId: commentUserId,
      commentGitHubUsername: commentUsername,
      commentType: "issue_comment",
      issueContext:
        issueType === "issue"
          ? `**${event.issue.title}**\n\n${event.issue.body ?? ""}`
          : undefined,
    });
    return;
  } catch (error) {
    console.error("Error handling issue comment event:", error);
    throw error;
  }
}

// Handle pull request review comment events
export async function handlePullRequestReviewCommentEvent(
  event: PullRequestReviewCommentEvent,
): Promise<void> {
  try {
    // Only process newly created comments
    if (event.action !== "created") {
      console.log(
        `Ignoring pull_request_review_comment action: ${event.action}`,
      );
      return;
    }
    if (event.comment.user === null) {
      console.log(
        "Ignoring pull request review comment event: Comment user is null",
      );
      return;
    }
    const commentBody = event.comment.body;
    const prNumber = event.pull_request.number;
    const repoFullName = event.repository.full_name;
    const commentUsername = event.comment.user.login;
    const commentUserId = event.comment.user.id;

    // Check if the comment mentions our app
    if (!isAppMentioned(commentBody)) {
      console.log(
        `Review comment on PR #${prNumber} in ${repoFullName} does not mention the app`,
      );
      return;
    }
    console.log(
      `Processing app mention in review comment on PR #${prNumber} in ${repoFullName} by ${commentUsername}`,
    );

    // Extract diff context for PR review comments
    const diffContext = getDiffContextStr(event.comment);
    // Fetch review comment thread context if this is a reply
    let commentContext: string | undefined;
    if (event.comment.in_reply_to_id) {
      const [owner, repo] = parseRepoFullName(repoFullName);
      const octokit = await getOctokitForApp({ owner, repo });
      commentContext = await fetchReviewCommentThreadContext({
        octokit,
        owner,
        repo,
        prNumber,
        currentCommentId: event.comment.id,
        inReplyToId: event.comment.in_reply_to_id,
      });
    }

    // Handle the app mention (this will check for automations internally)
    await handleAppMention({
      repoFullName,
      installationId: installationIdOf(event),
      issueOrPrNumber: prNumber,
      issueOrPrType: "pull_request",
      commentId: event.comment.id,
      commentBody,
      commentGitHubAccountId: commentUserId,
      commentGitHubUsername: commentUsername,
      commentType: "review_comment",
      diffContext,
      commentContext,
    });

    return;
  } catch (error) {
    console.error("Error handling pull request review comment event:", error);
    throw error;
  }
}

// Handle pull request review events
export async function handlePullRequestReviewEvent(
  event: PullRequestReviewEvent,
): Promise<void> {
  try {
    // Only process newly submitted reviews
    if (event.action !== "submitted") {
      console.log(`Ignoring pull_request_review action: ${event.action}`);
      return;
    }
    if (event.review.user === null) {
      console.log("Ignoring pull request review event: Review user is null");
      return;
    }

    const reviewBody = event.review.body;
    const prNumber = event.pull_request.number;
    const repoFullName = event.repository.full_name;
    const reviewUsername = event.review.user.login;
    const reviewUserId = event.review.user.id;

    // Check if the review body exists and mentions our app
    if (!reviewBody || !isAppMentioned(reviewBody)) {
      console.log(
        `Review on PR #${prNumber} in ${repoFullName} does not mention the app or has no body`,
      );
      return;
    }
    console.log(
      `Processing app mention in review on PR #${prNumber} in ${repoFullName} by ${reviewUsername}`,
    );

    // Note: PR reviews themselves don't support reactions, only review comments do
    // So we'll just handle the app mention without adding a reaction

    // Handle the app mention (this will check for automations internally)
    await handleAppMention({
      repoFullName,
      installationId: installationIdOf(event),
      issueOrPrNumber: prNumber,
      issueOrPrType: "pull_request",
      commentId: event.review.id,
      commentBody: reviewBody,
      commentGitHubUsername: reviewUsername,
      commentGitHubAccountId: reviewUserId,
    });
    return;
  } catch (error) {
    console.error("Error handling pull request review event:", error);
    throw error;
  }
}

// Handle check run events
export async function handleCheckRunEvent(event: CheckRunEvent): Promise<void> {
  try {
    const repoFullName = event.repository.full_name;
    const checkRun = event.check_run;
    const prNumbers = checkRun.pull_requests.map((pr) => pr.number);
    if (prNumbers.length === 0) {
      console.log(`Check run ${checkRun.id} has no associated PRs`);
      return;
    }
    console.log(
      `Processing check run ${event.action} for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    await Promise.all(
      prNumbers.map(async (prNumber) => {
        await updateGitHubPR({
          repoFullName,
          prNumber,
          createIfNotFound: false,
        });
      }),
    );
    console.log(
      `Successfully updated check status for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    return;
  } catch (error) {
    console.error("Error handling check run event:", error);
    throw error;
  }
}

// Handle check suite events
export async function handleCheckSuiteEvent(
  event: CheckSuiteEvent,
): Promise<void> {
  try {
    const repoFullName = event.repository.full_name;
    const checkSuite = event.check_suite;
    // Get PRs associated with this check suite
    const prNumbers = checkSuite.pull_requests.map((pr) => pr.number);
    if (prNumbers.length === 0) {
      console.log(`Check suite ${checkSuite.id} has no associated PRs`);
      return;
    }
    console.log(
      `Processing check suite ${event.action} for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    // Update each associated PR
    await Promise.all(
      prNumbers.map(async (prNumber) => {
        await updateGitHubPR({
          repoFullName,
          prNumber,
          createIfNotFound: false,
        });
      }),
    );
    console.log(
      `Successfully updated check status for PRs: ${prNumbers.map((pr) => `#${pr}`).join(", ")} in ${repoFullName}`,
    );
    return;
  } catch (error) {
    console.error("Error handling check suite event:", error);
    throw error;
  }
}

// Handle issue events
export async function handleIssueEvent(event: IssueEvent): Promise<void> {
  const repoFullName = event.repository.full_name;
  const issueNumber = event.issue.number;
  console.log(
    `Issue event: ${event.action} for issue #${issueNumber} in ${repoFullName}`,
  );
  try {
    // Get all issue automations for this repository
    const automations = await getIssueAutomationsForRepo({
      db,
      repoFullName,
    });
    if (automations.length === 0) {
      return;
    }
    console.log(
      `Found ${automations.length} issue automations for ${repoFullName}`,
    );
    // Process each automation
    for (let i = 0; i < automations.length; i += BATCH_SIZE) {
      const batch = automations.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((automation) => handleIssueAutomation(event, automation)),
      );
      const failed = results.filter((result) => result.status === "rejected");
      const succeeded = results.filter(
        (result) => result.status === "fulfilled",
      );
      console.log(`Successfully handled ${succeeded.length} issue automations`);
      if (failed.length > 0) {
        console.error(
          `Error handling ${failed.length} issue automations: ${failed.map((result) => result.reason).join(", ")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error("Error handling issue event:", error);
  }
}

async function handleIssueAutomation(
  event: IssueEvent,
  automation: Automation,
): Promise<void> {
  const issueNumber = event.issue.number;
  const repoFullName = event.repository.full_name;
  if (automation.repoFullName !== repoFullName) {
    return;
  }
  const config = automation.triggerConfig as IssueTriggerConfig;
  // Check if this automation should trigger for the current event
  let shouldTrigger = false;
  switch (event.action) {
    case "opened": {
      shouldTrigger = !!config.on.open;
      break;
    }
    default: {
      shouldTrigger = false;
    }
  }
  if (!shouldTrigger) {
    console.log(
      `Automation ${automation.id} not configured to trigger on ${event.action}`,
    );
    return;
  }
  const issueAuthorUserName = event.issue.user?.login;
  // Unconditional routing (mirror parity): match every issue regardless of author.
  if (config.filter.includeAllAuthors) {
    console.log(
      `Triggering automation ${automation.id} for issue #${issueNumber} in ${repoFullName} (${event.action}, all-authors)`,
    );
    await runIssueAutomation({
      automationId: automation.id,
      userId: automation.userId,
      issueEventAction: event.action,
      repoFullName,
      issueNumber,
      source: "automated",
    }).catch((error) => {
      console.error(
        `Error running automation ${automation.id} for issue #${issueNumber} in ${repoFullName}:`,
        error,
      );
    });
    return;
  }
  const isIssueAuthor = await getIsIssueAuthor({
    userId: automation.userId,
    repoFullName,
    issueNumber,
  });

  let authorMatches = isIssueAuthor;
  if (
    !authorMatches &&
    config.filter.includeOtherAuthors &&
    issueAuthorUserName &&
    config.filter.otherAuthors
  ) {
    const allowedAuthors = config.filter.otherAuthors
      .split(",")
      .map((author) => author.trim().toLowerCase());
    if (allowedAuthors.includes(issueAuthorUserName.toLowerCase())) {
      authorMatches = true;
    }
  }
  if (!authorMatches) {
    console.log(
      `Skipping automation ${automation.id} - Issue author ${issueAuthorUserName} not in allowed list`,
    );
    return;
  }
  console.log(
    `Triggering automation ${automation.id} for issue #${issueNumber} in ${repoFullName} (${event.action})`,
  );
  await runIssueAutomation({
    automationId: automation.id,
    userId: automation.userId,
    issueEventAction: event.action,
    repoFullName,
    issueNumber,
    source: "automated",
  }).catch((error) => {
    console.error(
      `Error running automation ${automation.id} for issue #${issueNumber} in ${repoFullName}:`,
      error,
    );
  });
}

// ---------------------------------------------------------------------------
// Mirror-intake (pilot). Event classes prod's WORKFLOW.md routes to a
// skill but the chassis has no task-creation path for. Each creates one org-
// attributed task (shadow when the installation is in shadow mode). See
// mirror-intake.ts + deploy/PILOT-RUNBOOK.md. These intentionally propagate a
// WebhookSkip for an unbound installation so the route fast-acks 2xx (WI-8).
// ---------------------------------------------------------------------------

// pull_request.review_requested + pull_request.closed(merged=true)
export async function handlePullRequestMirror(
  event: PullRequestEvent,
): Promise<void> {
  const repoFullName = event.repository.full_name;
  const installationId = installationIdOf(event);
  const accountLogin = event.repository.owner?.login;
  const pr = event.pull_request;
  if (event.action === "review_requested") {
    await createMirrorTask({
      repoFullName,
      installationId,
      accountLogin,
      intent: {
        kind: "pr-review-requested",
        prNumber: pr.number,
        headBranch: pr.head?.ref,
        baseBranch: pr.base?.ref,
      },
    });
    return;
  }
  if (event.action === "closed" && pr.merged) {
    await createMirrorTask({
      repoFullName,
      installationId,
      accountLogin,
      intent: {
        kind: "pr-merged",
        prNumber: pr.number,
        baseBranch: pr.base?.ref,
      },
    });
  }
}

// pull_request_review.submitted with state === "changes_requested"
export async function handlePullRequestReviewMirror(
  event: PullRequestReviewEvent,
): Promise<void> {
  if (event.action !== "submitted") {
    return;
  }
  if (event.review.state !== "changes_requested") {
    return;
  }
  await createMirrorTask({
    repoFullName: event.repository.full_name,
    installationId: installationIdOf(event),
    accountLogin: event.repository.owner?.login,
    intent: {
      kind: "pr-changes-requested",
      prNumber: event.pull_request.number,
      headBranch: event.pull_request.head?.ref,
      baseBranch: event.pull_request.base?.ref,
    },
  });
}

// workflow_run.completed with conclusion === "failure"
export async function handleWorkflowRunEvent(
  event: WorkflowRunEvent,
): Promise<void> {
  if (event.action !== "completed") {
    return;
  }
  if (event.workflow_run.conclusion !== "failure") {
    return;
  }
  await createMirrorTask({
    repoFullName: event.repository.full_name,
    installationId: installationIdOf(event),
    accountLogin: event.repository.owner?.login,
    intent: {
      kind: "ci-failure",
      runName: event.workflow_run.name ?? "workflow",
      runId: event.workflow_run.id,
      headBranch: event.workflow_run.head_branch,
    },
  });
}

// issues.labeled with a mirrored label (bug|enhancement)
export async function handleIssueLabeledMirror(
  event: IssueEvent,
): Promise<void> {
  if (event.action !== "labeled") {
    return;
  }
  const label = "label" in event ? event.label?.name : undefined;
  if (!label || !MIRRORED_ISSUE_LABELS.has(label.toLowerCase())) {
    return;
  }
  await createMirrorTask({
    repoFullName: event.repository.full_name,
    installationId: installationIdOf(event),
    accountLogin: event.repository.owner?.login,
    intent: {
      kind: "issue-labeled",
      issueNumber: event.issue.number,
      label,
    },
  });
}
