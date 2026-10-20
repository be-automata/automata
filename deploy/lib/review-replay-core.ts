/**
 * Pure core of deploy/review-replay.ts — the parts that decide what the replay
 * proves, kept free of I/O so they are unit-tested (deploy/review-replay.test.ts).
 *
 * The replay answers one question before a repo is cut over: given the exact
 * prompt the platform would send for a PR the legacy orchestrator already
 * judged, does the ported skill reach the same verdict? So the prompt must be
 * byte-for-byte what production builds, and the PR state must be the state AT
 * the legacy review, not today's.
 */
import {
  renderPriorReviews,
  renderReviewThreads,
  type PriorReviewData,
  type ReviewThreadData,
} from "../../packages/review/src/review/context/render";
import {
  buildReviewToleranceDirective,
  toleranceToPolicy,
  type BlockTolerance,
} from "../../packages/review/src/review/severity-policy";
import {
  findReviewContextDirective,
  substituteReviewContext,
} from "../../apps/www/src/server-lib/review/review-skill";

/** A GitHub review as `GET /pulls/{n}/reviews` returns it (the fields used). */
export interface ReplayReview {
  id: number;
  user: { login: string } | null;
  state: string;
  commit_id: string | null;
  body: string | null;
  submitted_at: string | null;
}

/** A review thread as the replay's GraphQL query returns it. */
export interface ReplayThread {
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: Array<{
    databaseId: number | null;
    author: { login: string } | null;
    body: string | null;
    createdAt: string;
  }>;
}

/** Reviews submitted before `asOf` — the `<prior_reviews>` the legacy run saw. */
export function reviewsAsOf(
  reviews: readonly ReplayReview[],
  asOf: string,
): PriorReviewData[] {
  return reviews
    .filter((r) => r.submitted_at !== null && r.submitted_at < asOf)
    .map((r) => ({
      authorLogin: r.user?.login ?? null,
      state: r.state,
      commitId: r.commit_id,
      body: r.body,
    }));
}

/**
 * Threads as they stood at `asOf`. GitHub exposes no resolution timestamp, so
 * the approximation is deterministic: a thread existed if its first comment
 * predates `asOf`, shows only the comments that predate it, and counts as
 * resolved only if the bot had already replied `Verified:` on it by then (the
 * legacy resolve-thread effect always replied before resolving).
 */
export function threadsAsOf(
  threads: readonly ReplayThread[],
  asOf: string,
  botLogin: string,
): ReviewThreadData[] {
  const out: ReviewThreadData[] = [];
  for (const t of threads) {
    const before = t.comments.filter((c) => c.createdAt < asOf);
    if (before.length === 0) continue;
    const resolved = before.some(
      (c) =>
        c.author?.login === botLogin &&
        (c.body ?? "").trimStart().startsWith("Verified:"),
    );
    out.push({
      isResolved: resolved,
      path: t.path,
      line: t.line,
      comments: before.map((c) => ({
        databaseId: c.databaseId,
        authorLogin: c.author?.login ?? null,
        body: c.body,
      })),
    });
  }
  return out;
}

/** Render the two historical blocks with the production renderers. */
export function renderHistoricalBlocks(args: {
  reviews: readonly ReplayReview[];
  threads: readonly ReplayThread[];
  asOf: string;
  botLogin: string;
}): { priorReviews: string; reviewThreads: string } {
  return {
    priorReviews: renderPriorReviews(reviewsAsOf(args.reviews, args.asOf)),
    reviewThreads: renderReviewThreads(
      threadsAsOf(args.threads, args.asOf, args.botLogin),
    ),
  };
}

/**
 * The prompt production sends, assembled the same three ways:
 *   1. the skill's placeholders are rendered (resolve-review-skill.ts
 *      renderSkillPlaceholders: only `{{repoFullName}}` and `{{baseBranch}}`),
 *   2. the context directive is replaced by the rendered context LAST
 *      (automations.ts), and the event line is joined to the skill with ONE
 *      space, then trimmed (db-message-helpers.ts convertToPlainText),
 *   3. the tolerance note is appended after `\n\n---\n\n`
 *      (remote-daemon-message.ts computeReviewToleranceDirective).
 */
export function buildReplayPrompt(args: {
  flattenedSkill: string;
  repoFullName: string;
  baseRef: string;
  prNumber: number;
  event: "opened" | "synchronize" | "ready_for_review";
  renderedContext: string;
  tolerance: BlockTolerance;
}): string {
  const rendered = args.flattenedSkill
    .replaceAll("{{repoFullName}}", args.repoFullName)
    .replaceAll("{{baseBranch}}", args.baseRef);
  if (findReviewContextDirective(rendered) === null) {
    throw new Error(
      "The skill has no automata:context directive — it is not a ported review skill.",
    );
  }
  const skillText = substituteReviewContext(rendered, args.renderedContext);
  const eventLine = `The "pull_request.${args.event}" event was triggered for PR #${args.prNumber}.`;
  const joined = /^\s/.test(skillText)
    ? `${eventLine}${skillText}`
    : `${eventLine} ${skillText}`;
  return (
    joined.trim() +
    "\n\n---\n\n" +
    buildReviewToleranceDirective(toleranceToPolicy(args.tolerance)) +
    "\n"
  );
}

/** `Resolved: X / Y` as the review bodies state it, or null. */
export function resolvedTally(text: string): string | null {
  const match = /Resolved:\s*(\d+)\s*\/\s*(\d+)/.exec(text);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The legacy review's verdict, or null when GitHub no longer says (DISMISSED). */
export function legacyVerdict(state: string): string | null {
  if (state === "APPROVED") return "approve";
  if (state === "CHANGES_REQUESTED") return "request_changes";
  if (state === "COMMENTED") return "comment";
  return null;
}
