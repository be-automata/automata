import type { DB } from "@terragon/shared/db";
import { getEnvironmentForUserRepo } from "@terragon/shared/model/environments";

import { getControlPlaneEnvironmentVariables } from "@/server-lib/env-audience";

import { normalizeProjects } from "./extract-ticket-keys";
import { normalizeTrackerBaseUrl } from "./youtrack-client";

/**
 * Per-repo tracker configuration (ADR-008), read from the ORG OWNER's
 * repository environment — the existing encrypted, org-fenced variable store,
 * editable from the dashboard's environment page. No new table.
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
 * The GLOBAL environment is deliberately NOT consulted: it is user-scoped with
 * no org fence, so one person owning two orgs would leak a token across them.
 */

export type TrackerWriteMode = "off" | "live";

export interface TrackerConfig {
  kind: "youtrack";
  baseUrl: string;
  token: string;
  projects: string[];
  writes: TrackerWriteMode;
}

export function parseTrackerConfig(
  variables: ReadonlyArray<{ key: string; value: string }>,
): TrackerConfig | null {
  const lookup = new Map(
    variables.map((variable) => [variable.key, variable.value.trim()]),
  );
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
    writes: lookup.get("AUTOMATA_TRACKER_WRITES") === "live" ? "live" : "off",
  };
}

export async function resolveTrackerConfig({
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
}): Promise<TrackerConfig | null> {
  const environment = await getEnvironmentForUserRepo({
    db,
    userId,
    repoFullName,
    organizationId,
  });
  if (!environment) return null;
  const variables = await getControlPlaneEnvironmentVariables({
    db,
    userId,
    environmentId: environment.id,
  });
  return parseTrackerConfig(variables);
}
