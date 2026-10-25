/**
 * Delivery-loop settings (#509): the per-repo mode of the loop that takes an
 * issue-delivery pull request from opened to merge-ready. One nullable column
 * on `repo_review_settings` (`delivery_loop_mode`); NULL = inherit (repo row ->
 * '*' org default row -> "off").
 *
 * - off: nothing is enrolled or evaluated.
 * - shadow: the loop enrolls and evaluates in full and records what it would
 *   do, but writes nothing to GitHub and dispatches nothing.
 * - on: the loop marks ready, comments and dispatches fix cycles.
 *
 * The global `deliveryLoop` feature flag sits above it: flag off = "off"
 * whatever the rows say.
 *
 * This module imports nothing (no db, no drizzle) so client components can
 * import it.
 */

export const DELIVERY_LOOP_MODES = ["off", "shadow", "on"] as const;
export type DeliveryLoopMode = (typeof DELIVERY_LOOP_MODES)[number];

export const DELIVERY_LOOP_MODE_FIELD = "deliveryLoopMode" as const;

/** Fix cycles per pull request (dev-execution's FIX_CAP default). */
export const DELIVERY_FIX_CAP = 3;

export function isDeliveryLoopMode(value: unknown): value is DeliveryLoopMode {
  return (
    typeof value === "string" &&
    (DELIVERY_LOOP_MODES as readonly string[]).includes(value)
  );
}

/** A write-boundary error message for a bad stored value, else undefined. */
export function findDeliveryLoopFieldError(
  patch: Record<string, unknown>,
): string | undefined {
  const value = patch[DELIVERY_LOOP_MODE_FIELD];
  if (value === undefined || value === null || isDeliveryLoopMode(value)) {
    return undefined;
  }
  return `${DELIVERY_LOOP_MODE_FIELD} must be one of ${DELIVERY_LOOP_MODES.join(", ")}`;
}

/**
 * The effective mode: the repo row's value, else the '*' org row's, else
 * "off". A stored value that is not a known mode resolves to "off" (fail
 * closed: an unreadable knob never turns effects on).
 */
export function resolveDeliveryLoopMode({
  repoValue,
  orgDefaultValue,
}: {
  repoValue: string | null | undefined;
  orgDefaultValue: string | null | undefined;
}): DeliveryLoopMode {
  const raw = repoValue ?? orgDefaultValue ?? null;
  if (raw === null) return "off";
  return isDeliveryLoopMode(raw) ? raw : "off";
}

/**
 * Folds the global flag and the installation's shadow state over the
 * settings value: flag off -> "off"; a shadow installation never goes past
 * "shadow".
 */
export function effectiveDeliveryLoopMode({
  flagEnabled,
  installationShadow,
  settingsMode,
}: {
  flagEnabled: boolean;
  installationShadow: boolean;
  settingsMode: DeliveryLoopMode;
}): DeliveryLoopMode {
  if (!flagEnabled || settingsMode === "off") return "off";
  if (installationShadow) return "shadow";
  return settingsMode;
}
