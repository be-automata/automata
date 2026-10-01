import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SOURCES,
  TERMINAL_CAUSES,
  describeCredentialSource,
  describeTerminalCause,
  type CredentialSource,
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

describe("worker credential sources mirror (#209 item 1)", () => {
  it("every source in the tuple is described; an unknown value throws", () => {
    for (const s of CREDENTIAL_SOURCES) {
      expect(describeCredentialSource(s).length).toBeGreaterThan(0);
    }
    expect(CREDENTIAL_SOURCES).toHaveLength(3);
    expect(() =>
      describeCredentialSource("nope" as CredentialSource),
    ).toThrow();
  });

  it("the three members match the control plane's vocabulary", () => {
    // Structural mirror: the tuple is duplicated, never imported. Pinning the
    // members here is what makes a drift from www a failing test, not a
    // silently different label on the other plane.
    expect([...CREDENTIAL_SOURCES]).toEqual([
      "user-credential",
      "built-in-credits",
      "box-key",
    ]);
  });
});
