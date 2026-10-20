import type { DB } from "@terragon/shared/db";

import {
  type EnvSource,
  getControlPlaneTrackerEnvironment,
} from "@/server-lib/env-audience";

import { normalizeProjects } from "./extract-ticket-keys";
import { normalizeTrackerBaseUrl } from "./youtrack-client";

/**
 * Tracker configuration (ADR-008), read from the ORGANIZATION environment
 * overlaid key by key by the ORG OWNER's repository environment — both
 * encrypted, org-fenced, editable from the dashboard's environments page.
 * Set the tracker once per org; a repository may override single keys (e.g.
 * its own YOUTRACK_PROJECTS).
 *
 * Keys:
 *   YOUTRACK_URL            https origin of the instance
 *   YOUTRACK_TOKEN          permanent token (control-plane only — see
 *                           env-audience.ts; never reaches an agent)
 *   YOUTRACK_PROJECTS       comma-separated project short names (e.g. `ACME`);
 *                           empty = generic KEY-123 matching
 *   AUTOMATA_TRACKER_WRITES `live` enables tracker writes; anything else is
 *                           shadow (all reads, PR comment only, zero writes)
 *
 * Jira instead of YouTrack: when JIRA_URL, JIRA_USERNAME and JIRA_API_TOKEN
 * are all set the tracker is Jira, otherwise the YouTrack keys above apply.
 *   JIRA_URL                https origin of the site (`https://acme.atlassian.net`)
 *   JIRA_USERNAME           Atlassian account email the API token belongs to
 *   JIRA_API_TOKEN          API token (control-plane only, like YOUTRACK_TOKEN)
 *   JIRA_PROJECTS           comma-separated project keys; empty = generic matching
 *
 * The personal GLOBAL environment is deliberately NOT consulted: it is
 * user-scoped with no org fence, so one person owning two orgs would leak a
 * token across them. `getControlPlaneTrackerEnvironment` never reads it.
 */

export type TrackerWriteMode = "off" | "live";

interface TrackerConfigBase {
  baseUrl: string;
  token: string;
  projects: string[];
  writes: TrackerWriteMode;
}

export interface YouTrackTrackerConfig extends TrackerConfigBase {
  kind: "youtrack";
}

export interface JiraTrackerConfig extends TrackerConfigBase {
  kind: "jira";
  /** Atlassian account email; Basic auth is `username:token`. */
  username: string;
}

export type TrackerConfig = YouTrackTrackerConfig | JiraTrackerConfig;

export type TrackerKind = TrackerConfig["kind"];

/** Every key the tracker config reads, for diagnostics. Names only. */
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

/** The URL and token keys of each tracker kind. */
export const TRACKER_CREDENTIAL_KEYS: Record<
  TrackerKind,
  { url: string; token: string }
> = {
  youtrack: { url: "YOUTRACK_URL", token: "YOUTRACK_TOKEN" },
  jira: { url: "JIRA_URL", token: "JIRA_API_TOKEN" },
};

/** True when the Jira keys select Jira as the tracker. */
function selectsJira(lookup: ReadonlyMap<string, string>): boolean {
  return (
    !!lookup.get("JIRA_URL") &&
    !!lookup.get("JIRA_USERNAME") &&
    !!lookup.get("JIRA_API_TOKEN")
  );
}

export function parseTrackerConfig(
  variables: ReadonlyArray<{ key: string; value: string }>,
): TrackerConfig | null {
  const lookup = new Map(
    variables.map((variable) => [variable.key, variable.value.trim()]),
  );
  const writes: TrackerWriteMode =
    lookup.get("AUTOMATA_TRACKER_WRITES") === "live" ? "live" : "off";
  if (selectsJira(lookup)) {
    return {
      kind: "jira",
      // Invalid → TrackerConfigError, exactly like YOUTRACK_URL below.
      baseUrl: normalizeTrackerBaseUrl(lookup.get("JIRA_URL") ?? ""),
      username: lookup.get("JIRA_USERNAME") ?? "",
      token: lookup.get("JIRA_API_TOKEN") ?? "",
      projects: normalizeProjects(
        (lookup.get("JIRA_PROJECTS") ?? "").split(","),
      ),
      writes,
    };
  }

  const rawUrl = lookup.get("YOUTRACK_URL");
  const token = lookup.get("YOUTRACK_TOKEN");
  if (!rawUrl || !token) return null;

  // An invalid URL throws TrackerConfigError: a half-configured tracker should
  // surface as an error in the audit comment, not silently read as "absent".
  const baseUrl = normalizeTrackerBaseUrl(rawUrl);
  const projects = normalizeProjects(
    (lookup.get("YOUTRACK_PROJECTS") ?? "").split(","),
  );

  return {
    kind: "youtrack",
    baseUrl,
    token,
    projects,
    writes,
  };
}

export interface TrackerConfigResolution {
  config: TrackerConfig | null;
  /** Which layer each tracker key came from. Key names only. */
  sources: Record<string, EnvSource>;
}

/**
 * Resolves the config and reports where each key came from — for the staff
 * diagnostic. Throws TrackerConfigError on an invalid YOUTRACK_URL, like
 * {@link resolveTrackerConfig}.
 */
export async function resolveTrackerConfigWithSources({
  db,
  userId,
  organizationId,
  repoFullName,
}: {
  db: DB;
  /** The org owner the mirror task is attributed to. */
  userId: string;
  organizationId: string | null | undefined;
  repoFullName: string;
}): Promise<TrackerConfigResolution> {
  const { variables, sources } = await getControlPlaneTrackerEnvironment({
    db,
    userId,
    organizationId,
    repoFullName,
  });
  return { config: parseTrackerConfig(variables), sources };
}

export async function resolveTrackerConfig(args: {
  db: DB;
  /** The org owner the mirror task is attributed to. */
  userId: string;
  organizationId: string | null | undefined;
  repoFullName: string;
}): Promise<TrackerConfig | null> {
  return (await resolveTrackerConfigWithSources(args)).config;
}
