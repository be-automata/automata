import { describe, expect, it, vi } from "vitest";

import { reconcileExpiredCells } from "./reconcile";

const NOW = 1_000_000;

function setup(
  cells: { cellId: string; tags: Record<string, string> }[],
  over: {
    revoke?: (k: string, a: number) => Promise<void>;
    teardown?: (id: string) => Promise<void>;
    limit?: number;
  } = {},
) {
  const calls: string[] = [];
  const provider = {
    listByTags: vi.fn(async () => cells),
    teardown: vi.fn(async (id: string) => {
      calls.push(`teardown:${id}`);
      await over.teardown?.(id);
    }),
  };
  const revoke = vi.fn(async (k: string, a: number) => {
    calls.push(`revoke:${k}:${a}`);
    await over.revoke?.(k, a);
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const run = () =>
    reconcileExpiredCells({
      provider,
      revoke,
      now: () => NOW,
      logger,
      limit: over.limit,
      // Just under 1 keeps every element in place: list order, no shuffle.
      random: () => 0.9999999,
    });
  return { calls, provider, revoke, logger, run };
}

const tags = (stepKey: string, expiresAt: number, attempt = "1") => ({
  automata: "cell",
  stepKey,
  attempt,
  expiresAt: String(expiresAt),
  worker: "w1",
  epoch: "1",
});

describe("reconcileExpiredCells", () => {
  it("revokes before tearing down an expired cell and leaves a live one", async () => {
    const s = setup([
      { cellId: "x", tags: tags("cell:x", NOW - 1) },
      { cellId: "y", tags: tags("cell:y", NOW + 600_000) },
    ]);
    const r = await s.run();
    expect(s.calls).toEqual(["revoke:cell:x:1", "teardown:x"]);
    expect(r).toEqual({
      listed: 2,
      expired: 1,
      reaped: 1,
      failed: 0,
      deferred: 0,
    });
  });

  it("treats expiresAt equal to now as expired", async () => {
    const s = setup([{ cellId: "x", tags: tags("cell:x", NOW) }]);
    expect((await s.run()).reaped).toBe(1);
  });

  it("reaps a cell with invalid tags without a revoke", async () => {
    const s = setup([
      { cellId: "a", tags: { automata: "cell" } },
      { cellId: "b", tags: { ...tags("cell:b", NOW + 1), attempt: "zero" } },
    ]);
    const r = await s.run();
    expect(s.revoke).not.toHaveBeenCalled();
    expect(s.provider.teardown).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      listed: 2,
      expired: 2,
      reaped: 2,
      failed: 0,
      deferred: 0,
    });
    expect(s.logger.warn).toHaveBeenCalled();
  });

  it("reaps a cell with an invalid expiresAt, revoking its valid key", async () => {
    const s = setup([
      { cellId: "c", tags: { ...tags("cell:c", 0), expiresAt: "soon" } },
    ]);
    const r = await s.run();
    expect(s.calls).toEqual(["revoke:cell:c:1", "teardown:c"]);
    expect(r.reaped).toBe(1);
  });

  it("still tears down when revoke fails, and counts it", async () => {
    const s = setup([{ cellId: "x", tags: tags("cell:x", NOW - 1) }], {
      revoke: async () => {
        throw new Error("db down");
      },
    });
    const r = await s.run();
    expect(s.calls).toEqual(["revoke:cell:x:1", "teardown:x"]);
    expect(r).toEqual({
      listed: 1,
      expired: 1,
      reaped: 0,
      failed: 1,
      deferred: 0,
    });
  });

  it("isolates a failed teardown from the next cell", async () => {
    const s = setup(
      [
        { cellId: "x", tags: tags("cell:x", NOW - 1) },
        { cellId: "z", tags: tags("cell:z", NOW - 1) },
      ],
      {
        teardown: async (id) => {
          if (id === "x") throw new Error("boom");
        },
      },
    );
    const r = await s.run();
    expect(s.calls).toEqual([
      "revoke:cell:x:1",
      "teardown:x",
      "revoke:cell:z:1",
      "teardown:z",
    ]);
    expect(r).toEqual({
      listed: 2,
      expired: 2,
      reaped: 1,
      failed: 1,
      deferred: 0,
    });
  });

  it("stops at the limit", async () => {
    const cells = [1, 2, 3, 4].map((n) => ({
      cellId: `c${n}`,
      tags: tags(`cell:${n}`, NOW - 1),
    }));
    const s = setup(cells, { limit: 2 });
    const r = await s.run();
    expect(s.provider.teardown).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      listed: 4,
      expired: 2,
      reaped: 2,
      failed: 0,
      deferred: 2,
    });
  });

  it("never logs tags beyond cellId, stepKey, attempt and error code", async () => {
    const s = setup([{ cellId: "x", tags: tags("cell:x", NOW - 1) }], {
      revoke: async () => {
        throw new Error("secret-ish message");
      },
    });
    await s.run();
    const logged = JSON.stringify([
      ...s.logger.info.mock.calls,
      ...s.logger.warn.mock.calls,
    ]);
    expect(logged).not.toContain("secret-ish");
    expect(logged).not.toContain("expiresAt");
  });

  it("reaches a healthy expired cell behind always-failing ones within a few runs", async () => {
    // A stable list order with 20 failing cells ahead of one healthy cell
    // would starve it at limit 20; the shuffle must reach it.
    const cells = [
      ...Array.from({ length: 20 }, (_, n) => ({
        cellId: `bad${n}`,
        tags: tags(`cell:bad${n}`, NOW - 1),
      })),
      { cellId: "good", tags: tags("cell:good", NOW - 1) },
    ];
    const reaped = new Set<string>();
    const s = setup(cells, {
      teardown: async (id) => {
        if (id.startsWith("bad")) throw new Error("stuck");
        reaped.add(id);
      },
    });
    // Deterministic LCG, so the test is stable.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let runs = 0;
    while (!reaped.has("good") && runs < 10) {
      runs += 1;
      await reconcileExpiredCells({
        provider: s.provider,
        revoke: s.revoke,
        now: () => NOW,
        logger: s.logger,
        random,
      });
    }
    expect(reaped.has("good")).toBe(true);
    expect(runs).toBeLessThanOrEqual(10);
  });

  it("shuffling keeps revoke before teardown for every cell it visits", async () => {
    const cells = [1, 2, 3, 4, 5].map((n) => ({
      cellId: `c${n}`,
      tags: tags(`cell:${n}`, NOW - 1),
    }));
    const s = setup(cells);
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    await reconcileExpiredCells({
      provider: s.provider,
      revoke: s.revoke,
      now: () => NOW,
      logger: s.logger,
      random,
    });
    expect(s.calls).toHaveLength(10);
    for (let i = 0; i < s.calls.length; i += 2) {
      const revoke = s.calls[i] ?? "";
      const teardown = s.calls[i + 1] ?? "";
      expect(revoke.startsWith("revoke:cell:")).toBe(true);
      expect(teardown).toBe(`teardown:c${revoke.split(":")[2]}`);
    }
  });
});
