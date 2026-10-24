import type {
  GitHubReview,
  ReviewGitHubClient,
  ReviewLogger,
} from "@terragon/review/state/review-github-client";
import {
  executeReviewIntent,
  type ReviewIntentOutcome,
} from "@terragon/review/state/review-intent-executor";
import { findAnyBotReviewAtCommit } from "@terragon/review/state/head-review-guard";
import {
  applyApproveSeverityFloor,
  DEFAULT_APPROVE_SEVERITY_POLICY,
  type ApproveSeverityPolicy,
} from "@terragon/review/severity-policy";
import type { FileAtCommit } from "@terragon/review/finding-verifier";
import { applyVerifyBeforeBlock } from "@terragon/review/verify-before-block";
import type { ReviewThreadClient } from "./octokit-review-client";
import { applyThreadResolutions } from "./review-thread-resolutions";
import {
  parseReviewIntent,
  toExecutorIntent,
  type EmittedReviewIntent,
} from "./parse-review-intent";
import {
  publishReviewNotice,
  retireReviewNotices,
  type NoVerdictCause,
  type ReviewWriterClient,
} from "./review-notice";
import type { ProviderUnavailable } from "@/agent/msg/classify-provider-result";
import type { RerunPlan, RerunPlanner, RunFailure } from "./review-rerun";

/**
 * The control-plane single writer for a review thread's effect (ADR-036 phase-2).
 * Given the agent's terminal output (which under the flag is emit-only — no
 * gh-write) this parses the fenced-JSON intent and posts EXACTLY ONE review via
 * the injected App-scoped client, with verdict-aware idempotency + the never-
 * silent-drop guarantees. Pure orchestration over `ReviewGitHubClient` + the
 * provided current HEAD sha, so it is fully unit-testable.
 *
 * Guarantees:
 *  - A NON-VERDICT IS NEVER A REVIEW (ADR-009): a run with no verdict — an
 *    unparseable intent, an agent that reports it could not review, or a bare
 *    `comment` on a ready PR — is reported as a marked notice in the PR
 *    conversation + a workFailed signal. The PR's review state stays empty, so
 *    nobody waiting on a verdict mistakes the bot's silence for one.
 *  - POSTED-ZERO IMPOSSIBLE: that notice is the floor — never a silent no-review.
 *  - STALE-INTENT NEVER SILENT-DROP: an intent for an older commit is posted at
 *    that commit (GitHub records it truthfully) UNLESS a newer bot review already
 *    sits at the live HEAD (then skip as superseded, logged).
 *  - IDEMPOTENT: delegates to executeReviewIntent's (headSha,verdict) HEAD-guard,
 *    so a finish-hook/sweep double-fire converges to skipped_existing.
 *  - AT MOST ONE VERDICT PER COMMIT: a redelivered run whose intent names a commit
 *    we have already delivered a verdict for posts nothing (#213 — a worker restart
 *    re-posted 12 stale verdicts onto PR #208 in 63 seconds). A legacy DEGRADED
 *    review is silence, not a verdict, and does not suppress a later real one.
 *    A DISMISSED verdict was still delivered: the reconciler dismisses our older
 *    verdicts on every run, so reading dismissal as "never delivered" re-posted
 *    them from the hourly sweep whenever HEAD had no verdict.
 *  - AT MOST ONE NOTICE PER COMMIT: a thread re-driven through the state
 *    machine (a redelivered run that restarts the agent, a resume, a follow-up)
 *    re-reads the SAME silent terminal text and would report it again at the
 *    same sha (#220). One notice per commit, whatever the reason; the message
 *    already says the only actionable thing, so a second adds noise, not
 *    information. The key is deliberately the COMMIT, not (commit, reason) — see
 *    #107, which must relax it if it ever wants two reasons to coexist at one sha.
 */

/**
 * The body prefix of the degraded COMMENT review this module posted before
 * ADR-009. NO LONGER EMITTED — a no-verdict run is a conversation notice now —
 * but PRs reviewed before that change still carry these reviews, and every
 * guard must keep reading them as silence. Do not remove while such PRs can
 * still be open.
 */
export const DEGRADED_INTENT_MARKER =
  "⚠️ Review intent could not be parsed — verdict NOT applied. This is NOT a clean pass.";

