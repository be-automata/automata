import type { DB } from "@terragon/shared/db";
import {
  getOrganizationBySlug,
  getOrganizationOwnerUserId,
} from "@terragon/shared/model/organizations";

import type { EnvSource } from "@/server-lib/env-audience";

import { resolveTrackerConfigWithSources } from "./tracker-config";
import { describeTrackerError } from "./youtrack-client";

const TRACKER_KEYS = [
  "YOUTRACK_URL",
  "YOUTRACK_TOKEN",
  "YOUTRACK_PROJECTS",
  "AUTOMATA_TRACKER_WRITES",
] as const;

/**
 * What the post-merge audit would resolve for `repoFullName` in the org
 * `organizationSlug` — attributed to the org owner exactly like the audit
 * (mirror-intake.ts). Staff diagnostic: it reports where each tracker key came
 * from and never returns the token.
 */
export type TrackerConfigDiagnostic =
  | { status: "org_not_found" | "no_owner" }
  | {
      status: "invalid";
      error: string;
      sources: Partial<Record<string, EnvSource>>;
    }
  | {
      status: "unconfigured" | "configured";
      baseUrl: string | null;
      projects: string[];
      writes: "off" | "live" | null;
      sources: Partial<Record<string, EnvSource>>;
      /** URL and token resolved from different layers — usually a stale override. */
      mixedLayers: boolean;
    };

export async function diagnoseTrackerConfig({
  db,
  organizationSlug,
  repoFullName,
}: {
  db: DB;
  organizationSlug: string;
  repoFullName: string;
}): Promise<TrackerConfigDiagnostic> {
  const organization = await getOrganizationBySlug({
    db,
    slug: organizationSlug,
  });
  if (!organization) return { status: "org_not_found" };
  const ownerUserId = await getOrganizationOwnerUserId({
    db,
    organizationId: organization.id,
  });
  if (!ownerUserId) return { status: "no_owner" };

  let resolution: Awaited<ReturnType<typeof resolveTrackerConfigWithSources>>;
  try {
    resolution = await resolveTrackerConfigWithSources({
      db,
      userId: ownerUserId,
      organizationId: organization.id,
      repoFullName,
    });
  } catch (error) {
    return {
      status: "invalid",
      error: describeTrackerError(error),
      sources: {},
    };
  }
  const sources = Object.fromEntries(
    TRACKER_KEYS.filter((key) => resolution.sources[key]).map((key) => [
      key,
      resolution.sources[key],
    ]),
  );
  const urlSource = resolution.sources.YOUTRACK_URL;
  const tokenSource = resolution.sources.YOUTRACK_TOKEN;
  const { config } = resolution;
  return {
    status: config ? "configured" : "unconfigured",
    baseUrl: config?.baseUrl ?? null,
    projects: config?.projects ?? [],
    writes: config?.writes ?? null,
    sources,
    mixedLayers: !!urlSource && !!tokenSource && urlSource !== tokenSource,
  };
}
