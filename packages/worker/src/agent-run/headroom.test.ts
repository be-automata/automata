import { describe, expect, it } from "vitest";

import {
  ADMISSION_BACKOFF,
  ADMISSION_DEFERRAL_BUDGET_S,
  AdmissionController,
  AdmissionDeferredError,
  assessHeadroomSupport,
  sumBackoffSeconds,
  evaluateHeadroom,
  isInertPolicy,
  parseMeminfo,
  type HeadroomPolicy,
  type MeminfoReading,
} from "./headroom";

const GIB = 1024 ** 3;

/** The live CX33 on 2026-10-18, rounded: 7.6 GB RAM, 8 GB swap, CommitLimit 12.3 GB. */
const MEMINFO = `MemTotal:        7937228 kB
MemFree:          500000 kB
MemAvailable:    6249396 kB
Buffers:           10000 kB
SwapTotal:       8388604 kB
SwapFree:        8289020 kB
CommitLimit:    12357216 kB
Committed_AS:    2622544 kB
`;

const POLICY: HeadroomPolicy = {
  floorBytes: 1 * GIB,
  commitFraction: 0.9,
  runCommitBytes: 5000 * 1024 ** 2,
};

describe("parseMeminfo", () => {
  it("reads the six fields and converts kB to bytes", () => {
    const r = parseMeminfo(MEMINFO);
    expect(r.memTotal).toBe(7937228 * 1024);
    expect(r.memAvailable).toBe(6249396 * 1024);
    expect(r.committedAs).toBe(2622544 * 1024);
    expect(r.commitLimit).toBe(12357216 * 1024);
    expect(r.swapTotal).toBe(8388604 * 1024);
    expect(r.swapFree).toBe(8289020 * 1024);
  });

  it("throws, naming the field, when one is missing or malformed", () => {
    expect(() =>
      parseMeminfo(MEMINFO.replace(/^CommitLimit:.*\n/m, "")),
    ).toThrow(/missing or malformed CommitLimit/);
    expect(() =>
      parseMeminfo(
        MEMINFO.replace("Committed_AS:    2622544 kB", "Committed_AS: lots"),
      ),
    ).toThrow(/Committed_AS/);
  });
});

describe("evaluateHeadroom (both arms, boundary-inclusive)", () => {
  const reading = parseMeminfo(MEMINFO);

  it("admits the idle box", () => {
    const v = evaluateHeadroom(reading, POLICY);
    expect(v.ok).toBe(true);
    expect(v.observed).toMatchObject({
      floor: POLICY.floorBytes,
      fraction: 0.9,
      runCommit: POLICY.runCommitBytes,
      reserved: 0,
    });
  });

  it("rejects on the floor arm when MemAvailable minus reservations drops below the floor", () => {
    const low: MeminfoReading = { ...reading, memAvailable: 1.5 * GIB };
    expect(evaluateHeadroom(low, POLICY, 0).ok).toBe(true);
    const v = evaluateHeadroom(low, POLICY, 1 * GIB);
    expect(v).toMatchObject({ ok: false, reason: "mem-available-below-floor" });
  });

  it("rejects on the commit arm when Committed_AS + reserved + this run exceeds fraction × CommitLimit", () => {
    // 2.6 + 5 = 7.6 GB ≤ 0.9 × 12.3 = 11.1 → admit; one more 5 GB reservation → 12.6 > 11.1 → defer.
    expect(evaluateHeadroom(reading, POLICY, 0).ok).toBe(true);
    const v = evaluateHeadroom(reading, POLICY, POLICY.runCommitBytes);
    expect(v).toMatchObject({ ok: false, reason: "commit-over-fraction" });
    expect(v.observed.reserved).toBe(POLICY.runCommitBytes);
  });

  it("is inclusive at the boundary on both arms", () => {
    const atFloor: MeminfoReading = {
      ...reading,
      memAvailable: POLICY.floorBytes,
    };
    expect(evaluateHeadroom(atFloor, POLICY).ok).toBe(true);
    const limit = 1000 * GIB;
    const exact: MeminfoReading = {
      ...reading,
      commitLimit: limit,
      committedAs: 0.9 * limit - POLICY.runCommitBytes,
    };
    expect(evaluateHeadroom(exact, POLICY).ok).toBe(true);
    expect(
      evaluateHeadroom({ ...exact, committedAs: exact.committedAs + 1 }, POLICY)
        .ok,
    ).toBe(false);
  });

  it("an inert arm never rejects: floor 0 skips the floor arm, fraction 1 skips the commit arm", () => {
    const starved: MeminfoReading = {
      ...reading,
      memAvailable: 0,
      committedAs: reading.commitLimit,
    };
    expect(
      evaluateHeadroom(starved, { ...POLICY, floorBytes: 0, commitFraction: 1 })
        .ok,
    ).toBe(true);
    expect(
      evaluateHeadroom(starved, { ...POLICY, floorBytes: 0 }),
    ).toMatchObject({
      ok: false,
      reason: "commit-over-fraction",
    });
    expect(
      evaluateHeadroom(starved, { ...POLICY, commitFraction: 1 }),
    ).toMatchObject({
      ok: false,
      reason: "mem-available-below-floor",
    });
    expect(isInertPolicy({ ...POLICY, floorBytes: 0, commitFraction: 1 })).toBe(
      true,
    );
    expect(isInertPolicy(POLICY)).toBe(false);
  });
});

