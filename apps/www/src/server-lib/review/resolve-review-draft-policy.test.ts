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
 * Draft-PR intake gate resolution. TRI-STATE precedence: explicit per-repo
 * value > explicit org-sentinel value > legacy automation filter > TRUE.
 * NULL at either dashboard tier means "no choice here" and falls through.
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
        automationIncludeDraftPrs: false,
      }),
    ).toBe(false);
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(true);
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
    // Tri-state: the row's draft value is NULL (no choice), so resolution
    // falls through the empty tiers to the system default.
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

  it("TRI-STATE (the migration happened): a supersede-only sentinel row is NO draft choice — the legacy filter wins again", async () => {
    // The predecessor of this test pinned the opposite (implicit true beats
    // the legacy filter) and instructed its own rewrite once the column went
    // nullable. It did: a row created by another family now carries NULL and
    // falls through, so a legacy includeDraftPRs:false is honoured again.
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
    ).toBe(false);
  });

  it("TRI-STATE: a repo row with a NULL draft value inherits THROUGH to the org sentinel", async () => {
    // The wart the migration removes: a tolerance-only repo row used to pin
    // drafts to implicit true, masking an org-level OFF.
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
      patch: { blockTolerance: "info" }, // draft family untouched → NULL
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(false);
  });

  it("TRI-STATE: PUT reviewDraftPrs null clears a repo override back to inherit", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { reviewDraftPrs: false },
    });
    const row = await upsertRepoReviewSetting({
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
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewDraftPrs: null },
      expectedUpdatedAt: row.updatedAt,
    });
    expect(
      await resolveReviewDraftPolicy({
        db,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBe(false); // inherits the org OFF again
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