/**
 * The first line of a verdict the bot posts as a COMMENT on a PR it opened
 * itself. GitHub answers a formal APPROVE / REQUEST_CHANGES from the PR's own
 * author with a 422 ("Can not approve your own pull request"), so on a
 * self-heal fix PR the only review the App can leave is a COMMENT; this line
 * carries the verdict that review would otherwise have had. It is a VERDICT,
 * not silence: it never starts with `DEGRADED_INTENT_MARKER`, so every
 * replay / supersession / sweep guard counts it as "the bot reviewed this
 * commit".
 */
export function botAuthoredVerdictLine(verdict: string): string {
  return `**Verdict: ${verdict}** (posted as a comment: GitHub does not let an app approve or request changes on a pull request it opened)`;
}

export type ReviewFromIntentOutcome =
  | {
      outcome: "posted";
      verdict: string;
      /**
       * Set only when a formal verdict went out as a COMMENT because the bot
       * opened the PR (see `botAuthoredVerdictLine`). `verdict` stays the
       * effective verdict the agent reached.
       */
      postedAsComment?: true;
    }
  | { outcome: "posted_stale_comment"; intendedVerdict: string }
  | { outcome: "skipped_existing" }
  | { outcome: "skipped_superseded" }
  | { outcome: "skipped_duplicate_at_commit"; commit: string }
  | {
      outcome: "skipped_stale_degrade";
      cause: NoVerdictCause;
      reason: string;
      workFailed: true;
    }
  | {
      outcome: "skipped_duplicate_degrade_at_commit";
      cause: NoVerdictCause;
      commit: string;
      reason: string;
      workFailed: true;
    }
  | {
      outcome: "degraded_comment";
      cause: NoVerdictCause;
      reason: string;
      workFailed: true;
    }
  | {
      /**
       * #107: the run failed before it produced a verdict and an automatic
       * re-run of this commit owns the outcome, so no notice is posted now.
       * Still a failed run: telemetry is how an operator counts them.
       */
      outcome: "deferred_to_rerun";
      attempt: number;
      reason: string;
      workFailed: true;
    }
  | { outcome: "post_failed"; failureReason: string; workFailed: true };

