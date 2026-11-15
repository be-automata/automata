import {
  parseRfc3339Ns,
  type CellPolicyProfile,
} from "../cell-policy/cell-policy";

/**
 * Switch guard (#611, OD-1/OD-4): the cell adapter calls this per create while
 * the broker switch is on. It refuses to run a cell on a profile whose egress is
 * not provider-enforced, with a named reason. Pure: the clock is injected and
 * nothing is logged.
 */

export const CELL_EGRESS_GUARD_REASONS = [
  "unknown_profile", // null, undefined, {} or no id
  "egress_mode_not_enforce", // configuration.egress_mode absent, "observe" or any value other than "enforce"
  "egress_not_allowlist", // capabilities.egress !== "allowlist"
  "allowlist_empty", // capabilities.egress_allowlist not a non-empty list of non-blank strings
  "evidence_missing", // no evidence.expires_at
  "evidence_not_from_conformance", // evidence.source !== "conformance"
  "evidence_invalid", // expires_at not RFC 3339
  "evidence_expired", // expires_at <= now
] as const;

export type CellEgressRefusal = (typeof CELL_EGRESS_GUARD_REASONS)[number];

export class CellEgressNotEnforcedError extends Error {
  readonly reason: CellEgressRefusal;
  /** The observed configuration.egress_mode (null when absent); set only for egress_mode_not_enforce. */
  readonly mode: string | null;

  constructor(reason: CellEgressRefusal, mode: string | null = null) {
    super(`cell egress not enforced: ${reason}`);
    this.name = "CellEgressNotEnforcedError";
    this.reason = reason;
    this.mode = mode;
  }
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.trim() !== "")
  );
}

export function assertCellEgressEnforced(input: {
  profile: CellPolicyProfile | Record<string, never> | null | undefined;
  now: Date;
}): void {
  const profile = input.profile;
  if (
    !profile ||
    !("id" in profile) ||
    typeof profile.id !== "string" ||
    profile.id === ""
  ) {
    throw new CellEgressNotEnforcedError("unknown_profile");
  }

  const mode = profile.configuration?.egress_mode;
  if (mode !== "enforce") {
    throw new CellEgressNotEnforcedError(
      "egress_mode_not_enforce",
      typeof mode === "string" ? mode : null,
    );
  }

  const caps = profile.capabilities ?? {};
  if (caps.egress !== "allowlist") {
    throw new CellEgressNotEnforcedError("egress_not_allowlist");
  }
  if (!isNonEmptyStringArray(caps.egress_allowlist)) {
    throw new CellEgressNotEnforcedError("allowlist_empty");
  }

  const evidence = profile.evidence;
  if (!evidence?.expires_at) {
    throw new CellEgressNotEnforcedError("evidence_missing");
  }
  if (evidence.source !== "conformance") {
    throw new CellEgressNotEnforcedError("evidence_not_from_conformance");
  }
  let expiresNs: number;
  try {
    expiresNs = parseRfc3339Ns(evidence.expires_at);
  } catch {
    throw new CellEgressNotEnforcedError("evidence_invalid");
  }
  // Same comparison cell.rego makes: expired at or after the expiry instant.
  if (expiresNs <= input.now.getTime() * 1e6) {
    throw new CellEgressNotEnforcedError("evidence_expired");
  }
}
