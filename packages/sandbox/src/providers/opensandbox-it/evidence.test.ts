import { describe, expect, it } from "vitest";

import {
  RUNC_REQUIRED_CHECKS,
  buildConformanceEvidence,
  type BuildConformanceEvidenceInput,
  type ConformanceChecks,
} from "./evidence";

const ok = (name: string) => ({ name, ok: true });

function checks(): ConformanceChecks {
  return {
    egress_enforced: [ok("https_allowed"), ok("tcp80_blocked")],
    metadata_blocked: [ok("metadata")],
    peer_isolated: [ok("peer")],
    teardown_verified: [ok("settled")],
    secret_brokering: [ok("canary")],
    provider_creds_in_guest: [ok("env_names")],
    provider_endpoints_reachable: [ok("gateway")],
  };
}

function input(
  overrides: Partial<BuildConformanceEvidenceInput> = {},
): BuildConformanceEvidenceInput {
  return {
    profileId: "opensandbox/runc",
    allowlist: ["httpbin.org"],
    checks: checks(),
    measuredAt: new Date("2026-11-16T00:00:00Z"),
    platformSha: "abc123",
    artifactDigest: "sha256:deadbeef",
    required: {},
    ...overrides,
  };
}

describe("buildConformanceEvidence", () => {
  it("emits the row set the guard and cell.rego read", () => {
    const rows = buildConformanceEvidence(input());
    const byCapability = Object.fromEntries(
      rows.map((r) => [r.capability, r.result.value]),
    );
    expect(byCapability).toEqual({
      egress: "allowlist",
      egress_allowlist: ["httpbin.org"],
      metadata_blocked: true,
      peer_isolated: true,
      teardown_verified: true,
      secret_brokering: true,
      dns_closed: false,
      provider_creds_in_guest: false,
      provider_endpoints_reachable: false,
    });
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.source).toBe("conformance");
      expect(row.profileId).toBe("opensandbox/runc");
      expect(row.platformSha).toBe("abc123");
      expect(row.artifactDigest).toBe("sha256:deadbeef");
      expect(row).not.toHaveProperty("expiresAt");
      expect(row.result.checks.length).toBeGreaterThan(0);
    }
  });

  it("throws on any failed check", () => {
    const bad = checks();
    bad.peer_isolated = [{ name: "peer", ok: false }];
    expect(() => buildConformanceEvidence(input({ checks: bad }))).toThrow(
      /peer_isolated: peer/,
    );
  });

  it("throws on a group with no checks", () => {
    const bad = checks();
    bad.metadata_blocked = [];
    expect(() => buildConformanceEvidence(input({ checks: bad }))).toThrow(
      /no checks for metadata_blocked/,
    );
  });

  it("throws on an empty allowlist", () => {
    expect(() => buildConformanceEvidence(input({ allowlist: [] }))).toThrow(
      /allowlist is empty/,
    );
    expect(() => buildConformanceEvidence(input({ allowlist: [" "] }))).toThrow(
      /allowlist is empty/,
    );
  });
  it("throws when a required check never ran", () => {
    expect(() =>
      buildConformanceEvidence(
        input({ required: { peer_isolated: ["peer", "peer_80"] } }),
      ),
    ).toThrow("missing checks in peer_isolated: peer_80");
  });

  it("passes when every required check is present", () => {
    expect(
      buildConformanceEvidence(
        input({ required: { egress_enforced: ["https_allowed"] } }),
      ),
    ).toHaveLength(9);
  });
  it("requires at least one check for every group of the runc profile", () => {
    for (const group of Object.keys(checks())) {
      expect(
        RUNC_REQUIRED_CHECKS[group as keyof ConformanceChecks].length,
      ).toBeGreaterThan(0);
    }
  });
});
