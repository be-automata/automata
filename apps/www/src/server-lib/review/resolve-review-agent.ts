import type { DB } from "@terragon/shared/db";
import type {
  RepoReviewSetting,
  ThreadTrustContext,
} from "@terragon/shared/db/types";
import { getOrganizationReviewSetting } from "@terragon/shared/model/organization-review-settings";
import { getRepoReviewSettingWithOrgDefault } from "@terragon/shared/model/repo-review-settings";
import {
  DEFAULT_REVIEW_BATTERIES,
  DEFAULT_REVIEW_RUN_TESTS,
  REVIEW_AGENT_FIELDS,
  REVIEW_CLASSIC_COMMAND_TIMEOUT_S,
  REVIEW_ORCHESTRATED_COMMAND_TIMEOUT_S_DEFAULT,
  effectiveReviewMode,
  findReviewAgentFieldError,
  isReviewBatteryPackId,
  type ReviewAgentField,
  type ReviewBatteryPackId,
  type ReviewMode,
} from "@terragon/shared/model/review-agent-settings";
import {
  capPermissionMode,
  type TrustedAuthorThreshold,
} from "@terragon/review/settings/permission-floor";

import { composeTrustedAuthorThreshold } from "./resolve-permission-mode";

/**
 * Effective review-agent settings for one PR-review dispatch (phase 4).
 *
 * PRECEDENCE, per field independently: repo row → '*' org-default row →
 * system default. Stored values are validated when picked; an unknown value
 * THROWS (supersede precedent) so the dispatch fails loudly and its daemon
 * token is revoked — it never degrades silently.
 *
 * CLASSIC = exactly today's behaviour — runTests/timeout/maxTurns apply only
 * when orchestrated. Under classic the result is runTests false, a 60 s
 * command timeout and no maxTurns, whatever is stored.
 *
 * RUN-TESTS DOWNGRADE: running the PR's own tests executes the author's code
 * while an Anthropic key is reachable under observe-mode egress (the
 * CodeRabbit-RCE class, EPIC Step 4). So runTests is forced false when the
 * head is a fork or another repo (`isFork`, or `isCrossRepo` not explicitly
 * false — pre-phase-4 snapshots fail closed), or when the trust snapshot is
 * missing or the author is below the effective trusted-author threshold. The
 * rank comparison is `capPermissionMode`'s, reused rather than re-implemented.
 *
 * PR-review runs only; consumed by the worker in Phase 5.
 */

/** Today's per-command timeout; always used under classic. */
export const CLASSIC_COMMAND_TIMEOUT_MS =
  REVIEW_CLASSIC_COMMAND_TIMEOUT_S * 1000;
/** Orchestrated default when no timeout is stored. */
export const ORCHESTRATED_COMMAND_TIMEOUT_MS =
  REVIEW_ORCHESTRATED_COMMAND_TIMEOUT_S_DEFAULT * 1000;

export type RunTestsDowngradedReason = "fork" | "untrusted-author";

export type ReviewAgentDispatch = {
  mode: ReviewMode;
  batteries: ReviewBatteryPackId[];
  runTests: boolean;
  /** Set only when a requested runTests was forced false by the trust gate. */
  runTestsDowngradedReason?: RunTestsDowngradedReason;
  commandTimeoutMs: number;
  /**
   * Limits the lead reviewer's turns. Sub-agent turns are not counted, so this is not a cost limit.
   * Absent when unset or under classic.
   */
  maxTurns?: number;
};

export type ReviewAgentStoredRow = Pick<
  RepoReviewSetting,
  "repoFullName" | ReviewAgentField
>;

type ReviewAgentTrust = Pick<
  ThreadTrustContext,
  "isFork" | "authorAssociation" | "isCrossRepo"
>;

/**
 * Per field, the first non-null value across `rows` (repo, then '*'),
 * validated. Throws naming the field and the row it came from.
 */
function pickStoredValues(
  organizationId: string,
  rows: ReadonlyArray<ReviewAgentStoredRow | undefined>,
): Partial<Pick<ReviewAgentStoredRow, ReviewAgentField>> {
  const picked: Partial<Pick<ReviewAgentStoredRow, ReviewAgentField>> = {};
  for (const field of REVIEW_AGENT_FIELDS) {
    const row = rows.find(
      (candidate) =>
        candidate !== undefined &&
        candidate[field] !== null &&
        candidate[field] !== undefined,
    );
    if (row === undefined) {
      continue;
    }
    const value = row[field];
    const error = findReviewAgentFieldError({ [field]: value });
    if (error !== undefined) {
      throw new Error(
        `Unknown ${field} ${JSON.stringify(value)} stored for (${organizationId}, ${row.repoFullName}) — ` +
          `refusing to dispatch with a silently-degraded review-agent setting (${error})`,
      );
    }
    Object.assign(picked, { [field]: value });
  }
  return picked;
}

function findRunTestsDowngrade(
  trust: ReviewAgentTrust | null,
  trustedAuthorThreshold: TrustedAuthorThreshold,
): RunTestsDowngradedReason | undefined {
  if (trust === null) {
    return "untrusted-author";
  }
  if (trust.isFork || trust.isCrossRepo !== false) {
    return "fork";
  }
  const trusted =
    capPermissionMode({
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: trust.authorAssociation },
      trustedAuthorThreshold,
    }) === "allowAll";
  return trusted ? undefined : "untrusted-author";
}

