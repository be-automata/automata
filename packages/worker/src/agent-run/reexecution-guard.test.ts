import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetReexecutionGuardForTests,
  assertNotReexecuting,
  deferralsRecorded,
  forgetRun,
  recordDeferral,
} from "./reexecution-guard";

describe("re-execution guard (#371): only a recorded deferral may be retried", () => {
  beforeEach(() => _resetReexecutionGuardForTests());

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
      /attempt 4 of this run follows a failure that was not an admission deferral \(1 deferral\(s\) recorded.*never re-executes/,
    );
  });

  it("forgetRun drops the ledger; threads are independent", () => {
    recordDeferral("a");
    recordDeferral("b");
    forgetRun("a");
    expect(deferralsRecorded("a")).toBe(0);
    expect(deferralsRecorded("b")).toBe(1);
    expect(() => assertNotReexecuting("a", 1)).toThrow(NonRetryableError);
    expect(() => assertNotReexecuting("b", 1)).not.toThrow();
  });
});
