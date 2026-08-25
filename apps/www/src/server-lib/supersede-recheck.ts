import { db } from "@/lib/db";
import { getLatestHatchetRunForThread } from "@terragon/shared/model/hatchet-run";
import {
  buildPrKey,
  claimRecheck,
  getDesiredHead,
  releaseRecheck,
} from "@terragon/shared/model/supersede-recheck";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { hatchetDispatchEnabled } from "@/agent/hatchet/dispatch";

/**
 * #125 C5 recheck reconciliation for `complete-run-discard` + `recheckOnComplete`.
 *
 * Discard means "a newer push while a review is running is dropped"; the
 * toggle promises "…but re-review the PR's head when the running review
 * finishes". Done naively ("compare SHAs at terminal, re-dispatch") this
 * loops and duplicates (Codex finding). Here it is exactly-once by
 * construction:
 *
 *  - the DESIRED head is durable (`supersede_desired_head`, CAS by webhook
 *    timestamp) and the REVIEWED head is stamped on the thread at creation
 *    (`reviewedSha`), never re-read from GitHub;
 *  - the policy snapshot read is the RUN ROW's (`hatchet_run.supersedePolicy`
 *    / `recheckOnComplete`), stamped at dispatch — never the current settings;
 *  - one re-dispatch per (prKey, desiredHeadSha): `claimRecheck` inserts into
 *    a UNIQUE-constrained ledger, and only the winner dispatches. Three rapid
 *    pushes during a run yield ONE recheck (for the final head); a push during
 *    the recheck yields exactly one more.
 *
 * Fires from every terminal write (finish hook, worker terminal route, sweep).
 * The re-dispatch is a normal PR automation run with a synthetic delivery id
 * `recheck:<prKey>:<sha>` — the id is unique per (prKey, sha) by the same
 * ledger, so it is never deduped against a real webhook delivery.
 */
type RecheckDispatch = (args: {
  userId: string;
  automationId: string;
  repoFullName: string;
  prNumber: number;
  deliveryId: string;
}) => Promise<void>;

/** Columns a caller may already hold — passing them skips the thread read. */
export type RecheckThreadPre = {
  userId: string;
  organizationId: string | null;
  githubRepoFullName: string;
  githubPRNumber: number | null;
  automationId: string | null;
  reviewedSha: string | null;
  sandboxProvider: string;
};

