import {
  CELL_EGRESS_GUARD_REASONS,
  type CellEgressGuardReason,
} from "@terragon/types/cell";

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

// The reasons live in @terragon/types/cell so the worker reads the same list.
export { CELL_EGRESS_GUARD_REASONS };

export type CellEgressRefusal = CellEgressGuardReason;

export class CellEgressNotEnforcedError extends Error {
  readonly reason: CellEgressRefusal;
  /** The observed configuration.egress_mode (null when absent); set only for the egress_mode_* refusals. */
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
  if (mode === undefined || mode === null) {
    throw new CellEgressNotEnforcedError("egress_mode_missing");
  }
  if (mode === "observe") {
    throw new CellEgressNotEnforcedError("egress_mode_observe", "observe");
  }
  if (mode !== "enforce") {
    throw new CellEgressNotEnforcedError(
      "egress_mode_unknown",
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
