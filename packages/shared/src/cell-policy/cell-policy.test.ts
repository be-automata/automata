import { beforeAll, describe, expect, it } from "vitest";
import {
  CELL_FIELDS,
  loadCellPolicy,
  parseRfc3339Ns,
  type CellPolicy,
  type CellPolicyInput,
  type CellPolicyProfile,
} from "./cell-policy";
import { readCellPolicyWasm } from "./cell-policy-file";

/**
 * The spike's opa test cases (policy/cell_test.rego), run against the
 * COMMITTED cell.wasm through the same loader www uses. `opa test` proves the
 * Rego; this proves the compiled artifact and its host (the custom
 * time.parse_rfc3339_ns builtin) agree with it.
 */

const NOW = "2026-11-08T12:00:00Z";
const server = Object.fromEntries(CELL_FIELDS.map((f) => [f, "server"]));

const syntheticCell = {
  data_class: "synthetic",
  repo_visibility: "public",
  untrusted_content: false,
  irreversible: false,
  lane: "implement",
  secrets: [] as string[],
  needs_egress: ["gateway.example"],
} as const;

const allowlistProfile: CellPolicyProfile = {
  id: "agent37/gvisor/allowlist",
  provider: "agent37",
  tier: "managed",
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

type AnyInput = Record<string, unknown>;

const req = (
  cell: Record<string, unknown> = { ...syntheticCell },
  profile: Record<string, unknown> = allowlistProfile,
): AnyInput => ({ now: NOW, cell, provenance: server, profile });

const withCaps = (caps: Record<string, unknown>) => ({
  ...allowlistProfile,
  capabilities: { ...allowlistProfile.capabilities, ...caps },
});

const without = <T extends Record<string, unknown>>(o: T, key: string) => {
  const { [key]: _drop, ...rest } = o;
  return rest;
};

type Case = {
  name: string;
  input: AnyInput;
  allowed: boolean;
  /** Reasons that must be present (all of them). */
  reasons?: string[];
};

const CASES: Case[] = [
  {
    name: "synthetic cell on the allowlist profile is allowed",
    input: req(),
    allowed: true,
    reasons: [],
  },
  {
    name: "missing field denies",
    input: req(without({ ...syntheticCell }, "data_class")),
    allowed: false,
    reasons: ["missing_field:data_class"],
  },
  {
    name: "expired evidence denies",
    input: req(undefined, {
      ...allowlistProfile,
      evidence: {
        ...allowlistProfile.evidence,
        expires_at: "2026-11-08T11:59:59Z",
      },
    }),
    allowed: false,
    reasons: ["evidence_expired"],
  },
  {
    name: "clock moved past expiry denies (31 days later)",
    input: { ...req(), now: "2026-12-09T12:00:00Z" },
    allowed: false,
    reasons: ["evidence_expired"],
  },
  {
    name: "self-declared input denies",
    input: {
      ...req(),
      provenance: { ...server, untrusted_content: "client" },
    },
    allowed: false,
    reasons: ["self_declared:untrusted_content"],
  },
  {
    name: "missing provenance counts as self-declared",
    input: without(req(), "provenance"),
    allowed: false,
    reasons: ["self_declared:data_class"],
  },
  {
    name: "empty input denies",
    input: {},
    allowed: false,
    reasons: ["unknown_profile", "missing_now", "evidence_missing"],
  },
  {
    name: "evidence from elsewhere denies",
    input: req(undefined, {
      ...allowlistProfile,
      evidence: { ...allowlistProfile.evidence, source: "vendor_docs" },
    }),
    allowed: false,
    reasons: ["evidence_not_from_conformance"],
  },
  {
    name: "unproven metadata block denies",
    input: req(undefined, {
      ...allowlistProfile,
      capabilities: without(allowlistProfile.capabilities, "metadata_blocked"),
    }),
    allowed: false,
    reasons: ["metadata_not_proven_blocked"],
  },
  {
    name: "open egress denies",
    input: req(undefined, withCaps({ egress: "open" })),
    allowed: false,
    reasons: ["egress_open"],
  },
  {
    name: "observe mode counts as open egress",
    input: req(undefined, {
      ...allowlistProfile,
      configuration: { egress_mode: "observe" },
    }),
    allowed: false,
    reasons: ["egress_open"],
  },
  {
    name: "enforce mode keeps the measured egress",
    input: req(undefined, {
      ...allowlistProfile,
      configuration: { egress_mode: "enforce" },
    }),
    allowed: true,
    reasons: [],
  },
  {
    name: "host outside the allowlist denies",
    input: req({
      ...syntheticCell,
      needs_egress: ["gateway.example", "attacker.example"],
    }),
    allowed: false,
    reasons: ["egress_host_not_allowed:attacker.example"],
  },
  {
    name: "untrusted content with provider creds and open DNS denies",
    input: req({ ...syntheticCell, untrusted_content: true }),
    allowed: false,
    reasons: ["provider_creds_exfiltrable_by_dns"],
  },
  {
    name: "unmeasured provider risks count as present",
    input: req(
      { ...syntheticCell, untrusted_content: true },
      {
        ...allowlistProfile,
        capabilities: {
          ...without(
            without(allowlistProfile.capabilities, "provider_creds_in_guest"),
            "provider_endpoints_reachable",
          ),
          dns_closed: true,
        },
      },
    ),
    allowed: false,
    reasons: ["provider_endpoints_reachable"],
  },
  {
    name: "untrusted content allowed when DNS closed and endpoints unreachable",
    input: req(
      { ...syntheticCell, untrusted_content: true },
      withCaps({ dns_closed: true }),
    ),
    allowed: true,
  },
  {
    name: "secrets without brokering deny",
    input: req({ ...syntheticCell, secrets: ["github_write"] }),
    allowed: false,
    reasons: ["secrets_need_brokering", "secrets_exfiltrable_by_dns"],
  },
  {
    name: "managed tier bars a private repo",
    input: req({ ...syntheticCell, repo_visibility: "private" }),
    allowed: false,
    reasons: ["private_repo_barred"],
  },
  {
    name: "managed tier bars personal data",
    input: req({ ...syntheticCell, data_class: "pii" }),
    allowed: false,
    reasons: ["data_class_barred:pii"],
  },
  {
    name: "managed tier bars an irreversible step",
    input: req({ ...syntheticCell, irreversible: true }),
    allowed: false,
    reasons: ["irreversible_barred"],
  },
  {
    name: "managed tier bars the review lane",
    input: req({ ...syntheticCell, lane: "review" }),
    allowed: false,
    reasons: ["review_lane_barred"],
  },
  {
    name: "missing legal record denies",
    input: req(undefined, without({ ...allowlistProfile }, "legal")),
    allowed: false,
    reasons: ["legal_record_missing"],
  },
  {
    name: "expired legal record denies",
    input: req(undefined, {
      ...allowlistProfile,
      legal: {
        status: "embedding_allowed",
        expires_at: "2026-01-01T00:00:00Z",
      },
    }),
    allowed: false,
    reasons: ["legal_record_expired"],
  },
  {
    name: "customer box is not held to the managed bars",
    input: req(
      { ...syntheticCell, repo_visibility: "private", data_class: "internal" },
      {
        ...withCaps({ provider_creds_in_guest: false }),
        tier: "customer_box",
      },
    ),
    allowed: true,
  },
];

describe("allow_cell compiled to WASM", () => {
  let policy: CellPolicy;

  beforeAll(async () => {
    policy = await loadCellPolicy(await readCellPolicyWasm());
  });

  it.each(CASES)("$name", ({ input, allowed, reasons }) => {
    const decision = policy.evaluate(input as CellPolicyInput);
    expect(decision.allowed).toBe(allowed);
    if (reasons && reasons.length === 0) {
      expect(decision.reasons).toEqual([]);
    }
    for (const reason of reasons ?? []) {
      expect(decision.reasons).toContain(reason);
    }
    // Deny by default: a denial always names a reason.
    if (!decision.allowed) {
      expect(decision.reasons.length).toBeGreaterThan(0);
    }
  });

  it("reasons come back sorted and unique", () => {
    const decision = policy.evaluate({} as CellPolicyInput);
    expect(decision.reasons).toEqual([...new Set(decision.reasons)].sort());
  });

  it("one instance serves many evaluations", () => {
    for (let i = 0; i < 200; i++) {
      expect(policy.evaluate(req() as CellPolicyInput).allowed).toBe(true);
    }
  });

  it("a malformed timestamp throws out of evaluate (the caller fails closed)", () => {
    expect(() =>
      policy.evaluate({ ...req(), now: "yesterday" } as CellPolicyInput),
    ).toThrow(/parse_rfc3339_ns/);
  });

  it("accepts a precompiled WebAssembly.Module (the Workers path)", async () => {
    const module = await WebAssembly.compile(await readCellPolicyWasm());
    const fromModule = await loadCellPolicy(module);
    expect(fromModule.evaluate(req() as CellPolicyInput)).toEqual({
      allowed: true,
      reasons: [],
    });
  });
});

describe("parseRfc3339Ns", () => {
  it("parses RFC 3339 to nanoseconds", () => {
    expect(parseRfc3339Ns("1970-01-01T00:00:01Z")).toBe(1e9);
    expect(parseRfc3339Ns("1970-01-01T01:00:00+01:00")).toBe(0);
  });

  it.each(["2026-11-08", "Nov 8 2026", "", 42, null])("rejects %s", (value) => {
    expect(() => parseRfc3339Ns(value)).toThrow(/not RFC 3339/);
  });
});
