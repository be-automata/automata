import { describe, expect, it } from "vitest";
import {
  TERMINAL_CAUSES,
  describeTerminalCause,
  type TerminalCause,
} from "./types";

describe("worker terminal causes mirror (#125 C4)", () => {
  it("every cause in the tuple is described; an unknown value throws", () => {
    for (const c of TERMINAL_CAUSES) {
      expect(describeTerminalCause(c).length).toBeGreaterThan(0);
    }
    expect(TERMINAL_CAUSES).toHaveLength(8);
    expect(() => describeTerminalCause("nope" as TerminalCause)).toThrow();
  });
});
