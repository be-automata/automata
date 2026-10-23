import { describe, expect, it, vi } from "vitest";

import {
  abnormalEndInfo,
  claimAbnormalEnd,
  classifyAbnormalEnd,
  newAbnormalEndState,
  postAbnormalEnd,
  postRunTerminalWithRetry,
  TERMINAL_POST_TIMEOUT_MS,
  type AbnormalEndInput,
} from "./abnormal-end";
import { resourceLimitFailure } from "./retry-classification";
import { ownsAbnormalTerminal } from "./run-lane";
import type { WwwClientOpts } from "./www-client";

const LIMIT_MS = 30 * 60_000;
const START = 1_000_000;
const OOM = () => resourceLimitFailure(5000 * 2 ** 20, 13);

/** A run that threw after its daemon started, at minute 5. */
function base(over: Partial<AbnormalEndInput> = {}): AbnormalEndInput {
  return {
    thrown: { error: new Error("boom") },
    cancelled: false,
    starvation: null,
    daemonStarted: true,
    runStartedAt: START,
    now: START + 5 * 60_000,
    runExecutionTimeoutMs: LIMIT_MS,
    ...over,
  };
}

/** A run that did not throw and was cancelled at `now`. */
const cancelledAt = (now: number, over: Partial<AbnormalEndInput> = {}) =>
  base({ thrown: undefined, cancelled: true, now, ...over });

const OPTS: WwwClientOpts = {
  baseUrl: "https://www.example.com",
  daemonToken: "daemon-tok",
  threadId: "thr_1",
  threadChatId: "tc_1",
  runExternalId: "run-ext-1",
};

describe("classifyAbnormalEnd (#437 Part A)", () => {
  it("an OOM kill is out-of-memory, by the daemon's signal or the typed error", () => {
    // protects=an OOM-killed task run gets its own cause; fails_when=it lands
    // as daemon-failed (today's generic error); no_claim=how the daemon reads
    // the kernel counter (daemon-process tests).
    expect(classifyAbnormalEnd(base({ starvation: OOM() }))).toBe(
      "out-of-memory",
    );
    expect(classifyAbnormalEnd(base({ thrown: { error: OOM() } }))).toBe(
      "out-of-memory",
    );
  });

  it("an OOM wins over a cancel that lands in the same tick", () => {
    // protects=AC7 "even when a cancel arrives in the same tick";
    // fails_when=the run is reported as a timeout or a user cancel;
    // no_claim=none beyond protects.
    expect(
      classifyAbnormalEnd(cancelledAt(START + LIMIT_MS, { starvation: OOM() })),
    ).toBe("out-of-memory");
  });

  it("a cancel at the execution limit is timeout, within the 15 s tolerance", () => {
    // protects=AC1's cause for a run cancelled at 30 minutes; fails_when=the
    // limit cancel reads as user-cancelled; no_claim=the engine's real
    // executionTimeout (the clock and limit are injected).
    for (const now of [START + LIMIT_MS, START + LIMIT_MS - 15_000]) {
      expect(classifyAbnormalEnd(cancelledAt(now))).toBe("timeout");
    }
  });

  it("an earlier cancel is not ours to post, thrown or not (null)", () => {
    // protects=a stale attempt cancelled after a heartbeat reassignment never
    // closes the thread attempt n+1 still works; fails_when=an early cancel
    // gets a cause; no_claim=the user Stop path (the `stopped` outcome).
    const early = START + LIMIT_MS - 15_001;
    expect(classifyAbnormalEnd(cancelledAt(early))).toBeNull();
    expect(
      classifyAbnormalEnd(base({ cancelled: true, now: early })),
    ).toBeNull();
  });

  it("a throw before the daemon started is run-failed-unreported", () => {
    // protects=AC8; fails_when=a clone/admission failure reads as a daemon
    // crash; no_claim=which pre-daemon steps throw (wiring tests).
    expect(classifyAbnormalEnd(base({ daemonStarted: false }))).toBe(
      "run-failed-unreported",
    );
  });

  it("any other throw is daemon-failed; a normal end is null", () => {
    // protects=the catch-all names the run as failed, and a clean run is never
    // given a cause; fails_when=either is wrong; no_claim=none beyond protects.
    expect(classifyAbnormalEnd(base())).toBe("daemon-failed");
    expect(classifyAbnormalEnd(base({ thrown: undefined }))).toBeNull();
  });

  it("only a task run that is not self-heal owns its abnormal terminal", () => {
    // protects=AC10 (review, pr and self-heal runs post nothing new);
    // fails_when=any of them is owned; no_claim=the wiring that skips the post
    // (wiring tests).
    expect(ownsAbnormalTerminal({})).toBe(true);
    expect(ownsAbnormalTerminal({ prKey: "org/o/r/7" })).toBe(false);
    expect(ownsAbnormalTerminal({ prNumber: 7 })).toBe(false);
    expect(
      ownsAbnormalTerminal({
        selfHeal: { kind: "audit", checks: [], checkToken: "t" },
      }),
    ).toBe(false);
  });
});

