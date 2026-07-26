import { describe, it, beforeEach, vi, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestOrganization,
} from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { withDefaultActiveOrganization } from "./active-org";

describe("withDefaultActiveOrganization (session.create.before hook body)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
  });

  it("stamps the member's org onto a new session", async () => {
    const { organization } = await createTestOrganization({
      db,
      userId: user.id,
      name: "stamp",
    });
    const session = { userId: user.id, token: "t" };
    const result = await withDefaultActiveOrganization({ db, session });
    expect(result).toEqual({
      data: { ...session, activeOrganizationId: organization.id },
    });
  });

  it("returns undefined for a user with no org (session unchanged)", async () => {
    expect(
      await withDefaultActiveOrganization({ db, session: { userId: user.id } }),
    ).toBeUndefined();
  });

  it("respects an explicit activeOrganizationId", async () => {
    await createTestOrganization({ db, userId: user.id, name: "ignored" });
    expect(
      await withDefaultActiveOrganization({
        db,
        session: { userId: user.id, activeOrganizationId: "explicit-org" },
      }),
    ).toBeUndefined();
  });

  it("picks the oldest-created org for multi-org users", async () => {
    const { organization: first } = await createTestOrganization({
      db,
      userId: user.id,
      name: "first",
    });
    // createdAt has ms precision — guarantee a strictly later second org.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createTestOrganization({ db, userId: user.id, name: "second" });
    const result = await withDefaultActiveOrganization({
      db,
      session: { userId: user.id, activeOrganizationId: null },
    });
    expect(result?.data.activeOrganizationId).toBe(first.id);
  });
});
