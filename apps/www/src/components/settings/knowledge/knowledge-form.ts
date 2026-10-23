/**
 * Pure form logic of the "Knowledge" settings section (phase 12): the budget
 * text <-> micro-USD conversion, the patch a Save sends, the spend view model
 * and the purge countdown. No React here. The server (12-06) is the authority
 * for every rule mirrored below; this module only gives immediate feedback.
 */

export const KNOWLEDGE_KILL_SWITCH_NOTE =
  "Stops reconcile, Slack decisions, agent reads and doc write-back for this organization. Data and progress are kept; turning it back on resumes where it stopped.";

export const KNOWLEDGE_OFFBOARD_NOTE =
  "Offboarding forces the engine Off now. All knowledge data for this organization is deleted 7 days later. You can undo until then.";

export type KnowledgeGateReason = "engine_off" | "offboarded";

export interface KnowledgeControlsDto {
  engine: boolean | null;
  budgetMicroUsd: number | null;
  effectiveBudgetMicroUsd: number;
  ceilingMicroUsd: number;
  offboardedAt: string | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  enabled: boolean;
  gateReason: KnowledgeGateReason | null;
  updatedAt: string | null;
}

export interface KnowledgeSpendDto {
  windowStart: string;
  capMicroUsd: number;
  reservedMicroUsd: number;
  spentMicroUsd: number;
  remainingMicroUsd: number;
  atCap: boolean;
  capAlertedAt: string | null;
}

export interface KnowledgeActionDto {
  id: string;
  action: string;
  target: unknown;
  actorUserId: string | null;
  createdAt: string;
}

export interface KnowledgeViewer {
  isOrgAdmin: boolean;
  isPlatformAdmin: boolean;
}

export interface KnowledgeSettingsResponse {
  orgSlug: string | null;
  controls: KnowledgeControlsDto | null;
  spend: KnowledgeSpendDto | null;
  actions: KnowledgeActionDto[];
  viewer: KnowledgeViewer;
}

export interface KnowledgeFieldError {
  field: "budget";
  message: string;
}

const MICRO_PER_DOLLAR = 1_000_000;
const BUDGET_PATTERN = /^(\d{1,9})(?:\.(\d{1,6}))?$/;
/** Mirrors KNOWLEDGE_BUDGET_ABSOLUTE_MAX_MICRO_USD (the server's $10,000 cap). */
export const KNOWLEDGE_BUDGET_MAX_MICRO_USD = 10_000 * MICRO_PER_DOLLAR;

/** Dollars as typed -> micro-USD. Empty means "use the platform default". */
export function dollarsToMicroUsd(
  text: string,
): { value: number | null } | { error: KnowledgeFieldError } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  const match = BUDGET_PATTERN.exec(trimmed);
  if (match === null) {
    return {
      error: {
        field: "budget",
        message:
          "Enter a dollar amount like 20 or 20.50 (at most 6 decimals, no signs).",
      },
    };
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const value = Number(whole) * MICRO_PER_DOLLAR + Number(fraction);
  if (value > KNOWLEDGE_BUDGET_MAX_MICRO_USD) {
    return {
      error: { field: "budget", message: "The budget can be at most $10,000." },
    };
  }
  return { value };
}

/** Micro-USD -> "20.00" for display (two decimals, rounded half up). */
export function microUsdToDollars(micro: number): string {
  const cents = Math.floor((micro + 5_000) / 10_000);
  const whole = Math.floor(cents / 100);
  const rest = (cents % 100).toString().padStart(2, "0");
  return `${whole}.${rest}`;
}

/** Exact dollars for an editable field (no rounding; at least two decimals). */
function microUsdToExactDollars(micro: number): string {
  const whole = Math.floor(micro / MICRO_PER_DOLLAR);
  const fraction = (micro % MICRO_PER_DOLLAR).toString().padStart(6, "0");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}

export interface KnowledgeDraft {
  engine: boolean;
  budget: string;
}