describe("abnormalEndInfo (#437 Part A2)", () => {
  it("timeout and out-of-memory get worker-authored text; other causes none", () => {
    // protects=AC7 "no JSON or stack trace" and the timeout line; fails_when=
    // the text carries the raw error or the wrong numbers; no_claim=the
    // salvage variant of the timeout line (Part B).
    const o = { starvation: null, runExecutionTimeoutMs: LIMIT_MS };
    expect(abnormalEndInfo("timeout", o)).toBe(
      "The run reached its 30-minute limit.",
    );
    expect(
      abnormalEndInfo("out-of-memory", { ...o, thrown: { error: OOM() } }),
    ).toBe("Memory limit 5000M reached (13 process(es) killed).");
    expect(
      abnormalEndInfo("daemon-failed", {
        ...o,
        thrown: { error: new Error("stack trace here") },
      }),
    ).toBeUndefined();
  });

  it("the out-of-memory info falls back to the daemon's signal when nothing threw", () => {
    // protects=AC7's text on the same-tick path; fails_when=the info is
    // undefined without a thrown error; no_claim=none beyond protects.
    expect(
      abnormalEndInfo("out-of-memory", {
        starvation: resourceLimitFailure(1500 * 2 ** 20, 2),
        runExecutionTimeoutMs: LIMIT_MS,
      }),
    ).toBe("Memory limit 1500M reached (2 process(es) killed).");
  });
});

describe("postRunTerminalWithRetry (#437 Part A2)", () => {
  const sleep = vi.fn(async (_ms: number) => {});
  const args = {
    wwwOpts: OPTS,
    runExternalId: "run-ext-1",
    cause: "timeout" as const,
    sleep,
  };

  it("retries a transport error 3 times with 1 s / 2 s backoff, then logs failed", async () => {
    // protects=AC9's log line and the attempt bound; fails_when=it retries
    // forever, gives up early or throws; no_claim=the real HTTP client.
    const post = vi.fn(async () => "error" as const);
    const log = vi.fn();
    sleep.mockClear();
    expect(await postRunTerminalWithRetry({ ...args, log, post })).toBe(
      "failed",
    );
    expect(post).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1_000, 2_000]);
    expect(log).toHaveBeenCalledWith(
      "terminal post failed after 3 attempts (timeout)",
    );
  });

  it("a 409 (rejected) or applied:false (noop) is final, never retried", async () => {
    // protects=a foreign generation is never hammered; fails_when=either
    // result is retried; no_claim=none beyond protects.
    for (const result of ["rejected", "noop"] as const) {
      const post = vi.fn(async () => result);
      expect(
        await postRunTerminalWithRetry({ ...args, log: vi.fn(), post }),
      ).toBe("noop");
      expect(post).toHaveBeenCalledTimes(1);
    }
  });

  it("a 4xx other than 409 (refused) is final and logged, never retried", async () => {
    // protects=a revoked token is not hammered 3 times; fails_when=a 401 is
    // retried or reported as applied; no_claim=which statuses www returns.
    const post = vi.fn(async () => "refused" as const);
    const log = vi.fn();
    expect(await postRunTerminalWithRetry({ ...args, log, post })).toBe(
      "failed",
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("terminal post refused by www (timeout)");
  });

  it("each attempt gets a fresh, live signal even when the run's is aborted", async () => {
    // protects=the post survives the cancel that ended the run; fails_when=it
    // reuses an aborted signal (the post would die instantly); no_claim=the
    // 10 s deadline firing (TERMINAL_POST_TIMEOUT_MS is asserted, not waited).
    const signals: AbortSignal[] = [];
    const post = vi.fn(
      async (_o: unknown, _a: unknown, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return signals.length < 2 ? ("error" as const) : ("applied" as const);
      },
    );
    const info = "Memory limit 5000M reached (13 process(es) killed).";
    expect(
      await postRunTerminalWithRetry({
        ...args,
        cause: "out-of-memory",
        info,
        log: vi.fn(),
        post,
      }),
    ).toBe("applied");
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    expect(TERMINAL_POST_TIMEOUT_MS).toBe(10_000);
    expect(post.mock.calls[0]![1]).toEqual({
      runExternalId: "run-ext-1",
      cause: "out-of-memory",
      info,
    });
  });
});

