import { afterEach, describe, expect, it, vi } from "vitest";

import {
  abnormalEndInfo,
  claimAbnormalEnd,
  newAbnormalEndState,
} from "./abnormal-end";
import {
  REGISTERED_EXECUTION_TIMEOUT,
  TASK_LANE_EXECUTION_TIMEOUT,
} from "@terragon/types/cell";

import {
  REFRESH_DEADLINE_MS,
  TASK_LANE_REFRESH,
  applyRunBudget,
  refreshesRunBudget,
} from "./run-budget";
import { ownsAbnormalTerminal } from "./run-lane";
import type { AgentRunWireInput } from "./run-secrets";

const wire = (extra: Record<string, unknown> = {}): AgentRunWireInput =>
  ({
    threadId: "thr_1",
    threadChatId: "tc_1",
    repoFullName: "o/r",
    branch: "main",
    daemonCallbackUrl: "https://www.example.com",
    orgId: "org-1",
    // Marked for a cell by default: only a cell run gets the 60-minute budget.
    cell: "opensandbox",
    ...extra,
  }) as unknown as AgentRunWireInput;

const LANES: Array<[string, Record<string, unknown>, number]> = [
  ["task in a cell", {}, 60],
  // Box task runs keep 30: their brokers push with the dispatch-minted
  // installation token, which GitHub expires after about an hour.
  ["task on the box", { cell: undefined }, 30],
  [
    "task + self-heal",
    { selfHeal: { kind: "audit", attemptId: "a1", checkToken: "t" } },
    30,
  ],
  [
    "task + self-heal fix",
    {
      selfHeal: {
        kind: "fix",
        attemptId: "a1",
        branch: "automata/fix-1-deadbeef-a1",
        baseBranch: "main",
        checks: [],
        denyExceptions: [],
      },
    },
    30,
  ],
  ["pr", { prNumber: 7 }, 30],
  // A PR companion automation dispatches on the legacy plan with the thread's
  // PR number and no prKey (dispatch.test.ts): the pr lane.
  ["pr companion", { prNumber: 300, prKey: undefined }, 30],
  ["review", { prKey: "org-1/o/r/7", supersedePolicy: "newest-wins" }, 30],
];

