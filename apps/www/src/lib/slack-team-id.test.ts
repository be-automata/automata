import { describe, expect, it } from "vitest";

import { isSlackTeamId, parseSlackTeamId } from "./slack-team-id";

describe("slack team id", () => {
  it("accepts workspace and enterprise ids", () => {
    expect(isSlackTeamId("T0EXAMPLE01")).toBe(true);
    expect(isSlackTeamId("E01ABCDEF")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of ["", "t0example01", "C0A1KPD6CTY", "T12", "T0&x=1"]) {
      expect(isSlackTeamId(value)).toBe(false);
    }
  });

  it("parses an id or a Slack client URL", () => {
    expect(parseSlackTeamId(" T0EXAMPLE01 ")).toBe("T0EXAMPLE01");
    expect(
      parseSlackTeamId("https://app.slack.com/client/T0EXAMPLE01/C0A1KPD6CTY"),
    ).toBe("T0EXAMPLE01");
    expect(parseSlackTeamId("https://example.com/T0EXAMPLE01")).toBeNull();
    expect(parseSlackTeamId("nope")).toBeNull();
  });
});
