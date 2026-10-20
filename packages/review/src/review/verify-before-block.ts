/**
 * Verify-before-block pass — the deterministic half of the anti-hallucination
 * guard (the prompt half is the review skills' "quote at HEAD" rule).
 *
 * Ported from orch-agents (`src/execution/effects/verify-before-block.ts` @
 * b337099). Every finding that BLOCKS under the run's policy must reproduce its
 * verbatim `quote` at `path:line ± 3` at the reviewed commit, or it is
 * annotated and de-fanged: stamped `suppressGating` (the only exclusion that
 * works when `info` itself blocks) and, where `info` is non-gating, downgraded
 * to `info`. When that leaves no gating blocker on an agent's
 * `request_changes`, the verdict becomes `comment`. It never upgrades to
 * `approve` (the reviewer may have body-level reservations nobody can verify).
 *
 * One addition over legacy, because the file is read over the network rather
 * than from a local checkout: a file the reader could not check (outage,
 * binary) keeps its finding GATING with a `[quote not checked: …]` note. An
 * outage must never change a verdict, in either direction.
 */
import {
  isBlockingUnderPolicy,
  type ApproveSeverityPolicy,
  type FloorVerdict,
} from "./severity-policy";
import {
  verifyFindingQuote,
  type FileAtCommit,
  type FileAtCommitReader,
  type FindingVerificationResult,
} from "./finding-verifier";
import type { ReviewIntentComment } from "./state/review-intent-executor";
import type { ReviewLogger } from "./state/review-github-client";

export const UNVERIFIED_ANNOTATION =
  "[unverified — quoted text not found at HEAD]";

export function uncheckedAnnotation(reason: string): string {
  return `[quote not checked: ${reason}]`;
}

/** How many distinct files are read at once. */
export const VERIFY_READ_CONCURRENCY = 4;

export interface VerifiableIntent {
  verdict: FloorVerdict;
  comments?: ReviewIntentComment[];
}

export interface VerifyBeforeBlockOpts {
  /**
   * The run's approve-floor policy — the SAME snapshot the floor applies
   * afterwards, so the set checked here is exactly the set that could gate.
   */
  policy: ApproveSeverityPolicy;
  /** Reads a path at the commit the agent reviewed (`intent.commit`). */
  readFile: FileAtCommitReader;
  repo: string;
  prNumber: number;
  logger?: ReviewLogger;
}

/**
 * Read each distinct path once, at most `VERIFY_READ_CONCURRENCY` at a time.
 * A reader that throws is treated as "could not check" — the post must never
 * fail because one file read did.
 */
function cachedReader(
  readFile: FileAtCommitReader,
  paths: readonly string[],
): FileAtCommitReader {
  const cache = new Map<string, FileAtCommit>();
  const safeRead = async (path: string): Promise<FileAtCommit> => {
    try {
      return await readFile(path);
    } catch (err) {
      return {
        kind: "unchecked",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
  const queue = [...new Set(paths)];
  const workers = Array.from(
    { length: Math.min(VERIFY_READ_CONCURRENCY, queue.length) },
    async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        cache.set(path, await safeRead(path));
      }
    },
  );
  const warmed = Promise.all(workers);
  return async (path) => {
    await warmed;
    return cache.get(path) ?? (await safeRead(path));
  };
}

/** Run the pass over `intent`; returns the (possibly de-fanged) intent. */
export async function applyVerifyBeforeBlock<T extends VerifiableIntent>(
  intent: T,
  opts: VerifyBeforeBlockOpts,
): Promise<T> {
  const { policy, repo, prNumber, logger } = opts;
  const comments = intent.comments ?? [];
  const blocking = comments.filter((c) =>
    isBlockingUnderPolicy(c.severity, policy),
  );
  if (blocking.length === 0) return intent;

  const readFile = cachedReader(
    opts.readFile,
    blocking.map((c) => c.path),
  );
  const results = new Map<ReviewIntentComment, FindingVerificationResult>();
  for (const c of blocking) {
    results.set(
      c,
      await verifyFindingQuote(
        { path: c.path, line: c.line, quote: c.quote },
        readFile,
      ),
    );
  }

  let downgraded = 0;
  let gatingBlockers = 0;
  let changed = false;
  const checked = comments.map((c): ReviewIntentComment => {
    const verification = results.get(c);
    if (!verification) return c;
    if (verification.result === "verified") {
      gatingBlockers++;
      return c;
    }
    changed = true;
    if (verification.result === "unchecked") {
      gatingBlockers++;
      logger?.warn("verify-before-block: quote not checked; finding kept", {
        repo,
        prNumber,
        path: c.path,
        line: c.line,
        reason: verification.reason,
      });
      return {
        ...c,
        body: `${c.body} ${uncheckedAnnotation(verification.reason ?? "unknown")}`,
      };
    }
    downgraded++;
    logger?.warn("verify-before-block: de-fanged unverified blocking finding", {
      repo,
      prNumber,
      path: c.path,
      line: c.line,
      severity: c.severity,
      verification: verification.result,
      blockSeverity: policy.blockSeverity,
    });
    return {
      ...c,
      ...(policy.blockSeverity !== "info" ? { severity: "info" as const } : {}),
      suppressGating: true,
      body: `${c.body} ${UNVERIFIED_ANNOTATION}`,
    };
  });

  if (!changed) return intent;
  const verdict =
    intent.verdict === "request_changes" &&
    downgraded > 0 &&
    gatingBlockers === 0
      ? "comment"
      : intent.verdict;
  if (verdict !== intent.verdict) {
    logger?.warn(
      "verify-before-block: verdict downgraded — every blocking finding failed quote verification",
      { repo, prNumber, from: intent.verdict, to: verdict, downgraded },
    );
  }
  return { ...intent, verdict, comments: checked };
}
