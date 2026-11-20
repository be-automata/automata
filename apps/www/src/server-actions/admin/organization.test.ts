import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import { getOrganizationCellsEnabled } from "@terragon/shared/model/organizations";
import {
  createTestOrg,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser } from "@/test-helpers/mock-next";

import { setOrganizationCellsEnabledAction } from "./organization";

describe("setOrganizationCellsEnabledAction (#708)", () => {
  let adminId: string;
  let orgId: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  async function loginAdmin() {
    const { user, session } = await createTestUser({ db });
    await db
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, user.id));
    await mockLoggedInUser(session);
    adminId = user.id;
  }

  beforeEach(async () => {
    orgId = await createTestOrg({ db });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("rejects a non-admin without writing", async () => {
    const { session } = await createTestUser({ db });
    await mockLoggedInUser(session);
    await expect(
      setOrganizationCellsEnabledAction({
        organizationId: orgId,
        enabled: true,
      }),
    ).rejects.toThrow("Unauthorized");
    expect(
      await getOrganizationCellsEnabled({ db, organizationId: orgId }),
    ).toBe(false);
  });

  it("switches an org on and off and logs ids only", async () => {
    await loginAdmin();
    expect(
      await setOrganizationCellsEnabledAction({
        organizationId: orgId,
        enabled: true,
      }),
    ).toEqual({ ok: true });
    expect(
      await getOrganizationCellsEnabled({ db, organizationId: orgId }),
    ).toBe(true);
    expect(logSpy).toHaveBeenCalledWith("[admin:org-cells]", {
      actorUserId: adminId,
      organizationId: orgId,
      enabled: true,
    });

    expect(
      await setOrganizationCellsEnabledAction({
        organizationId: orgId,
        enabled: false,
      }),
    ).toEqual({ ok: true });
    expect(
      await getOrganizationCellsEnabled({ db, organizationId: orgId }),
    ).toBe(false);
  });

  it("an unknown org is not_found and logs nothing", async () => {
    await loginAdmin();
    expect(
      await setOrganizationCellsEnabledAction({
        organizationId: "no-such-org",
        enabled: true,
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it.each([
    { organizationId: "", enabled: true },
    { organizationId: "x", enabled: "yes" },
    { enabled: true },
  ])("invalid input %j writes nothing", async (input) => {
    await loginAdmin();
    expect(await setOrganizationCellsEnabledAction(input as never)).toEqual({
      ok: false,
      error: "invalid_input",
    });
    expect(
      await getOrganizationCellsEnabled({ db, organizationId: orgId }),
    ).toBe(false);
  });
});
