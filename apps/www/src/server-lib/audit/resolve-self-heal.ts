import type { DB } from "@terragon/shared/db";
import type { RepoReviewSetting } from "@terragon/shared/db/types";
import { getFeatureFlag } from "@terragon/shared/model/feature-flags";
import { featureFlagsDefinitions } from "@terragon/shared/model/feature-flags-definitions";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import {
  getRepoReviewSettingWithOrgDefault,
  normalizeRepo,
} from "@terragon/shared/model/repo-review-settings";
import {
  getBreakerState,
  probeAttemptIdOf,
  type BreakerRow,
} from "@terragon/shared/model/self-heal-breaker";
import {
  findSelfHealFieldError,
  SELF_HEAL_DEFAULTS,
  type SelfHealField,
  type SelfHealMode,
  type SelfHealSeverity,
} from "@terragon/shared/model/self-heal-settings";

import { githubSideEffectsEnabled } from "@/lib/github-side-effects";

/**
 * The single decision gate in front of every self-heal effect (RES-16).
 *
 * Manual switches (the global flag, the org kill switch, the mode) always
 * override automatic ones; a breaker or a precondition can only NARROW the
 * mode, never widen it; and toggling the mode never resets a breaker (reset is
 * its own admin action, 08-19).
 */

export interface ResolvedSelfHeal {
  mode: SelfHealMode;
  killSwitch: boolean;
  maxOpenIssues: number;
  maxAttempts: number;
  cooldownMin: number;
  minSeverity: SelfHealSeverity;
  autoLabel: boolean;
  absentAudits: number;
  maxDiffLines: number;
  prExpiryDays: number;
  runWindow: string;
}

export interface ResolvedSelfHealRows {
  settings: ResolvedSelfHeal;
  /** Set when the winning stored value of some field is invalid (mode is then off). */
  invalid?: string;
  killed: boolean;
}

type SettingsRow = RepoReviewSetting | undefined;

interface FieldSpec {
  field: SelfHealField;
  key: keyof ResolvedSelfHeal;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { field: "selfHealMode", key: "mode" },
  { field: "selfHealMaxOpenIssues", key: "maxOpenIssues" },
  { field: "selfHealMaxAttempts", key: "maxAttempts" },
  { field: "selfHealCooldownMin", key: "cooldownMin" },
  { field: "selfHealMinSeverity", key: "minSeverity" },
  { field: "selfHealAutoLabel", key: "autoLabel" },
  { field: "selfHealAbsentAudits", key: "absentAudits" },
  { field: "selfHealMaxDiffLines", key: "maxDiffLines" },
  { field: "selfHealPrExpiryDays", key: "prExpiryDays" },
  { field: "selfHealRunWindow", key: "runWindow" },
];

/**
 * Per field: repo row, then the '*' row, then the system default. The kill
 * switch is read only from '*' (T-08-08-1: a repo row can never lift an org
 * stop). Pure; never throws. An invalid winning value resolves mode off.
 */
export function resolveSelfHealFromRows({
  repo,
  orgDefault,
}: {
  organizationId: string;
  repo: SettingsRow;
  orgDefault: SettingsRow;
}): ResolvedSelfHealRows {
  const settings: Record<string, unknown> = { ...SELF_HEAL_DEFAULTS };
  let invalid: string | undefined;

  for (const { field, key } of FIELD_SPECS) {
    const winner = [repo, orgDefault].find(
      (row) => row !== undefined && row[field] !== null,
    );
    if (winner === undefined) continue;
    const value = winner[field];
    // The kill switch has its own rule below, so the org-row flag is moot here.
    const error = findSelfHealFieldError(
      { [field]: value },
      { isOrgDefaultRow: true },
    );
    if (error !== undefined) {
      invalid ??= `row ${winner.repoFullName} field ${field}: ${error}`;
      continue;
    }
    settings[key] = value;
  }

  const killed = orgDefault?.selfHealKillSwitch === true;
  settings.killSwitch = killed;
  if (invalid !== undefined) {
    settings.mode = "off";
  }

  return {
    // Every key was seeded from SELF_HEAL_DEFAULTS and only assigned values
    // that passed the validator above.
    settings: settings as unknown as ResolvedSelfHeal,
    ...(invalid !== undefined ? { invalid } : {}),
    killed,
  };
}

export type SelfHealEffectiveReason =
  | "flag_off"
  | "side_effects_disabled"
  | "shadow"
  | "killed"
  | "mode_off"
  | "invalid_settings"
  | "missing_permission"
  | "loop_audit_open"
  | "mode_dry_run"
  | "on";

export interface SelfHealEffective {
  mode: SelfHealMode;
  reason: SelfHealEffectiveReason;
  /** False when the loop_fix breaker is open or the loop is off. */
  fixAllowed: boolean;
}

export interface SelfHealBreakerFlags {
  permissionLatched: boolean;
  loopAuditOpen: boolean;
  loopFixOpen: boolean;
}

