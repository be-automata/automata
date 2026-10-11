import { beforeEach, describe, expect, it } from "vitest";
import {
  createTestAutomation,
  createTestThread,
  createTestUser,
} from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { ThreadStatus, ThreadStatusDeprecated, User } from "../db/types";
import { AutomationAction } from "../automations";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";
import {
  createAutomation,
  updateAutomation,
  getAutomation,
  getAutomations,
  deleteAutomation,
  incrementAutomationRunCount,
  getScheduledAutomations,
  getScheduledAutomationsDueToRun,
  getPullRequestAutomationsForRepo,
  getIssueAutomationRunStats,
} from "./automations";
import { nanoid } from "nanoid/non-secure";

const db = createDb(env.DATABASE_URL!);

describe("automations", () => {
  let user: User;

  beforeEach(async () => {
    await db.delete(schema.automations);
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;
  });

  describe("createAutomation", () => {
    it("should create an automation with default enabled state", async () => {
      const action: AutomationAction = {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Daily standup reminder" }],
          },
        },
      };

      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Daily Standup",
          description: "Send a daily standup reminder",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action,
        },
      });

      expect(automation).toBeDefined();
      expect(automation.id).toBeDefined();
      expect(automation.userId).toBe(user.id);
      expect(automation.name).toBe("Daily Standup");
      expect(automation.description).toBe("Send a daily standup reminder");
      expect(automation.triggerType).toEqual("schedule");
      expect(automation.triggerConfig).toEqual({
        cron: "0 9 * * *",
        timezone: "UTC",
      });
      expect(automation.repoFullName).toBe("terragon/test-repo");
      expect(automation.branchName).toBe("main");
      expect(automation.action).toEqual(action);
      expect(automation.enabled).toBe(true);
      expect(automation.runCount).toBe(0);
      expect(automation.lastRunAt).toBeNull();
      expect(automation.createdAt).toBeDefined();
      expect(automation.updatedAt).toBeDefined();
    });

    it("should create an automation with enabled explicitly set to false", async () => {
      const action: AutomationAction = {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Weekly review" }],
          },
        },
      };

      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Weekly Review",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 0 * * 0", // Weekly on Sunday
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action,
          enabled: false,
        },
      });

      expect(automation.enabled).toBe(false);
    });

    it("should create an automation without description", async () => {
      const action: AutomationAction = {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Check status" }],
          },
        },
      };

      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Status Check",
          triggerType: "schedule",
          triggerConfig: {
            cron: "*/30 * * * *", // Every 30 minutes
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action,
        },
      });

      expect(automation.description).toBeNull();
    });

    it("should create multiple automations for the same user", async () => {
      const action: AutomationAction = {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Test" }],
          },
        },
      };

      const automation1 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Automation 1",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 10 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action,
        },
      });

      const automation2 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Automation 2",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 10 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action,
        },
      });

      expect(automation1.id).not.toBe(automation2.id);
      expect(automation1.userId).toBe(automation2.userId);
    });

    it("should set nextRunAt for scheduled automations", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Daily Task",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Daily task" }],
              },
            },
          },
        },
      });

      expect(automation.nextRunAt).not.toBeNull();
      expect(automation.nextRunAt).toBeInstanceOf(Date);
      // Should be scheduled for the next 9 AM UTC
      const nextRunAt = automation.nextRunAt!;
      expect(nextRunAt.getUTCHours()).toBe(9);
      expect(nextRunAt.getUTCMinutes()).toBe(0);
    });

    it("should not set nextRunAt for non-scheduled automations", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "PR Automation",
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: false,
              includeOtherAuthors: false,
              otherAuthors: "",
            },
            on: {
              open: true,
              update: false,
            },
            autoArchiveOnComplete: false,
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "PR opened" }],
              },
            },
          },
        },
      });

      expect(automation.nextRunAt).toBeNull();
    });
  });

  describe("updateAutomation", () => {
    it("should update automation fields", async () => {
      const action: AutomationAction = {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Original message" }],
          },
        },
      };

      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Original Name",
          description: "Original Description",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action,
        },
      });

      const originalUpdatedAt = automation.updatedAt;

      // Wait to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const newAction: AutomationAction = {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "Updated message" }],
          },
        },
      };

      const updatedAutomation = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          name: "Updated Name",
          description: "Updated Description",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 10 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: newAction,
          enabled: false,
        },
      });

      expect(updatedAutomation.name).toBe("Updated Name");
      expect(updatedAutomation.description).toBe("Updated Description");
      expect(updatedAutomation.triggerType).toEqual("schedule");
      expect(updatedAutomation.triggerConfig).toEqual({
        cron: "0 10 * * *",
        timezone: "UTC",
      });
      expect(updatedAutomation.action).toEqual(newAction);
      expect(updatedAutomation.enabled).toBe(false);
      expect(updatedAutomation.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });

    it("should recalculate nextRunAt when cron schedule changes", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Scheduled Task",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Morning task" }],
              },
            },
          },
        },
      });

      const originalNextRunAt = automation.nextRunAt;
      expect(originalNextRunAt).not.toBeNull();

      // Update to run at 5 PM instead of 9 AM
      const updated = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          triggerConfig: {
            cron: "0 17 * * *",
            timezone: "UTC",
          },
        },
      });

      expect(updated.nextRunAt).not.toBeNull();
      expect(updated.nextRunAt!.getUTCHours()).toBe(17);
      expect(updated.nextRunAt!.getTime()).not.toBe(
        originalNextRunAt!.getTime(),
      );
    });

    it("should recalculate nextRunAt when timezone changes", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Scheduled Task",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Morning task" }],
              },
            },
          },
        },
      });

      const originalNextRunAt = automation.nextRunAt;

      // Change timezone from UTC to EST
      const updated = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "America/New_York",
          },
        },
      });

      expect(updated.nextRunAt).not.toBeNull();
      // 9 AM EST is different from 9 AM UTC
      expect(updated.nextRunAt!.getTime()).not.toBe(
        originalNextRunAt!.getTime(),
      );
    });

    it("should clear nextRunAt when changing from scheduled to pull_request trigger", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Scheduled Task",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Task" }],
              },
            },
          },
        },
      });

      expect(automation.nextRunAt).not.toBeNull();

      const updated = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: false,
              includeOtherAuthors: false,
              otherAuthors: "",
            },
            on: {
              open: true,
              update: false,
            },
            autoArchiveOnComplete: false,
          },
        },
      });

      expect(updated.nextRunAt).toBeNull();
    });

    it("should set nextRunAt when changing from pull_request to scheduled trigger", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "PR Task",
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: false,
              includeOtherAuthors: false,
              otherAuthors: "",
            },
            on: {
              open: true,
              update: false,
            },
            autoArchiveOnComplete: false,
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Task" }],
              },
            },
          },
        },
      });

      expect(automation.nextRunAt).toBeNull();

      const updated = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
        },
      });

      expect(updated.nextRunAt).not.toBeNull();
      expect(updated.nextRunAt!.getUTCHours()).toBe(9);
    });

    it("should update lastRunAt and increment runCount", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      expect(automation.runCount).toBe(0);
      expect(automation.lastRunAt).toBeNull();

      const runDate = new Date();
      const updatedAutomation = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          lastRunAt: runDate,
          runCount: automation.runCount + 1,
        },
      });

      expect(updatedAutomation.runCount).toBe(1);
      expect(updatedAutomation.lastRunAt).toEqual(runDate);

      // Run again
      const runDate2 = new Date();
      const updatedAutomation2 = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          lastRunAt: runDate2,
          runCount: updatedAutomation.runCount + 1,
        },
      });

      expect(updatedAutomation2.runCount).toBe(2);
      expect(updatedAutomation2.lastRunAt).toEqual(runDate2);
    });

    it("should fail to update automation with wrong user", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      const { user: otherUser } = await createTestUser({ db });

      await expect(
        updateAutomation({
          db,
          automationId: automation.id,
          userId: otherUser.id,
          accessTier: "core",
          updates: { name: "Hacked" },
        }),
      ).rejects.toThrow("Failed to update automation");
    });

    it("should fail to update non-existent automation", async () => {
      await expect(
        updateAutomation({
          db,
          automationId: "non-existent-id",
          userId: user.id,
          accessTier: "core",
          updates: { name: "New Name" },
        }),
      ).rejects.toThrow("Failed to update automation");
    });

    it("should update only specified fields", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Original Name",
          description: "Original Description",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Original" }],
              },
            },
          },
        },
      });

      const updatedAutomation = await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          name: "New Name",
          // Other fields should remain unchanged
        },
      });

      expect(updatedAutomation.name).toBe("New Name");
      expect(updatedAutomation.description).toBe("Original Description");
      expect(updatedAutomation.triggerType).toEqual("schedule");
      expect(updatedAutomation.triggerConfig).toEqual(automation.triggerConfig);
      expect(updatedAutomation.action).toEqual(automation.action);
      expect(updatedAutomation.enabled).toBe(automation.enabled);
    });
  });

  describe("getAutomation", () => {
    it("should get automation by id and userId", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          description: "Test Description",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      const retrievedAutomation = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });

      expect(retrievedAutomation).toBeDefined();
      expect(retrievedAutomation!.id).toBe(automation.id);
      expect(retrievedAutomation!.name).toBe("Test Automation");
    });

    it("should return undefined for non-existent automation", async () => {
      const automation = await getAutomation({
        db,
        automationId: "non-existent-id",
        userId: user.id,
      });

      expect(automation).toBeUndefined();
    });

    it("should not return automation for wrong user", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      const { user: otherUser } = await createTestUser({ db });

      const retrievedAutomation = await getAutomation({
        db,
        automationId: automation.id,
        userId: otherUser.id,
      });

      expect(retrievedAutomation).toBeUndefined();
    });
  });

  describe("getAutomations", () => {
    it("should get all automations for a user", async () => {
      // Create multiple automations
      const automation1 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Automation 1",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test 1" }],
              },
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const automation2 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Automation 2",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 10 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test 2" }],
              },
            },
          },
        },
      });

      const automations = await getAutomations({ db, userId: user.id });

      expect(automations.length).toBe(2);
      // Should be ordered by updatedAt desc
      expect(automations[0]!.id).toBe(automation2.id);
      expect(automations[1]!.id).toBe(automation1.id);
    });

    it("should support pagination", async () => {
      // Create 5 automations
      for (let i = 0; i < 5; i++) {
        await createAutomation({
          db,
          userId: user.id,
          accessTier: "core",
          automation: {
            name: `Automation ${i}`,
            triggerType: "schedule",
            triggerConfig: {
              cron: "0 9 * * *",
              timezone: "UTC",
            },
            repoFullName: "terragon/test-repo",
            branchName: "main",
            action: {
              type: "user_message",
              config: {
                message: {
                  type: "user",
                  model: null,
                  parts: [{ type: "text", text: `Test ${i}` }],
                },
              },
            },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const page1 = await getAutomations({
        db,
        userId: user.id,
        limit: 2,
        offset: 0,
      });
      expect(page1.length).toBe(2);

      const page2 = await getAutomations({
        db,
        userId: user.id,
        limit: 2,
        offset: 2,
      });
      expect(page2.length).toBe(2);

      const page3 = await getAutomations({
        db,
        userId: user.id,
        limit: 2,
        offset: 4,
      });
      expect(page3.length).toBe(1);

      // Verify no overlap
      const page1Ids = page1.map((a) => a.id);
      const page2Ids = page2.map((a) => a.id);
      const page3Ids = page3.map((a) => a.id);
      expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
      expect(page1Ids.some((id) => page3Ids.includes(id))).toBe(false);
      expect(page2Ids.some((id) => page3Ids.includes(id))).toBe(false);
    });

    it("should return empty array when user has no automations", async () => {
      const automations = await getAutomations({ db, userId: user.id });
      expect(automations).toEqual([]);
    });

    it("should not return automations from other users", async () => {
      const { user: otherUser } = await createTestUser({ db });

      await createAutomation({
        db,
        userId: otherUser.id,
        accessTier: "core",
        automation: {
          name: "Other User Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      const automations = await getAutomations({ db, userId: user.id });
      expect(automations).toEqual([]);
    });
  });

  describe("deleteAutomation", () => {
    it("should delete an automation", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "To Be Deleted",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      // Verify it exists
      const beforeDelete = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });
      expect(beforeDelete).toBeDefined();

      // Delete it
      const deletedAutomation = await deleteAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });

      expect(deletedAutomation.id).toBe(automation.id);

      // Verify it's deleted
      const afterDelete = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });
      expect(afterDelete).toBeUndefined();
    });

    it("should fail to delete automation with wrong user", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      const { user: otherUser } = await createTestUser({ db });

      await expect(
        deleteAutomation({
          db,
          automationId: automation.id,
          userId: otherUser.id,
        }),
      ).rejects.toThrow("Failed to delete automation");
    });

    it("should fail to delete non-existent automation", async () => {
      await expect(
        deleteAutomation({
          db,
          automationId: "non-existent-id",
          userId: user.id,
        }),
      ).rejects.toThrow("Failed to delete automation");
    });
  });

  describe("incrementAutomationRunCount", () => {
    it("should increment run count and update lastRunAt", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      expect(automation.runCount).toBe(0);
      expect(automation.lastRunAt).toBeNull();

      const beforeRunAt = new Date();
      const updatedAutomation = await incrementAutomationRunCount({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
      });

      expect(updatedAutomation.runCount).toBe(1);
      expect(updatedAutomation.lastRunAt).toBeDefined();
      expect(updatedAutomation.lastRunAt!.getTime()).toBeGreaterThanOrEqual(
        beforeRunAt.getTime(),
      );

      // Run again
      const updatedAutomation2 = await incrementAutomationRunCount({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
      });

      expect(updatedAutomation2.runCount).toBe(2);
      expect(updatedAutomation2.lastRunAt!.getTime()).toBeGreaterThanOrEqual(
        updatedAutomation.lastRunAt!.getTime(),
      );
    });

    it("should increment run count using SQL expression", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      // Manually set runCount to verify SQL increment
      await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: { runCount: 10 },
      });

      const updatedAutomation = await incrementAutomationRunCount({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
      });

      expect(updatedAutomation.runCount).toBe(11);
    });

    it("should fail for non-existent automation", async () => {
      await expect(
        incrementAutomationRunCount({
          db,
          automationId: "non-existent-id",
          userId: user.id,
          accessTier: "core",
        }),
      ).rejects.toThrow("Automation not found");
    });

    it("should fail for wrong user", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      const { user: otherUser } = await createTestUser({ db });

      await expect(
        incrementAutomationRunCount({
          db,
          automationId: automation.id,
          userId: otherUser.id,
          accessTier: "core",
        }),
      ).rejects.toThrow("Automation not found");
    });

    it("should handle concurrent increments correctly", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Test Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      // Run multiple increments concurrently
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          incrementAutomationRunCount({
            db,
            automationId: automation.id,
            userId: user.id,
            accessTier: "core",
          }),
        );
      }

      await Promise.all(promises);

      const finalAutomation = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });

      // Due to SQL increment, all 5 increments should have succeeded
      expect(finalAutomation!.runCount).toBe(5);
      expect(finalAutomation!.lastRunAt).toBeDefined();
    });

    it("should update nextRunAt when incrementing run count", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Scheduled Task",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Daily task" }],
              },
            },
          },
        },
      });

      const originalNextRunAt = automation.nextRunAt;
      expect(originalNextRunAt).not.toBeNull();

      // Wait a moment to ensure time has passed
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Increment run count (simulating successful execution)
      const updated = await incrementAutomationRunCount({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
      });

      expect(updated.nextRunAt).not.toBeNull();
      expect(updated.lastRunAt).not.toBeNull();
      // Next run should be at least as far in the future as the original
      expect(updated.nextRunAt!.getTime()).toBeGreaterThanOrEqual(
        originalNextRunAt!.getTime(),
      );
      // Should still be scheduled for 9 AM
      expect(updated.nextRunAt!.getUTCHours()).toBe(9);
      expect(updated.nextRunAt!.getUTCMinutes()).toBe(0);
    });

    it("should not update nextRunAt for non-scheduled automations", async () => {
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "PR Task",
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: false,
              includeOtherAuthors: false,
              otherAuthors: "",
            },
            on: {
              open: true,
              update: false,
            },
            autoArchiveOnComplete: false,
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "PR task" }],
              },
            },
          },
        },
      });

      expect(automation.nextRunAt).toBeNull();

      const updated = await incrementAutomationRunCount({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
      });

      expect(updated.nextRunAt).toBeNull();
      expect(updated.lastRunAt).not.toBeNull();
      expect(updated.runCount).toBe(1);
    });
  });

  describe("getScheduledAutomations", () => {
    it("should return only enabled scheduled automations", async () => {
      // Create multiple automations with different states
      const scheduledEnabled = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Scheduled Enabled",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
          enabled: true,
        },
      });

      const scheduledDisabled = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Scheduled Disabled",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 10 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
          enabled: false,
        },
      });

      // Create another user's scheduled automation
      const { user: otherUser } = await createTestUser({ db });
      const otherUserScheduled = await createAutomation({
        db,
        userId: otherUser.id,
        accessTier: "core",
        automation: {
          name: "Other User Scheduled",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 11 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
          enabled: true,
        },
      });

      const scheduledAutomations = await getScheduledAutomations({ db });

      // Should include both users' enabled scheduled automations
      const automationIds = scheduledAutomations.map((a) => a.id);
      expect(automationIds).toContain(scheduledEnabled.id);
      expect(automationIds).toContain(otherUserScheduled.id);
      expect(automationIds).not.toContain(scheduledDisabled.id);
    });

    it("should return empty array when no scheduled automations exist", async () => {
      // Get the current count of scheduled automations
      const initialAutomations = await getScheduledAutomations({ db });
      const initialCount = initialAutomations.length;

      // Create a disabled automation (should not be returned)
      await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Disabled Test",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
          enabled: false,
        },
      });

      // Count should remain the same
      const scheduledAutomations = await getScheduledAutomations({ db });
      expect(scheduledAutomations.length).toBe(initialCount);
    });

    it("should not return non-scheduled automations", async () => {
      // Get the current count of scheduled automations
      const initialAutomations = await getScheduledAutomations({ db });
      const initialCount = initialAutomations.length;

      // Currently only "schedule" type exists, but this test is for future-proofing
      // Create a scheduled automation that is disabled
      await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Disabled Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
          enabled: false,
        },
      });

      const scheduledAutomations = await getScheduledAutomations({ db });
      // Count should remain the same since we only added a disabled automation
      expect(scheduledAutomations.length).toBe(initialCount);
    });

    it("should return automations from multiple users", async () => {
      // Create automations for multiple users
      const users = await Promise.all([
        createTestUser({ db }),
        createTestUser({ db }),
        createTestUser({ db }),
      ]);

      const automations = await Promise.all(
        users.map((testUserAndAccount, index) =>
          createAutomation({
            db,
            userId: testUserAndAccount.user.id,
            accessTier: "core",
            automation: {
              name: `User ${index} Automation`,
              triggerType: "schedule",
              triggerConfig: {
                cron: `0 ${index} * * *`,
                timezone: "UTC",
              },
              repoFullName: "terragon/test-repo",
              branchName: "main",
              action: {
                type: "user_message",
                config: {
                  message: {
                    type: "user",
                    model: null,
                    parts: [{ type: "text", text: `Test ${index}` }],
                  },
                },
              },
              enabled: true,
            },
          }),
        ),
      );

      const scheduledAutomations = await getScheduledAutomations({ db });
      const automationIds = scheduledAutomations.map((a) => a.id);

      // Should include all enabled scheduled automations
      automations.forEach((automation) => {
        expect(automationIds).toContain(automation.id);
      });
    });

    it("should return automations with complex cron expressions", async () => {
      const complexCronAutomations = [
        { cron: "0 0,12 * * 1-5", name: "Twice daily on weekdays" },
        { cron: "*/15 * * * *", name: "Every 15 minutes" },
        { cron: "0 0 1 * *", name: "Monthly on the 1st" },
        { cron: "0 0 * * 0", name: "Weekly on Sunday" },
      ];

      await Promise.all(
        complexCronAutomations.map((config) =>
          createAutomation({
            db,
            userId: user.id,
            accessTier: "core",
            automation: {
              name: config.name,
              triggerType: "schedule",
              triggerConfig: {
                cron: config.cron,
                timezone: "UTC",
              },
              repoFullName: "terragon/test-repo",
              branchName: "main",
              action: {
                type: "user_message",
                config: {
                  message: {
                    type: "user",
                    model: null,
                    parts: [{ type: "text", text: "Test" }],
                  },
                },
              },
              enabled: true,
            },
          }),
        ),
      );

      const scheduledAutomations = await getScheduledAutomations({ db });
      expect(scheduledAutomations.length).toBeGreaterThanOrEqual(
        complexCronAutomations.length,
      );

      // Verify all have the correct properties
      scheduledAutomations.forEach((automation) => {
        expect(automation.enabled).toBe(true);
        expect(automation.triggerType).toBe("schedule");
        expect(automation.triggerConfig).toBeDefined();
        if (automation.triggerType === "schedule") {
          const config = automation.triggerConfig as {
            cron: string;
            timezone: string;
          };
          expect(config.cron).toBeDefined();
        }
      });
    });
  });

  describe("getPullRequestAutomationsForRepo", () => {
    it("should return only enabled pull request automations for a specific repo", async () => {
      const repoFullName = `terragon/test-repo-${nanoid()}`;
      const otherRepoFullName = `terragon/test-repo-${nanoid()}`;

      // Create pull request automation for test repo (enabled)
      const prAutomation1 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "PR Automation 1",
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: false,
              includeOtherAuthors: true,
            },
            on: {
              open: true,
              update: false,
            },
          },
          repoFullName,
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "PR opened" }],
              },
            },
          },
          enabled: true,
        },
      });

      // Create pull request automation for test repo (disabled)
      await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "PR Automation 2 (disabled)",
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: true,
              includeOtherAuthors: false,
            },
            on: {
              open: false,
              update: true,
            },
          },
          repoFullName,
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "PR updated" }],
              },
            },
          },
          enabled: false,
        },
      });

      // Create pull request automation for different repo
      const prAutomation3 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Other Repo PR Automation",
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: false,
              includeOtherAuthors: true,
            },
            on: {
              open: true,
              update: true,
            },
          },
          repoFullName: otherRepoFullName,
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "PR event" }],
              },
            },
          },
          enabled: true,
        },
      });

      // Create schedule automation (should not be returned)
      await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Schedule Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName,
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Scheduled" }],
              },
            },
          },
          enabled: true,
        },
      });

      // Get automations for test repo
      const automations = await getPullRequestAutomationsForRepo({
        db,
        repoFullName,
      });

      // Should only return the enabled pull request automation for test repo
      expect(automations.length).toBe(1);
      expect(automations[0]!.id).toBe(prAutomation1.id);
      expect(automations[0]!.triggerType).toBe("pull_request");
      expect(automations[0]!.enabled).toBe(true);

      // Get automations for other repo
      const otherRepoAutomations = await getPullRequestAutomationsForRepo({
        db,
        repoFullName: otherRepoFullName,
      });

      expect(otherRepoAutomations.length).toBe(1);
      expect(otherRepoAutomations[0]!.id).toBe(prAutomation3.id);

      // Get automations for non-existent repo
      const noAutomations = await getPullRequestAutomationsForRepo({
        db,
        repoFullName: "terragon/non-existent",
      });

      expect(noAutomations.length).toBe(0);
    });
  });

  describe("edge cases and concurrency", () => {
    it("should handle concurrent automation creation", async () => {
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          createAutomation({
            db,
            userId: user.id,
            accessTier: "core",
            automation: {
              name: `Concurrent ${i}`,
              triggerType: "schedule",
              triggerConfig: {
                cron: "0 9 * * *",
                timezone: "UTC",
              },
              repoFullName: "terragon/test-repo",
              branchName: "main",
              action: {
                type: "user_message",
                config: {
                  message: {
                    type: "user",
                    model: null,
                    parts: [{ type: "text", text: `Test ${i}` }],
                  },
                },
              },
            },
          }),
        );
      }

      const automations = await Promise.all(promises);
      expect(automations.length).toBe(5);

      // Verify all were created
      const allAutomations = await getAutomations({ db, userId: user.id });
      expect(allAutomations.length).toBe(5);
    });

    it("should handle complex automation configurations", async () => {
      const complexAction: AutomationAction = {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [
              { type: "text", text: "Run automated tests for " },
              { type: "text", text: "feature branch with " },
              { type: "text", text: "complex workflow" },
            ],
          },
        },
      };

      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Complex Automation",
          description: "A complex automation with detailed configuration",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 0,6,12,18 * * 1-5", // Every 6 hours on weekdays
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: complexAction,
        },
      });

      expect(automation.triggerType).toEqual("schedule");
      expect(automation.triggerConfig).toEqual({
        cron: "0 0,6,12,18 * * 1-5", // Every 6 hours on weekdays
        timezone: "UTC",
      });
      expect(automation.action).toEqual(complexAction);

      // Verify it can be retrieved correctly
      const retrieved = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });

      expect(retrieved!.triggerType).toEqual("schedule");
      expect(retrieved!.triggerConfig).toEqual({
        cron: "0 0,6,12,18 * * 1-5", // Every 6 hours on weekdays
        timezone: "UTC",
      });
      expect(retrieved!.action).toEqual(complexAction);
    });

    it("should handle automation lifecycle", async () => {
      // Create
      const automation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Lifecycle Test",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Test" }],
              },
            },
          },
        },
      });

      // Disable
      await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: { enabled: false },
      });

      // Run it (even though disabled)
      const firstRun = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });

      await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          lastRunAt: new Date(),
          runCount: firstRun!.runCount + 1,
        },
      });

      // Re-enable
      await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: { enabled: true },
      });

      // Run it again
      const secondRun = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });

      await updateAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
        accessTier: "core",
        updates: {
          lastRunAt: new Date(),
          runCount: secondRun!.runCount + 1,
        },
      });

      const finalAutomation = await getAutomation({
        db,
        automationId: automation.id,
        userId: user.id,
      });

      expect(finalAutomation!.enabled).toBe(true);
      expect(finalAutomation!.runCount).toBe(2);
      expect(finalAutomation!.lastRunAt).toBeDefined();
    });
  });

  describe("getScheduledAutomationsDueToRun", () => {
    it("should return automations with nextRunAt in the past", async () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
      const futureDate = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours from now

      // Create automation that should run (nextRunAt in the past)
      const dueAutomation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Due Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Should run" }],
              },
            },
          },
        },
      });

      // Manually update nextRunAt to be in the past
      await db
        .update(schema.automations)
        .set({ nextRunAt: pastDate })
        .where(eq(schema.automations.id, dueAutomation.id));

      // Create automation that should not run (nextRunAt in the future)
      const futureAutomation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Future Automation",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 17 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Should not run yet" }],
              },
            },
          },
        },
      });

      // Manually update nextRunAt to be in the future
      await db
        .update(schema.automations)
        .set({ nextRunAt: futureDate })
        .where(eq(schema.automations.id, futureAutomation.id));

      const dueAutomations = await getScheduledAutomationsDueToRun({ db });
      const dueIds = dueAutomations.map((a) => a.id);
      expect(dueIds).toContain(dueAutomation.id);
      expect(dueIds).not.toContain(futureAutomation.id);
    });

    it("should not return disabled automations even if due", async () => {
      const pastDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      const disabledAutomation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Disabled Due Automation",
          enabled: false,
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Disabled" }],
              },
            },
          },
        },
      });

      // Manually update nextRunAt to be in the past
      await db
        .update(schema.automations)
        .set({ nextRunAt: pastDate })
        .where(eq(schema.automations.id, disabledAutomation.id));

      const dueAutomations = await getScheduledAutomationsDueToRun({ db });
      const dueIds = dueAutomations.map((a) => a.id);

      expect(dueIds).not.toContain(disabledAutomation.id);
    });

    it("should not return non-scheduled automations", async () => {
      const prAutomation = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "PR Automation",
          triggerType: "pull_request",
          triggerConfig: {
            filter: {
              includeDraftPRs: false,
              includeOtherAuthors: false,
              otherAuthors: "",
            },
            on: {
              open: true,
              update: false,
            },
            autoArchiveOnComplete: false,
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "PR" }],
              },
            },
          },
        },
      });

      const dueAutomations = await getScheduledAutomationsDueToRun({ db });
      const dueIds = dueAutomations.map((a) => a.id);

      expect(dueIds).not.toContain(prAutomation.id);
    });

    it("should return automations ordered by nextRunAt", async () => {
      const now = new Date();
      const dates = [
        new Date(now.getTime() - 3 * 60 * 60 * 1000), // 3 hours ago
        new Date(now.getTime() - 1 * 60 * 60 * 1000), // 1 hour ago
        new Date(now.getTime() - 2 * 60 * 60 * 1000), // 2 hours ago
      ];

      const automations = await Promise.all(
        dates.map((date, i) =>
          createAutomation({
            db,
            userId: user.id,
            accessTier: "core",
            automation: {
              name: `Automation ${i}`,
              triggerType: "schedule",
              triggerConfig: {
                cron: "0 9 * * *",
                timezone: "UTC",
              },
              repoFullName: "terragon/test-repo",
              branchName: "main",
              action: {
                type: "user_message",
                config: {
                  message: {
                    type: "user",
                    model: null,
                    parts: [{ type: "text", text: `Task ${i}` }],
                  },
                },
              },
            },
          }),
        ),
      );

      // Update nextRunAt for each automation
      await Promise.all(
        automations.map((automation, i) =>
          db
            .update(schema.automations)
            .set({ nextRunAt: dates[i] })
            .where(eq(schema.automations.id, automation.id)),
        ),
      );

      const dueAutomations = await getScheduledAutomationsDueToRun({ db });
      const relevantAutomations = dueAutomations.filter((a) =>
        automations.some((created) => created.id === a.id),
      );

      // Should be ordered by nextRunAt (oldest first)
      expect(relevantAutomations).toHaveLength(3);
      expect(relevantAutomations[0]?.id).toBe(automations[0]?.id); // 3 hours ago
      expect(relevantAutomations[1]?.id).toBe(automations[2]?.id); // 2 hours ago
      expect(relevantAutomations[2]?.id).toBe(automations[1]?.id); // 1 hour ago
    });

    it("should use provided currentTime parameter", async () => {
      const futureTime = new Date("2025-01-01T12:00:00Z");
      const beforeFutureTime = new Date("2025-01-01T10:00:00Z");
      const afterFutureTime = new Date("2025-01-01T14:00:00Z");

      const automation1 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "Before Future Time",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "Before" }],
              },
            },
          },
        },
      });

      const automation2 = await createAutomation({
        db,
        userId: user.id,
        accessTier: "core",
        automation: {
          name: "After Future Time",
          triggerType: "schedule",
          triggerConfig: {
            cron: "0 9 * * *",
            timezone: "UTC",
          },
          repoFullName: "terragon/test-repo",
          branchName: "main",
          action: {
            type: "user_message",
            config: {
              message: {
                type: "user",
                model: null,
                parts: [{ type: "text", text: "After" }],
              },
            },
          },
        },
      });

      // Set specific nextRunAt times
      await db
        .update(schema.automations)
        .set({ nextRunAt: beforeFutureTime })
        .where(eq(schema.automations.id, automation1.id));

      await db
        .update(schema.automations)
        .set({ nextRunAt: afterFutureTime })
        .where(eq(schema.automations.id, automation2.id));

      // Query with future time
      const dueAutomations = await getScheduledAutomationsDueToRun({
        db,
        currentTime: futureTime,
      });
      const dueIds = dueAutomations.map((a) => a.id);

      // Only automation1 should be due (beforeFutureTime < futureTime)
      expect(dueIds).toContain(automation1.id);
      expect(dueIds).not.toContain(automation2.id);
    });
  });

  describe("getIssueAutomationRunStats", () => {
    it("counts this automation's threads for the issue and the in-flight ones", async () => {
      const repoFullName = `terragon/test-repo-${nanoid()}`;
      const automation = await createTestAutomation({
        db,
        userId: user.id,
        values: { triggerType: "issue", repoFullName },
      });
      const other = await createTestAutomation({
        db,
        userId: user.id,
        values: { triggerType: "issue", repoFullName },
      });
      const issueThread = ({
        status,
        ...overrides
      }: NonNullable<Parameters<typeof createTestThread>[0]["overrides"]> & {
        status: Exclude<ThreadStatus, ThreadStatusDeprecated>;
      }) =>
        createTestThread({
          db,
          userId: user.id,
          overrides: {
            githubRepoFullName: repoFullName,
            automationId: automation.id,
            githubIssueNumber: 7,
            ...overrides,
          },
          chatOverrides: { status },
        });

      expect(
        await getIssueAutomationRunStats({
          db,
          automationId: automation.id,
          repoFullName,
          issueNumber: 7,
        }),
      ).toEqual({ total: 0, active: 0 });

      await issueThread({ status: "complete" });
      await issueThread({ status: "working" });
      await issueThread({ status: "queued", archived: true });
      // Not counted: other issue, other automation, other repo.
      await issueThread({ githubIssueNumber: 8, status: "working" });
      await issueThread({ automationId: other.id, status: "working" });
      await issueThread({
        githubRepoFullName: `terragon/other-${nanoid()}`,
        status: "working",
      });

      expect(
        await getIssueAutomationRunStats({
          db,
          automationId: automation.id,
          repoFullName,
          issueNumber: 7,
        }),
      ).toEqual({ total: 3, active: 1 });
    });

    it("treats a typed terminal cause as not in flight", async () => {
      const repoFullName = `terragon/test-repo-${nanoid()}`;
      const automation = await createTestAutomation({
        db,
        userId: user.id,
        values: { triggerType: "issue", repoFullName },
      });
      await createTestThread({
        db,
        userId: user.id,
        overrides: {
          githubRepoFullName: repoFullName,
          automationId: automation.id,
          githubIssueNumber: 1,
          terminalCause: "superseded",
        },
        chatOverrides: { status: "working" },
      });
      expect(
        await getIssueAutomationRunStats({
          db,
          automationId: automation.id,
          repoFullName,
          issueNumber: 1,
        }),
      ).toEqual({ total: 1, active: 0 });
    });
  });
});
