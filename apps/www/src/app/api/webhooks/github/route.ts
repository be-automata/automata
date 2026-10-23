/*
 * GitHub Webhook Handler for Pull Request Status Updates and App Mentions
 *
 * GitHub App Setup:
 * 1. Go to Settings → Developer settings → GitHub Apps → Select your app
 *
 * 2. Configure Webhook Settings:
 *    - Webhook URL: https://your-domain.com/api/webhooks/github
 *    - Webhook secret: Generate a secure secret and add to .env as GITHUB_WEBHOOK_SECRET
 *
 * 3. Subscribe to Events:
 *    - In "Permissions & events" section
 *    - Under "Subscribe to events", check: Pull requests, Issues, Issue comments, Pull request review comments, Pull request reviews, Check runs, Check suites
 *
 * 4. Set Required Permissions:
 *    - Repository permissions:
 *      • Pull requests: Read (minimum)
 *      • Issues: Read (to read PR comments)
 *      • Contents: Read (if you need to access code)
 *      • Metadata: Read (always required)
 *
 * 5. Set environment variable:
 *    - NEXT_PUBLIC_GITHUB_APP_NAME: Your GitHub app name for mention detection
 *
 * 6. Save changes and install the app on target repositories
 *
 * This handler processes:
 * - PR actions: opened, closed, reopened, ready_for_review, converted_to_draft
 * - Issue actions: opened/labeled (issue automations, mirror intake),
 *   closed/unlabeled (withdraw a self-heal finding's fix readiness)
 * - Issue comments: Creates follow-up tasks when the app is mentioned in PR comments
 * - PR review comments: Creates follow-up tasks when the app is mentioned in PR review comments
 * - PR reviews: Creates follow-up tasks when the app is mentioned in PR reviews
 * - Check runs: Updates PR check status when checks are created, completed, or rerequested
 * - Check suites: Updates PR check status when check suites are completed or rerequested
 */

import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import {
  handlePullRequestStatusChange,
  handleIssueCommentEvent,
  handlePullRequestReviewCommentEvent,
  handlePullRequestReviewEvent,
  handleCheckRunEvent,
  handleCheckSuiteEvent,
  handlePullRequestUpdated,
  handleIssueEvent,
  handleSelfHealIssueReopened,
  handleSelfHealIssueUnready,
  handlePullRequestMirror,
  handlePullRequestReviewMirror,
  handleWorkflowRunEvent,
  handleIssueLabeledMirror,
} from "./handlers";
import { Webhooks } from "@octokit/webhooks";
import { env } from "@terragon/env/apps-www";
import { findWebhookSkip } from "./webhook-skip";
import { handleSelfHealCiEvent } from "@/server-lib/audit/evaluate-fix-ci";
import { handleSelfHealPrClosed } from "@/server-lib/audit/fix-pr-lifecycle";
import { deferWebhookWork } from "./defer-webhook-work";

