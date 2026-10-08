"use server";

import { User } from "@terragon/shared";

import { adminOnly } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  diagnoseTrackerConfig,
  type TrackerConfigDiagnostic,
} from "@/server-lib/tracker/tracker-config-diagnostic";

/** Staff-only: what the post-merge audit would resolve. Never the token. */
export const checkTrackerConfig = adminOnly(async function checkTrackerConfig(
  adminUser: User,
  {
    organizationSlug,
    repoFullName,
  }: { organizationSlug: string; repoFullName: string },
): Promise<TrackerConfigDiagnostic> {
  console.log("[admin] checkTrackerConfig", {
    adminUserId: adminUser.id,
    organizationSlug,
    repoFullName,
  });
  return await diagnoseTrackerConfig({
    db,
    organizationSlug: organizationSlug.trim(),
    repoFullName: repoFullName.trim(),
  });
});
