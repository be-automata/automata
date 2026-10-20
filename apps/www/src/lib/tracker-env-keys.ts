/**
 * Environment keys the post-merge audit's tracker config reads (ADR-008).
 * Pure and client-safe: shared by the server-side parser and the editor's
 * key hints, so both agree on which keys exist and when Jira is selected.
 */

/** Every key the tracker config reads. Names only. */
export const TRACKER_CONFIG_KEYS = [
  "YOUTRACK_URL",
  "YOUTRACK_TOKEN",
  "YOUTRACK_PROJECTS",
  "JIRA_URL",
  "JIRA_USERNAME",
  "JIRA_API_TOKEN",
  "JIRA_PROJECTS",
  "AUTOMATA_TRACKER_WRITES",
] as const;

/** Jira is the tracker only when all three are set (non-empty). */
export const JIRA_REQUIRED_KEYS = [
  "JIRA_URL",
  "JIRA_USERNAME",
  "JIRA_API_TOKEN",
] as const;

/** The keys that configure a tracker, as named in "not configured" notices. */
export const TRACKER_SETUP_KEYS_TEXT =
  "`YOUTRACK_URL` and `YOUTRACK_TOKEN` (or, for Jira, `JIRA_URL`, `JIRA_USERNAME` and `JIRA_API_TOKEN`)";

/** True when `isSet` reports every Jira key, selecting Jira over YouTrack. */
export function selectsJira(isSet: (key: string) => boolean): boolean {
  return JIRA_REQUIRED_KEYS.every(isSet);
}
