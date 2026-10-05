import type { AuditFindingRow } from "@terragon/shared/model/audit-findings";
import { isInRunWindow } from "@terragon/shared/model/self-heal-settings";

import type { ResolvedSelfHeal, SelfHealEffective } from "./resolve-self-heal";

/**
 * Every guard in front of a self-heal fix run, as one pure function (SC3,
 * KILL-01). The dispatcher gathers the inputs (DB reads, the capability
 * preflight) and this decides; no IO happens here.
 *
 * Branch protection is deliberately NOT an input: it is optional hardening
 * (a free-plan private repo cannot have it). Main stays safe through the
 * git-broker ref fence and the human merge.
 */

export type FixTriggerRefusal =
  | "flag_off"
  | "killed"
  | "mode_off"
  | "dry_run"
  | "shadow"
  | "side_effects_disabled"
  | "missing_permission"
  | "loop_fix_open"
  | "exec_plane_open"
  | "hatchet_dispatch_open"
  | "outside_run_window"
  | "no_fix_automation"
  | "no_review_automation"
  | "attempts_cap"
  | "cooldown"
  | "active_attempt"
  /** The claim compare-and-set lost (decided by the database, not here). */
  | "claim_refused";

/**
 * First match wins, in this order. The four mode refusals share one tier:
 * only one effective reason exists at a time.
 */
export const FIX_TRIGGER_PRECEDENCE = [
  "flag_off",
  "killed",
  "mode_off",
  "dry_run",
  "shadow",
  "side_effects_disabled",
  "missing_permission",
  "loop_fix_open",
  "exec_plane_open",
  "hatchet_dispatch_open",
  "outside_run_window",
  "no_fix_automation",
  "no_review_automation",
  "attempts_cap",
  "cooldown",
  "active_attempt",
] as const satisfies readonly FixTriggerRefusal[];

/** Refusals that only withhold effects: a dry run logs would_dispatch. */
const WOULD_DISPATCH: ReadonlySet<FixTriggerRefusal> = new Set([
  "dry_run",
  "shadow",
  "side_effects_disabled",
]);

export interface FixTriggerInput {
  effective: SelfHealEffective;
  /** The fixLoop capability preflight passed (pull_requests/contents write, checks/actions read). */
  capabilitiesOk: boolean;
  breakers: { execPlaneOpen: boolean; hatchetDispatchOpen: boolean };
  /** The repo's enabled audit-fix issue automation, if any. */
  fixAutomation: { id: string; userId: string } | null;
  /** REV-01: an enabled pull_request automation reviews bot-authored PRs. */
  reviewAutomationMatchesBot: boolean;
  finding: Pick<
    AuditFindingRow,
    "attempts" | "lastAttemptAt" | "activeAttemptId"
  >;
  settings: ResolvedSelfHeal;
  now: Date;
}

export type FixTriggerResult =
  | { ok: true }
  | { ok: false; reason: FixTriggerRefusal; wouldDispatch: boolean };

function refuse(reason: FixTriggerRefusal): FixTriggerResult {
  return { ok: false, reason, wouldDispatch: WOULD_DISPATCH.has(reason) };
}

/** The mode tier: which manual switch, if any, withholds the run. */
function modeRefusal({
  effective,
  settings,
}: FixTriggerInput): FixTriggerRefusal | null {
  if (
    effective.reason === "mode_off" ||
    effective.reason === "invalid_settings" ||
    settings.mode === "off"
  ) {
    return "mode_off";
  }
  // The repo's own dry-run outranks a latched permission (resolveSelfHeal
  // checks the latch first because it only narrows the mode).
  if (settings.mode === "dry-run" || effective.reason === "mode_dry_run") {
    return "dry_run";
  }
  if (effective.reason === "shadow") return "shadow";
  if (effective.reason === "side_effects_disabled") {
    return "side_effects_disabled";
  }
  // A breaker-narrowed dry run (loop_audit open).
  if (effective.mode === "dry-run") return "dry_run";
  return null;
}

export function evaluateFixTrigger(input: FixTriggerInput): FixTriggerResult {
  const { effective, settings, finding, now } = input;

  if (effective.reason === "flag_off") return refuse("flag_off");
  if (settings.killSwitch || effective.reason === "killed") {
    return refuse("killed");
  }
  const mode = modeRefusal(input);
  if (mode !== null) return refuse(mode);
  if (!input.capabilitiesOk || effective.reason === "missing_permission") {
    return refuse("missing_permission");
  }
  // Defensive: anything else that is not "on" withholds the run.
  if (effective.mode !== "on") return refuse("mode_off");
  if (!effective.fixAllowed) return refuse("loop_fix_open");
  if (input.breakers.execPlaneOpen) return refuse("exec_plane_open");
  if (input.breakers.hatchetDispatchOpen) {
    return refuse("hatchet_dispatch_open");
  }
  if (!isInRunWindow(settings.runWindow, now)) {
    return refuse("outside_run_window");
  }
  if (input.fixAutomation === null) return refuse("no_fix_automation");
  if (!input.reviewAutomationMatchesBot) return refuse("no_review_automation");
  if (finding.attempts >= settings.maxAttempts) return refuse("attempts_cap");
  if (
    finding.lastAttemptAt !== null &&
    now.getTime() - finding.lastAttemptAt.getTime() <
      settings.cooldownMin * 60_000
  ) {
    return refuse("cooldown");
  }
  if (finding.activeAttemptId !== null) return refuse("active_attempt");
  return { ok: true };
}