export function draftFromControls(
  controls: KnowledgeControlsDto | null,
): KnowledgeDraft {
  return {
    engine: controls?.engine ?? false,
    budget:
      controls?.budgetMicroUsd == null
        ? ""
        : microUsdToExactDollars(controls.budgetMicroUsd),
  };
}

export interface KnowledgePatch {
  engine?: boolean;
  budgetMicroUsd?: number | null;
}

export type KnowledgeDraftResult =
  | { patch: KnowledgePatch }
  | { error: KnowledgeFieldError };

/**
 * Only the changed fields. Mirrors the 12-06 PUT gate: the engine field is
 * never sent by a viewer who is not an org admin; a budget above the platform
 * ceiling is only allowed for platform admins (lowering is always allowed).
 */
export function draftToPatch(
  draft: KnowledgeDraft,
  controls: KnowledgeControlsDto | null,
  viewer: KnowledgeViewer,
): KnowledgeDraftResult {
  const patch: KnowledgePatch = {};

  if (viewer.isOrgAdmin && draft.engine !== (controls?.engine ?? false)) {
    patch.engine = draft.engine;
  }

  const parsed = dollarsToMicroUsd(draft.budget);
  if ("error" in parsed) return parsed;
  const current = controls?.budgetMicroUsd ?? null;
  if (parsed.value !== current) {
    const ceiling = controls?.ceilingMicroUsd;
    if (
      parsed.value !== null &&
      ceiling !== undefined &&
      parsed.value > ceiling &&
      !viewer.isPlatformAdmin &&
      !(current !== null && parsed.value <= current)
    ) {
      return {
        error: {
          field: "budget",
          message: `Above the platform ceiling of $${microUsdToDollars(ceiling)}. Ask a platform admin.`,
        },
      };
    }
    patch.budgetMicroUsd = parsed.value;
  }
  return { patch };
}

export interface SpendView {
  percentUsed: number;
  paused: boolean;
}

export function spendView(spend: KnowledgeSpendDto): SpendView {
  const percentUsed =
    spend.capMicroUsd <= 0
      ? 100
      : Math.min(
          100,
          Math.max(
            0,
            Math.round(
              ((spend.spentMicroUsd + spend.reservedMicroUsd) /
                spend.capMicroUsd) *
                100,
            ),
          ),
        );
  return {
    percentUsed,
    paused:
      spend.atCap || spend.capAlertedAt !== null || spend.capMicroUsd <= 0,
  };
}

const MS_PER_DAY = 86_400_000;

/** Whole days until the purge (never negative). */
export function purgeCountdown(purgeAfter: string, now: Date): number {
  const diff = new Date(purgeAfter).getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / MS_PER_DAY));
}

export const KNOWLEDGE_ACTION_LABELS: Record<string, string> = {
  engine_toggle: "Engine toggled",
  budget_change: "Budget changed",
  offboard: "Offboarded",
  offboard_undo: "Offboarding undone",
};

/** Label for a stored action enum; unknown values fall back to the enum. */
export function knowledgeActionLabel(action: string): string {
  return KNOWLEDGE_ACTION_LABELS[action] ?? action;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * from/to primitives of an admin action, as text. Never renders the raw
 * target: only the known from/to keys, and only when they are primitives.
 */
export function knowledgeActionDetail(
  action: string,
  target: unknown,
): string | null {
  if (!isRecord(target)) return null;
  if (action === "engine_toggle") {
    const { from, to } = target;
    if (typeof to !== "boolean") return null;
    const word = (v: unknown) => (v === true ? "On" : "Off");
    return `${word(from)} to ${word(to)}`;
  }
  if (action === "budget_change") {
    const money = (v: unknown) =>
      typeof v === "number" ? `$${microUsdToDollars(v)}` : "default";
    return `${money(target.fromMicroUsd)} to ${money(target.toMicroUsd)}`;
  }
  return null;
}
