import { describe, expect, it } from "vitest";

import { reconcileTokenMatches, reconcileUnauthorized } from "./reconcile-auth";

describe("reconcileTokenMatches", () => {
  it("accepts only the equal secret", () => {
    expect(reconcileTokenMatches("s", "s")).toBe(true);
    expect(reconcileTokenMatches("s", "t")).toBe(false);
    expect(reconcileTokenMatches("s", "ss")).toBe(false);
  });

  it("refuses a missing header", () => {
    expect(reconcileTokenMatches("s", null)).toBe(false);
    expect(reconcileTokenMatches("s", "")).toBe(false);
  });

  it("refuses everything when the secret is empty", () => {
    expect(reconcileTokenMatches("", "")).toBe(false);
    expect(reconcileTokenMatches("", "anything")).toBe(false);
    expect(reconcileTokenMatches("", null)).toBe(false);
  });
});

describe("reconcileUnauthorized", () => {
  it("is the same 401 body every time", async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = reconcileUnauthorized();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
  });
});
