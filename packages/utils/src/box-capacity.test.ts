import { describe, expect, it } from "vitest";

import {
  ADMISSION_EXHAUSTED_PREFIX,
  isAdmissionExhaustedText,
} from "./box-capacity";

// The worker's AdmissionBudgetExhaustedError text, as it reaches www.
const RAW =
  "The box had no memory headroom for this run after 8 deferral(s) (366s deferred); last check: The box had no memory headroom for this run (attempt 9, commit-over-fraction): MemAvailable=13047M";

describe("isAdmissionExhaustedText (#561)", () => {
  it("matches the worker's message, bare or wrapped by Hatchet's error summary", () => {
    expect(RAW.startsWith(ADMISSION_EXHAUSTED_PREFIX)).toBe(true);
    expect(isAdmissionExhaustedText(RAW)).toBe(true);
    expect(
      isAdmissionExhaustedText(`run: ${JSON.stringify({ message: RAW })}`),
    ).toBe(true);
  });

  it("never matches a single deferral, another error or nothing", () => {
    // One refusal (AdmissionDeferredError) is internal and retried, not final.
    expect(
      isAdmissionExhaustedText(
        "The box had no memory headroom for this run (attempt 2, commit-over-fraction)",
      ),
    ).toBe(false);
    expect(isAdmissionExhaustedText("daemon exited with code 1")).toBe(false);
    expect(isAdmissionExhaustedText("")).toBe(false);
    expect(isAdmissionExhaustedText(null)).toBe(false);
    expect(isAdmissionExhaustedText(undefined)).toBe(false);
  });
});
