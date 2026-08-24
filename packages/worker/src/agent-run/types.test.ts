import { describe, expect, it } from "vitest";
import { describeTerminalCause, type TerminalCause } from "./types";

const ALL: TerminalCause[] = [
  "superseded",
  "discarded",
  "stale-skipped",
  "user-cancelled",
  "timeout",
  "daemon-failed",
  "publish-failed",
  "plane-offline",
];

describe("worker terminal causes mirror (#125 C4)", () => {
  it("every cause is described; the switch is exhaustive", () => {
    for (const c of ALL)
      expect(describeTerminalCause(c).length).toBeGreaterThan(0);
    expect(() => describeTerminalCause("nope" as TerminalCause)).toThrow();
  });
});
