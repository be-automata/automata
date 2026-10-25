import type { DB } from "@terragon/shared/db";
import {
  findOpenDeliveryPrs,
  type DeliveryPullRequestRow,
} from "@terragon/shared/model/delivery-loop";

import { db as defaultDb } from "@/lib/db";
import { waitUntil } from "@/lib/wait-until";
import { resolveBotLogin } from "@/server-lib/review/bot-login";

import { evaluateDeliveryPr } from "./evaluate-delivery-pr";

/**
 * Webhook entry points of the delivery loop (#509). Each one makes at most one
 * indexed lookup, hands every matching row's evaluation to waitUntil and
 * returns: no GitHub call inside the webhook, and the payload is used only to
 * find the row (the evaluator re-reads GitHub). An event whose head branch is
 * not a task work branch costs nothing. Never throws.
 */

/** Every delivery PR's head: remote-task-pr's work branch. */
const DELIVERY_BRANCH_PREFIX = "automata/task-";

export interface DeliveryWebhookDeps {
  db: DB;
  evaluate: (args: { deliveryPrId: string }) => Promise<unknown>;
  schedule: (promise: Promise<unknown>) => void;
  botLogin: () => string;
}

const DEFAULT_DEPS: DeliveryWebhookDeps = {
  db: defaultDb,
  evaluate: evaluateDeliveryPr,
  schedule: waitUntil,
  botLogin: resolveBotLogin,
};

interface RepoPayload {
  repository?: { full_name?: unknown };
}

interface CiPayload extends RepoPayload {
  check_suite?: { head_branch?: unknown; head_sha?: unknown };
  workflow_run?: { head_branch?: unknown; head_sha?: unknown };
}

interface PullRequestPayload extends RepoPayload {
  pull_request?: { number?: unknown; head?: { ref?: unknown } };
}

interface ReviewPayload extends PullRequestPayload {
  review?: { user?: { login?: unknown } };
}

function repoOf(payload: RepoPayload): string | null {
  const repo = payload.repository?.full_name;
  return typeof repo === "string" && repo.length > 0 ? repo : null;
}

function isDeliveryBranch(ref: unknown): ref is string {
  return typeof ref === "string" && ref.startsWith(DELIVERY_BRANCH_PREFIX);
}

async function scheduleMatches(
  deps: DeliveryWebhookDeps,
  label: string,
  lookup: () => Promise<DeliveryPullRequestRow[]>,
): Promise<void> {
  try {
    for (const row of await lookup()) {
      deps.schedule(deps.evaluate({ deliveryPrId: row.id }));
    }
  } catch (error: unknown) {
    console.error(`[delivery-loop] ${label} lookup failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * check_suite.completed / workflow_run.completed. Matched by head branch, not
 * sha: a row enrolled a moment ago has no head sha recorded yet.
 */
export async function handleDeliveryCiEvent(
  payload: unknown,
  overrides: Partial<DeliveryWebhookDeps> = {},
): Promise<void> {
  if (typeof payload !== "object" || payload === null) return;
  const event = payload as CiPayload;
  const headRef =
    event.check_suite?.head_branch ?? event.workflow_run?.head_branch;
  const repoFullName = repoOf(event);
  if (!isDeliveryBranch(headRef) || repoFullName === null) return;
  const deps = { ...DEFAULT_DEPS, ...overrides };
  await scheduleMatches(deps, "CI event", () =>
    findOpenDeliveryPrs(deps.db, { repoFullName, headRef }),
  );
}

/** pull_request_review.submitted: only the bot's reviews move the loop. */
export async function handleDeliveryReviewEvent(
  payload: unknown,
  overrides: Partial<DeliveryWebhookDeps> = {},
): Promise<void> {
  if (typeof payload !== "object" || payload === null) return;
  const event = payload as ReviewPayload;
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const reviewer = event.review?.user?.login;
  if (
    typeof reviewer !== "string" ||
    reviewer.toLowerCase() !== deps.botLogin().toLowerCase()
  ) {
    return;
  }
  await handlePullRequestTarget(event, deps, "review event");
}

/**
 * pull_request synchronize / ready_for_review / converted_to_draft / closed /
 * reopened: the PR moved under the loop.
 */
export async function handleDeliveryPullRequestEvent(
  payload: unknown,
  overrides: Partial<DeliveryWebhookDeps> = {},
): Promise<void> {
  if (typeof payload !== "object" || payload === null) return;
  await handlePullRequestTarget(
    payload as PullRequestPayload,
    { ...DEFAULT_DEPS, ...overrides },
    "pull request event",
  );
}

async function handlePullRequestTarget(
  event: PullRequestPayload,
  deps: DeliveryWebhookDeps,
  label: string,
): Promise<void> {
  const prNumber = event.pull_request?.number;
  const repoFullName = repoOf(event);
  if (
    !isDeliveryBranch(event.pull_request?.head?.ref) ||
    typeof prNumber !== "number" ||
    repoFullName === null
  ) {
    return;
  }
  await scheduleMatches(deps, label, () =>
    findOpenDeliveryPrs(deps.db, { repoFullName, prNumber }),
  );
}
