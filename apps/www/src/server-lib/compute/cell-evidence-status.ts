import type { DB } from "@terragon/shared/db";
import {
  parseRfc3339Ns,
  type CellPolicyProfile,
} from "@terragon/shared/cell-policy/cell-policy";
import {
  CellEgressNotEnforcedError,
  assertCellEgressEnforced,
  type CellEgressRefusal,
} from "@terragon/shared/model/cell-egress-guard";
import {
  getCurrentProfileEvidence,
  getExecutionProfile,
  profileRecordForPolicy,
} from "@terragon/shared/model/execution-profiles";

import { OPENSANDBOX_RUNC_PROFILE_ID } from "@/server-lib/compute/cell-gate";
import { EVIDENCE_ALERT_WINDOW_DAYS } from "@/server-lib/compute/profile-evidence-expiry";

/**
 * #709: is the opensandbox/runc conformance evidence good enough for cell-plan,
 * and for how long? The same reads and the same guard cell-plan runs, so a
 * `refused` status is exactly the refusal every cell plan gets: the guard's
 * reason under `egress_not_enforced`, or `unknown_profile` with no profile row.
 * The expiry read is the EARLIEST among the current rows (profileRecordForPolicy),
 * the figure cell-plan enforces, not the newest row's. Read by the hourly cron (a log line) and the public status
 * endpoint the synthetic workflow polls (a `cell-evidence` issue).
 */

const DAY_MS = 86_400_000;

export type CellEvidenceStatus =
  | { status: "unconfigured" }
  | {
      status: "refused";
      reason: CellEgressRefusal;
      /** The earliest current expiry, when there is evidence at all. */
      expiresAt: string | null;
    }
  | { status: "expiring" | "ok"; expiresAt: string; daysLeft: number };

/** Pure: the clock and the configured flag are injected. */
export function classifyCellEvidence({
  configured,
  profile,
  now,
}: {
  configured: boolean;
  profile: CellPolicyProfile | null;
  now: Date;
}): CellEvidenceStatus {
  if (!configured) return { status: "unconfigured" };
  if (profile === null) {
    return { status: "refused", reason: "unknown_profile", expiresAt: null };
  }
  const expiresAt = profile.evidence?.expires_at ?? null;
  try {
    assertCellEgressEnforced({ profile, now });
  } catch (error) {
    if (!(error instanceof CellEgressNotEnforcedError)) throw error;
    return { status: "refused", reason: error.reason, expiresAt };
  }
  // The guard passed, so expires_at is a valid RFC 3339 instant after now.
  const expiresMs = parseRfc3339Ns(expiresAt ?? "") / 1e6;
  const leftMs = expiresMs - now.getTime();
  return {
    status: leftMs < EVIDENCE_ALERT_WINDOW_DAYS * DAY_MS ? "expiring" : "ok",
    expiresAt: new Date(expiresMs).toISOString(),
    daysLeft: Math.floor(leftMs / DAY_MS),
  };
}

export function cellEvidenceNeedsAttention(s: CellEvidenceStatus): boolean {
  return s.status === "expiring" || s.status === "refused";
}

/** The two reads cell-plan makes, skipped when cells are off. */
export async function readCellEvidenceStatus({
  db,
  now,
  configured,
}: {
  db: DB;
  now: Date;
  configured: boolean;
}): Promise<CellEvidenceStatus> {
  if (!configured) return { status: "unconfigured" };
  const [row, evidence] = await Promise.all([
    getExecutionProfile({ db, id: OPENSANDBOX_RUNC_PROFILE_ID }),
    getCurrentProfileEvidence({ db, profileId: OPENSANDBOX_RUNC_PROFILE_ID }),
  ]);
  return classifyCellEvidence({
    configured,
    profile: row ? profileRecordForPolicy(row, evidence).profile : null,
    now,
  });
}
