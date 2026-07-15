import { describe, expect, it, beforeEach } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { redis } from "@/lib/redis";
import {
  withSandboxResource,
  shouldHibernateSandbox,
  getActiveUsers,
  setTerminalActive,
  getTerminalStatus,
  setActiveThreadChat,
  getActiveThreadChats,
} from "./sandbox-resource";

describe("sandbox-resource", () => {
  let testSandboxId: string;

  beforeEach(() => {
    testSandboxId = `test-sandbox-${nanoid()}`;
  });

  describe("withSandboxResource", () => {
    it("should return value from callback", async () => {
      const result = await withSandboxResource({
        label: "test-label",
        sandboxId: testSandboxId,
        callback: async () => {
          return "test";
        },
      });
      expect(result).toBe("test");
    });

    it("should increment active users and decrement after callback", async () => {
      let callbackExecuted = false;
      await withSandboxResource({
        label: "test-label",
        sandboxId: testSandboxId,
        callback: async () => {
          callbackExecuted = true;
          const activeUsers = await getActiveUsers(testSandboxId);
          expect(activeUsers).toBe(1);
        },
      });
      expect(callbackExecuted).toBe(true);
      const finalActiveUsers = await getActiveUsers(testSandboxId);
      expect(finalActiveUsers).toBe(0);
    });

    it("should handle multiple concurrent users", async () => {
      const promises = Array.from({ length: 3 }, (_, i) =>
        withSandboxResource({
          label: "test-label",
          sandboxId: testSandboxId,
          callback: async () => {
            const numActiveUsers = await getActiveUsers(testSandboxId);
            expect(numActiveUsers).not.toBe(0);
            await new Promise((resolve) => setTimeout(resolve, 100));
          },
        }),
      );
      await Promise.all(promises);
      const finalActiveUsers = await getActiveUsers(testSandboxId);
      expect(finalActiveUsers).toBe(0);
    });

    it("should decrement active users even if callback throws", async () => {
      const error = new Error("Test error");
      await expect(
        withSandboxResource({
          label: "test-label",
          sandboxId: testSandboxId,
          callback: async () => {
            throw error;
          },
        }),
      ).rejects.toThrow("Test error");
      const activeUsers = await getActiveUsers(testSandboxId);
      expect(activeUsers).toBe(0);
    });

    it("should set expiration on active users key", async () => {
      await withSandboxResource({
        label: "test-label",
        sandboxId: testSandboxId,
        callback: async () => {
          const ttl = await redis.ttl(`sandbox-active-users:${testSandboxId}`);
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(600);
        },
      });
    });

    it("fails open and still runs the callback if the lock cannot be acquired", async () => {
      // Fail-open quarantine: when the Redis-backed lock is unavailable (empty/errored
      // pipeline result), withSandboxResource must NOT block the run — it proceeds
      // without the lock so a degraded/unconfigured Redis never bricks the agent path.
      const originalPipeline = redis.pipeline;
      redis.pipeline = () =>
        ({
          incr: () => {},
          expire: () => {},
          exec: async () => [null, null],
        }) as any;

      let ran = false;
      try {
        const result = await withSandboxResource({
          label: "test-label",
          sandboxId: testSandboxId,
          callback: async () => {
            ran = true;
            // Restore the real pipeline before withSandboxResource's finally block
            // decrements: the client auto-pipelines every command through
            // redis.pipeline(), so leaving the incomplete mock installed would corrupt
            // the shared auto-pipeline executor for later tests.
            redis.pipeline = originalPipeline;
            return "ok";
          },
        });
        expect(ran).toBe(true);
        expect(result).toBe("ok");
      } finally {
        redis.pipeline = originalPipeline;
      }
    });
  });

  describe("setActiveThreadChat", () => {
    it("should add thread chat id when setting active", async () => {
      const threadChatId = `chat-${nanoid()}`;
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });
      const activeChats = await getActiveThreadChats(testSandboxId);
      expect(activeChats).toContain(threadChatId);
    });

    it("should remove thread chat id when setting inactive", async () => {
      const threadChatId = `chat-${nanoid()}`;
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });
      let activeChats = await getActiveThreadChats(testSandboxId);
      expect(activeChats).toContain(threadChatId);

      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: false,
      });
      activeChats = await getActiveThreadChats(testSandboxId);
      expect(activeChats).not.toContain(threadChatId);
    });

    it("should handle multiple thread chats for same sandbox", async () => {
      const threadChatId1 = `chat-${nanoid()}`;
      const threadChatId2 = `chat-${nanoid()}`;

      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId: threadChatId1,
        isActive: true,
      });
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId: threadChatId2,
        isActive: true,
      });

      const activeChats = await getActiveThreadChats(testSandboxId);
      expect(activeChats).toContain(threadChatId1);
      expect(activeChats).toContain(threadChatId2);
      expect(activeChats.length).toBe(2);
    });

    it("should set expiration on thread chats key", async () => {
      const threadChatId = `chat-${nanoid()}`;
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });

      const ttl = await redis.ttl(
        `sandbox-active-thread-chats:${testSandboxId}`,
      );
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60 * 60 * 24); // 1 day
    });

    it("should remove only specified thread chat when multiple exist", async () => {
      const threadChatId1 = `chat-${nanoid()}`;
      const threadChatId2 = `chat-${nanoid()}`;

      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId: threadChatId1,
        isActive: true,
      });
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId: threadChatId2,
        isActive: true,
      });

      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId: threadChatId1,
        isActive: false,
      });

      const activeChats = await getActiveThreadChats(testSandboxId);
      expect(activeChats).not.toContain(threadChatId1);
      expect(activeChats).toContain(threadChatId2);
      expect(activeChats.length).toBe(1);
    });

    it("should return empty array when no active thread chats", async () => {
      const activeChats = await getActiveThreadChats(testSandboxId);
      expect(activeChats).toEqual([]);
    });

    it("should handle setting same thread chat active multiple times", async () => {
      const threadChatId = `chat-${nanoid()}`;

      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });

      const activeChats = await getActiveThreadChats(testSandboxId);
      expect(activeChats).toContain(threadChatId);
      expect(activeChats.length).toBe(1);
    });
  });

  describe("setTerminalActive", () => {
    it("should set terminal status with expiration", async () => {
      await setTerminalActive({ sandboxId: testSandboxId, expires: 300 });
      const status = await getTerminalStatus(testSandboxId);
      expect(status).toBe(1);

      // Check that expiration is set
      const ttl = await redis.ttl(`sandbox-terminal-status:${testSandboxId}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it("should set expiration on terminal status key", async () => {
      await setTerminalActive({ sandboxId: testSandboxId, expires: 60 * 5 });
      const ttl = await redis.ttl(`sandbox-terminal-status:${testSandboxId}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900); // 15 minutes default
    });

    it("should overwrite existing terminal status", async () => {
      // Set initial status
      await setTerminalActive({ sandboxId: testSandboxId, expires: 100 });
      const status1 = await getTerminalStatus(testSandboxId);
      expect(status1).toBe(1);

      // Set again with different expiration
      await setTerminalActive({ sandboxId: testSandboxId, expires: 200 });
      const status2 = await getTerminalStatus(testSandboxId);
      expect(status2).toBe(1);

      // Check new expiration is applied
      const ttl = await redis.ttl(`sandbox-terminal-status:${testSandboxId}`);
      expect(ttl).toBeGreaterThan(100);
      expect(ttl).toBeLessThanOrEqual(200);
    });
  });

  describe("shouldHibernateSandbox", () => {
    it("should return true when nothing is active", async () => {
      const result = await shouldHibernateSandbox(testSandboxId);
      expect(result).toBe(true);
    });

    it("should return false when there are active users", async () => {
      let shouldHibernateInCallback = false;
      let callbackExecuted = false;
      await withSandboxResource({
        label: "test-label",
        sandboxId: testSandboxId,
        callback: async () => {
          callbackExecuted = true;
          shouldHibernateInCallback =
            await shouldHibernateSandbox(testSandboxId);
        },
      });
      expect(callbackExecuted).toBe(true);
      expect(shouldHibernateInCallback).toBe(false);
    });

    it("should return false when there are active thread chats", async () => {
      const threadChatId = `chat-${nanoid()}`;
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });
      const result = await shouldHibernateSandbox(testSandboxId);
      expect(result).toBe(false);
    });

    it("should return true when thread chat is set to inactive", async () => {
      const threadChatId = `chat-${nanoid()}`;
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: false,
      });
      const result = await shouldHibernateSandbox(testSandboxId);
      expect(result).toBe(true);
    });

    it("should return false when terminal is active", async () => {
      await setTerminalActive({ sandboxId: testSandboxId, expires: 60 * 5 });
      const result = await shouldHibernateSandbox(testSandboxId);
      expect(result).toBe(false);
    });

    it("should return false when terminal is active even with no thread chats", async () => {
      await setTerminalActive({ sandboxId: testSandboxId, expires: 60 * 5 });
      const result = await shouldHibernateSandbox(testSandboxId);
      expect(result).toBe(false);
    });

    it("should return true when terminal expires", async () => {
      await setTerminalActive({ sandboxId: testSandboxId, expires: 1 });

      // Wait for terminal status to expire
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const result = await shouldHibernateSandbox(testSandboxId);
      expect(result).toBe(true);
    });

    it("should return false when multiple conditions are active", async () => {
      const threadChatId = `chat-${nanoid()}`;
      await setActiveThreadChat({
        sandboxId: testSandboxId,
        threadChatId,
        isActive: true,
      });
      await setTerminalActive({ sandboxId: testSandboxId, expires: 60 * 5 });

      const result = await shouldHibernateSandbox(testSandboxId);
      expect(result).toBe(false);
    });
  });
});
