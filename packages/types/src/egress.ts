/**
 * Code lists of the repo egress API (#728). The classifier in
 * `@terragon/shared/model/egress-entries`, the oRPC contract and the tests all
 * read these lists, so a new code fails to compile until each of them names it.
 */

/** Why the API refuses an egress change. `entry`/`index` name the entry when there is one. */
export const EGRESS_ENTRY_CODES = [
  "wildcard_not_allowed", // `*.host`: a cell refuses wildcards
  "port_not_allowed", // `host:8443`: a cell is HTTPS/443 only
  "ip_not_allowed", // `10.0.0.1`
  "ipv6_not_allowed", // `::1`
  "invalid_host", // not a bare ASCII domain (entry not echoed when it may carry a secret)
  "public_suffix_wildcard", // `*.co.uk`
  "too_many_entries", // the rendered cell list exceeds its cap (set-level)
  "level_unsupported_in_cell", // `ip_port` (set-level)
  "invalid_input", // a request-shape rule (set-level), e.g. `allowlist` together with `add`
] as const;

export type EgressEntryCode = (typeof EGRESS_ENTRY_CODES)[number];

/** Advisory notes returned next to a valid change; none of them refuses it. */
export const EGRESS_WARNING_CODES = [
  "multi_tenant_upload_host", // storage.googleapis.com, S3 hosts (#719): anyone's bucket is reachable
  "domain_governs_box", // level `domain` also enforces the list on the box
  "no_policy_box_open", // no level: the box enforces nothing
  "registries_ignored", // registries opt-in under `none` has no effect
  "cell_refuses_wildcard", // a stored (legacy) wildcard keeps the repo off cells
  "cell_refuses_port", // a stored (legacy) non-443 port keeps the repo off cells
] as const;

export type EgressWarningCode = (typeof EGRESS_WARNING_CODES)[number];

/** Why the API refuses access to an org's repo egress (FORBIDDEN `data.reason`). */
export const EGRESS_ACCESS_REFUSALS = [
  "org_mismatch",
  "org_forbidden",
  "org_required",
  "not_repo_admin",
  "origin_mismatch", // a session write whose Origin is not this app's (CSRF guard)
] as const;

export type EgressAccessRefusal = (typeof EGRESS_ACCESS_REFUSALS)[number];

/** The egress policy levels. One list for the box, the API contract and the stored column. */
export const EGRESS_POLICY_LEVELS = ["none", "ip_port", "domain"] as const;

export type EgressLevel = (typeof EGRESS_POLICY_LEVELS)[number];