/**
 * Everything but the trust gate: the dispatch with runTests false, plus
 * whether runTests was requested (only ever true under orchestrated).
 */
function resolveStored({
  organizationId,
  repo,
  orgDefault,
}: {
  organizationId: string;
  repo: ReviewAgentStoredRow | undefined;
  orgDefault: ReviewAgentStoredRow | undefined;
}): { dispatch: ReviewAgentDispatch; runTestsRequested: boolean } {
  // Validate every picked value BEFORE mode gating, so an invalid stored
  // value throws even when classic would ignore it.
  const stored = pickStoredValues(organizationId, [repo, orgDefault]);
  const mode = effectiveReviewMode(stored.reviewMode, null);
  // Validated above, so the filter only narrows the type.
  const batteries = stored.reviewBatteries
    ? stored.reviewBatteries.filter(isReviewBatteryPackId)
    : [...DEFAULT_REVIEW_BATTERIES];

  if (mode === "classic") {
    return {
      dispatch: {
        mode,
        batteries,
        runTests: false,
        commandTimeoutMs: CLASSIC_COMMAND_TIMEOUT_MS,
      },
      runTestsRequested: false,
    };
  }
  return {
    dispatch: {
      mode,
      batteries,
      runTests: false,
      commandTimeoutMs:
        typeof stored.reviewCommandTimeoutS === "number"
          ? stored.reviewCommandTimeoutS * 1000
          : ORCHESTRATED_COMMAND_TIMEOUT_MS,
      ...(typeof stored.reviewMaxTurns === "number"
        ? { maxTurns: stored.reviewMaxTurns }
        : {}),
    },
    runTestsRequested: stored.reviewRunTests ?? DEFAULT_REVIEW_RUN_TESTS,
  };
}

/** Apply the runTests trust gate to a dispatch whose runTests was requested. */
function applyRunTestsGate(
  dispatch: ReviewAgentDispatch,
  trust: ReviewAgentTrust | null,
  trustedAuthorThreshold: TrustedAuthorThreshold,
): ReviewAgentDispatch {
  const downgrade = findRunTestsDowngrade(trust, trustedAuthorThreshold);
  const { mode, batteries, commandTimeoutMs, maxTurns } = dispatch;
  // Key order is the payload's serialized order (the transport golden).
  return {
    mode,
    batteries,
    runTests: downgrade === undefined,
    ...(downgrade !== undefined ? { runTestsDowngradedReason: downgrade } : {}),
    commandTimeoutMs,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

/** Pure resolution (no DB). See the module docblock for the rules. */
export function resolveReviewAgentSettings({
  organizationId,
  repo,
  orgDefault,
  trust,
  trustedAuthorThreshold,
}: {
  organizationId: string;
  repo: ReviewAgentStoredRow | undefined;
  orgDefault: ReviewAgentStoredRow | undefined;
  trust: ReviewAgentTrust | null;
  trustedAuthorThreshold: TrustedAuthorThreshold;
}): ReviewAgentDispatch {
  const { dispatch, runTestsRequested } = resolveStored({
    organizationId,
    repo,
    orgDefault,
  });
  return runTestsRequested
    ? applyRunTestsGate(dispatch, trust, trustedAuthorThreshold)
    : dispatch;
}

/**
 * Resolve from the already-fetched repo and '*' rows (dispatch reads them
 * once for every review family). The trusted-author threshold's repo half
 * comes from the same repo row; the org half is read ONLY when the trust gate
 * actually runs (orchestrated with runTests requested). Throws on an invalid
 * stored value; the dispatch caller decides what that means.
 */
export async function resolveReviewAgentFromRows({
  db,
  organizationId,
  repo,
  orgDefault,
  trustContext,
}: {
  db: DB;
  organizationId: string;
  repo: RepoReviewSetting | undefined;
  orgDefault: RepoReviewSetting | undefined;
  trustContext: ThreadTrustContext | null;
}): Promise<ReviewAgentDispatch> {
  const { dispatch, runTestsRequested } = resolveStored({
    organizationId,
    repo,
    orgDefault,
  });
  if (!runTestsRequested) {
    return dispatch;
  }
  const orgSetting = await getOrganizationReviewSetting({
    db,
    organizationId,
  });
  return applyRunTestsGate(
    dispatch,
    trustContext,
    composeTrustedAuthorThreshold(orgSetting, repo),
  );
}

/** Thin DB loader: one query for the repo + '*' rows, then the resolver. */
export async function resolveReviewAgentForDispatch({
  db,
  organizationId,
  repoFullName,
  trustContext,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  trustContext: ThreadTrustContext | null;
}): Promise<ReviewAgentDispatch> {
  const { repo, orgDefault } = await getRepoReviewSettingWithOrgDefault({
    db,
    organizationId,
    repoFullName,
  });
  return resolveReviewAgentFromRows({
    db,
    organizationId,
    repo,
    orgDefault,
    trustContext,
  });
}
