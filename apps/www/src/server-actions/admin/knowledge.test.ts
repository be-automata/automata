import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import {
  createTestOrg,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { setKnowledgeBudgetCeiling } from "@terragon/shared/model/knowledge-controls";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import {
  getKnowledgeCeilingAction,
  setKnowledgeCeilingAction,
} from "./knowledge";

describe("knowledge ceiling admin actions", () => {
  let adminId: string;
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
    await db.delete(schema.knowledgePlatformSettings);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await db.delete(schema.knowledgePlatformSettings);
  });

  it("rejects non-admin users without writing", async () => {
    const { session } = await createTestUser({ db });
    await mockLoggedInUser(session);
    await expect(getKnowledgeCeilingAction()).rejects.toThrow("Unauthorized");
    await expect(setKnowledgeCeilingAction({ dollars: "50" })).rejects.toThrow(
      "Unauthorized",
    );
    const rows = await db.select().from(schema.knowledgePlatformSettings);
    expect(rows).toHaveLength(0);
  });

  it("returns the default when no row exists", async () => {
    await loginAdmin();
    expect(await getKnowledgeCeilingAction()).toEqual({
      ceilingMicroUsd: 100_000_000,
      isDefault: true,
      updatedByUserId: null,
      updatedAt: null,
      absoluteMaxMicroUsd: 10_000_000_000,
    });
  });

  it("round-trips a set and logs once", async () => {
    await loginAdmin();
    expect(await setKnowledgeCeilingAction({ dollars: "50" })).toEqual({
      ok: true,
    });
    const got = await getKnowledgeCeilingAction();
    expect(got.ceilingMicroUsd).toBe(50_000_000);
    expect(got.isDefault).toBe(false);
    expect(got.updatedByUserId).toBe(adminId);
    expect(typeof got.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(got.updatedAt!))).toBe(false);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[knowledge:ceiling]", {
      actorUserId: adminId,
      fromMicroUsd: null,
      toMicroUsd: 50_000_000,
    });
  });

  it("accepts fractional dollars exactly", async () => {
    await loginAdmin();
    await setKnowledgeCeilingAction({ dollars: "0.000001" });
    expect((await getKnowledgeCeilingAction()).ceilingMicroUsd).toBe(1);
  });

  it.each([{ dollars: "" }, { reset: true }])(
    "resets with %j",
    async (input) => {
      await loginAdmin();
      await setKnowledgeCeilingAction({ dollars: "50" });
      expect(await setKnowledgeCeilingAction(input)).toEqual({ ok: true });
      expect((await getKnowledgeCeilingAction()).isDefault).toBe(true);
    },
  );

  it.each(["-1", "abc", "1.0000001", "10000.01", "99999999999999999999"])(
    "rejects %s and writes nothing",
    async (dollars) => {
      await loginAdmin();
      expect(await setKnowledgeCeilingAction({ dollars })).toEqual({
        ok: false,
        error: "invalid_amount",
      });
      expect((await getKnowledgeCeilingAction()).isDefault).toBe(true);
      expect(logSpy).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly the $10k maximum", async () => {
    await loginAdmin();
    expect(await setKnowledgeCeilingAction({ dollars: "10000" })).toEqual({
      ok: true,
    });
  });

  it("lowering the ceiling leaves an org budget unchanged", async () => {
    await loginAdmin();
    const orgId = await createTestOrg({ db, name: "Lower" });
    await db.insert(schema.organizationReviewSettings).values({
      organizationId: orgId,
      knowledgeBudgetMicroUsd: 80_000_000,
    });
    await setKnowledgeBudgetCeiling(db, {
      micro: 200_000_000,
      actorUserId: adminId,
    });
    await setKnowledgeCeilingAction({ dollars: "10" });
    const [row] = await db
      .select()
      .from(schema.organizationReviewSettings)
      .where(eq(schema.organizationReviewSettings.organizationId, orgId));
    expect(row?.knowledgeBudgetMicroUsd).toBe(80_000_000);
  });
});
