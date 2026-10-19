import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetReexecutionGuardForTests,
  assertNotReexecuting,
  deferralsRecorded,
  forgetRun,
  LEDGER_DIRNAME,
  LEDGER_TTL_MS,
  ledgerSize,
  recordDeferral,
  sweepDeferralLedger,
} from "./reexecution-guard";

describe("re-execution guard (#371): only a recorded deferral may be retried", () => {
  beforeEach(() => _resetReexecutionGuardForTests());

  it("is durable: with a root, the count survives a process restart (file under <root>/deferrals), forgetRun removes it, a stale file is ignored", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
    try {
      const t0 = 5_000_000;
      recordDeferral("wfr-1", { root, now: t0 });
      recordDeferral("wfr-1", { root, now: t0 + 1 });
      expect(fs.existsSync(path.join(root, LEDGER_DIRNAME, "wfr-1.json"))).toBe(
        true,
      );
      // "restart": the in-process map is gone, the file is not.
      _resetReexecutionGuardForTests();
      expect(deferralsRecorded("wfr-1", { root, now: t0 + 2 })).toBe(2);
      expect(() =>
        assertNotReexecuting("wfr-1", 2, { root, now: t0 + 2 }),
      ).not.toThrow();
      expect(() =>
        assertNotReexecuting("wfr-1", 3, { root, now: t0 + 2 }),
      ).toThrow(NonRetryableError);
      // A stale file (older than the TTL) counts for nothing.
      expect(
        deferralsRecorded("wfr-1", { root, now: t0 + LEDGER_TTL_MS + 10 }),
      ).toBe(0);
      forgetRun("wfr-1", { root });
      expect(fs.existsSync(path.join(root, LEDGER_DIRNAME, "wfr-1.json"))).toBe(
        false,
      );
      // A key that is not a safe filename is sanitised, never a path.
      recordDeferral("../evil/run", { root, now: t0 });
      expect(
        fs.existsSync(path.join(root, LEDGER_DIRNAME, ".._evil_run.json")),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is bounded: an entry whose retry never came back ages out after the TTL (budget + one scheduleTimeout), on reads too", () => {
    const t0 = 1_000_000;
    recordDeferral("stale", { now: t0 });
    // A read past the TTL counts it as 0 even with no later write.
    expect(deferralsRecorded("stale", { now: t0 + LEDGER_TTL_MS + 1 })).toBe(0);
    recordDeferral("fresh", { now: t0 + LEDGER_TTL_MS + 1 });
    expect(ledgerSize()).toBe(1);
    expect(deferralsRecorded("fresh", { now: t0 + LEDGER_TTL_MS + 2 })).toBe(1);
  });

  it("sweepDeferralLedger removes durable files older than the TTL and unreadable ones, keeps fresh ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-sweep-"));
    try {
      const t0 = 9_000_000;
      recordDeferral("old", { root, now: t0 });
      recordDeferral("new", { root, now: t0 + LEDGER_TTL_MS - 1 });
      fs.writeFileSync(
        path.join(root, LEDGER_DIRNAME, "junk.json"),
        "{not json",
      );
      expect(sweepDeferralLedger(root, t0 + LEDGER_TTL_MS + 1)).toBe(2);
      expect(fs.readdirSync(path.join(root, LEDGER_DIRNAME))).toEqual([
        "new.json",
      ]);
      expect(sweepDeferralLedger("/nonexistent/root")).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("attempt 0 always passes; attempt n passes only with n deferrals recorded", () => {
    expect(() => assertNotReexecuting("t", 0)).not.toThrow();
    expect(() => assertNotReexecuting("t", 1)).toThrow(NonRetryableError);
    recordDeferral("t");
    expect(deferralsRecorded("t")).toBe(1);
    expect(() => assertNotReexecuting("t", 1)).not.toThrow();
    expect(() => assertNotReexecuting("t", 2)).toThrow(NonRetryableError);
    recordDeferral("t");
    expect(() => assertNotReexecuting("t", 2)).not.toThrow();
  });

  it("the refusal is final and says why (timeout or restart), naming the recorded count", () => {
    recordDeferral("t");
    let err: unknown;
    try {
      assertNotReexecuting("t", 3);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).toMatch(
      /most likely its execution timeout.*attempt 4, 1 admission deferral\(s\) on record.*never re-executes/,
    );
  });

  it("forgetRun drops the ledger; runs are independent (keyed by the workflow run, never the thread)", () => {
    recordDeferral("a");
    recordDeferral("b");
    forgetRun("a");
    expect(deferralsRecorded("a")).toBe(0);
    expect(deferralsRecorded("b")).toBe(1);
    expect(() => assertNotReexecuting("a", 1)).toThrow(NonRetryableError);
    expect(() => assertNotReexecuting("b", 1)).not.toThrow();
  });
});