describe("claimAbnormalEnd / postAbnormalEnd (#437)", () => {
  const state = (owns = true) =>
    newAbnormalEndState({
      owns,
      runStartedAt: START,
      runExecutionTimeoutMs: LIMIT_MS,
    });
  const threw = {
    thrown: { error: new Error("x") },
    cancelled: false,
    starvation: null,
  };

  it("claims at most once per run, whichever exit claims first, and posts the claim", async () => {
    // protects=the teardown and the outer catch never double-post;
    // fails_when=a second claim succeeds; no_claim=none beyond protects.
    const s = state();
    s.daemonStarted = true;
    const end = claimAbnormalEnd(s, threw, START + 1);
    expect(end?.cause).toBe("daemon-failed");
    expect(claimAbnormalEnd(s, threw, START + 1)).toBeNull();
    const post = vi.fn(async () => "applied" as const);
    const log = vi.fn();
    // Non-null: the claim above was asserted to be daemon-failed.
    await postAbnormalEnd(s, end!, { wwwOpts: OPTS, log, post });
    expect(post).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "abnormal end → daemon-failed terminal: applied",
    );
  });

  it("a cancel is timed by when the abort fired, not by when the slow teardown claimed it", () => {
    // protects=the 15 s tolerance staying 15 s; fails_when=a cancel 20 s
    // before the limit, claimed after a 30 s teardown, reads as timeout
    // (it is an early cancel: null);
    // no_claim=the abort listener wiring (workflow.ts).
    const s = state();
    s.cancelledAt = START + LIMIT_MS - 20_000;
    const end = claimAbnormalEnd(
      s,
      { cancelled: true, starvation: null },
      START + LIMIT_MS + 10_000,
    );
    expect(end).toBeNull();
  });

  it("a run this plane does not own never claims", () => {
    // protects=AC10 at the claim; fails_when=a non-owned run gets a cause;
    // no_claim=none beyond protects.
    expect(claimAbnormalEnd(state(false), threw, START + 1)).toBeNull();
  });

  it("without a workflowRunId it logs and posts nothing", async () => {
    // protects=no post without a generation to fence on; fails_when=it posts
    // with an empty run id; no_claim=none beyond protects.
    const s = state();
    const end = claimAbnormalEnd(s, threw, START + 1);
    expect(end).not.toBeNull();
    const post = vi.fn(async () => "applied" as const);
    const log = vi.fn();
    // Non-null: asserted on the line above.
    await postAbnormalEnd(s, end!, {
      wwwOpts: { ...OPTS, runExternalId: undefined },
      log,
      post,
    });
    expect(post).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "abnormal end → run-failed-unreported: terminal not posted (no workflowRunId)",
    );
  });
});