export async function POST(request: NextRequest) {
  const webhooks = new Webhooks({
    secret: env.GITHUB_WEBHOOK_SECRET,
  });
  const [headersList, body] = await Promise.all([headers(), request.text()]);
  const signature = headersList.get("x-hub-signature-256") ?? "";
  const eventType = headersList.get("x-github-event") ?? "";
  const requestId = headersList.get("x-github-delivery") ?? "";
  webhooks.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.closed",
      "pull_request.ready_for_review",
      "pull_request.converted_to_draft",
    ],
    async ({ payload }) => {
      await handlePullRequestStatusChange(payload);
    },
  );
  webhooks.on(
    [
      "pull_request.opened",
      "pull_request.ready_for_review",
      "pull_request.synchronize",
    ],
    async ({ id, payload }) => {
      // #127: thread the webhook delivery id to the dispatch — it becomes the
      // run's idempotency identity under the supersedePolicy flag.
      await handlePullRequestUpdated(payload, id);
    },
  );
  // A retarget (base changed, e.g. a stacked PR's parent merged and GitHub
  // moved the child onto the parent's base) changes the diff without moving
  // the head: reviewed like a synchronize. A title/body edit (no
  // `changes.base`) is dropped inside the handler and triggers nothing.
  webhooks.on("pull_request.edited", async ({ id, payload }) => {
    await handlePullRequestUpdated(payload, id);
  });
  // Mirror-intake (pilot): event classes prod routes to a skill but the
  // chassis has no task-creation path for. Each creates an org-attributed shadow
  // task (see mirror-intake.ts).
  //
  // #447: the merged-PR mirror task stays awaited on pull_request.closed. An
  // unexpected failure there must still 500, because the red mark in GitHub's
  // delivery log is the operator's only signal to redeliver a lost merged-PR
  // audit until durable ingress (#448) exists. Its p50 (4.6s) is well inside
  // the 10s limit; a WebhookSkip still fast-acks with `skipped: true` (WI-8).
  webhooks.on(
    ["pull_request.review_requested", "pull_request.closed"],
    async ({ payload }) => {
      await handlePullRequestMirror(payload);
    },
  );
  // R5: a self-heal fix PR a person merged or closed. A sibling of the closed
  // handlers above: one DB lookup by (repo, pr_number), then the GitHub reads
  // of a merge. Observation only; never merges, never throws (its failures were
  // only ever logged), so #447 runs it after the 2xx at no loss of signal.
  webhooks.on("pull_request.closed", ({ id, payload }) => {
    deferWebhookWork({
      deliveryId: id,
      eventName: "pull_request.closed",
      label: "self-heal fix PR lifecycle",
      work: () => handleSelfHealPrClosed(payload),
    });
  });
  webhooks.on("pull_request_review.submitted", async ({ payload }) => {
    await handlePullRequestReviewMirror(payload);
  });
  webhooks.on("workflow_run.completed", async ({ payload }) => {
    await handleWorkflowRunEvent(payload);
  });
  webhooks.on("issues.labeled", async ({ payload }) => {
    await handleIssueLabeledMirror(payload);
  });
  webhooks.on("issue_comment.created", async ({ payload }) => {
    await handleIssueCommentEvent(payload);
  });
  webhooks.on("pull_request_review.submitted", async ({ payload }) => {
    await handlePullRequestReviewEvent(payload);
  });
  webhooks.on("pull_request_review_comment.created", async ({ payload }) => {
    await handlePullRequestReviewCommentEvent(payload);
  });
  webhooks.on(
    ["check_run.completed", "check_run.created", "check_run.rerequested"],
    async ({ payload }) => {
      await handleCheckRunEvent(payload);
    },
  );
  webhooks.on(
    ["check_suite.completed", "check_suite.rerequested"],
    async ({ payload }) => {
      await handleCheckSuiteEvent(payload);
    },
  );
  // GATE-01: CI completion on a self-heal draft's gated head. A sibling of the
  // check_suite / workflow_run handlers above: one DB lookup, evaluation in
  // waitUntil (and on the tick), no GitHub call here. Never throws.
  webhooks.on(
    ["check_suite.completed", "workflow_run.completed"],
    async ({ payload }) => {
      await handleSelfHealCiEvent(payload);
    },
  );
  webhooks.on(["issues.opened", "issues.labeled"], async ({ id, payload }) => {
    // #447: the automations run after the ack; the id tags their failure logs.
    await handleIssueEvent(payload, id);
  });
  // R7: a closed issue or a removed trigger label withdraws a self-heal
  // finding's readiness. DB-only, never throws.
  webhooks.on(["issues.closed", "issues.unlabeled"], async ({ payload }) => {
    await handleSelfHealIssueUnready(payload);
  });
  // A reopened issue (the audit reopens a regressed finding; its trigger
  // label is still on it, so no issues.labeled fires) restores the finding's
  // readiness. Audit-fix automations only; DB-only, never throws.
  webhooks.on("issues.reopened", async ({ payload }) => {
    await handleSelfHealIssueReopened(payload);
  });
  webhooks.onAny(({ name, payload }) => {
    const payloadInfo: string[] = [];
    if ("action" in payload) {
      payloadInfo.push(`action: ${payload.action}`);
    }
    if ("repository" in payload && payload.repository) {
      payloadInfo.push(`repository: ${payload.repository.full_name}`);
    }
    // Surface the installation id + account on EVERY delivery. This is how an
    // operator captures the installation id during pilot bring-up: the
    // id isn't obtainable via the user-token API, so we read it off the first
    // delivery, then bind it to the org (see deploy/PILOT-RUNBOOK.md). Account
    // login disambiguates which org the delivery belongs to.
    if ("installation" in payload && payload.installation) {
      payloadInfo.push(`installation.id: ${payload.installation.id}`);
    }
    const accountLogin =
      ("installation" in payload &&
        payload.installation &&
        "account" in payload.installation &&
        payload.installation.account &&
        "login" in payload.installation.account &&
        payload.installation.account.login) ||
      ("repository" in payload && payload.repository?.owner?.login) ||
      undefined;
    if (accountLogin) {
      payloadInfo.push(`account: ${accountLogin}`);
    }

    console.log("[github webhook] event received", name, ...payloadInfo);
  });
  webhooks.onError((error) => {
    console.error("[github webhook] error", error);
  });
  try {
    const isValid = await webhooks.verify(body, signature);
    if (!isValid) {
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );
    }
    await webhooks.receive({
      id: requestId,
      name: eventType as any,
      payload: JSON.parse(body),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    // WI-8: a business rejection (app not installed, no mapped user, unmapped
    // installation, unconfigured repo) fast-acks 2xx with a structured skip log:
    // a redelivery would never help. Only genuine unexpected errors 5xx. GitHub
    // never retries a failed delivery on its own, so a 5xx is only a marker in
    // the delivery log that an operator can redeliver from (#447); durable
    // ingress is #448.
    const skip = findWebhookSkip(error);
    if (skip) {
      console.log("[github webhook] skipped", {
        deliveryId: requestId,
        eventType,
        category: skip.category,
        reason: skip.message,
        ...skip.detail,
      });
      return NextResponse.json({
        success: true,
        skipped: true,
        category: skip.category,
      });
    }
    console.error("[github webhook] error", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
