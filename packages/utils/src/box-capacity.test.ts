import { describe, expect, it } from "vitest";

import {
  ADMISSION_EXHAUSTED_PREFIX,
  DISK_FLOOR_PREFIX,
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

describe("isAdmissionExhaustedText — the disk floor", () => {
  // The worker's DiskFloorError text, as it reaches www.
  const DISK =
    "box_disk_low: the execution box has 3.0 GiB free under /usr/local/automata/runs, below its 5.0 GiB floor (WORKER_DISK_FLOOR); the run was refused before cloning";

  it("matches the worker's disk-floor refusal, bare or wrapped", () => {
    expect(DISK.startsWith(DISK_FLOOR_PREFIX)).toBe(true);
    expect(isAdmissionExhaustedText(DISK)).toBe(true);
    expect(
      isAdmissionExhaustedText(`run: ${JSON.stringify({ message: DISK })}`),
    ).toBe(true);
  });

  it("does not match the bare token or a clone that hit ENOSPC", () => {
    expect(isAdmissionExhaustedText("box_disk_low")).toBe(false);
    expect(
      isAdmissionExhaustedText(
        "git clone failed (exit 128): fatal: write error: No space left on device",
      ),
    ).toBe(false);
  });
});
