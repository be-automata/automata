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
    expect(TERMINAL_CAUSES).toHaveLength(10);
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
    // #380: `run-failed-unreported` is the sweep's name for a run that died
    // before posting back — it owned the PR like `daemon-failed`, so it is
    // sweepable (the no-verdict notice path), never abandoned.
    expect(sweepable.sort()).toEqual([
      "daemon-failed",
      "out-of-memory",
      "publish-failed",
      "run-failed-unreported",
      "timeout",
    ]);
  });

  it("describes out-of-memory in plain words and keeps it sweepable (#437)", () => {
    // protects=the label/detail a user reads for an OOM-killed run;
    // fails_when=the cause is missing, reworded to raw JSON, or classed as
    // abandoned (the run owned its work and failed); no_claim=none beyond protects.
    expect(isTerminalCause("out-of-memory")).toBe(true);
    expect(describeTerminalCause("out-of-memory")).toEqual({
      label: "Ran out of memory",
      detail:
        "The run exceeded its memory limit and the kernel stopped it. Reduce parallelism (for example test workers) and retry.",
    });
    expect(isAbandonedTerminalCause("out-of-memory")).toBe(false);
  });

  it("isAbandonedTerminalCause treats NULL (a dropped finish event) as sweepable", () => {
    expect(isAbandonedTerminalCause(null)).toBe(false);
    expect(isAbandonedTerminalCause("timeout")).toBe(false);
    expect(isAbandonedTerminalCause("superseded")).toBe(true);
  });
});
