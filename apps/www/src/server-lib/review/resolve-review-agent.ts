import type { DB } from "@terragon/shared/db";
import type {
  RepoReviewSetting,
  ThreadTrustContext,
} from "@terragon/shared/db/types";
import { getRepoReviewSettingWithOrgDefault } from "@terragon/shared/model/repo-review-settings";
import {
  DEFAULT_REVIEW_MODE,
  REVIEW_BATTERY_PACK_IDS,
  findReviewAgentFieldError,
  type ReviewBatteryPackId,
  type ReviewMode,
} from "@terragon/shared/model/review-agent-settings";
import {
  capPermissionMode,
  type TrustedAuthorThreshold,
} from "@terragon/review/settings/permission-floor";

import { resolveTrustedAuthorThreshold } from "./resolve-permission-mode";

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
export const CLASSIC_COMMAND_TIMEOUT_MS = 60_000;
/** Orchestrated default when no timeout is stored. */
export const ORCHESTRATED_COMMAND_TIMEOUT_MS = 300_000;

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
  | "repoFullName"
  | "reviewMode"
  | "reviewBatteries"
  | "reviewRunTests"
  | "reviewCommandTimeoutS"
  | "reviewMaxTurns"
>;

type ReviewAgentTrust = Pick<
  ThreadTrustContext,
  "isFork" | "authorAssociation" | "isCrossRepo"
>;

type StoredField = Exclude<keyof ReviewAgentStoredRow, "repoFullName">;

function pickValidated<F extends StoredField>(
  field: F,
  organizationId: string,
  rows: ReadonlyArray<ReviewAgentStoredRow | undefined>,
): NonNullable<ReviewAgentStoredRow[F]> | undefined {
  for (const row of rows) {
    const value = row?.[field];
    if (row === undefined || value === null || value === undefined) {
      continue;
    }
    const error = findReviewAgentFieldError({ [field]: value });
    if (error !== undefined) {
      throw new Error(
        `Unknown ${field} ${JSON.stringify(value)} stored for (${organizationId}, ${row.repoFullName}) — ` +
          `refusing to dispatch with a silently-degraded review-agent setting (${error})`,
      );
    }
    return value;
  }
  return undefined;
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
  const rows = [repo, orgDefault] as const;
  // Validate every picked value BEFORE mode gating, so an invalid stored
  // value throws even when classic would ignore it.
  const storedMode = pickValidated("reviewMode", organizationId, rows);
  const storedBatteries = pickValidated(
    "reviewBatteries",
    organizationId,
    rows,
  );
  const storedRunTests = pickValidated("reviewRunTests", organizationId, rows);
  const storedTimeoutS = pickValidated(
    "reviewCommandTimeoutS",
    organizationId,
    rows,
  );
  const storedMaxTurns = pickValidated("reviewMaxTurns", organizationId, rows);

  // pickValidated has checked these against the allowed values.
  const mode = (storedMode as ReviewMode | undefined) ?? DEFAULT_REVIEW_MODE;
  const batteries = storedBatteries
    ? [...(storedBatteries as ReviewBatteryPackId[])]
    : [...REVIEW_BATTERY_PACK_IDS];

  if (mode === "classic") {
    return {
      mode,
      batteries,
      runTests: false,
      commandTimeoutMs: CLASSIC_COMMAND_TIMEOUT_MS,
    };
  }

  const commandTimeoutMs =
    storedTimeoutS !== undefined
      ? storedTimeoutS * 1000
      : ORCHESTRATED_COMMAND_TIMEOUT_MS;
  const requestedRunTests = storedRunTests ?? false;
  const downgrade = requestedRunTests
    ? findRunTestsDowngrade(trust, trustedAuthorThreshold)
    : undefined;

  return {
    mode,
    batteries,
    runTests: requestedRunTests && downgrade === undefined,
    ...(downgrade !== undefined ? { runTestsDowngradedReason: downgrade } : {}),
    commandTimeoutMs,
    ...(storedMaxTurns !== undefined ? { maxTurns: storedMaxTurns } : {}),
  };
}

/**
 * Thin DB loader: one query for the repo + '*' rows and the composed
 * trusted-author threshold, then the pure resolver. Throws on an invalid
 * stored value; the dispatch caller decides what that means.
 */
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
  const [{ repo, orgDefault }, trustedAuthorThreshold] = await Promise.all([
    getRepoReviewSettingWithOrgDefault({ db, organizationId, repoFullName }),
    resolveTrustedAuthorThreshold({ db, organizationId, repoFullName }),
  ]);
  return resolveReviewAgentSettings({
    organizationId,
    repo,
    orgDefault,
    trust: trustContext
      ? {
          isFork: trustContext.isFork,
          isCrossRepo: trustContext.isCrossRepo,
          authorAssociation: trustContext.authorAssociation,
        }
      : null,
    trustedAuthorThreshold,
  });
}
