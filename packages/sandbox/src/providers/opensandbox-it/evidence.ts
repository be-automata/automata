/**
 * Conformance evidence for the OpenSandbox runc profile (#634 S3).
 *
 * Pure builder: turns the IT's measured checks into rows for
 * `insertProfileEvidenceRows` (@terragon/shared). `@terragon/sandbox` does not
 * import shared, so the row shape is declared here. There is no `expiresAt`:
 * the database generates it from `measuredAt`.
 */

export interface ConformanceEvidenceRow {
  profileId: string;
  capability: string;
  measuredAt: Date;
  source: "conformance";
  result: { value: unknown; checks: string[] };
  artifactDigest: string;
  platformSha: string;
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
}

export interface ConformanceChecks {
  egress_enforced: ConformanceCheck[];
  metadata_blocked: ConformanceCheck[];
  peer_isolated: ConformanceCheck[];
  teardown_verified: ConformanceCheck[];
  secret_brokering: ConformanceCheck[];
  provider_creds_in_guest: ConformanceCheck[];
  provider_endpoints_reachable: ConformanceCheck[];
}

export interface BuildConformanceEvidenceInput {
  profileId: string;
  allowlist: string[];
  checks: ConformanceChecks;
  measuredAt: Date;
  /** Git HEAD of the platform revision measured. */
  platformSha: string;
  /** `sha256:<hex>` of the results JSON. */
  artifactDigest: string;
  /**
   * Check names each group must contain. A check that never ran (an earlier
   * assertion threw, or `-t` filtered its scenario) is missing, so it fails.
   */
  required: Readonly<
    Partial<Record<keyof ConformanceChecks, readonly string[]>>
  >;
}

/**
 * Every check the OpenSandbox runc profile's rows rest on, by group. The IT
 * passes this as `required`, so a check that never ran fails the build.
 */
export const RUNC_REQUIRED_CHECKS = {
  egress_enforced: [
    "allowed_https_200",
    "allowed_80_blocked",
    "denied_dns_nxdomain",
    "denied_ip_tls_blocked",
    "denied_ip_80_blocked",
    "dot_blocked",
    "doh_by_ip_blocked",
    "wildcard_apex_allowed",
    "wildcard_sub_allowed",
    "wildcard_sibling_blocked",
    "policy_101_rules_enforced",
    "negative_control_reaches_4_of_4",
  ],
  metadata_blocked: ["metadata_169_254_blocked"],
  peer_isolated: ["peer_execd_blocked", "peer_80_blocked"],
  teardown_verified: [
    "after_revoke_bearer_401",
    "after_quarantine_host_blocked",
    "after_quarantine_learned_ip_blocked",
    "delete_deleted",
    "second_delete_gone",
    "no_survivors",
    "run_baseline_restored",
  ],
  secret_brokering: [
    "vault_injects_bearer",
    "guest_proc_has_no_secret",
    "inspect_has_no_secret",
    "logs_have_no_secret",
  ],
  provider_creds_in_guest: ["guest_env_has_no_provider_names"],
  provider_endpoints_reachable: [
    "guest_gateway_found",
    "server_api_at_gateway_blocked",
    "sidecar_policy_api_refuses_guest",
    "sidecar_vault_api_refuses_guest",
  ],
} as const satisfies Record<keyof ConformanceChecks, readonly string[]>;

/** A check name the runc profile requires, by group. */
export type RuncCheckName<G extends keyof ConformanceChecks> =
  (typeof RUNC_REQUIRED_CHECKS)[G][number];

export class ConformanceEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceEvidenceError";
  }
}

function names(checks: ConformanceCheck[]): string[] {
  return checks.map((check) => check.name);
}

/** Throws when the allowlist is empty or any check failed or is missing. */
export function buildConformanceEvidence(
  input: BuildConformanceEvidenceInput,
): ConformanceEvidenceRow[] {
  const allowlist = input.allowlist.filter((host) => host.trim() !== "");
  if (allowlist.length === 0) {
    throw new ConformanceEvidenceError("allowlist is empty");
  }
  const groups = Object.entries(input.checks) as Array<
    [keyof ConformanceChecks, ConformanceCheck[]]
  >;
  for (const [group, checks] of groups) {
    if (checks.length === 0) {
      throw new ConformanceEvidenceError(`no checks for ${group}`);
    }
    const have = new Set(names(checks));
    const missing = (input.required[group] ?? []).filter(
      (name) => !have.has(name),
    );
    if (missing.length > 0) {
      throw new ConformanceEvidenceError(
        `missing checks in ${group}: ${missing.join(", ")}`,
      );
    }
    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      throw new ConformanceEvidenceError(
        `failed checks in ${group}: ${names(failed).join(", ")}`,
      );
    }
  }

  const { checks } = input;
  const row = (
    capability: string,
    value: unknown,
    evidenceChecks: ConformanceCheck[],
  ): ConformanceEvidenceRow => ({
    profileId: input.profileId,
    capability,
    measuredAt: input.measuredAt,
    source: "conformance",
    result: { value, checks: names(evidenceChecks) },
    artifactDigest: input.artifactDigest,
    platformSha: input.platformSha,
  });

  return [
    row("egress", "allowlist", checks.egress_enforced),
    row("egress_allowlist", allowlist, checks.egress_enforced),
    row("metadata_blocked", true, checks.metadata_blocked),
    row("peer_isolated", true, checks.peer_isolated),
    row("teardown_verified", true, checks.teardown_verified),
    row("secret_brokering", true, checks.secret_brokering),
    // Measured, not closed: the resolver is filtered, not shut (spike 058).
    row("dns_closed", false, checks.egress_enforced),
    row("provider_creds_in_guest", false, checks.provider_creds_in_guest),
    row(
      "provider_endpoints_reachable",
      false,
      checks.provider_endpoints_reachable,
    ),
  ];
}
