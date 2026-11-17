import { describe, expect, it, vi } from "vitest";

import type { CellKey } from "./reconcile";
import { reconcileExpiredCells } from "./reconcile";

const NOW = 1_000_000;

function setup(
  cells: { cellId: string; tags: Record<string, string> }[],
  over: {
    revoke?: (k: string, a: number) => Promise<void>;
    teardown?: (id: string) => Promise<void>;
    limit?: number;
    isDead?: (keys: CellKey[]) => Promise<Set<string>>;
    truncated?: boolean;
    deployment?: string;
  } = {},
) {
  const calls: string[] = [];
  const provider = {
    listByTags: vi.fn(async () => {
      const out = [...cells];
      Object.defineProperty(out, "truncated", {
        value: over.truncated ?? false,
        enumerable: false,
      });
      return out;
    }),
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
      deployment: over.deployment ?? "d1",
      isDead: over.isDead,
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
      dead: 0,
      truncated: false,
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
      dead: 0,
      truncated: false,
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
      dead: 0,
      truncated: false,
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
      dead: 0,
      truncated: false,
    });
  });

  it.each([[""], ["  "]])(
    "refuses deployment %j before listing (an unset filter would list every deployment)",
    async (deployment) => {
      const h = setup([], { deployment });
      await expect(h.run()).rejects.toThrow(RangeError);
      expect(h.provider.listByTags).not.toHaveBeenCalled();
    },
  );

  it("refuses an undefined deployment from an untyped caller before listing", async () => {
    const h = setup([]);
    await expect(
      reconcileExpiredCells({
        provider: h.provider,
        revoke: h.revoke,
        now: () => NOW,
        logger: h.logger,
        deployment: undefined as unknown as string,
      }),
    ).rejects.toThrow(RangeError);
    expect(h.provider.listByTags).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, 0, -3, 2.5])(
    "a limit of %s falls back to the default cap instead of removing it",
    async (limit) => {
      const cells = Array.from({ length: 25 }, (_, i) => ({
        cellId: `c${i}`,
        tags: tags(`cell:k${i}`, NOW - 1),
      }));
      const h = setup(cells, { limit });
      const out = await h.run();
      expect(out.expired).toBe(20);
      expect(out.deferred).toBe(5);
    },
  );

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
      dead: 0,
      truncated: false,
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
        deployment: "d1",
        random,
      });
    }
    expect(reaped.has("good")).toBe(true);
    expect(runs).toBeLessThanOrEqual(10);
  });

  describe("deployment scope and dead cells", () => {
    const liveCells = () => [
      { cellId: "x", tags: tags("cell:x", NOW + 600_000, "2") },
      { cellId: "y", tags: tags("cell:y", NOW + 600_000) },
    ];

    it("lists with its deployment and the page cap", async () => {
      const s = setup([]);
      await s.run();
      expect(s.provider.listByTags).toHaveBeenCalledWith(
        { deployment: "d1" },
        { maxPages: 5 },
      );
    });

    it("reaps a dead-but-unexpired cell, revoke first, and leaves a live one", async () => {
      const isDead = vi.fn(async () => new Set(["cell:x#2"]));
      const s = setup(liveCells(), { isDead });
      const r = await s.run();
      expect(s.calls).toEqual(["revoke:cell:x:2", "teardown:x"]);
      expect(isDead).toHaveBeenCalledWith([
        { stepKey: "cell:x", attempt: 2 },
        { stepKey: "cell:y", attempt: 1 },
      ]);
      expect(r).toMatchObject({ expired: 0, dead: 1, reaped: 1, failed: 0 });
    });

    it.each([
      ["an empty set", new Set<string>()],
      ["a partial set for other keys", new Set(["cell:z#1"])],
      ["a wrong attempt", new Set(["cell:x#1"])],
    ])("%s reaps nothing extra (negative control)", async (_n, dead) => {
      const s = setup(liveCells(), { isDead: async () => dead });
      const r = await s.run();
      expect(s.calls).toEqual([]);
      expect(r).toMatchObject({ dead: 0, reaped: 0 });
    });

    it("an isDead throw logs once and reaps only the expired", async () => {
      const s = setup(
        [...liveCells(), { cellId: "e", tags: tags("cell:e", NOW - 1) }],
        {
          isDead: async () => {
            throw new Error("db down SECRET-CANARY");
          },
        },
      );
      const r = await s.run();
      expect(s.calls).toEqual(["revoke:cell:e:1", "teardown:e"]);
      expect(r).toMatchObject({ expired: 1, dead: 0, reaped: 1 });
      expect(s.logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(s.logger.warn.mock.calls)).not.toContain("CANARY");
    });

    it("passes truncated through, read from the listed array", async () => {
      expect((await setup([], { truncated: true }).run()).truncated).toBe(true);
      expect((await setup([], { truncated: false }).run()).truncated).toBe(
        false,
      );
    });

    it("warns once, with counts only, when the listing was truncated", async () => {
      const s = setup([{ cellId: "e", tags: tags("cell:e", NOW - 1) }], {
        truncated: true,
      });
      await s.run();
      const warns = s.logger.warn.mock.calls.filter(([msg]) =>
        String(msg).includes("truncated"),
      );
      expect(warns).toHaveLength(1);
      expect(Object.keys(warns[0]![1] as object).sort()).toEqual(
        ["dead", "deferred", "listed", "reaped"].sort(),
      );
    });

    it("does not warn when the listing was complete", async () => {
      const s = setup([], { truncated: false });
      await s.run();
      expect(
        s.logger.warn.mock.calls.some(([msg]) =>
          String(msg).includes("truncated"),
        ),
      ).toBe(false);
    });

    it("counts expired and dead together against the limit", async () => {
      const s = setup(
        [...liveCells(), { cellId: "e", tags: tags("cell:e", NOW - 1) }],
        { limit: 1, isDead: async () => new Set(["cell:x#2"]) },
      );
      const r = await s.run();
      expect(r.expired + r.dead).toBe(1);
      expect(r.deferred).toBe(1);
    });
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
      deployment: "d1",
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
