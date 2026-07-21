import { describe, it, expect, beforeEach } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { nanoid } from "nanoid";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  setRepoReviewSetting,
  removeRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import {
  DEFAULT_APPROVE_SEVERITY_POLICY,
  toleranceToPolicy,
} from "@terragon/review/severity-policy";
import { resolveApproveFloor } from "./resolve-approve-floor";

/**
 * The dispatch snapshot seam: proves resolveApproveFloor reads the LIVE Neon row
 * for the run's (org, repo) and maps it to a policy, org-fenced, with the locked
 * default as the fallback. This is the "one snapshot per run" resolution that
 * feeds the executor.
 */

const db = createDb(env.DATABASE_URL!);

async function makeOrg(): Promise<string> {
  const org = await createOrganization({
    db,
    name: "acme",
    slug: `acme-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("resolveApproveFloor (dispatch snapshot)", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await makeOrg();
  });

  it("no org (legacy/unfenced thread) → the locked default, never a DB read", async () => {
    const policy = await resolveApproveFloor({
      db,
      organizationId: null,
      repoFullName: "acme/widgets",
    });
    expect(policy).toEqual(DEFAULT_APPROVE_SEVERITY_POLICY);
  });

  it("org present, no override → locked default", async () => {
    const policy = await resolveApproveFloor({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
    });
    expect(policy).toEqual(DEFAULT_APPROVE_SEVERITY_POLICY);
  });

  it("stored override → its mapped policy (read live), reverting on removal", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(
      await resolveApproveFloor({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
      }),
    ).toEqual(toleranceToPolicy("error"));

    // A dashboard change is picked up on the NEXT resolution (no restart/snapshot).
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "info",
    });
    expect(
      await resolveApproveFloor({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
      }),
    ).toEqual(toleranceToPolicy("info"));

    await removeRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
    });
    expect(
      await resolveApproveFloor({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
      }),
    ).toEqual(DEFAULT_APPROVE_SEVERITY_POLICY);
  });
});
