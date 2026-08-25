import { describe, expect, it } from "vitest";
import {
  TERMINAL_CAUSES,
  describeTerminalCause,
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
});