describe("#742 per-lane run budget", () => {
  afterEach(() => vi.useRealTimers());

  // card: protects=only a task, non-self-heal run is entitled to 60 minutes; fails_when=review, pr or self-heal inherit it; no_claim=the engine (refresh-timeout.integration.test.ts)
  it.each(LANES)("%s resolves to %i minutes", async (_n, extra, minutes) => {
    const out = await applyRunBudget(wire(extra), {
      log: vi.fn(),
      refreshTimeout: async () => {},
    });
    expect(out).toBe(minutes * 60_000);
  });

  it("for a cell run, the refresh lane is exactly the lane that owns the abnormal terminal", () => {
    for (const [, extra] of LANES) {
      const w = wire(extra);
      if (w.cell === undefined) {
        expect(refreshesRunBudget(w)).toBe(false);
        continue;
      }
      expect(refreshesRunBudget(w)).toBe(
        ownsAbnormalTerminal(w as Parameters<typeof ownsAbnormalTerminal>[0]),
      );
    }
  });

  // card: protects=refresh is called once for a task run and the effective budget is 60; fails_when=it is skipped, repeated or called for another lane; no_claim=the engine honouring it
  it("a task run refreshes once with TASK_LANE_REFRESH and gets 60 minutes", async () => {
    const refreshTimeout = vi.fn(async () => {});
    const log = vi.fn();
    expect(await applyRunBudget(wire(), { log, refreshTimeout })).toBe(
      TASK_LANE_EXECUTION_TIMEOUT,
    );
    expect(refreshTimeout).toHaveBeenCalledTimes(1);
    expect(refreshTimeout).toHaveBeenCalledWith(TASK_LANE_REFRESH);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("run budget: 60m");
  });

  it.each(LANES.filter(([, , m]) => m === 30))(
    "%s never refreshes and stays at 30 minutes",
    async (_n, extra) => {
      const refreshTimeout = vi.fn(async () => {});
      const log = vi.fn();
      expect(await applyRunBudget(wire(extra), { log, refreshTimeout })).toBe(
        REGISTERED_EXECUTION_TIMEOUT,
      );
      expect(refreshTimeout).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  // card: protects=the fail-open line says WHY the refresh failed (timeout, rejected with the error's class name, or no context) and never carries the error's message; fails_when=the cause is dropped or the message leaks into the journal; no_claim=the engine's error taxonomy
  it.each([
    [
      "a rejection names the error class, never its message",
      {
        refreshTimeout: async () => {
          const e = new TypeError("secret-bearing text tok_abc");
          throw e;
        },
      },
      "run budget: refresh failed (rejected: TypeError), staying at 30m",
    ],
    [
      "a non-Error rejection is unknown",
      {
        refreshTimeout: async () => {
          throw "tok_abc";
        },
      },
      "run budget: refresh failed (rejected: unknown), staying at 30m",
    ],
    [
      "an Error whose name is not a plain identifier is unknown",
      {
        refreshTimeout: async () => {
          const e = new Error("x");
          e.name = "Bad name tok_abc";
          throw e;
        },
      },
      "run budget: refresh failed (rejected: unknown), staying at 30m",
    ],
    [
      "a missing refreshTimeout says no context",
      {},
      "run budget: refresh failed (no context), staying at 30m",
    ],
  ] as Array<[string, Partial<Parameters<typeof applyRunBudget>[1]>, string]>)(
    "%s",
    async (_n, extra, line) => {
      const log = vi.fn();
      expect(await applyRunBudget(wire(), { log, ...extra })).toBe(
        REGISTERED_EXECUTION_TIMEOUT,
      );
      expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
        `[agent-run thr_1] ${line}`,
      ]);
      expect(String(log.mock.calls[0]![0])).not.toContain("tok_abc");
    },
  );

  // card: protects=a hung refresh call cannot hold the run past 10 s; fails_when=the race is dropped; no_claim=the engine's own timeout
  it("a refresh that never answers is cut at 10 s, says timeout and fails open", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const pending = applyRunBudget(wire(), {
      log,
      refreshTimeout: () => new Promise<void>(() => {}),
    });
    await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);
    expect(await pending).toBe(REGISTERED_EXECUTION_TIMEOUT);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      "[agent-run thr_1] run budget: refresh failed (timeout), staying at 30m",
    ]);
  });

  // card: protects=the effective budget drives the typed timeout: a cancel at 60 minutes is a timeout whose copy says 60, a cancel at 31 minutes is not; fails_when=the classifier keeps reading 30; no_claim=workflow.ts wiring (workflow.test.ts)
  // card: protects=roborev 1373: a refresh that lands AFTER its 10 s bound was still applied by the engine, so the recorded budget follows it to 60 min; a late rejection keeps 30; fails_when=a real 60-minute timeout is labelled 30, or a late rejection raises it; no_claim=the engine's late-apply behaviour (IT)
  it.each([
    ["resolves", true],
    ["rejects", false],
  ])(
    "a refresh that %s after the bound: onLateRefresh %s",
    async (_how, resolves) => {
      vi.useFakeTimers();
      const log = vi.fn();
      let settle!: () => void;
      const call = new Promise<void>((resolve, reject) => {
        settle = resolves ? () => resolve() : () => reject(new Error("late"));
      });
      const onLate = vi.fn();
      const p = applyRunBudget(
        wire(),
        { log, refreshTimeout: () => call },
        onLate,
      );
      await vi.advanceTimersByTimeAsync(REFRESH_DEADLINE_MS);
      expect(await p).toBe(REGISTERED_EXECUTION_TIMEOUT);
      settle();
      await vi.runAllTimersAsync();
      await Promise.resolve();
      if (resolves) {
        expect(onLate).toHaveBeenCalledExactlyOnceWith(
          TASK_LANE_EXECUTION_TIMEOUT,
        );
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("(refreshed late)"),
        );
      } else {
        expect(onLate).not.toHaveBeenCalled();
      }
    },
  );

  it("the abnormal end at the 60-minute budget classifies as timeout and says 60", () => {
    const START = 1_000_000;
    const state = (budget: number) =>
      newAbnormalEndState({
        owns: true,
        runStartedAt: START,
        runExecutionTimeoutMs: budget,
      });
    const end = { cancelled: true, starvation: null };
    const at60 = claimAbnormalEnd(
      state(TASK_LANE_EXECUTION_TIMEOUT),
      end,
      START + TASK_LANE_EXECUTION_TIMEOUT,
    );
    expect(at60?.cause).toBe("timeout");
    expect(
      abnormalEndInfo("timeout", {
        runExecutionTimeoutMs: TASK_LANE_EXECUTION_TIMEOUT,
        starvation: null,
      }),
    ).toBe("The run reached its 60-minute limit.");
    // Control: at 31 minutes a 60-minute run is not at its limit.
    expect(
      claimAbnormalEnd(
        state(TASK_LANE_EXECUTION_TIMEOUT),
        end,
        START + 31 * 60_000,
      ),
    ).toBeNull();
    // Refresh failed: the 30-minute state still types a 30-minute cancel.
    expect(
      claimAbnormalEnd(
        state(REGISTERED_EXECUTION_TIMEOUT),
        end,
        START + REGISTERED_EXECUTION_TIMEOUT,
      )?.cause,
    ).toBe("timeout");
  });
});
