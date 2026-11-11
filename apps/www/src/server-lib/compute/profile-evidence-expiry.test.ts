import { describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  insertProfileEvidence,
  upsertExecutionProfile,
} from "@terragon/shared/model/execution-profiles";
import {
  EVIDENCE_CHECK_UTC_HOUR,
  findExpiringProfiles,
  formatExpiringProfilesAlert,
  runProfileEvidenceExpiryCheck,
} from "./profile-evidence-expiry";

const DAY_MS = 86_400_000;
const NOW = new Date(
  `2026-12-03T${String(EVIDENCE_CHECK_UTC_HOUR).padStart(2, "0")}:00:00Z`,
);

async function profileMeasuredAt(...measuredAt: Date[]) {
  const p = await upsertExecutionProfile({
    db,
    id: `test/${nanoid(8)}`,
    provider: `prov-${nanoid(6)}`,
    tier: "customer_box",
    configuration: { egress_mode: "observe" },
  });
  for (const [i, at] of measuredAt.entries()) {
    await insertProfileEvidence({
      db,
      evidence: {
        profileId: p.id,
        capability: `cap_${i}`,
        measuredAt: at,
        source: "conformance",
        result: { value: true },
      },
    });
  }
  return p.id;
}

describe("findExpiringProfiles (DB)", () => {
  it("reports a profile whose EARLIEST current row expires within 7 days, or has none", async () => {
    const fresh = await profileMeasuredAt(new Date(NOW.getTime() - 2 * DAY_MS));
    // One stale capability is enough: the policy reads the earliest expiry.
    const staleOne = await profileMeasuredAt(
      new Date(NOW.getTime() - 2 * DAY_MS),
      new Date(NOW.getTime() - 25 * DAY_MS),
    );
    const expired = await profileMeasuredAt(
      new Date(NOW.getTime() - 31 * DAY_MS),
    );
    const empty = await profileMeasuredAt();

    const found = await findExpiringProfiles({ db, now: NOW });
    const byId = new Map(found.map((p) => [p.profileId, p.expiresAt]));
    expect(byId.has(fresh)).toBe(false);
    expect(byId.get(staleOne)).toBe(
      new Date(NOW.getTime() + 5 * DAY_MS).toISOString(),
    );
    expect(byId.get(expired)).toBe(
      new Date(NOW.getTime() - DAY_MS).toISOString(),
    );
    expect(byId.has(empty)).toBe(true);
    expect(byId.get(empty)).toBeNull();
  });
});

describe("formatExpiringProfilesAlert", () => {
  it("says expires, expired or no evidence, with ids and dates only", () => {
    const { text } = formatExpiringProfilesAlert(
      [
        {
          profileId: "automata-box/enforce",
          expiresAt: "2026-12-10T16:30:00.000Z",
        },
        { profileId: "a/old", expiresAt: "2026-12-01T00:00:00.000Z" },
        { profileId: "a/none", expiresAt: null },
      ],
      NOW,
    );
    expect(text).toContain(
      "automata-box/enforce expires 2026-12-10T16:30:00.000Z",
    );
    expect(text).toContain("a/old expired 2026-12-01T00:00:00.000Z");
    expect(text).toContain("a/none has no evidence");
  });
});

describe("runProfileEvidenceExpiryCheck", () => {
  it("does nothing outside the daily check hour", async () => {
    const alert = vi.fn(async () => ({ sent: true as const }));
    const result = await runProfileEvidenceExpiryCheck({
      db,
      now: new Date(NOW.getTime() + 3600_000),
      alert,
    });
    expect(result).toEqual({ ran: false, expiring: [], alerted: false });
    expect(alert).not.toHaveBeenCalled();
  });

  it("alerts once at the check hour when a profile is near expiry", async () => {
    const id = await profileMeasuredAt(new Date(NOW.getTime() - 28 * DAY_MS));
    const alert = vi.fn(async () => ({ sent: true as const }));
    const result = await runProfileEvidenceExpiryCheck({ db, now: NOW, alert });
    expect(result.ran).toBe(true);
    expect(result.alerted).toBe(true);
    expect(result.expiring.map((p) => p.profileId)).toContain(id);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
