/**
 * The cap counts active automations in every org the user belongs to, while
 * the list below shows only this org's: say so, or an org with no automations
 * reads as "limit reached" for no visible reason.
 */
export function automationLimitMessage({
  count,
  max,
}: {
  count: number;
  max: number | null;
}): string {
  const counts = max !== null ? ` (${count} of ${max})` : "";
  return `You have reached the maximum number of active automations for your plan across all your organizations${counts}. To create another, disable or delete an existing active automation.`;
}
