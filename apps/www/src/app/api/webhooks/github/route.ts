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
  handlePullRequestMirror,
  handlePullRequestReviewMirror,
  handleWorkflowRunEvent,
  handleIssueLabeledMirror,
} from "./handlers";
import { Webhooks } from "@octokit/webhooks";
import { env } from "@terragon/env/apps-www";
import { findWebhookSkip } from "./webhook-skip";

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
    async ({ payload }) => {
      await handlePullRequestUpdated(payload);
    },
  );
  // Mirror-intake (pilot): event classes prod routes to a skill but the
  // chassis has no task-creation path for. Each creates an org-attributed shadow
  // task (see mirror-intake.ts).
  webhooks.on(
    ["pull_request.review_requested", "pull_request.closed"],
    async ({ payload }) => {
      await handlePullRequestMirror(payload);
    },
  );
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
  webhooks.on(["issues.opened"], async ({ payload }) => {
    await handleIssueEvent(payload);
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
    // installation, unconfigured repo) fast-acks 2xx with a structured skip log
    // — GitHub must NOT retry it (retries never help and eventually disable the
    // webhook). Only genuine unexpected errors 5xx so GitHub retries transient
    // infra failures until the ingress outbox lands.
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
