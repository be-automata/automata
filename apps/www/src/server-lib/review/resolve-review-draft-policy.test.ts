import { describe, it, expect, beforeEach } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { nanoid } from "nanoid";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  ORG_DEFAULT_REPO_SENTINEL,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import { resolveReviewDraftPolicy } from "./resolve-review-draft-policy";

/**
 * Draft-PR intake gate resolution. Precedence: per-repo dashboard setting >
 * automation config > default TRUE (Automata works on drafts by default).
 */

const db = createDb(env.DATABASE_URL!);
const REPO = "acme/widgets";

async function makeOrg(): Promise<string> {
  const org = await createOrganization({
    db,
    name: "acme",
    slug: `acme-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("resolveReviewDraftPolicy", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await makeOrg();
  });

  it("no org, no automation config → default TRUE (works on drafts)", async () => {
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: null,
        repoFullName: REPO,
      }),
    ).toBe(true);
  });

  it("org present, no per-repo row → falls to automation config, else default TRUE", async () => {
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(true);
    // Legacy per-automation opt-out is still honored when there's no dashboard row.
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        automationIncludeDraftPrs: false,
      }),
    ).toBe(false);
  });

  it("a per-repo row WINS over the automation config", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewDraftPrs: false },
    });
    // Dashboard says ignore drafts even though the automation opts them in.
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        automationIncludeDraftPrs: true,
      }),
    ).toBe(false);

    // Flipping the dashboard row back to review-drafts is picked up live.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewDraftPrs: true },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        automationIncludeDraftPrs: false,
      }),
    ).toBe(true);
  });

  it("a tolerance-only row leaves the draft policy at its default TRUE", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { blockTolerance: "error" },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(true);
  });
});

describe("resolveReviewDraftPolicy — org-default sentinel tier", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await makeOrg();
  });

  it("sentinel FALSE + no repo row → drafts skipped, beating automation TRUE", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { reviewDraftPrs: false },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        automationIncludeDraftPrs: true,
      }),
    ).toBe(false);
  });

  it("repo row TRUE wins over sentinel FALSE", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { reviewDraftPrs: false },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewDraftPrs: true },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(true);
  });

  it("PINS THE NO-MIGRATION DECISION: a supersede-only sentinel row carries an authoritative implicit TRUE, beating a legacy includeDraftPRs=false", async () => {
    // reviewDraftPrs is NOT NULL DEFAULT true, so a sentinel row created by
    // the supersede UI alone still speaks for the draft family. Deliberate:
    // matches the repo tier's shipped semantics (dashboard > legacy filter).
    // If this test starts failing because the column went nullable, the
    // migration finally happened — rewrite this to assert the tri-state.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { supersedePolicy: "newest-wins" },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        automationIncludeDraftPrs: false,
      }),
    ).toBe(true);
  });

  it("another org's sentinel is invisible", async () => {
    const otherOrg = await makeOrg();
    await upsertRepoReviewSetting({
      db,
      organizationId: otherOrg,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { reviewDraftPrs: false },
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        automationIncludeDraftPrs: false,
      }),
    ).toBe(false); // falls through to the automation filter, not the foreign sentinel
  });
});