export interface SelfHealEffectiveInput {
  flagEnabled: boolean;
  sideEffectsEnabled: boolean;
  shadow: boolean;
  resolved: ResolvedSelfHealRows;
  breakers: SelfHealBreakerFlags;
}

/**
 * RESILIENCE 3.4: first match wins. Pure.
 *
 * Branch protection is deliberately not an input: a free-plan account cannot
 * protect a private repo, and the loop must not depend on it. Main is kept
 * safe by the git-broker ref fence and the human merge, not by protection.
 */
export function resolveSelfHealEffective(
  input: SelfHealEffectiveInput,
): SelfHealEffective {
  const { resolved, breakers } = input;
  const fixAllowed = (mode: SelfHealMode) =>
    mode !== "off" && !breakers.loopFixOpen;
  const decide = (
    mode: SelfHealMode,
    reason: SelfHealEffectiveReason,
  ): SelfHealEffective => ({ mode, reason, fixAllowed: fixAllowed(mode) });

  if (!input.flagEnabled) return decide("off", "flag_off");
  if (!input.sideEffectsEnabled) {
    return decide("dry-run", "side_effects_disabled");
  }
  if (input.shadow) return decide("dry-run", "shadow");
  if (resolved.killed) return decide("off", "killed");
  if (resolved.invalid !== undefined) return decide("off", "invalid_settings");
  if (resolved.settings.mode === "off") return decide("off", "mode_off");
  if (breakers.permissionLatched) return decide("off", "missing_permission");
  if (breakers.loopAuditOpen) return decide("dry-run", "loop_audit_open");
  if (resolved.settings.mode === "dry-run") {
    return decide("dry-run", "mode_dry_run");
  }
  return decide("on", "on");
}

/**
 * The global flag: the admin-page override, else the definition default.
 * Per-user overrides are ignored on purpose: effects are not per user.
 */
export async function isSelfHealLoopEnabled(db: DB): Promise<boolean> {
  const flag = await getFeatureFlag({ db, name: "selfHealLoop" });
  return (
    flag?.globalOverride ?? featureFlagsDefinitions.selfHealLoop.defaultValue
  );
}

export const SELF_HEAL_WRITER_PERMISSIONS = ["issues"] as const;

export interface SelfHealContext {
  flagEnabled: boolean;
  sideEffectsEnabled: boolean;
  shadow: boolean;
  resolved: ResolvedSelfHealRows;
  breakers: SelfHealBreakerFlags;
}

/**
 * loop_fix withholds fixes unless closed — except for the ONE attempt that
 * holds a half-open probe (RES-15): the dispatcher stamped its id into the
 * trip evidence, and that attempt must reach its draft for the probe to
 * decide anything. open and paused_manual block every attempt.
 */
export function loopFixBlocks(
  row: BreakerRow,
  probeAttemptId?: string,
): boolean {
  if (row.state === "closed") return false;
  return !(
    row.state === "half_open" &&
    probeAttemptId !== undefined &&
    probeAttemptIdOf(row) === probeAttemptId
  );
}

/**
 * One settings read, one flag read, the installation mode and the breaker
 * reads. `probeAttemptId`: the fix attempt the caller acts for, so the
 * half-open probe attempt is not refused by its own breaker.
 */
export async function loadSelfHealContext({
  db,
  organizationId,
  repoFullName,
  installationKey,
  probeAttemptId,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  installationKey: string;
  probeAttemptId?: string;
}): Promise<SelfHealContext> {
  const repoKey = normalizeRepo(repoFullName);
  const [flagEnabled, rows, installationMode] = await Promise.all([
    isSelfHealLoopEnabled(db),
    getRepoReviewSettingWithOrgDefault({ db, organizationId, repoFullName }),
    getOrganizationInstallationMode({ db, organizationId }),
  ]);
  const [permissionRows, loopAudit, loopFix] = await Promise.all([
    Promise.all(
      SELF_HEAL_WRITER_PERMISSIONS.map((permission) =>
        getBreakerState({
          db,
          organizationId,
          scopeKind: "permission",
          scopeKey: `${installationKey}:${permission}`,
        }),
      ),
    ),
    getBreakerState({
      db,
      organizationId,
      scopeKind: "loop_audit",
      scopeKey: repoKey,
    }),
    getBreakerState({
      db,
      organizationId,
      scopeKind: "loop_fix",
      scopeKey: repoKey,
    }),
  ]);
  return {
    flagEnabled,
    sideEffectsEnabled: githubSideEffectsEnabled(),
    shadow: installationMode === "shadow",
    resolved: resolveSelfHealFromRows({
      organizationId,
      repo: rows.repo,
      orgDefault: rows.orgDefault,
    }),
    breakers: {
      permissionLatched: permissionRows.some((r) => r.state !== "closed"),
      // Any non-closed state (open, half_open, paused_manual) withholds effects.
      loopAuditOpen: loopAudit.state !== "closed",
      loopFixOpen: loopFixBlocks(loopFix, probeAttemptId),
    },
  };
}
