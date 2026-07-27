import { describe, it, expect } from "vitest";
import { STALLED_CUTOFF_SECS } from "./cron";

/**
 * Enterprise-hardening #2 watchdog delta (amendment 5): the hourly stalled-task cron
 * reaps with a cutoff ABOVE a remote agent-run's 60m worst case (30m Hatchet schedule
 * + 30m execution), else a late-starting remote run is reaped at the boundary.
 * runStalledTasksCron passes this constant to getStalledThreads (see cron.ts); this
 * locks the raised value so a future edit can't silently drop it back to ≤60m.
 */
describe("stalled-task watchdog cutoff", () => {
  it("is 75 minutes — above the 60m remote worst case, with margin", () => {
    expect(STALLED_CUTOFF_SECS).toBe(75 * 60);
    expect(STALLED_CUTOFF_SECS).toBeGreaterThan(60 * 60);
  });
});
