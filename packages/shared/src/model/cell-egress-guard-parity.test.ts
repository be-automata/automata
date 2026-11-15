import { beforeAll, describe, expect, it } from "vitest";

import {
  loadCellPolicy,
  type CellPolicy,
  type CellPolicyInput,
  type CellPolicyProfile,
} from "../cell-policy/cell-policy";
import { readCellPolicyWasm } from "../cell-policy/cell-policy-file";

import {
  assertCellEgressEnforced,
  CellEgressNotEnforcedError,
  type CellEgressRefusal,
} from "./cell-egress-guard";

/**
 * The TS guard and cell.rego (compiled to the committed cell.wasm) must agree
 * on allow/deny for a managed-tier profile, and every guard refusal must map to
 * a reason the policy also emits.
 */

const NOW = "2026-11-08T12:00:00Z";
const server = {
  data_class: "server",
  repo_visibility: "server",
  untrusted_content: "server",
  irreversible: "server",
  lane: "server",
  secrets: "server",
  needs_egress: "server",
};
const cell = {
  data_class: "synthetic",
  repo_visibility: "public",
  untrusted_content: false,
  irreversible: false,
  lane: "implement",
  secrets: [] as string[],
  needs_egress: ["gateway.example"],
};

const base: CellPolicyProfile = {
  id: "agent37/gvisor/allowlist",
  provider: "agent37",
  tier: "managed",
  configuration: { egress_mode: "enforce" },
  capabilities: {
    egress: "allowlist",
    egress_allowlist: ["gateway.example"],
    dns_closed: false,
    metadata_blocked: true,
    peer_isolated: true,
    teardown_verified: true,
    provider_creds_in_guest: true,
    provider_endpoints_reachable: false,
  },
  evidence: {
    source: "conformance",
    measured_at: "2026-11-08T00:00:00Z",
    expires_at: "2026-12-08T00:00:00Z",
  },
  legal: { status: "embedding_allowed", expires_at: "2027-05-06T00:00:00Z" },
};

const evidence = (patch: Record<string, unknown>) => ({
  ...base,
  evidence: { ...base.evidence, ...patch },
});

/** guard reason -> the rego reasons that may carry it (any one is enough). */
const REGO_REASONS: Record<
  Exclude<CellEgressRefusal, "allowlist_empty" | "unknown_profile">,
  string[]
> = {
  egress_mode_not_enforce: ["egress_not_enforced"],
  egress_not_allowlist: ["egress_not_enforced"],
  evidence_missing: ["evidence_missing"],
  evidence_not_from_conformance: ["evidence_not_from_conformance"],
  evidence_invalid: [], // rego's parse builtin throws instead; see the row below
  evidence_expired: ["evidence_expired"],
};

const without = (o: Record<string, unknown>, key: string) => {
  const { [key]: _drop, ...rest } = o;
  return rest;
};

const ROWS: {
  name: string;
  profile: Record<string, unknown>;
  guard: CellEgressRefusal | null;
}[] = [
  {
    name: "enforce + allowlist + current evidence",
    profile: base,
    guard: null,
  },
  {
    name: "observe mode",
    profile: { ...base, configuration: { egress_mode: "observe" } },
    guard: "egress_mode_not_enforce",
  },
  {
    name: "missing mode",
    profile: without(base, "configuration"),
    guard: "egress_mode_not_enforce",
  },
  {
    name: "unknown mode",
    profile: { ...base, configuration: { egress_mode: "audit" } },
    guard: "egress_mode_not_enforce",
  },
  {
    name: "caps.egress none",
    profile: {
      ...base,
      capabilities: { ...base.capabilities, egress: "none" },
    },
    guard: "egress_not_allowlist",
  },
  {
    name: "caps.egress open",
    profile: {
      ...base,
      capabilities: { ...base.capabilities, egress: "open" },
    },
    guard: "egress_not_allowlist",
  },
  {
    name: "evidence missing",
    profile: without(base, "evidence"),
    guard: "evidence_missing",
  },
  {
    name: "evidence from vendor docs",
    profile: evidence({ source: "vendor_docs" }),
    guard: "evidence_not_from_conformance",
  },
  {
    name: "evidence expired",
    profile: evidence({ expires_at: "2026-11-08T11:59:59Z" }),
    guard: "evidence_expired",
  },
];

describe("cell egress guard vs compiled cell.wasm", () => {
  let policy: CellPolicy;
  beforeAll(async () => {
    policy = await loadCellPolicy(await readCellPolicyWasm());
  });

  it.each(ROWS)("$name", ({ profile, guard }) => {
    const decision = policy.evaluate({
      now: NOW,
      cell,
      provenance: server,
      profile,
    } as unknown as CellPolicyInput);

    let refusal: CellEgressRefusal | null = null;
    try {
      assertCellEgressEnforced({
        profile: profile as unknown as CellPolicyProfile,
        now: new Date(NOW),
      });
    } catch (e) {
      expect(e).toBeInstanceOf(CellEgressNotEnforcedError);
      refusal = (e as CellEgressNotEnforcedError).reason;
    }

    expect(refusal).toBe(guard);
    expect(decision.allowed).toBe(guard === null);
    if (refusal !== null && refusal in REGO_REASONS) {
      const mapped = REGO_REASONS[refusal as keyof typeof REGO_REASONS];
      expect(mapped.some((r) => decision.reasons.includes(r))).toBe(true);
    }
  });

  // allowlist_empty has no rego equivalent: the policy checks each host the
  // cell needs against the list (egress_host_not_allowed), not that the list is
  // non-empty, so only the guard refuses it. Asserted on the guard side alone.
  it("allowlist_empty is a guard-only refusal", () => {
    const empty = {
      ...base,
      capabilities: { ...base.capabilities, egress_allowlist: [] },
    };
    expect(() =>
      assertCellEgressEnforced({ profile: empty, now: new Date(NOW) }),
    ).toThrow(/allowlist_empty/);
  });
});
