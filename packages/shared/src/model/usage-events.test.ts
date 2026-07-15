import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import {
  getUserUsageEvents,
  getUserUsageEventsAggregated,
  trackUsageEventBatched,
} from "./usage-events";
import { createOrganization } from "./organizations";
import { nanoid } from "nanoid";
import { set as setDateValues, subDays } from "date-fns";
import { tz } from "@date-fns/tz";
import { OPENAI_RESPONSES_GPT_5_SKU } from "./usage-pricing";

const db = createDb(env.DATABASE_URL!);

describe("usage-events", () => {
  let user: User;

  beforeEach(async () => {
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;
  });

  describe("trackUsageEventBatched", () => {
    it("should track multiple events", async () => {
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [
          { eventType: "claude_cost_usd", value: 1 },
          {
            eventType: "sandbox_usage_time_application_ms",
            value: 5 * 60 * 1000,
          },
          {
            eventType: "billable_openai_usd",
            value: 2.5,
            sku: OPENAI_RESPONSES_GPT_5_SKU,
            tokenUsage: {
              inputTokens: 2000,
              cachedInputTokens: 100,
              outputTokens: 500,
            },
          },
        ],
      });
      const events = await getUserUsageEvents({
        db,
        userId: user.id,
        eventType: "claude_cost_usd",
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(user.id);
      expect(events[0]!.eventType).toBe("claude_cost_usd");
      expect(events[0]!.value).toBe("1");

      const events2 = await getUserUsageEvents({
        db,
        userId: user.id,
        eventType: "sandbox_usage_time_application_ms",
      });
      expect(events2).toHaveLength(1);
      expect(events2[0]!.userId).toBe(user.id);
      expect(events2[0]!.eventType).toBe("sandbox_usage_time_application_ms");
      expect(events2[0]!.value).toBe((5 * 60 * 1000).toString());

      const openAiEvents = await getUserUsageEvents({
        db,
        userId: user.id,
        eventType: "billable_openai_usd",
      });

      expect(openAiEvents).toHaveLength(1);
      expect(openAiEvents[0]!.value).toBe("2.5");
      expect(openAiEvents[0]!.inputTokens).toBe(2000);
      expect(openAiEvents[0]!.cachedInputTokens).toBe(100);
      expect(openAiEvents[0]!.outputTokens).toBe(500);
      expect(openAiEvents[0]!.sku).toBe(OPENAI_RESPONSES_GPT_5_SKU);
    });

    it("stamps organizationId on the written events (WI-5)", async () => {
      const org = await createOrganization({
        db,
        name: "Acme",
        slug: `acme-${nanoid(8).toLowerCase()}`,
      });
      await trackUsageEventBatched({
        db,
        userId: user.id,
        organizationId: org.id,
        events: [{ eventType: "claude_cost_usd", value: 3 }],
      });
      const events = await getUserUsageEvents({
        db,
        userId: user.id,
        eventType: "claude_cost_usd",
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.organizationId).toBe(org.id);
    });

    it("leaves organizationId null when unset (nullable-safe)", async () => {
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [{ eventType: "claude_cost_usd", value: 1 }],
      });
      const events = await getUserUsageEvents({
        db,
        userId: user.id,
        eventType: "claude_cost_usd",
      });
      expect(events[0]!.organizationId).toBeNull();
    });
  });

  describe("getUserUsageEvents", () => {
    beforeEach(async () => {
      // Create some test events
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [
          {
            eventType: "claude_cost_usd",
            value: 1,
          },
        ],
      });
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [
          {
            eventType: "claude_cost_usd",
            value: 2,
          },
        ],
      });
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [
          {
            eventType: "sandbox_usage_time_application_ms",
            value: 5 * 60 * 1000, // 5 minutes
          },
        ],
      });
    });

    it("all events for a user", async () => {
      const events = await getUserUsageEvents({ db, userId: user.id });
      expect(events).toHaveLength(3);
    });

    it("filter by event type", async () => {
      const events = await getUserUsageEvents({
        db,
        userId: user.id,
        eventType: "claude_cost_usd",
      });
      expect(events).toHaveLength(2);
      expect(events[0]!.eventType).toBe("claude_cost_usd");
      expect(events[1]!.eventType).toBe("claude_cost_usd");
    });

    it("filter by date range", async () => {
      const futureDate = new Date(Date.now() + 1000);
      const tomorrow = new Date(futureDate.getTime() + 24 * 60 * 60 * 1000);
      const events = await getUserUsageEvents({
        db,
        userId: user.id,
        startDate: futureDate,
        endDate: tomorrow,
      });
      expect(events).toHaveLength(0);
    });

    it("should return empty array for user with no events", async () => {
      const newUser = await createTestUser({ db });
      const events = await getUserUsageEvents({
        db,
        userId: newUser.user.id,
      });
      expect(events).toHaveLength(0);
    });
  });
  describe("getUserUsageEventsAggregated", () => {
    it("should return aggregated events", async () => {
      for (const value of [0.1, 0.2, 0.3]) {
        await trackUsageEventBatched({
          db,
          userId: user.id,
          events: [
            {
              eventType: "claude_cost_usd",
              value,
              createdAt: new Date("2021-01-01"),
            },
            {
              eventType: "sandbox_usage_time_agent_ms",
              value: 60 * 1000 * value,
              createdAt: new Date("2021-01-01"),
            },
          ],
        });
      }
      for (const value of [0.4, 0.5, 0.6]) {
        await trackUsageEventBatched({
          db,
          userId: user.id,
          events: [
            {
              eventType: "claude_cost_usd",
              value,
              createdAt: new Date("2021-01-02"),
            },
            {
              eventType: "sandbox_usage_time_agent_ms",
              value: 60 * 1000 * value,
              createdAt: new Date("2021-01-02"),
            },
          ],
        });
      }
      for (const value of [0.7, 0.8, 0.9]) {
        await trackUsageEventBatched({
          db,
          userId: user.id,
          events: [
            {
              eventType: "claude_cost_usd",
              value,
              createdAt: new Date("2021-01-03"),
            },
            {
              eventType: "sandbox_usage_time_agent_ms",
              value: 60 * 1000 * value,
              createdAt: new Date("2021-01-03"),
            },
          ],
        });
      }
      const events = await getUserUsageEventsAggregated({
        db,
        userId: user.id,
        startDate: new Date("2021-01-01"),
        endDate: new Date("2021-01-03"),
      });
      expect(events).toEqual([
        {
          date: "2021-01-01",
          eventType: "claude_cost_usd",
          value: "0.6",
        },
        {
          date: "2021-01-01",
          eventType: "sandbox_usage_time_agent_ms",
          value: "36000",
        },
        {
          date: "2021-01-02",
          eventType: "claude_cost_usd",
          value: "1.5",
        },
        {
          date: "2021-01-02",
          eventType: "sandbox_usage_time_agent_ms",
          value: "90000",
        },
        {
          date: "2021-01-03",
          eventType: "claude_cost_usd",
          value: "2.4",
        },
        {
          date: "2021-01-03",
          eventType: "sandbox_usage_time_agent_ms",
          value: "144000",
        },
      ]);
    });

    it("should handle timezone parameter correctly", async () => {
      // Create event at 2021-01-01 23:00 UTC
      // In UTC: 2021-01-01
      // In Europe/Paris (UTC+1): 2021-01-02 00:00
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [
          {
            eventType: "claude_cost_usd",
            value: 1.0,
            createdAt: new Date("2021-01-01T23:00:00Z"),
          },
        ],
      });

      // Create event at 2021-01-02 01:00 UTC
      // In UTC: 2021-01-02
      // In Europe/Paris (UTC+1): 2021-01-02 02:00
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [
          {
            eventType: "claude_cost_usd",
            value: 2.0,
            createdAt: new Date("2021-01-02T01:00:00Z"),
          },
        ],
      });

      // Test with UTC timezone (default)
      const eventsUTC = await getUserUsageEventsAggregated({
        db,
        userId: user.id,
        startDate: new Date("2021-01-01T00:00:00Z"),
        endDate: new Date("2021-01-02T23:59:59Z"),
      });

      expect(eventsUTC).toHaveLength(2);
      expect(eventsUTC.find((e) => e.date === "2021-01-01")?.value).toBe("1");
      expect(eventsUTC.find((e) => e.date === "2021-01-02")?.value).toBe("2");

      // Test with UTC+1 timezone (Europe/Paris)
      const eventsParis = await getUserUsageEventsAggregated({
        db,
        userId: user.id,
        startDate: new Date("2021-01-01T00:00:00Z"),
        endDate: new Date("2021-01-02T23:59:59Z"),
        timezone: "Europe/Paris",
      });

      expect(eventsParis).toHaveLength(1);
      expect(eventsParis.find((e) => e.date === "2021-01-02")?.value).toBe("3");

      // Test with invalid timezone (should default to UTC)
      const eventsInvalid = await getUserUsageEventsAggregated({
        db,
        userId: user.id,
        startDate: new Date("2021-01-01T00:00:00Z"),
        endDate: new Date("2021-01-02T23:59:59Z"),
        timezone: "Invalid/Timezone",
      });

      expect(eventsInvalid).toHaveLength(2);
      expect(eventsInvalid.find((e) => e.date === "2021-01-01")?.value).toBe(
        "1",
      );
      expect(eventsInvalid.find((e) => e.date === "2021-01-02")?.value).toBe(
        "2",
      );
    });

    it("should handle timezone boundaries correctly with toUTC", async () => {
      // Create an event at a specific time
      await trackUsageEventBatched({
        db,
        userId: user.id,
        events: [
          {
            eventType: "claude_cost_usd",
            value: 1.0,
            createdAt: new Date("2025-07-23 16:00:16.850631"),
          },
        ],
      });
      const end = setDateValues(
        new Date("2025-07-23T19:30:10.573-07:00"),
        {},
        { in: tz("America/Los_Angeles") },
      );
      const start = setDateValues(
        subDays(end, 1, {
          in: tz("America/Los_Angeles"),
        }),
        { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 },
      );
      const events = await getUserUsageEventsAggregated({
        db,
        userId: user.id,
        startDate: start,
        endDate: end,
        timezone: "America/Los_Angeles",
      });
      expect(events).toEqual([
        {
          date: "2025-07-23",
          eventType: "claude_cost_usd",
          value: "1",
        },
      ]);
    });
  });
});
