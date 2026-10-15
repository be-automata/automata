import { describe, expect, it } from "vitest";

import { isSlackTeamId, parseSlackTeamId } from "./slack-team-id";

describe("slack team id", () => {
  it("accepts workspace and enterprise ids", () => {
    expect(isSlackTeamId("T09TZHQ5VNX")).toBe(true);
    expect(isSlackTeamId("E01ABCDEF")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of ["", "t09tzhq5vnx", "C0A1KPD6CTY", "T12", "T0&x=1"]) {
      expect(isSlackTeamId(value)).toBe(false);
    }
  });

  it("parses an id or a Slack client URL", () => {
    expect(parseSlackTeamId(" T09TZHQ5VNX ")).toBe("T09TZHQ5VNX");
    expect(
      parseSlackTeamId("https://app.slack.com/client/T09TZHQ5VNX/C0A1KPD6CTY"),
    ).toBe("T09TZHQ5VNX");
    expect(parseSlackTeamId("https://example.com/T09TZHQ5VNX")).toBeNull();
    expect(parseSlackTeamId("nope")).toBeNull();
  });
});