export interface ExecuteReviewFromIntentOpts {
  github: ReviewWriterClient;
  repoFullName: string;
  prNumber: number;
  botLogin: string;
  /** Live PR HEAD sha at execution time (fetched by the caller). */
  currentHeadSha: string;
  /** The agent's terminal output (from the persisted thread messages). */
  terminalText: string;
  postInlineComments?: boolean;
  /**
   * The ONE per-repo approve-severity-floor snapshot for this run (ADR-036
   * review floor). Downgrades a too-generous `approve` to `request_changes` /
   * `comment` server-side per the repo's tolerance. Defaults to the locked
   * `warning` floor when the caller does not resolve one, so the floor is
   * enforced even absent a per-repo override — never a verbatim pass-through.
   */
  approveFloorPolicy?: ApproveSeverityPolicy;
  /**
   * Draft PR → the floor caps at `comment` (never a formal request_changes),
   * and an agent's bare `comment` is its legitimate draft verdict. Absent is
   * treated as READY: the stricter reading, so a caller that forgets the flag
   * cannot post a non-verdict as a review.
   */
  isDraft?: boolean;
  /**
   * The draft state the run's prompt stated (#504), stamped at dispatch from
   * the same `pulls.get` read. Consulted ONLY by the no-verdict rule: a bare
   * `comment` from a run told "this is a draft" is its draft verdict even when
   * the PR left draft mid-run. The floor cap keeps following the live
   * `isDraft`. Ignored for an abandoned run, so a superseded draft-era run
   * cannot occupy HEAD with a COMMENT review. Absent = today's behaviour.
   */
  draftAtDispatch?: boolean;
  /**
   * The head SHA this run was dispatched to review (thread.reviewedSha, #125 C5).
   * Consulted ONLY on the NO-VERDICT path: a run that produced no verdict
   * has nothing to anchor its notice to except the commit it was pointed at, so
   * when that commit is no longer HEAD the notice is not about live HEAD and is
   * skipped — a newer run owns the PR. Omit (or NULL for a legacy/in-process
   * thread) to keep the pre-existing behaviour of degrading at live HEAD.
   */
  reviewedSha?: string | null;
  /**
   * This run was abandoned by policy or by a user (see ABANDONED_TERMINAL_CAUSES).
   * Also NO-VERDICT-path only, and deliberately NOT a reason to skip the candidate
   * outright: a superseded run can still have persisted a real verdict that the
   * generation fence stopped its finish hook from posting, and discarding that is
   * the worst outcome this module has. An abandoned run's SILENCE proves nothing,
   * so only the no-verdict notice is withheld; a parsed verdict posts
   * through the normal (or stale) path exactly as it would otherwise.
   */
  runAbandoned?: boolean;
  /**
   * Prefer the lead's tagged `json review-intent` block (phase 6). Set from
   * selectReviewTerminalText, true ONLY for threads whose prompt was rendered
   * orchestrated; absent = today's last-block rule.
   */
  preferTaggedIntent?: boolean;
  /**
   * The review bot opened this PR (a self-heal fix PR). GitHub rejects a
   * formal APPROVE / REQUEST_CHANGES from a PR's author, so a fresh verdict is
   * posted as a COMMENT led by `botAuthoredVerdictLine`. Absent = false: every
   * other PR is posted exactly as before.
   */
  prAuthoredByBot?: boolean;
  /**
   * The run's provider classification (#441), from the thread chat's
   * `provider-unavailable` error. Consulted ONLY when no intent parsed: the
   * notice then names the provider cause instead of `unparseable`. Absent /
   * null = today's notice.
   */
  providerUnavailable?: ProviderUnavailable | null;
  /**
   * #107: the run FAILED for an infra reason (`classifyRunFailure`). Consulted
   * ONLY when no intent parsed and no provider cause applies: the notice then
   * names the run's own error instead of "no JSON intent block", and
   * `planRerun` may defer it to an automatic re-run. Absent / null = today.
   */
  runFailure?: RunFailure | null;
  /**
   * #107: the review thread this run is. Rendered on the no-verdict notice so
   * a reader can join it to the worker logs without forensics. Absent = no
   * Run line.
   */
  threadId?: string;
  /**
   * #107: schedules (or reports the spent budget of) the automatic re-run of
   * this commit. Called only for a `runFailure` whose notice could speak for
   * live HEAD. A throw is treated as "no re-run": the notice posts as before.
   */
  planRerun?: RerunPlanner;
  /**
   * verify-before-block's reader: a file at a commit (the GitHub contents API
   * with the App token). When set, every finding that blocks under the floor
   * policy must reproduce its quote at `intent.commit` or it is de-fanged
   * before the floor runs. Absent = no verification (callers that predate it).
   */
  readFileAtCommit?: (path: string, sha: string) => Promise<FileAtCommit>;
  /**
   * Resolve the prior review threads the intent names, after the review is
   * posted (or found already posted) at live HEAD. `claim(commit)` takes the
   * per-(thread, commit) lease. Absent = resolutions are not applied (the
   * hourly sweep, by design: a lost resolution heals on the next push).
   */
  threadResolutions?: {
    client: ReviewThreadClient;
    claim: (commit: string) => Promise<boolean>;
  };
  /**
   * The PR base ref this run was dispatched against (the thread's
   * `reviewBase` stamp). When set, a fresh verdict carries a hidden base
   * marker, and a same-verdict review already at HEAD is "this review" only
   * when it was written for the same base: a retarget at an unchanged head
   * changed the diff, so its review is not a replay of the earlier one.
   * Absent (a thread from before the stamp) = the `(headSha, verdict)` key.
   */
  reviewBase?: string | null;
  /**
   * The PR's base ref NOW (the same pulls.get as `currentHeadSha`). A run
   * whose `reviewBase` is no longer the live base reviewed a stale diff and
   * never supersedes a review already at HEAD.
   */
  liveBase?: string | null;
  logger?: ReviewLogger;
}

/**
 * The hidden base marker a fresh verdict carries when the run knows its base.
 * URI-encoded, so whatever the (user-controlled) branch name holds, the marker
 * cannot close the HTML comment or render as text.
 */
const REVIEW_BASE_MARKER_PREFIX = "<!-- automata:review-base ";
const REVIEW_BASE_MARKER_RE = /<!-- automata:review-base ([^\s>]*) -->/;

export function reviewBaseMarker(base: string): string {
  return `${REVIEW_BASE_MARKER_PREFIX}${encodeURIComponent(base)} -->`;
}

