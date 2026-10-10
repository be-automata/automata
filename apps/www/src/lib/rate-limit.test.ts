import { afterEach, describe, expect, it, vi } from "vitest";

// A Redis client with no methods at all: any real @upstash/ratelimit call
// against it throws (`evalsha is not a function`), exactly like the in-memory
// stand-in in apps/www/src/lib/redis.ts.
async function loadRateLimit(inMemory: boolean) {
  vi.resetModules();
  vi.doMock("./redis", () => ({ isInMemoryRedis: inMemory, redis: {} }));
  return import("./rate-limit");
}

afterEach(() => {
  vi.doUnmock("./redis");
  vi.resetModules();
});

describe("rate limits against the in-memory Redis stand-in", () => {
  it("never trip and never call Upstash", async () => {
    const rl = await loadRateLimit(true);
    await expect(rl.trackSandboxCreation("u1")).resolves.toBeUndefined();
    await expect(rl.checkWaitlistRateLimit("1.2.3.4")).resolves.toMatchObject({
      success: true,
    });
    await expect(rl.checkOnboardingRateLimit("1.2.3.4")).resolves.toMatchObject(
      { success: true },
    );
    await expect(rl.checkCliTaskCreationRateLimit("u1")).resolves.toMatchObject(
      { success: true },
    );
    await expect(rl.getSandboxCreationRemaining("u1")).resolves.toEqual({
      remaining: Number.MAX_SAFE_INTEGER,
      reset: 0,
    });
  });
});

describe("rate limits against a real Redis", () => {
  it("still propagate backend errors (no global fail-open)", async () => {
    const rl = await loadRateLimit(false);
    await expect(rl.trackSandboxCreation("u1")).rejects.toThrow();
    await expect(rl.checkWaitlistRateLimit("1.2.3.4")).rejects.toThrow();
    await expect(rl.checkCliTaskCreationRateLimit("u1")).rejects.toThrow();
  });
});
