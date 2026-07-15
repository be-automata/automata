import { describe, it, vi, beforeEach, expect } from "vitest";
import { createCliApiToken } from "./cli-api-token";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User, Session } from "@terragon/shared";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import { session as sessionTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { unwrapResult } from "@/lib/server-actions";

describe("createCliApiToken — org stamping", () => {
  let user: User;
  let session: Session;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
  });

  it("stamps the minting user's active org so the daemon token resolves the tenant", async () => {
    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    await addOrganizationMember({
      db,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
    });
    await db
      .update(sessionTable)
      .set({ activeOrganizationId: org.id })
      .where(eq(sessionTable.id, session.id));

    await mockLoggedInUser(session);
    const key = unwrapResult(await createCliApiToken());

    // The read path resolves { userId, organizationId } from the minted key.
    const ctx = await getDaemonTokenContext({
      headers: new Headers({ "X-Daemon-Token": key }),
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe(user.id);
    expect(ctx!.organizationId).toBe(org.id);
  });

  it("mints without org metadata when the session has no active org (null tenant)", async () => {
    await mockLoggedInUser(session);
    const key = unwrapResult(await createCliApiToken());

    const ctx = await getDaemonTokenContext({
      headers: new Headers({ "X-Daemon-Token": key }),
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.userId).toBe(user.id);
    expect(ctx!.organizationId).toBeNull();
  });
});
