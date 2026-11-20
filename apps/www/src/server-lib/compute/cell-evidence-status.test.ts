import { describe, expect, it } from "vitest";

import type { CellPolicyProfile } from "@terragon/shared/cell-policy/cell-policy";

import {
  cellEvidenceNeedsAttention,
  classifyCellEvidence,
} from "./cell-evidence-status";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-12-12T13:00:00.000Z");

/** The runc profile as cell-plan reads it, with conformance evidence expiring at `expiresAt`. */
function profile(
  expiresAt: Date | null,
  over: Partial<CellPolicyProfile> = {},
): CellPolicyProfile {
  return {
    id: "opensandbox/runc",
    provider: "opensandbox",
    tier: "customer_box",
    configuration: { egress_mode: "enforce" },
    capabilities: {
      egress: "allowlist",
      egress_allowlist: ["api.anthropic.com", "www.example.test"],
    },
    ...(expiresAt
      ? {
          evidence: {
            source: "conformance",
            measured_at: new Date(
              expiresAt.getTime() - 30 * DAY_MS,
            ).toISOString(),
            expires_at: expiresAt.toISOString(),
          },
        }
      : {}),
    ...over,
  };
}

describe("classifyCellEvidence (#709)", () => {
  it("fresh: more than 7 days left is ok, and needs no attention", () => {
    const expires = new Date(NOW.getTime() + 20 * DAY_MS + 3_600_000);
    const s = classifyCellEvidence({
      configured: true,
      profile: profile(expires),
      now: NOW,
    });
    expect(s).toEqual({
      status: "ok",
      expiresAt: expires.toISOString(),
      daysLeft: 20,
    });
    expect(cellEvidenceNeedsAttention(s)).toBe(false);
  });

  it("exactly 7 days left is still ok; one ms less is expiring", () => {
    const at7 = new Date(NOW.getTime() + 7 * DAY_MS);
    expect(
      classifyCellEvidence({
        configured: true,
        profile: profile(at7),
        now: NOW,
      }).status,
    ).toBe("ok");
    const under7 = new Date(at7.getTime() - 1);
    expect(
      classifyCellEvidence({
        configured: true,
        profile: profile(under7),
        now: NOW,
      }),
    ).toEqual({
      status: "expiring",
      expiresAt: under7.toISOString(),
      daysLeft: 6,
    });
  });

  it("within 7 days: expiring, and needs attention", () => {
    const expires = new Date(NOW.getTime() + 2 * DAY_MS);
    const s = classifyCellEvidence({
      configured: true,
      profile: profile(expires),
      now: NOW,
    });
    expect(s).toEqual({
      status: "expiring",
      expiresAt: expires.toISOString(),
      daysLeft: 2,
    });
    expect(cellEvidenceNeedsAttention(s)).toBe(true);
  });

  it("expired: refused with the guard's evidence_expired, the reason cell-plan refuses with", () => {
    for (const expires of [NOW, new Date(NOW.getTime() - DAY_MS)]) {
      const s = classifyCellEvidence({
        configured: true,
        profile: profile(expires),
        now: NOW,
      });
      expect(s).toEqual({
        status: "refused",
        reason: "evidence_expired",
        expiresAt: expires.toISOString(),
      });
      expect(cellEvidenceNeedsAttention(s)).toBe(true);
    }
  });

  it("no evidence, foreign evidence or no profile row: refused, named", () => {
    expect(
      classifyCellEvidence({
        configured: true,
        profile: profile(null),
        now: NOW,
      }),
    ).toEqual({
      status: "refused",
      reason: "evidence_missing",
      expiresAt: null,
    });
    const later = new Date(NOW.getTime() + 20 * DAY_MS);
    expect(
      classifyCellEvidence({
        configured: true,
        profile: profile(later, {
          evidence: {
            source: "manual",
            measured_at: NOW.toISOString(),
            expires_at: later.toISOString(),
          },
        }),
        now: NOW,
      }),
    ).toMatchObject({
      status: "refused",
      reason: "evidence_not_from_conformance",
    });
    expect(
      classifyCellEvidence({ configured: true, profile: null, now: NOW }),
    ).toEqual({
      status: "refused",
      reason: "unknown_profile",
      expiresAt: null,
    });
  });

  it("cells unconfigured: unconfigured whatever the evidence, and needs no attention", () => {
    for (const p of [
      null,
      profile(null),
      profile(new Date(NOW.getTime() - DAY_MS)),
    ]) {
      const s = classifyCellEvidence({
        configured: false,
        profile: p,
        now: NOW,
      });
      expect(s).toEqual({ status: "unconfigured" });
      expect(cellEvidenceNeedsAttention(s)).toBe(false);
    }
  });
});
