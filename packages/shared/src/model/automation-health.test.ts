import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";

import { createDb } from "../db";
import {
  DEGRADED_AFTER_FAILURES,
  getAutomationHealth,
} from "./automation-health";
import {
  createTestAutomation,
  createTestOrg,
  createTestThread,
  createTestUser,
} from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

describe("getAutomationHealth", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgId = await createTestOrg({ db, name: "Health" });
  });

  /** Runs created oldest first, so the last status is the newest run. */
  async function runs(
    automationId: string,
    statuses: ("complete" | "working" | "working-error")[],
  ) {
    for (const status of statuses) {
      await createTestThread({
        db,
        userId,
        overrides: { organizationId: orgId, automationId },
        chatOverrides: { status },
      });
    }
  }

  it("returns nothing for an empty automation list", async () => {
    expect((await getAutomationHealth({ db, automations: [] })).size).toBe(0);
  });

  it(`marks ${DEGRADED_AFTER_FAILURES} failures in a row degraded, but not one fewer`, async () => {
    const flaky = await createTestAutomation({ db, userId });
    const wobbly = await createTestAutomation({ db, userId });
    await runs(flaky.id, [
      "complete",
      "working-error",
      "working-error",
      "working-error",
    ]);
    await runs(wobbly.id, ["complete", "working-error", "working-error"]);
    const health = await getAutomationHealth({
      db,
      automations: [
        { id: flaky.id, enabled: true },
        { id: wobbly.id, enabled: true },
      ],
    });
    expect(health.get(flaky.id)?.health).toBe("degraded");
    expect(health.get(flaky.id)?.successRate7d).toBeCloseTo(0.25);
    expect(health.get(flaky.id)?.failuresInLast5).toBe(3);
    expect(health.get(wobbly.id)?.health).toBe("healthy");
  });

  it("reports running, paused and idle, with a null success rate when nothing finished", async () => {
    const live = await createTestAutomation({ db, userId });
    const paused = await createTestAutomation({
      db,
      userId,
      values: { enabled: false },
    });
    const fresh = await createTestAutomation({ db, userId });
    await runs(live.id, ["working"]);
    const health = await getAutomationHealth({
      db,
      automations: [
        { id: live.id, enabled: true },
        { id: paused.id, enabled: false },
        { id: fresh.id, enabled: true },
      ],
    });
    expect(health.get(live.id)?.health).toBe("running");
    expect(health.get(live.id)?.successRate7d).toBeNull();
    expect(health.get(paused.id)?.health).toBe("paused");
    expect(health.get(fresh.id)?.health).toBe("idle");
    expect(health.get(fresh.id)?.lastRun).toBeNull();
  });

  it("keeps each automation's own newest 14 runs, so a busy one cannot hide a quiet one", async () => {
    const busy = await createTestAutomation({ db, userId });
    const quiet = await createTestAutomation({ db, userId });
    await runs(quiet.id, ["working-error", "working-error", "working-error"]);
    await runs(
      busy.id,
      Array.from({ length: 16 }, () => "complete" as const),
    );
    const health = await getAutomationHealth({
      db,
      automations: [
        { id: busy.id, enabled: true },
        { id: quiet.id, enabled: true },
      ],
    });
    expect(health.get(busy.id)?.history).toHaveLength(14);
    expect(health.get(busy.id)?.health).toBe("healthy");
    expect(health.get(quiet.id)?.history).toHaveLength(3);
    expect(health.get(quiet.id)?.health).toBe("degraded");
  });
});
