import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_SOURCES,
  describeCredentialSource,
  isCredentialSource,
} from "./credential-source";

/**
 * Shapes that would mean a credential leaked into the attribution copy. The
 * DoD asks for this to be asserted rather than assumed.
 */
const SECRET_SHAPED = [
  /sk-/,
  /sk-ant/,
  /ghp_/,
  /ghs_/,
  /Bearer /,
  /-----BEGIN/,
  /"contents"/,
  /"value"/,
];

describe("credential sources (#209 item 1)", () => {
  it("every source in the union is described (the exhaustive switch)", () => {
    for (const source of CREDENTIAL_SOURCES) {
      expect(describeCredentialSource(source).length).toBeGreaterThan(0);
    }
    expect(CREDENTIAL_SOURCES).toHaveLength(3);
  });

  it("isCredentialSource narrows strings; an unknown value is refused", () => {
    expect(isCredentialSource("user-credential")).toBe(true);
    expect(isCredentialSource("built-in-credits")).toBe(true);
    expect(isCredentialSource("box-key")).toBe(true);
    expect(isCredentialSource("anything-else")).toBe(false);
    expect(() =>
      describeCredentialSource("anything-else" as unknown as "box-key"),
    ).toThrow();
  });

  it("no label carries secret-shaped text", () => {
    for (const source of CREDENTIAL_SOURCES) {
      const label = describeCredentialSource(source);
      for (const pattern of SECRET_SHAPED) {
        expect(label).not.toMatch(pattern);
      }
    }
  });
});
