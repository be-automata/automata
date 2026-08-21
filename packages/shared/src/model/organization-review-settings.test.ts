import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import { createOrganization } from "./organizations";
import { createTestUser } from "./test-helpers";
import {
  getOrganizationReviewSetting,
  upsertOrganizationReviewSetting,
  removeOrganizationReviewSetting,
} from "./organization-review-settings";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("organization-review-settings (Neon, org-fenced)", () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("returns undefined when no floor row exists", async () => {
    const row = await getOrganizationReviewSetting({
      db,
      organizationId: orgA,
    });
    expect(row).toBeUndefined();
  });

  it("upserts and reads back blockTolerance", async () => {
    const set = await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { blockTolerance: "error" },
    });
    expect(set.blockTolerance).toBe("error");
    expect(set.trustedAuthorThreshold).toBeNull();

    const got = await getOrganizationReviewSetting({
      db,
      organizationId: orgA,
    });
    expect(got?.blockTolerance).toBe("error");
  });

  it("upserts and reads back trustedAuthorThreshold", async () => {
    const set = await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { trustedAuthorThreshold: "COLLABORATOR" },
    });
    expect(set.trustedAuthorThreshold).toBe("COLLABORATOR");
    expect(set.blockTolerance).toBeNull();

    const got = await getOrganizationReviewSetting({
      db,
      organizationId: orgA,
    });
    expect(got?.trustedAuthorThreshold).toBe("COLLABORATOR");
  });

  it("partial upsert: writing one field PRESERVES the other's stored value", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { blockTolerance: "error", trustedAuthorThreshold: "OWNER" },
    });

    // Update ONLY blockTolerance — trustedAuthorThreshold must survive.
    const afterTol = await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { blockTolerance: "info" },
    });
    expect(afterTol.blockTolerance).toBe("info");
    expect(afterTol.trustedAuthorThreshold).toBe("OWNER");

    // Update ONLY trustedAuthorThreshold — blockTolerance must survive.
    const afterThreshold = await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { trustedAuthorThreshold: "MEMBER" },
    });
    expect(afterThreshold.trustedAuthorThreshold).toBe("MEMBER");
    expect(afterThreshold.blockTolerance).toBe("info");
  });

  it("explicit null clears a previously set floor", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { blockTolerance: "error", trustedAuthorThreshold: "OWNER" },
    });
    const cleared = await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { trustedAuthorThreshold: null },
    });
    expect(cleared.trustedAuthorThreshold).toBeNull();
    expect(cleared.blockTolerance).toBe("error");
  });

  it("is org-fenced: the org floor for org A is never returned for org B", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { blockTolerance: "info", trustedAuthorThreshold: "OWNER" },
    });
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgB,
      patch: { blockTolerance: "error", trustedAuthorThreshold: "NONE" },
    });

    const a = await getOrganizationReviewSetting({ db, organizationId: orgA });
    const b = await getOrganizationReviewSetting({ db, organizationId: orgB });
    expect(a?.blockTolerance).toBe("info");
    expect(a?.trustedAuthorThreshold).toBe("OWNER");
    expect(b?.blockTolerance).toBe("error");
    expect(b?.trustedAuthorThreshold).toBe("NONE");
  });

  it("records updatedByUserId", async () => {
    const { user } = await createTestUser({ db });
    const row = await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { blockTolerance: "warning" },
      updatedByUserId: user.id,
    });
    expect(row.updatedByUserId).toBe(user.id);
  });

  it("remove deletes the floor row and reports whether a row was removed", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgA,
      patch: { blockTolerance: "error" },
    });
    expect(
      await removeOrganizationReviewSetting({ db, organizationId: orgA }),
    ).toBe(true);
    expect(
      await getOrganizationReviewSetting({ db, organizationId: orgA }),
    ).toBeUndefined();
    // Removing an absent floor is a no-op returning false.
    expect(
      await removeOrganizationReviewSetting({ db, organizationId: orgA }),
    ).toBe(false);
  });

  it("remove is org-fenced: org A cannot delete org B's floor", async () => {
    await upsertOrganizationReviewSetting({
      db,
      organizationId: orgB,
      patch: { blockTolerance: "info" },
    });
    const removed = await removeOrganizationReviewSetting({
      db,
      organizationId: orgA,
    });
    expect(removed).toBe(false);
    // orgB's row survives.
    expect(
      await getOrganizationReviewSetting({ db, organizationId: orgB }),
    ).toBeDefined();
  });
});
