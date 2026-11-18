import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CELL_TEARDOWN_DEADLINE_MS,
  teardownCellRun,
  type CellTeardownDeps,
  type CellTeardownKey,
} from "./cell-teardown";
import type { FailedStep } from "./cell-www-client";

const KEY: CellTeardownKey = {
  stepKey: "cell-k1",
  attempt: 7,
  deployment: "www.example.org",
  cellId: "c1",
};

interface Harness {
  calls: string[];
  reports: { outcome: string; failedSteps?: FailedStep[] }[];
  logs: string[];
  deps: CellTeardownDeps;
}

function harness(
  over: {
    revoke?: () => Promise<{ result: "ok" | "failed" | "already_reported" }>;
    vault?: () => Promise<void>;
    quarantine?: () => Promise<void>;
    del?: () => Promise<"deleted" | "gone">;
    list?: (n: number) => { cellId: string; tags: Record<string, string> }[];
    listThrows?: boolean;
    report?: () => Promise<"ok" | "already_reported" | "failed">;
  } = {},
): Harness {
  const calls: string[] = [];
  const reports: Harness["reports"] = [];
  const logs: string[] = [];
  let lists = 0;
  const deps: CellTeardownDeps = {
    revoke: async () => {
      calls.push("www.revoke");
      return (await over.revoke?.()) ?? { result: "ok" };
    },
    report: async (_attempt, outcome) => {
      calls.push("www.report");
      reports.push(outcome);
      return (await over.report?.()) ?? "ok";
    },
    provider: {
      revoke: async () => {
        calls.push("provider.revoke");
        await over.vault?.();
      },
      quarantine: async () => {
        calls.push("provider.quarantine");
        await over.quarantine?.();
      },
      delete: async () => {
        calls.push("provider.delete");
        return (await over.del?.()) ?? "deleted";
      },
      listByTags: async () => {
        calls.push("provider.listByTags");
        if (over.listThrows) throw new Error("list down");
        return (over.list?.(lists++) ?? []) as never;
      },
    },
    postAbnormal: async () => {
      calls.push("www.abnormal");
    },
    now: () => Date.now(),
    log: (l) => logs.push(l),
  };
  return { calls, reports, logs, deps };
}

afterEach(() => vi.useRealTimers());

