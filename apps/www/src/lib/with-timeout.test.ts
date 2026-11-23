import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the work's value", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });

  it("rejects with a TimeoutError when the work outlives the budget", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 500);
    const assertion = expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TimeoutError &&
        error.name === "TimeoutError" &&
        error.message === "timed out after 500ms",
    );
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("propagates the work's own rejection", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1_000),
    ).rejects.toThrow("boom");
  });

  it("clears the timer once the work settles", async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
