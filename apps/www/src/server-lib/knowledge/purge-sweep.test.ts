import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  runKnowledgePurgeSweep,
  type KnowledgePurgeSweepDeps,
} from "./purge-sweep";

const COUNTS = {
  claims: 2,
  pins: 3,
  ops: 1,
  decisions: 1,
  cursors: 1,
  intents: 1,
};

function makeDeps(
  overrides: Partial<KnowledgePurgeSweepDeps> = {},
): KnowledgePurgeSweepDeps {
  return {
    listDue: vi.fn(async () => ["A", "B"]),
    purge: vi.fn(async () => COUNTS),
    log: { log: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("runKnowledgePurgeSweep", () => {
  it("purges each due org in order and logs ids and counts only", async () => {
    const deps = makeDeps();
    const r = await runKnowledgePurgeSweep(deps);
    expect(r).toEqual({ purged: 2, failed: 0, timedOut: 0 });
    expect(vi.mocked(deps.purge).mock.calls.map((c) => c[0])).toEqual([
      "A",
      "B",
    ]);
    expect(deps.log.log).toHaveBeenCalledWith("[cron:knowledge-purge]", {
      organizationId: "A",
      ...COUNTS,
    });
  });

  it("continues after a failing org and logs the error name only", async () => {
    const purge = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret statement text"))
      .mockResolvedValueOnce(COUNTS);
    const deps = makeDeps({ purge });
    const r = await runKnowledgePurgeSweep(deps);
    expect(r).toEqual({ purged: 1, failed: 1, timedOut: 0 });
    expect(deps.log.error).toHaveBeenCalledWith("[cron:knowledge-purge]", {
      organizationId: "A",
      error: "Error",
    });
    expect(JSON.stringify(vi.mocked(deps.log.error).mock.calls)).not.toContain(
      "secret",
    );
  });

  it("counts a hung org as timed out and continues", async () => {
    const purge = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(COUNTS);
    const deps = makeDeps({
      purge,
      budget: { totalMs: 5_000, perOrgMs: 20, limit: 10 },
    });
    const r = await runKnowledgePurgeSweep(deps);
    expect(r).toEqual({ purged: 1, failed: 0, timedOut: 1 });
  });

  it("logs a timed-out purge's outcome when it settles late", async () => {
    let finish: (counts: typeof COUNTS) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const purge = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<typeof COUNTS>((resolve) => (finish = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<typeof COUNTS>((_, reject) => (fail = reject)),
      );
    const deps = makeDeps({
      purge,
      budget: { totalMs: 5_000, perOrgMs: 20, limit: 10 },
    });
    const r = await runKnowledgePurgeSweep(deps);
    expect(r).toEqual({ purged: 0, failed: 0, timedOut: 2 });

    finish(COUNTS);
    fail(new TypeError("secret statement text"));
    await vi.waitFor(() => {
      expect(deps.log.log).toHaveBeenCalledWith(
        "[cron:knowledge-purge] finished after timeout",
        { organizationId: "A", ...COUNTS },
      );
      expect(deps.log.error).toHaveBeenCalledWith(
        "[cron:knowledge-purge] failed after timeout",
        { organizationId: "B", error: "TypeError" },
      );
    });
    expect(JSON.stringify(vi.mocked(deps.log.error).mock.calls)).not.toContain(
      "secret",
    );
  });

  it("skips remaining orgs when the total budget is exhausted", async () => {
    const deps = makeDeps({
      purge: vi.fn(() => new Promise<never>(() => undefined)),
      budget: { totalMs: 30, perOrgMs: 1_000, limit: 10 },
    });
    const r = await runKnowledgePurgeSweep(deps);
    expect(r.timedOut).toBe(1);
    expect(deps.purge).toHaveBeenCalledTimes(1);
  });

  it("never throws when listing fails", async () => {
    const deps = makeDeps({
      listDue: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(runKnowledgePurgeSweep(deps)).resolves.toEqual({
      purged: 0,
      failed: 0,
      timedOut: 0,
    });
    expect(deps.log.error).toHaveBeenCalled();
  });
});
