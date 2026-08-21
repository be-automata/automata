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
  upsertOrganizationReviewSetting,
  removeOrganizationReviewSetting,
} from "@terragon/shared/model/organization-review-settings";
import {
  DEFAULT_APPROVE_SEVERITY_POLICY,
  GATE_SEVERITY_POLICY,
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

  // ---------------------------------------------------------------------
  // Org floor composition (ADR-005 §1/§4, issue #73). The org row can only
  // TIGHTEN the repo-tier result — never loosen it.
  // ---------------------------------------------------------------------

  it("AC1: org warning + repo error → composed floor is warning (org tightens)", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "warning" },
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    const policy = await resolveApproveFloor({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
    });
    expect(policy).toEqual({
      blockSeverity: "warning",
      surfaceSeverity: "warning",
    });
  });

  it("AC2: org warning + repo info → composed floor is info (stricter repo honored)", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "warning" },
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "info",
    });
    const policy = await resolveApproveFloor({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
    });
    expect(policy).toEqual(toleranceToPolicy("info"));
  });

  it("the floor cannot LOOSEN: org error + repo info → composed floor stays info", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "error" },
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "info",
    });
    const policy = await resolveApproveFloor({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
    });
    expect(policy).toEqual(toleranceToPolicy("info"));
  });

  it("removing the org row reverts to the repo-only result (rollback)", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "warning" },
    });
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
    ).toEqual({ blockSeverity: "warning", surfaceSeverity: "warning" });

    await removeOrganizationReviewSetting({ db, organizationId: orgId });

    expect(
      await resolveApproveFloor({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
      }),
    ).toEqual(toleranceToPolicy("error"));
  });

  it('invalid org strings ("bogus", "") are treated as absent, no crash', async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });

    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "bogus" },
    });
    expect(
      await resolveApproveFloor({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
      }),
    ).toEqual(toleranceToPolicy("error"));

    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "" },
    });
    expect(
      await resolveApproveFloor({
        db,
        organizationId: orgId,
        repoFullName: "acme/widgets",
      }),
    ).toEqual(toleranceToPolicy("error"));
  });

  // -----------------------------------------------------------------------
  // (c) ReviewGate untouched — the live, composed-vs-untouched contrast:
  // GATE_SEVERITY_POLICY (the internal gate's OWN, deliberately non-per-repo
  // bar — owner ruling, ADR-005) must stay exactly {warning,warning} even
  // when an org floor is configured, while resolveApproveFloor (the
  // external-PR verdict path this issue wires up) DOES pick up the tightened
  // org floor. This is the one place in the repo that can exercise both
  // sides live; the static "no code path could wire the gate up" guarantee
  // lives in packages/review/tests/review/severity-policy.test.ts.
  // -----------------------------------------------------------------------
  it("ReviewGate untouched: org floor of info tightens resolveApproveFloor but GATE_SEVERITY_POLICY is unaffected", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgId,
      patch: { blockTolerance: "info" },
    });

    const externalFloor = await resolveApproveFloor({
      db,
      organizationId: orgId,
      repoFullName: "acme/widgets",
    });
    expect(externalFloor).toEqual({
      blockSeverity: "info",
      surfaceSeverity: "info",
    });

    // GATE_SEVERITY_POLICY is a module-level constant — never read from the DB
    // or affected by any org/repo row — so it stays exactly as today.
    expect(GATE_SEVERITY_POLICY).toEqual({
      blockSeverity: "warning",
      surfaceSeverity: "warning",
    });
  });
});
