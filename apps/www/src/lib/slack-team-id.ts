/**
 * A Slack workspace ID as shown in app.slack.com/client/<ID>/…: "T" and
 * uppercase alphanumerics (Enterprise Grid orgs start with "E").
 */
export function isSlackTeamId(value: string): boolean {
  return /^[TE][A-Z0-9]{6,20}$/.test(value);
}

/**
 * Pull a workspace ID out of what a user pastes: the ID itself, or a Slack
 * client URL such as https://app.slack.com/client/T01ABCDEF/C02XYZ.
 */
export function parseSlackTeamId(input: string): string | null {
  const trimmed = input.trim();
  if (isSlackTeamId(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/app\.slack\.com\/client\/([A-Z0-9]+)/);
  return match?.[1] && isSlackTeamId(match[1]) ? match[1] : null;
}
