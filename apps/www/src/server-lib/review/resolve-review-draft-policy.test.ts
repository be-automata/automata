import { describe, it, expect, beforeEach } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { nanoid } from "nanoid";
import { createOrganization } from "@terragon/shared/model/organizations";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
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
