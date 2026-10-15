import { describe, it, vi, beforeEach, expect } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { Session } from "@terragon/shared";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import { session as sessionTable } from "@terragon/shared/db/schema";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { getSlackAppInstallUrl, getSlackOAuthUrl } from "./slack";

describe("slack server actions — install target", () => {
  let session: Session;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    session = created.session;
    const suffix = nanoid(8).toLowerCase();
    const a = await createOrganization({ db, name: "A", slug: `a-${suffix}` });
    const b = await createOrganization({ db, name: "B", slug: `b-${suffix}` });
    for (const org of [a, b]) {
      await addOrganizationMember({
        db,
        organizationId: org.id,
        userId: created.user.id,
        role: "owner",
      });
    }
    orgA = a.id;
    orgB = b.id;
    // Another tab switched the session to B after this page showed A.
    await db
      .update(sessionTable)
      .set({ activeOrganizationId: orgB })
      .where(eq(sessionTable.id, session.id));
    await mockLoggedInUser(session);
  });

  it("refuses an install when the session org is not the one the page showed", async () => {
    const result = await getSlackAppInstallUrl({
      expectedOrganizationId: orgA,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/active organization changed/);
  });

  it("refuses a connect for the same reason", async () => {
    const result = await getSlackOAuthUrl({ expectedOrganizationId: orgA });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/active organization changed/);
  });
});
