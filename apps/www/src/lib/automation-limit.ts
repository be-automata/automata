/**
 * The cap counts active automations in every org the user belongs to, while
 * the automations list shows only this org's: say so, or an org with no
 * automations reads as "limit reached" for no visible reason.
 *
 * `next` is what the user was trying to do: create another automation (the
 * default, and the list's banner) or enable a disabled one.
 */
export function automationLimitMessage({
  count,
  max,
  next = "create",
}: {
  count: number;
  max: number | null;
  next?: "create" | "enable";
}): string {
  const counts = max !== null ? ` (${count} of ${max})` : "";
  const remedy =
    next === "enable"
      ? "To enable this one, disable or delete another active automation."
      : "To create another, disable or delete an existing active automation.";
  return `You have reached the maximum number of active automations for your plan across all your organizations${counts}. ${remedy}`;
}
