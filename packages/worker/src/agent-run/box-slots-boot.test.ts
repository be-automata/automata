import { describe, expect, it, vi } from "vitest";

import {
  assertSlotsFitCommitLimit,
  BOX_BASE_COMMIT_BYTES,
  warnIfSlotsExceedMemory,
} from "./box-slots-boot";

describe("warnIfSlotsExceedMemory (#205 boot)", () => {
  const meminfo = "MemTotal:        7937228 kB\nMemFree:          100 kB\n";

  it("is silent at N = 1 and when the ceiling is off", () => {
    const log = vi.fn();
    warnIfSlotsExceedMemory(
      { boxSlots: 1, memoryMaxBytes: 5000 * 1024 ** 2 },
      () => meminfo,
      log,
    );
    warnIfSlotsExceedMemory(
      { boxSlots: 3, memoryMaxBytes: 0 },
      () => meminfo,
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("warns, naming both knobs and MemTotal, when N × ceiling exceeds the box RAM", () => {
    const log = vi.fn();
    warnIfSlotsExceedMemory(
      { boxSlots: 2, memoryMaxBytes: 5000 * 1024 ** 2 },
      () => meminfo,
      log,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(
      /WORKER_BOX_SLOTS=2 × WORKER_RUN_MEMORY_MAX=5242880000 = 10485760000 bytes exceeds MemTotal 8127721472/,
    );
  });

  it("is silent when N × ceiling fits, and when /proc/meminfo is unreadable", () => {
    const log = vi.fn();
    warnIfSlotsExceedMemory(
      { boxSlots: 2, memoryMaxBytes: 1500 * 1024 ** 2 },
      () => meminfo,
      log,
    );
    warnIfSlotsExceedMemory(
      { boxSlots: 2, memoryMaxBytes: 5000 * 1024 ** 2 },
      () => {
        throw new Error("ENOENT");
      },
      log,
    );
    expect(log).not.toHaveBeenCalled();
  });
});

describe("assertSlotsFitCommitLimit (#372 boot, Linux, ceiling on) — in the headroom check's own terms", () => {
  const meminfo = (commitLimitKb: number) => `MemTotal:        7937228 kB
MemAvailable:    6000000 kB
SwapTotal:       8388604 kB
CommitLimit:    ${commitLimitKb} kB
Committed_AS:    2600000 kB
`;
  // The pilot cx33: CommitLimit 12 357 216 kB (8 GB swap + 50 % of 7.6 GB RAM).
  const CX33 = meminfo(12357216);
  // cx43 at vm.overcommit_ratio=80 — the ESTIMATE deploy/uat/phase2-4.md
  // sizes with (MemTotal scaled from the cx33's 7 937 228 kB ⇒ 16 258 000 kB;
  // 8 388 604 kB swap + 0.8 × MemTotal = 21 395 004 kB ≈ 21.9 GB; the UAT
  // replaces it with the measured value after the resize).
  const CX43_R80 = meminfo(21395004);
  const fiveG = 5000 * 1024 ** 2;
  const tuple = (boxSlots: number, fraction = 0.9) => ({
    boxSlots,
    memoryMaxBytes: fiveG,
    headroomRunCommitBytes: fiveG,
    headroomCommitFraction: fraction,
  });
  const linux = (text: string) => ({
    platform: "linux" as const,
    readMeminfo: () => text,
  });

  it("the pilot's own numbers: N = 1 is not this guard's business (#371 owns it); TWO 5000M runs do not fit 0.9 × CommitLimit beside the base — refused naming the knobs (what #371's drill observed as 'every second run deferred')", () => {
    expect(() =>
      assertSlotsFitCommitLimit(tuple(1), linux(CX33)),
    ).not.toThrow();
    expect(() => assertSlotsFitCommitLimit(tuple(2), linux(CX33))).toThrow(
      /WORKER_BOX_SLOTS=2 × run commit 5242880000 .* exceeds 0\.9 × CommitLimit 12653789184 .*WORKER_GLOBAL_MAX_RUNS/,
    );
  });

  it("the chosen production tuple: three 5000M runs fit cx43 at overcommit_ratio 80 under 0.9 × CommitLimit; four do not", () => {
    expect(() =>
      assertSlotsFitCommitLimit(tuple(3), linux(CX43_R80)),
    ).not.toThrow();
    expect(() => assertSlotsFitCommitLimit(tuple(4), linux(CX43_R80))).toThrow(
      /WORKER_BOX_SLOTS=4/,
    );
  });

  it("an inert commit arm (fraction ≥ 1 — the rollback, or the arm alone) skips the guard under evaluateHeadroom's own condition: an oversized tuple boots", () => {
    expect(() =>
      assertSlotsFitCommitLimit(tuple(8, 1), linux(CX33)),
    ).not.toThrow();
    expect(() =>
      assertSlotsFitCommitLimit(tuple(8, 1.5), linux("garbage")),
    ).not.toThrow();
  });

  it("the boundary is exact at the budget", () => {
    const commitLimit = 12357216 * 1024;
    const budget = 0.5 * commitLimit;
    const exact = Math.floor((budget - BOX_BASE_COMMIT_BYTES) / 2);
    const t = (runCommit: number) => ({
      boxSlots: 2,
      memoryMaxBytes: fiveG,
      headroomRunCommitBytes: runCommit,
      headroomCommitFraction: 0.5,
    });
    expect(() =>
      assertSlotsFitCommitLimit(t(exact), linux(CX33)),
    ).not.toThrow();
    expect(() => assertSlotsFitCommitLimit(t(exact + 2), linux(CX33))).toThrow(
      /exceeds 0\.5 × CommitLimit/,
    );
  });

  it("is not its business without the ceiling or off Linux; an unreadable meminfo with the ceiling on refuses (parseMeminfo's own error, never a silent pass)", () => {
    expect(() =>
      assertSlotsFitCommitLimit(
        { ...tuple(4), memoryMaxBytes: 0 },
        linux("garbage"),
      ),
    ).not.toThrow();
    expect(() =>
      assertSlotsFitCommitLimit(tuple(4), {
        platform: "darwin",
        readMeminfo: () => {
          throw new Error("must not be called");
        },
      }),
    ).not.toThrow();
    expect(() => assertSlotsFitCommitLimit(tuple(2), linux("garbage"))).toThrow(
      /\/proc\/meminfo: missing or malformed/,
    );
  });
});