/** NEVER throws: every terminal writer calls this bare (fail-soft inside). */
export async function maybeRecheckOnComplete(args: {
  threadId: string;
  /** Pre-read thread columns (zero-read bail) — see RecheckThreadPre. */
  thread?: RecheckThreadPre;
  /** Pre-read run snapshot (the sweep already holds it). */
  run?: { supersedePolicy: string | null; recheckOnComplete: boolean | null };
  /** Injected for tests; production re-dispatches through runPullRequestAutomation. */
  dispatch?: RecheckDispatch;
}): Promise<{ rechecked: boolean; reason: string }> {
  try {
    return await recheckOnComplete(args);
  } catch (error) {
    console.error("[supersede-recheck] failed (non-fatal)", {
      threadId: args.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { rechecked: false, reason: "error" };
  }
}

async function recheckOnComplete({
  threadId,
  thread: pre,
  run: preRun,
  dispatch = defaultDispatch,
}: {
  threadId: string;
  thread?: RecheckThreadPre;
  run?: { supersedePolicy: string | null; recheckOnComplete: boolean | null };
  dispatch?: RecheckDispatch;
}): Promise<{ rechecked: boolean; reason: string }> {
  // Zero-read bail when the caller already holds the columns: the finish
  // hook fires for EVERY thread terminal in the system, so the common
  // (non-review, non-remote) path must not cost a query.
  // "Remote" is decided by the SAME gate as dispatch (hatchetDispatchEnabled):
  // under HATCHET_ENABLED every thread runs remotely and the provider column
  // keeps its local default ("docker" in production) — a bare provider check
  // here would make the recheck never fire in prod.
  if (pre && (!hatchetDispatchEnabled(pre) || !pre.reviewedSha)) {
    return { rechecked: false, reason: "not-a-review-run" };
  }
  const row =
    pre ??
    (
      await db
        .select({
          userId: threadTable.userId,
          organizationId: threadTable.organizationId,
          githubRepoFullName: threadTable.githubRepoFullName,
          githubPRNumber: threadTable.githubPRNumber,
          automationId: threadTable.automationId,
          reviewedSha: threadTable.reviewedSha,
          sandboxProvider: threadTable.sandboxProvider,
        })
        .from(threadTable)
        .where(eq(threadTable.id, threadId))
        .limit(1)
    )[0];
  if (
    !row ||
    !row.organizationId ||
    row.githubPRNumber === null ||
    !row.automationId ||
    !row.reviewedSha
  ) {
    return { rechecked: false, reason: "not-a-review-run" };
  }
  const run = preRun ?? (await getLatestHatchetRunForThread({ db, threadId }));
  if (
    !run ||
    run.supersedePolicy !== "complete-run-discard" ||
    run.recheckOnComplete !== true
  ) {
    return { rechecked: false, reason: "policy-not-discard-recheck" };
  }
  const prKey = buildPrKey({
    orgId: row.organizationId,
    repoFullName: row.githubRepoFullName,
    prNumber: row.githubPRNumber,
  });
  const desired = await getDesiredHead({ db, prKey });
  // Inequality, not "newer than": reviewedSha comes from pulls.get at
  // creation and can be AHEAD of the webhook's sha; the newer push's own
  // delivery advances desired to the same sha before most runs finish, and
  // the rare race costs one ledger-capped recheck of an already-reviewed head.
  if (!desired || desired.sha === row.reviewedSha) {
    return { rechecked: false, reason: "head-already-reviewed" };
  }
  const won = await claimRecheck({
    db,
    prKey,
    desiredHeadSha: desired.sha,
    triggeredByThreadId: threadId,
  });
  if (!won) {
    return { rechecked: false, reason: "recheck-already-claimed" };
  }
  console.log("[supersede-recheck] re-dispatching for the current head", {
    threadId,
    prKey,
    reviewedSha: row.reviewedSha,
    desiredSha: desired.sha,
  });
  try {
    await dispatch({
      userId: row.userId,
      automationId: row.automationId,
      repoFullName: row.githubRepoFullName,
      prNumber: row.githubPRNumber,
      deliveryId: `recheck:${prKey}:${desired.sha}`,
    });
  } catch (error) {
    // The ledger row is the ONLY gate for this head: a claim whose dispatch
    // failed must be given back, or the discard+recheck promise is silently
    // and permanently lost for that push. Release, then let the caller's
    // never-throws boundary log it.
    await releaseRecheck({
      db,
      prKey,
      desiredHeadSha: desired.sha,
      triggeredByThreadId: threadId,
    }).catch((releaseError: unknown) => {
      console.error("[supersede-recheck] claim release failed", {
        threadId,
        prKey,
        error:
          releaseError instanceof Error
            ? releaseError.message
            : String(releaseError),
      });
    });
    throw error;
  }
  return { rechecked: true, reason: "dispatched" };
}

const defaultDispatch: RecheckDispatch = async (args) => {
  // Dynamic import: automations.ts drags the thread-creation graph in; this
  // module is imported by the sweep/cron path that must stay light.
  const { runPullRequestAutomation } = await import("@/server-lib/automations");
  // runPullRequestAutomation swallows its own dispatch-chain failures (it
  // reports them on the GitHub check run instead). For the recheck that is
  // NOT enough: a swallowed failure would leave the ledger row claimed with
  // no run — so a non-dispatch is surfaced as a throw, which releases the
  // claim (see maybeRecheckOnComplete) and lets a later terminal retry.
  const dispatched = await runPullRequestAutomation({
    ...args,
    prEventAction: "synchronize",
    source: "automated",
  });
  if (!dispatched) {
    throw new Error(
      `recheck re-dispatch for ${args.repoFullName}#${args.prNumber} did not start a run`,
    );
  }
};
