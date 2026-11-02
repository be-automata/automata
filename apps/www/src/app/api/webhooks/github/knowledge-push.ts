import type { PushEvent } from "@octokit/webhooks-types";

import { db } from "@/lib/db";
import { getRepoInstallationId } from "@terragon/shared/github-app";
import { getInstallationOrgAndMode } from "@terragon/shared/model/github-installation";
import { forKnowledge } from "@terragon/shared/model/knowledge-access";
import { normalizeRepo } from "@terragon/shared/model/repo-review-settings";

const FULL_SHA = /^[0-9a-f]{40}$/;
const ALL_ZERO = /^0+$/;

/**
 * Phase 13 push ingress (D-01..D-06, D-17): durably record an intent for a push
 * to the repository's default branch, before the webhook acks.
 *
 * - Only `refs/heads/<default_branch>` writes anything; a deleted push, an
 *   all-zero `after`, a tag or another branch writes nothing. A forced push to
 *   the default branch records its `after` sha like any other (D-06).
 * - The org comes from the installation id (fallback: the repo's installation),
 *   never from payload repo claims. An unbound installation writes nothing.
 * - The write goes through `recordPushUnlessOffboarded`: an Off org records so
 *   turning the engine On resumes from fresh state; an offboarded org does not.
 * - Never throws (D-03). A swallowed write is recovered by the head check
 *   (plan 13-15), so swallowing never loses a merge for good. Logs carry the
 *   delivery id, org id, booleans and error names only: no payload content.
 */
export async function handleKnowledgePush(
  payload: PushEvent,
  deliveryId: string,
): Promise<void> {
  try {
    const defaultBranch = payload.repository.default_branch;
    if (payload.ref !== `refs/heads/${defaultBranch}`) return;
    const after = payload.after;
    if (payload.deleted || ALL_ZERO.test(after) || !FULL_SHA.test(after)) {
      return;
    }

    const fullName = payload.repository.full_name;
    const [owner, name] = fullName.split("/");
    if (!owner || !name) return;

    const installationId =
      payload.installation?.id ?? (await getRepoInstallationId(owner, name));
    const { organizationId } = await getInstallationOrgAndMode({
      db,
      installationId,
    });
    if (!organizationId) return;

    const result = await forKnowledge({
      db,
      organizationId,
    }).store.recordPushUnlessOffboarded({
      repoFullName: normalizeRepo(fullName),
      defaultBranch,
      targetSha: after,
      now: new Date(),
    });
    if (!result.ok) {
      console.log("[knowledge push] not recorded", {
        deliveryId,
        organizationId,
        reason: result.reason,
      });
      return;
    }
    console.log("[knowledge push] recorded", {
      deliveryId,
      organizationId,
      inserted: result.value.inserted,
    });
  } catch (error) {
    console.error("[knowledge push] failed", {
      deliveryId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
