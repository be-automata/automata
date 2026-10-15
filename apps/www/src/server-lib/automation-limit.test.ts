import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import {
  createTestAutomation,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { automations as automationsTable } from "@terragon/shared/db/schema";
import { DEFAULT_MAX_AUTOMATIONS } from "@/lib/subscription-tiers";
import { getAutomationLimitStatus } from "./automations";

describe("getAutomationLimitStatus", () => {
  it(
    "counts active automations across every org (the cap is account-wide)",
    { timeout: 20_000 },
    async () => {
      const { user } = await createTestUser({ db });
      for (const name of ["Acme", "Customer"]) {
        const org = await createOrganization({
          db,
          name,
          slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
        });
        const automation = await createTestAutomation({ db, userId: user.id });
        await db
          .update(automationsTable)
          .set({ organizationId: org.id, enabled: true })
          .where(eq(automationsTable.id, automation.id));
      }

      const status = await getAutomationLimitStatus({
        userId: user.id,
        tier: "core",
      });

      expect(status.count).toBe(2);
      expect(status.max).toBe(DEFAULT_MAX_AUTOMATIONS);
      expect(status.reached).toBe(
        DEFAULT_MAX_AUTOMATIONS !== null && 2 >= DEFAULT_MAX_AUTOMATIONS,
      );
    },
  );

  it("has no cap on pro", async () => {
    const { user } = await createTestUser({ db });
    expect(
      await getAutomationLimitStatus({ userId: user.id, tier: "pro" }),
    ).toEqual({ reached: false, count: 0, max: null });
  });
});
