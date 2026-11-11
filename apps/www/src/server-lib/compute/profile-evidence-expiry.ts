import type { DB } from "@terragon/shared/db";
import {
  getCurrentProfileEvidence,
  listExecutionProfiles,
  profileRecordForPolicy,
} from "@terragon/shared/model/execution-profiles";
import type { OpsAlertResult } from "@/server-lib/knowledge/ops-alert";

/**
 * ADR-014 evidence upkeep: warn the operator a week before a profile's
 * evidence runs out, since an expired profile is denied `evidence_expired` by
 * the policy. Runs once a day, from the hourly cron at EVIDENCE_CHECK_UTC_HOUR.
 *
 * A profile's expiry is the EARLIEST among its current capability rows, the
 * same figure the policy reads (profileRecordForPolicy). A profile with no
 * evidence at all is reported too.
 */

export const EVIDENCE_ALERT_WINDOW_DAYS = 7;
export const EVIDENCE_CHECK_UTC_HOUR = 13;

const DAY_MS = 86_400_000;

export interface ExpiringProfile {
  profileId: string;
  /** Null when the profile has no evidence row at all. */
  expiresAt: string | null;
}

export async function findExpiringProfiles({
  db,
  now,
}: {
  db: DB;
  now: Date;
}): Promise<ExpiringProfile[]> {
  const cutoff = now.getTime() + EVIDENCE_ALERT_WINDOW_DAYS * DAY_MS;
  const expiring: ExpiringProfile[] = [];
  for (const profile of await listExecutionProfiles({ db })) {
    const evidence = await getCurrentProfileEvidence({
      db,
      profileId: profile.id,
    });
    const expiresAt =
      profileRecordForPolicy(profile, evidence).profile.evidence?.expires_at ??
      null;
    if (expiresAt === null || new Date(expiresAt).getTime() < cutoff) {
      expiring.push({ profileId: profile.id, expiresAt });
    }
  }
  return expiring;
}

export function formatExpiringProfilesAlert(
  expiring: ExpiringProfile[],
  now: Date,
): { text: string } {
  const items = expiring.map(({ profileId, expiresAt }) => {
    if (expiresAt === null) return `${profileId} has no evidence`;
    const verb = new Date(expiresAt) <= now ? "expired" : "expires";
    return `${profileId} ${verb} ${expiresAt}`;
  });
  return {
    text: `execution profile evidence within ${EVIDENCE_ALERT_WINDOW_DAYS} days of expiry (the policy denies evidence_expired): ${items.join("; ")}. Renew with the box probes (packages/worker/deploy/README.md, "Security probes").`,
  };
}

/** Once a day; never throws. Returns what it found, for the logs and tests. */
export async function runProfileEvidenceExpiryCheck({
  db,
  now,
  alert,
}: {
  db: DB;
  now: Date;
  alert: (payload: { text: string }) => Promise<OpsAlertResult>;
}): Promise<{ ran: boolean; expiring: ExpiringProfile[]; alerted: boolean }> {
  if (now.getUTCHours() !== EVIDENCE_CHECK_UTC_HOUR) {
    return { ran: false, expiring: [], alerted: false };
  }
  const expiring = await findExpiringProfiles({ db, now });
  if (expiring.length === 0) return { ran: true, expiring, alerted: false };
  const result = await alert(formatExpiringProfilesAlert(expiring, now));
  return { ran: true, expiring, alerted: result.sent };
}
