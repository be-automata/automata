import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import { createOrganization } from "./organizations";
import {
  getRepoReviewSetting,
  setRepoReviewSetting,
  upsertRepoReviewSetting,
  removeRepoReviewSetting,
  listRepoReviewSettings,
} from "./repo-review-settings";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("repo-review-settings (Neon, org-fenced)", () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("returns undefined when no override exists", async () => {
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
    });
    expect(row).toBeUndefined();
  });

  it("upserts and reads back a tolerance for (org, repo)", async () => {
    const set = await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(set.blockTolerance).toBe("error");

    const got = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
    });
    expect(got?.blockTolerance).toBe("error");
  });

  it("upsert updates in place (one row per org+repo), not a second row", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "warning",
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "info",
    });
    const list = await listRepoReviewSettings({ db, organizationId: orgA });
    expect(list).toHaveLength(1);
    expect(list[0]!.blockTolerance).toBe("info");
  });

  it("lowercases the repo slug on write and read (case-insensitive match)", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "Acme/Widgets",
      blockTolerance: "error",
    });
    const got = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/WIDGETS",
    });
    expect(got?.blockTolerance).toBe("error");
    expect(got?.repoFullName).toBe("acme/widgets");
  });

  it("is org-fenced: the SAME repo slug under two orgs holds independent tolerances", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
      blockTolerance: "info",
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
      blockTolerance: "error",
    });

    const a = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
    });
    const b = await getRepoReviewSetting({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
    });
    expect(a?.blockTolerance).toBe("info");
    expect(b?.blockTolerance).toBe("error");

    // orgB never sees orgA's row in a list, and vice versa.
    expect(
      await listRepoReviewSettings({ db, organizationId: orgA }),
    ).toHaveLength(1);
    expect(
      await listRepoReviewSettings({ db, organizationId: orgB }),
    ).toHaveLength(1);
  });

  it("remove deletes the override and reports whether a row was removed", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(
      await removeRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toBe(true);
    expect(
      await getRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toBeUndefined();
    // Removing an absent override is a no-op returning false.
    expect(
      await removeRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toBe(false);
  });

  it("defaults: a tolerance-only insert leaves reviewDraftPrs TRUE", async () => {
    const row = await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(row.reviewDraftPrs).toBe(true);
    expect(row.blockTolerance).toBe("error");
  });

  it("defaults: a draft-only insert leaves blockTolerance at 'warning'", async () => {
    const row = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { reviewDraftPrs: false },
    });
    expect(row.blockTolerance).toBe("warning");
    expect(row.reviewDraftPrs).toBe(false);
  });

  it("partial upsert: writing one field PRESERVES the other's stored value", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { blockTolerance: "error", reviewDraftPrs: false },
    });
    // Update ONLY the tolerance — draft policy must survive.
    const afterTol = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { blockTolerance: "info" },
    });
    expect(afterTol.blockTolerance).toBe("info");
    expect(afterTol.reviewDraftPrs).toBe(false);

    // Update ONLY the draft policy — tolerance must survive.
    const afterDraft = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { reviewDraftPrs: true },
    });
    expect(afterDraft.reviewDraftPrs).toBe(true);
    expect(afterDraft.blockTolerance).toBe("info");

    // Still exactly one row.
    expect(
      await listRepoReviewSettings({ db, organizationId: orgA }),
    ).toHaveLength(1);
  });

  it("remove is org-fenced: org A cannot delete org B's override", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
      blockTolerance: "info",
    });
    const removed = await removeRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
    });
    expect(removed).toBe(false);
    // orgB's row survives.
    expect(
      await getRepoReviewSetting({
        db,
        organizationId: orgB,
        repoFullName: "shared/repo",
      }),
    ).toBeDefined();
  });
});