describe("teardownCellRun", () => {
  // card: protects=the fixed order R, vault, quarantine, delete, readback, A, P; fails_when=any step moves or P is not last; no_claim=the executor's exits (cell-run.test.ts)
  it("T-ORDER: www revoke first, then the provider steps, then readback, A, report last", async () => {
    const h = harness();
    const out = await teardownCellRun(KEY, h.deps);
    expect(out.failedSteps).toEqual([]);
    expect(h.calls).toEqual([
      "www.revoke",
      "provider.revoke",
      "provider.quarantine",
      "provider.delete",
      "provider.listByTags",
      "www.abnormal",
      "www.report",
    ]);
    expect(h.reports).toEqual([{ outcome: "clean" }]);
  });

  // card: protects=a throwing R still runs every local step and is reported as revoke_attempt; fails_when=T is skipped after R fails; no_claim=www recovery
  it("T-ORDER control: R throwing still runs T and reports revoke_attempt", async () => {
    const h = harness({
      revoke: async () => {
        throw new Error("boom");
      },
    });
    const out = await teardownCellRun(KEY, h.deps);
    expect(out.failedSteps).toEqual(["revoke_attempt"]);
    expect(h.calls.slice(0, 4)).toEqual([
      "www.revoke",
      "provider.revoke",
      "provider.quarantine",
      "provider.delete",
    ]);
    expect(h.reports).toEqual([
      { outcome: "incomplete", failedSteps: ["revoke_attempt"] },
    ]);
  });

  // card: protects=each failed provider step is named and the rest still run; fails_when=a vault failure skips quarantine or delete; no_claim=the failure's cause
  it("records vault, quarantine and delete failures and carries on", async () => {
    const boom = async () => {
      throw new Error("x");
    };
    const h = harness({ vault: boom, quarantine: boom, del: boom });
    const out = await teardownCellRun(KEY, h.deps);
    expect(out.failedSteps).toEqual(["vault", "quarantine", "delete"]);
    expect(h.calls).toContain("provider.delete");
  });

  // card: protects=a survivor in the readback gets a second pass of the three steps and is named; an empty readback is clean; fails_when=survivors are ignored or the second pass is skipped; no_claim=the survivor's origin
  it("T-READBACK: a survivor is torn down again and named; empty is clean", async () => {
    const h = harness({
      list: (n) => (n === 0 ? [{ cellId: "c9", tags: {} }] : []),
    });
    const out = await teardownCellRun(KEY, h.deps);
    expect(out.failedSteps).toEqual(["survivor"]);
    expect(h.calls.filter((c) => c === "provider.listByTags")).toHaveLength(2);
    expect(h.calls.slice(5, 8)).toEqual([
      "provider.revoke",
      "provider.quarantine",
      "provider.delete",
    ]);
    const clean = await teardownCellRun(KEY, harness().deps);
    expect(clean.failedSteps).toEqual([]);
  });

  // card: protects=an unreadable readback counts as a survivor; fails_when=a list error is read as clean; no_claim=what the survivor is
  it("T-READBACK control: listByTags throwing is a survivor", async () => {
    const h = harness({ listThrows: true });
    expect((await teardownCellRun(KEY, h.deps)).failedSteps).toEqual([
      "survivor",
    ]);
  });

  // card: protects=the readback queries exactly this attempt's tags; fails_when=it asks for another attempt or deployment; no_claim=the server's filtering
  it("reads back with the attempt's own tags", async () => {
    const seen: unknown[] = [];
    const h = harness();
    h.deps.provider.listByTags = (async (tags: unknown) => {
      seen.push(tags);
      return [];
    }) as never;
    await teardownCellRun(KEY, h.deps);
    expect(seen).toEqual([
      {
        automata: "cell",
        stepKey: "cell-k1",
        attempt: "7",
        deployment: "www.example.org",
      },
    ]);
  });

  // card: protects=a cell that create never returned is still looked for: B finds it and tears it down; fails_when=a null cellId skips the readback; no_claim=create's own cleanup
  it("with no cellId the readback still drives T on what it finds", async () => {
    const h = harness({
      list: (n) => (n === 0 ? [{ cellId: "c5", tags: {} }] : []),
    });
    const out = await teardownCellRun({ ...KEY, cellId: null }, h.deps);
    expect(out.failedSteps).toEqual(["survivor"]);
    expect(h.calls.filter((c) => c === "provider.delete")).toHaveLength(1);
  });

  // card: protects=a hanging provider step ends the teardown within the 90 s deadline and P is still sent; fails_when=the teardown waits on the hang or P is skipped; no_claim=wall time on a real box
  it("T-DEADLINE: a hung step ends the teardown by 90 s, B counts as survivor, P is sent", async () => {
    vi.useFakeTimers();
    const h = harness({ quarantine: () => new Promise<void>(() => {}) });
    const done = teardownCellRun(KEY, h.deps);
    await vi.advanceTimersByTimeAsync(CELL_TEARDOWN_DEADLINE_MS + 1);
    const out = await done;
    expect(out.failedSteps).toEqual(
      expect.arrayContaining(["quarantine", "delete", "survivor"]),
    );
    expect(h.calls).not.toContain("provider.delete");
    expect(h.calls[h.calls.length - 1]).toBe("www.report");
    expect(h.reports[0]).toMatchObject({ outcome: "incomplete" });
  });

  // card: protects=skipWww sends nothing to www and runs only the local steps and the readback; fails_when=R, A or P goes out after www deleted the token; no_claim=the 409 detection
  it("T-409-SKIP: skipWww runs the local steps only", async () => {
    const h = harness();
    await teardownCellRun({ ...KEY, skipWww: true }, h.deps);
    expect(h.calls).toEqual([
      "provider.revoke",
      "provider.quarantine",
      "provider.delete",
      "provider.listByTags",
    ]);
  });

  // card: protects=the fenced path's vault revoke already ran, so the sequencer does not repeat it; fails_when=a second vault revoke is sent; no_claim=the executor's early revoke
  it("vaultRevoked skips the vault step only", async () => {
    const h = harness();
    await teardownCellRun({ ...KEY, vaultRevoked: true }, h.deps);
    expect(h.calls).not.toContain("provider.revoke");
    expect(h.calls).toContain("provider.quarantine");
  });

  // card: protects=a failed report logs cell_teardown_incomplete locally and never throws; fails_when=the line is missing or the teardown throws; no_claim=the reconciler picking it up
  it("T-REPORT: a failed report logs cell_teardown_incomplete and returns", async () => {
    const h = harness({ report: async () => "failed" });
    await expect(teardownCellRun(KEY, h.deps)).resolves.toEqual({
      failedSteps: [],
    });
    expect(h.logs.some((l) => l.startsWith("cell_teardown_incomplete "))).toBe(
      true,
    );
    expect(h.logs.filter((l) => l.startsWith("cell.teardown "))).toHaveLength(
      1,
    );
  });

  // card: protects=the one log line names the step key, attempt, steps and ms only; fails_when=it carries a cell id, tag or vault; no_claim=other log lines
  it("logs one cell.teardown line without a cell id", async () => {
    const h = harness();
    await teardownCellRun(KEY, h.deps);
    const line = h.logs.find((l) => l.startsWith("cell.teardown "))!;
    expect(
      Object.keys(JSON.parse(line.slice("cell.teardown ".length))),
    ).toEqual(["stepKey", "attempt", "failedSteps", "ms"]);
    expect(line).not.toContain("c1");
  });
});
