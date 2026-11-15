import { describe, expect, it } from "vitest";

import type { CellPolicyProfile } from "../cell-policy/cell-policy";

import {
  assertCellEgressEnforced,
  CellEgressNotEnforcedError,
  type CellEgressRefusal,
} from "./cell-egress-guard";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const FUTURE = "2026-11-15T12:00:00.001Z"; // 1 ms after NOW
const EQUAL = "2026-11-15T12:00:00.000Z";

function profile(patch: Partial<CellPolicyProfile> = {}): CellPolicyProfile {
  return {
    id: "test/profile",
    provider: "test",
    tier: "managed",
    configuration: { egress_mode: "enforce" },
    capabilities: {
      egress: "allowlist",
      egress_allowlist: ["broker.automata.test"],
    },
    evidence: {
      source: "conformance",
      measured_at: "2026-11-01T00:00:00Z",
      expires_at: FUTURE,
    },
    ...patch,
  };
}

function reasonOf(
  p: Parameters<typeof assertCellEgressEnforced>[0]["profile"],
): CellEgressRefusal | undefined {
  try {
    assertCellEgressEnforced({ profile: p, now: NOW });
  } catch (e) {
    expect(e).toBeInstanceOf(CellEgressNotEnforcedError);
    if (e instanceof CellEgressNotEnforcedError) {
      expect(e.message).toBe(`cell egress not enforced: ${e.reason}`);
      return e.reason;
    }
  }
  return undefined;
}

describe("assertCellEgressEnforced", () => {
  it("passes for enforce + allowlist + current conformance evidence", () => {
    expect(reasonOf(profile())).toBeUndefined();
  });

  it.each<[string, Parameters<typeof reasonOf>[0], CellEgressRefusal]>([
    ["null", null, "unknown_profile"],
    ["undefined", undefined, "unknown_profile"],
    ["an empty record", {}, "unknown_profile"],
    ["no id", profile({ id: "" }), "unknown_profile"],
    [
      "no configuration",
      profile({ configuration: undefined }),
      "egress_mode_missing",
    ],
    [
      "observe mode",
      profile({ configuration: { egress_mode: "observe" } }),
      "egress_mode_observe",
    ],
    [
      "an unknown mode",
      profile({ configuration: { egress_mode: "audit" } }),
      "egress_mode_unknown",
    ],
    [
      "egress none",
      profile({
        capabilities: { egress: "none", egress_allowlist: ["a.test"] },
      }),
      "egress_not_allowlist",
    ],
    [
      "no allowlist",
      profile({ capabilities: { egress: "allowlist" } }),
      "allowlist_empty",
    ],
    [
      "an empty allowlist",
      profile({ capabilities: { egress: "allowlist", egress_allowlist: [] } }),
      "allowlist_empty",
    ],
    [
      "a non-string allowlist",
      profile({ capabilities: { egress: "allowlist", egress_allowlist: [1] } }),
      "allowlist_empty",
    ],
    ["no evidence", profile({ evidence: undefined }), "evidence_missing"],
    [
      "evidence not from conformance",
      profile({
        evidence: {
          source: "self_report",
          measured_at: "2026-11-01T00:00:00Z",
          expires_at: FUTURE,
        },
      }),
      "evidence_not_from_conformance",
    ],
    [
      "an invalid expiry",
      profile({
        evidence: {
          source: "conformance",
          measured_at: "2026-11-01T00:00:00Z",
          expires_at: "tomorrow",
        },
      }),
      "evidence_invalid",
    ],
    [
      "an expiry equal to now",
      profile({
        evidence: {
          source: "conformance",
          measured_at: "2026-11-01T00:00:00Z",
          expires_at: EQUAL,
        },
      }),
      "evidence_expired",
    ],
  ])("refuses %s", (_name, p, reason) => {
    expect(reasonOf(p)).toBe(reason);
  });
});
