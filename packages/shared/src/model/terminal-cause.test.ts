import { describe, expect, it } from "vitest";
import {
  ABANDONED_TERMINAL_CAUSES,
  TERMINAL_CAUSES,
  describeTerminalCause,
  isAbandonedTerminalCause,
  isTerminalCause,
} from "./terminal-cause";

describe("terminal causes (#125 C4)", () => {
  it("every cause in the union is described (the exhaustive switch)", () => {
    for (const cause of TERMINAL_CAUSES) {
      const d = describeTerminalCause(cause);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.detail.length).toBeGreaterThan(0);
    }
    expect(TERMINAL_CAUSES).toHaveLength(8);
  });

  it("isTerminalCause narrows strings; an unknown value is refused", () => {
    expect(isTerminalCause("superseded")).toBe(true);
    expect(isTerminalCause("plane-offline")).toBe(true);
    expect(isTerminalCause("yolo")).toBe(false);
    expect(() =>
      describeTerminalCause("yolo" as unknown as "superseded"),
    ).toThrow();
  });

  it("partitions every cause into abandoned vs sweepable — a new cause must choose", () => {
    // The review sweep speaks for the sweepable half only (#140). A cause added
    // without a deliberate side lands in the sweepable half by default, which is
    // the one that POSTS to GitHub — so pin the split explicitly.
    const abandoned = new Set<string>(ABANDONED_TERMINAL_CAUSES);
    const sweepable = TERMINAL_CAUSES.filter((c) => !abandoned.has(c));
    expect([...abandoned].sort()).toEqual([
      "discarded",
      "plane-offline",
      "stale-skipped",
      "superseded",
      "user-cancelled",
    ]);
    expect(sweepable.sort()).toEqual([
      "daemon-failed",
      "publish-failed",
      "timeout",
    ]);
  });

  it("isAbandonedTerminalCause treats NULL (a dropped finish event) as sweepable", () => {
    expect(isAbandonedTerminalCause(null)).toBe(false);
    expect(isAbandonedTerminalCause("timeout")).toBe(false);
    expect(isAbandonedTerminalCause("superseded")).toBe(true);
  });
});