/** The base a review body's marker names, or null for an unmarked review. */
export function parseReviewBaseMarker(body: string): string | null {
  const match = REVIEW_BASE_MARKER_RE.exec(body);
  if (!match || match[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed escape is not a marker this module wrote.
    return null;
  }
}

/**
 * The same-review judgement the executor asks for, when the run knows its
 * base. A review at HEAD is a DIFFERENT review (post, then supersede it) only
 * when it names another base AND this run's base is still the PR's base. An
 * unmarked review (posted before markers existed) counts as the same, so a
 * redelivery straddling the deploy never double-posts; a run that reviewed a
 * base the PR has since left never supersedes anything.
 */
function sameReviewByBase(
  reviewBase: string,
  liveBase: string | null | undefined,
): (existing: GitHubReview) => boolean {
  return (existing) => {
    const marked = parseReviewBaseMarker(existing.body);
    if (marked === null) return true;
    if (liveBase !== undefined && liveBase !== null && liveBase !== reviewBase)
      return true;
    return marked === reviewBase;
  };
}

/** Post the emitted review intent as the single writer. Never silent-drops. */
export async function executeReviewFromIntent(
  opts: ExecuteReviewFromIntentOpts,
): Promise<ReviewFromIntentOutcome> {
  const {
    github,
    repoFullName,
    prNumber,
    botLogin,
    currentHeadSha,
    terminalText,
    logger,
  } = opts;

  const parsed = parseReviewIntent(terminalText, {
    preferTaggedIntent: opts.preferTaggedIntent,
  });
  if (!parsed.ok) {
    // #441: a run the provider refused has no verdict BECAUSE of the
    // provider; say so instead of "no JSON intent block found".
    if (parsed.source !== "agent" && opts.providerUnavailable) {
      return await reportNoVerdict(opts, {
        cause: "provider_unavailable",
        reason: parsed.reason,
        provider: opts.providerUnavailable,
      });
    }
    return await reportNoVerdict(opts, {
      cause: parsed.source === "agent" ? "agent_unable" : "unparseable",
      reason: parsed.reason,
      commit: parsed.source === "agent" ? parsed.commit : undefined,
    });
  }

  const emitted = parsed.intent;
  const draftForNoVerdict =
    opts.isDraft === true ||
    (opts.draftAtDispatch === true && !opts.runAbandoned);
  if (isBareCommentOnReadyPr(emitted, draftForNoVerdict)) {
    return await reportNoVerdict(opts, {
      cause: "agent_comment_without_findings",
      reason: emitted.summary,
      commit: emitted.commit,
    });
  }
  // Apply the per-repo severity floor server-side BEFORE anything is posted —
  // the load-bearing guarantee. `applyApproveSeverityFloor` only ever TIGHTENS:
  // a too-generous `approve` is recomputed from the findings' severities, a
  // `comment` carrying a gating blocker is raised to `request_changes`, and a
  // `request_changes` passes through. This runs identically for the fresh and
  // stale paths so the effective verdict is consistent regardless of HEAD
  // movement.
  // Verify-before-block FIRST (legacy order): a blocking finding whose quote
  // does not reproduce at the reviewed commit is de-fanged, so the floor below
  // never lets a hallucination lower an approve or raise a comment.
  const policy = opts.approveFloorPolicy ?? DEFAULT_APPROVE_SEVERITY_POLICY;
  const reader = opts.readFileAtCommit;
  const verifiedIntent = reader
    ? await applyVerifyBeforeBlock(toExecutorIntent(emitted), {
        policy,
        readFile: (path) => reader(path, emitted.commit),
        repo: repoFullName,
        prNumber,
        logger,
      })
    : toExecutorIntent(emitted);
  const execIntent = applyApproveSeverityFloor(verifiedIntent, policy, {
    isDraft: opts.isDraft,
  });
  const effectiveVerdict = execIntent.verdict;
  const isStale = emitted.commit !== currentHeadSha;

  if (isStale) {
    // The PR moved since the agent reviewed. Never silent-drop: post the verdict
    // as a COMMENT review AT the reviewed commit (GitHub records commit_id
    // truthfully via submitReviewWithComments), UNLESS a newer bot review already
    // sits at live HEAD (then skip as superseded). We post a COMMENT rather than a
    // formal APPROVE/REQUEST_CHANGES because the octokit createReview verdict path
    // posts at the LATEST commit (no commit_id), which would mis-attribute a stale
    // verdict to code the agent never saw — team-lead's blessed minimum-acceptable
    // path (a marked COMMENT "reviewed at <sha>, PR has moved" + telemetry).
    // #213 REPLAY GUARD. The worker's lease can end without a clean ack, and the
    // redelivered task re-parses the SAME persisted terminal text — same intent,
    // same `emitted.commit`. The probe below only asks whether something sits at
    // LIVE head, which is false for a replay *and* for a late first delivery, so
    // it cannot tell them apart; on 2026-09-29 one restart therefore re-posted
    // twelve already-delivered verdicts onto PR #208 in 63 seconds, each at its
    // own original sha.
    //
    // The signal that DOES separate them is whether a review by us already
    // exists AT `emitted.commit`, dismissed or not:
    //   - present  → we already said this; the reader has it. Drop the replay.
    //   - absent   → never delivered. Post it (the marked COMMENT below), because
    //                losing a first-and-only finding is worse than this bug.
    // A degraded "could not be parsed" COMMENT does NOT count as present — see
    // `isDegradedComment`. Derived from GitHub's own state — the PR's reviews carry `commit_id` and an
    // author — deliberately NOT from a new DB column (prod schema migration here
    // is manual and the prod DATABASE_URL is a write-only Worker secret).
    //
    // DISMISSED COUNTS AS PRESENT. Only a formal verdict can be dismissed, so a
    // dismissed review of ours is always a verdict we delivered, and the
    // reconciler dismisses every older one as the PR advances. The guard used to
    // require a review still in force; the hourly sweep then re-posted each
    // older commit's verdict as a stale COMMENT whenever HEAD had none.
    // `findAnyBotReviewAtCommit` asks "did the bot ever review THIS commit?"
    // across all states including COMMENTED and DISMISSED.
    //
    // ONE round trip serves BOTH guards: the primitive's only I/O is listReviews,
    // so a single snapshot answers "already reviewed `emitted.commit`?" and
    // "superseded at live HEAD?" without the two answers being able to disagree.
    //
    // LOOKUP FAILED → EMPTY SNAPSHOT → BOTH GUARDS OPEN → POST ANYWAY. Deliberate,
    // and the posture this module already took at the supersession probe: a rare
    // duplicate is recoverable by a reader, a permanently lost first-and-only
    // finding is not. A transient listReviews failure is independent of replay, so
    // post-anyway bounds the damage to the rare-failure window instead of
    // re-opening the deterministic 12x storm.
    let reviews: GitHubReview[] = [];
    try {
      reviews = await github.listReviews(repoFullName, prNumber);
    } catch (err) {
      logger?.warn(
        "review-from-intent: review lookup failed (replay + supersession guards); posting the stale COMMENT anyway",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    // #221: ONE filtered list feeds BOTH guards, and that is the whole point.
    // A degraded comment is a run's confession that it produced NOTHING — it is
    // evidence of silence at a commit, never a verdict. Counting it as a prior
    // DELIVERY ate a real first-and-only finding (found in #213's refinement and
    // fixed at the replay guard); counting it as a NEWER verdict here drops a real
    // verdict that merely arrived late. Same defect, two guards, and only one was
    // fixed. They share a single `const` now so they cannot drift apart again —
    // do not re-inline either filter.
    const verdicts = reviews.filter((r) => !isDegradedComment(r));

    const alreadyAtIntentCommit = await findAnyBotReviewAtCommit({
      github: snapshotOf(verdicts),
      repo: repoFullName,
      prNumber,
      headSha: emitted.commit,
      botLogin,
    });
    if (alreadyAtIntentCommit) {
      logger?.info(
        "review-from-intent: replay of an already-delivered verdict at this commit; skipping",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          currentHeadSha,
          existingReviewId: alreadyAtIntentCommit.id,
          existingReviewState: alreadyAtIntentCommit.state,
        },
      );
      return {
        outcome: "skipped_duplicate_at_commit",
        commit: emitted.commit,
      };
    }

    const newerAtHead = await findAnyBotReviewAtCommit({
      github: snapshotOf(verdicts),
      repo: repoFullName,
      prNumber,
      headSha: currentHeadSha,
      botLogin,
    });
    if (newerAtHead) {
      logger?.info(
        "review-from-intent: stale intent superseded by review at HEAD",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          currentHeadSha,
        },
      );
      return { outcome: "skipped_superseded" };
    }
    const staleBody = `_Intended verdict: **${effectiveVerdict}**, reviewed at \`${emitted.commit}\`; the PR has since advanced to \`${currentHeadSha}\`, so this is posted as a COMMENT rather than a formal verdict._\n\n${execIntent.body}`;
    try {
      await github.submitReviewWithComments(
        repoFullName,
        prNumber,
        emitted.commit,
        "COMMENT",
        staleBody,
        [],
      );
      logger?.info(
        "review-from-intent: posted stale intent as a COMMENT at reviewed commit",
        {
          repoFullName,
          prNumber,
          intentCommit: emitted.commit,
          currentHeadSha,
          intendedVerdict: emitted.verdict,
        },
      );
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      logger?.error("review-from-intent: stale COMMENT post failed", {
        repoFullName,
        prNumber,
        reason: failureReason,
      });
      return { outcome: "post_failed", failureReason, workFailed: true };
    }
    return {
      outcome: "posted_stale_comment",
      intendedVerdict: effectiveVerdict,
    };
  }

  // #504: a bare `comment` posts as a review here ONLY because the run was told
  // "draft" and the PR has since left draft. It is a draft-era note, so it must
  // never replace a review already in force at HEAD (the executor would post it
  // and dismiss a newer APPROVE / REQUEST_CHANGES from the ready-PR run). The
  // executor checks at post time, so a verdict landing late still wins.
  const draftEraNote =
    opts.isDraft !== true &&
    draftForNoVerdict &&
    isBareCommentOnReadyPr(emitted, false);

  // SELF-AUTHORED PR. The floor above already ran, so `effectiveVerdict` is
  // the verdict we would have submitted; only the review EVENT changes. The
  // findings ride along untouched — inline or folded, exactly as they would
  // with a formal verdict. The executor's (headSha, verdict) idempotency then
  // keys on COMMENTED, which is the state GitHub will record. One consequence:
  // a SECOND run at the same head that reaches a different verdict is skipped
  // as a redelivery — a COMMENT cannot be dismissed, so there is no supersede to
  // do, and the first verdict at the commit stands.
  const postAsComment =
    opts.prAuthoredByBot === true && effectiveVerdict !== "comment";
  if (postAsComment) {
    logger?.info(
      "review-from-intent: the bot opened this PR; posting the verdict as a COMMENT (GitHub refuses a formal verdict from the PR author)",
      { repoFullName, prNumber, currentHeadSha, verdict: effectiveVerdict },
    );
  }
  const postedIntent = postAsComment
    ? {
        ...execIntent,
        verdict: "comment" as const,
        body: [botAuthoredVerdictLine(effectiveVerdict), execIntent.body.trim()]
          .filter((part) => part.length > 0)
          .join("\n\n"),
      }
    : execIntent;
  // A run that knows its base stamps it on the review (hidden), and keys
  // same-review idempotency on it: see `sameReviewByBase`.
  const reviewBase = opts.reviewBase ?? null;
  const markedIntent = reviewBase
    ? {
        ...postedIntent,
        body: `${postedIntent.body.trimEnd()}\n\n${reviewBaseMarker(reviewBase)}`,
      }
    : postedIntent;

  const outcome = await runExecutor({
    github,
    repoFullName,
    prNumber,
    botLogin,
    headSha: currentHeadSha,
    execIntent: markedIntent,
    postInlineComments: opts.postInlineComments,
    ...(reviewBase
      ? { isSameReview: sameReviewByBase(reviewBase, opts.liveBase) }
      : {}),
    ...(draftEraNote ? { yieldToExisting: true } : {}),
    logger,
  });
  if (outcome.outcome === "posted") {
    // A verdict now sits at HEAD, so a notice saying there is none is false.
    await retireReviewNotices({
      github,
      repoFullName,
      prNumber,
      botLogin,
      logger,
    });
  }
  // Thread resolutions ride the verdict at live HEAD: posted now, or already
  // posted by an earlier execution of this same intent (so a crash between the
  // post and the resolutions is finished by the redelivered run). Never on the
  // stale path above, never on a notice. Best effort: never changes `outcome`.
  if (
    opts.threadResolutions &&
    (outcome.outcome === "posted" || outcome.outcome === "skipped_existing")
  ) {
    try {
      await applyThreadResolutions({
        ...opts.threadResolutions,
        prNumber,
        commit: emitted.commit,
        resolutions: emitted.resolvedThreads ?? [],
        logger,
      });
    } catch (err) {
      logger?.warn(
        "review-from-intent: thread resolutions failed (best-effort)",
        {
          repoFullName,
          prNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
  if (postAsComment && outcome.outcome === "posted") {
    return {
      outcome: "posted",
      verdict: effectiveVerdict,
      postedAsComment: true,
    };
  }
  return mapOutcome(outcome);
}

/**
 * An agent-chosen `comment` that carries no findings, on a PR that is ready for
 * review and was ready when the run's prompt was built (#504). The skill
 * reserves `comment` for drafts and for findings surfaced below the block
 * floor; with neither, it can only mean "I could not reach a verdict" — the
 * review #228 received when the agent had no git access. That is a
 * non-verdict and must not be posted as a review.
 *
 * Keyed on the EMITTED verdict, before the approve floor: a server-side
 * downgrade of `approve` to `comment` always carries the findings that caused
 * it, and stays a review.
 */
function isBareCommentOnReadyPr(
  emitted: EmittedReviewIntent,
  treatAsDraft: boolean,
): boolean {
  return (
    emitted.verdict === "comment" &&
    !treatAsDraft &&
    (emitted.findings?.length ?? 0) === 0
  );
}

/**
 * Report a run that produced no verdict: a notice in the PR conversation, never
 * a review, and always a workFailed outcome so an operator hears about it.
 */
async function reportNoVerdict(
  opts: ExecuteReviewFromIntentOpts,
  noVerdict: {
    cause: NoVerdictCause;
    reason: string;
    commit?: string;
    provider?: ProviderUnavailable;
  },
): Promise<ReviewFromIntentOutcome> {
  const { github, repoFullName, prNumber, botLogin, currentHeadSha, logger } =
    opts;
  let { cause, reason } = noVerdict;

  // A NOTICE IS A CLAIM ABOUT LIVE HEAD: "this commit has no verdict". Three
  // cases make that claim false, and in ALL of them the run's silence is
  // evidence of nothing about the code at HEAD:
  //   - the run was dispatched against an older commit (a newer run owns HEAD);
  //   - the run itself names an older commit as the one it looked at;
  //   - the run was abandoned by policy or by a user before it could speak.
  // Observed on #140 (2026-08-25): the hourly sweep reaped a run killed with
  // the worker box and stamped "no parseable verdict — a human should review
  // this PR" onto a commit pushed 73 seconds earlier, whose own review was
  // still running.
  //
  // This withholds ONLY the notice, never a verdict — a real verdict never
  // reaches this function. And it stays loud where it matters: workFailed still
  // fires, so an agent that failed to emit pages an operator instead of
  // shouting at the PR author (see #107).
  const canSpeakForHead =
    !opts.runAbandoned &&
    !(opts.reviewedSha && opts.reviewedSha !== currentHeadSha) &&
    !(noVerdict.commit && noVerdict.commit !== currentHeadSha);
  if (!canSpeakForHead) {
    logger?.warn(
      "review-from-intent: no verdict from a run that cannot speak for HEAD — notice withheld",
      {
        repoFullName,
        prNumber,
        reviewedSha: opts.reviewedSha ?? null,
        intentCommit: noVerdict.commit ?? null,
        currentHeadSha,
        runAbandoned: opts.runAbandoned ?? false,
        cause,
        reason,
      },
    );
    return {
      outcome: "skipped_stale_degrade",
      cause,
      reason,
      workFailed: true,
    };
  }

  // #107: a run that FAILED (infra) before producing anything readable gets
  // bounded automatic re-runs of this commit before the PR hears about it.
  // Only `unparseable` qualifies: an agent that answered `unable_to_review`
  // or left a bare note spoke, and a provider refusal keeps its own notice.
  let reruns: number | undefined;
  if (cause === "unparseable" && opts.runFailure) {
    const plan = await planRerunSafely(opts);
    if (plan?.defer) {
      logger?.warn(
        "review-from-intent: run failed before a verdict — an automatic re-run owns this commit; notice deferred",
        {
          repoFullName,
          prNumber,
          currentHeadSha,
          attempt: plan.attempt,
          decision: plan.decision,
          runError: opts.runFailure.detail,
        },
      );
      return {
        outcome: "deferred_to_rerun",
        attempt: plan.attempt,
        reason: opts.runFailure.detail ?? reason,
        workFailed: true,
      };
    }
    cause = "run_failed";
    reason = opts.runFailure.detail ?? "";
    reruns = plan?.attempts;
  }

  const published = await publishReviewNotice({
    github,
    repoFullName,
    prNumber,
    botLogin,
    sha: currentHeadSha,
    cause,
    reason,
    provider: noVerdict.provider,
    reruns,
    threadId: opts.threadId,
    logger,
  });
  if (published.result === "duplicate_at_commit") {
    logger?.info(
      "review-from-intent: a no-verdict notice already exists at this commit; skipping the duplicate",
      {
        repoFullName,
        prNumber,
        currentHeadSha,
        cause,
        reason,
        existingCommentId: published.commentId,
      },
    );
    return {
      outcome: "skipped_duplicate_degrade_at_commit",
      cause,
      commit: currentHeadSha,
      reason,
      workFailed: true,
    };
  }
  if (published.result === "post_failed") {
    logger?.error("review-from-intent: no-verdict notice post ALSO failed", {
      repoFullName,
      prNumber,
      cause,
      reason,
      error: published.failureReason,
    });
  } else {
    logger?.error(
      published.result === "updated"
        ? "review-from-intent: NO VERDICT — corrected the notice at this commit in place"
        : "review-from-intent: NO VERDICT — posted a notice in the PR conversation",
      { repoFullName, prNumber, cause, reason },
    );
  }
  return { outcome: "degraded_comment", cause, reason, workFailed: true };
}

/** The re-run planner, fail-open: any error means "no re-run, post the notice". */
async function planRerunSafely(
  opts: ExecuteReviewFromIntentOpts,
): Promise<RerunPlan | null> {
  if (!opts.planRerun) return null;
  try {
    return await opts.planRerun(opts.currentHeadSha);
  } catch (err) {
    opts.logger?.error(
      "review-from-intent: re-run planning failed — posting the notice instead",
      {
        repoFullName: opts.repoFullName,
        prNumber: opts.prNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return null;
  }
}

async function runExecutor(args: {
  github: ReviewGitHubClient;
  repoFullName: string;
  prNumber: number;
  botLogin: string;
  headSha: string;
  execIntent: ReturnType<typeof toExecutorIntent>;
  postInlineComments?: boolean;
  isSameReview?: (existing: GitHubReview) => boolean;
  yieldToExisting?: boolean;
  logger?: ReviewLogger;
}): Promise<ReviewIntentOutcome> {
  return await executeReviewIntent({
    github: args.github,
    repo: args.repoFullName,
    prNumber: args.prNumber,
    headSha: args.headSha,
    botLogin: args.botLogin,
    intent: args.execIntent,
    postInlineComments: args.postInlineComments,
    ...(args.isSameReview ? { isSameReview: args.isSameReview } : {}),
    ...(args.yieldToExisting ? { yieldToExisting: true } : {}),
    logger: args.logger,
  });
}

function mapOutcome(o: ReviewIntentOutcome): ReviewFromIntentOutcome {
  if (o.outcome === "posted") return { outcome: "posted", verdict: o.verdict };
  if (o.outcome === "skipped_existing") return { outcome: "skipped_existing" };
  return {
    outcome: "post_failed",
    failureReason: o.failureReason,
    workFailed: true,
  };
}

/**
 * LEGACY (pre-ADR-009) reviews only — see `DEGRADED_INTENT_MARKER`.
 *
 * A degraded COMMENT is a run's CONFESSION that it produced no parseable verdict —
 * it is evidence of silence at that commit, never of a delivered verdict. It must
 * therefore not satisfy the #213 replay guard: a later run that DID produce a real
 * finding at the same commit would otherwise be dropped by the earlier run's
 * silence, which is exactly the lost-verdict failure #213's fix exists to avoid.
 * It cannot re-open the 12x storm either — a degraded comment was only ever emitted
 * by the no-verdict branch, which returns long before this guard.
 *
 * NO AUTHOR CHECK: this is a bare body match, so a HUMAN quoting the marker in a
 * review satisfies it. Every consumer must layer an author filter of its own —
 * in practice `findBotReviewAtHead`'s `r.user?.login === botLogin`, applied AFTER
 * this one.
 */
export function isDegradedComment(review: GitHubReview): boolean {
  // STRUCTURAL, NOT A SUBSTRING SEARCH. The retired emission site always built
  // the body as `${MARKER}\n\n_Reason: …`, so the marker is a PREFIX by
  // construction. `includes` was wider than the thing it meant to recognise:
  // one of our own REAL verdicts that merely QUOTES the
  // marker — and reviews of this very code plausibly do — was read as silence,
  // which made the sweep run its backstop on a PR that already had a verdict.
  // Matching the prefix closes that without any author heuristic, and because
  // it lives in the one shared helper, all three guards stay identical.
  return review.body.startsWith(DEGRADED_INTENT_MARKER);
}

/**
 * Freeze an already-fetched review list into the `Pick<ReviewGitHubClient,
 * "listReviews">` seam `findBotReviewAtHead` takes. Every guard in this module
 * fetches ONCE and then re-asks the primitive over filtered views of that one
 * snapshot, so two guards reading the same PR can never see different states.
 */
export function snapshotOf(reviews: GitHubReview[]) {
  return { listReviews: async () => reviews };
}