describe("AdmissionController (mutex + reservations)", () => {
  it("disabled: never reads meminfo, never throws, returns a no-op reservation", async () => {
    let reads = 0;
    const c = new AdmissionController(POLICY, false, () => {
      reads += 1;
      return MEMINFO;
    });
    const r = await c.admit({ threadId: "t1", attempt: 0 });
    r.release();
    expect(reads).toBe(0);
    expect(c.reservedBytes()).toBe(0);
  });

  it("two concurrent admissions with headroom for exactly one admit exactly one; the loser is deferred with the winner's reservation in its observed fields", async () => {
    const lines: string[] = [];
    const c = new AdmissionController(POLICY, true, () => MEMINFO);
    const results = await Promise.allSettled([
      c.admit({ threadId: "a", attempt: 0, log: (l) => lines.push(l) }),
      c.admit({ threadId: "b", attempt: 0, log: (l) => lines.push(l) }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(AdmissionDeferredError);
    expect((err as AdmissionDeferredError).reason).toBe("commit-over-fraction");
    expect((err as AdmissionDeferredError).observed.reserved).toBe(
      POLICY.runCommitBytes,
    );
    expect(c.reservedBytes()).toBe(POLICY.runCommitBytes);
    expect(lines[0]).toMatch(/^box\.headroom_ok \{/);
    expect(lines[1]).toMatch(
      /^box\.headroom_rejected \{.*"reason":"commit-over-fraction"/,
    );
    // The deferral names the three kernel values the operator needs.
    expect((err as Error).message).toMatch(
      /MemAvailable=\d+M Committed_AS=\d+M\/CommitLimit=\d+M/,
    );
  });

  it("releasing the reservation lets the next admission through; release is idempotent", async () => {
    const c = new AdmissionController(POLICY, true, () => MEMINFO);
    const a = await c.admit({ threadId: "a", attempt: 0 });
    await expect(c.admit({ threadId: "b", attempt: 0 })).rejects.toBeInstanceOf(
      AdmissionDeferredError,
    );
    a.release();
    a.release();
    expect(c.reservedBytes()).toBe(0);
    const b = await c.admit({ threadId: "b", attempt: 1 });
    expect(c.reservedBytes()).toBe(POLICY.runCommitBytes);
    b.release();
  });

  it("a redelivered attempt of the same thread never counts its own stale reservation", async () => {
    const c = new AdmissionController(POLICY, true, () => MEMINFO);
    await c.admit({ threadId: "a", attempt: 0 }); // never released (crashed attempt)
    const again = await c.admit({ threadId: "a", attempt: 1 });
    expect(c.reservedBytes()).toBe(POLICY.runCommitBytes);
    again.release();
    expect(c.reservedBytes()).toBe(0);
  });

  it("an unreadable meminfo at admission FAILS OPEN: one box.headroom_unreadable line, no reservation, no throw", async () => {
    let fail = true;
    const lines: string[] = [];
    const c = new AdmissionController(POLICY, true, () => {
      if (fail) throw new Error("EIO");
      return MEMINFO;
    });
    const r = await c.admit({
      threadId: "a",
      attempt: 2,
      log: (l) => lines.push(l),
    });
    r.release();
    expect(lines).toEqual([
      expect.stringMatching(/^box\.headroom_unreadable \{.*"attempt":2.*EIO/),
    ]);
    expect(c.reservedBytes()).toBe(0);
    fail = false;
    const b = await c.admit({ threadId: "b", attempt: 0 });
    expect(c.reservedBytes()).toBe(POLICY.runCommitBytes);
    b.release();
  });

  it("the deferral message is operator-facing and names the three kernel values in MiB", () => {
    const err = new AdmissionDeferredError(
      "commit-over-fraction",
      {
        memAvailable: 2 * GIB,
        committedAs: 11 * GIB,
        commitLimit: 12 * GIB,
        floor: GIB,
        fraction: 0.9,
        runCommit: 5000 * 1024 ** 2,
        reserved: 0,
      },
      1,
    );
    expect(err.message).toMatch(
      /^The box had no memory headroom for this run \(attempt 2, commit-over-fraction\): MemAvailable=2048M Committed_AS=11264M\/CommitLimit=12288M/,
    );
    expect(err.name).toBe("AdmissionDeferredError");
  });
});

describe("the deferral budget vs the control plane's 75-minute stalled cutoff", () => {
  it("Σbackoff is 2^n capped at 120 s and the default 8 deferrals stay well inside the budget", () => {
    expect(ADMISSION_BACKOFF).toEqual({ factor: 2, maxSeconds: 120 });
    expect(sumBackoffSeconds(0)).toBe(0);
    expect(sumBackoffSeconds(3)).toBe(2 + 4 + 8);
    expect(sumBackoffSeconds(8)).toBe(2 + 4 + 8 + 16 + 32 + 64 + 120 + 120);
    expect(sumBackoffSeconds(8)).toBeLessThanOrEqual(
      ADMISSION_DEFERRAL_BUDGET_S,
    );
    expect(ADMISSION_DEFERRAL_BUDGET_S).toBe(12 * 60);
    // 30 m initial schedule window + budget + 30 m execution leaves margin under 75 m.
    expect(30 * 60 + ADMISSION_DEFERRAL_BUDGET_S + 30 * 60).toBeLessThan(
      75 * 60,
    );
  });
});

describe("assessHeadroomSupport (boot)", () => {
  it("inert policy ⇒ off, with the reason", () => {
    expect(
      assessHeadroomSupport({
        policy: { ...POLICY, floorBytes: 0, commitFraction: 1 },
        platform: "linux",
        readMeminfo: () => MEMINFO,
      }),
    ).toEqual({
      enabled: false,
      reason: "policy is inert (floor 0, fraction 1)",
    });
  });

  it("macOS ⇒ off (no /proc/meminfo), never reads", () => {
    expect(
      assessHeadroomSupport({
        policy: POLICY,
        platform: "darwin",
        readMeminfo: () => {
          throw new Error("must not be called");
        },
      }),
    ).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/darwin/),
    });
  });

  it("linux with a readable meminfo ⇒ on; unreadable ⇒ off with the error", () => {
    expect(
      assessHeadroomSupport({
        policy: POLICY,
        platform: "linux",
        readMeminfo: () => MEMINFO,
      }),
    ).toEqual({ enabled: true });
    expect(
      assessHeadroomSupport({
        policy: POLICY,
        platform: "linux",
        readMeminfo: () => "garbage",
      }),
    ).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/MemTotal/),
    });
  });
});
