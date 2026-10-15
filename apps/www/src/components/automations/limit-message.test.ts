import { describe, expect, it } from "vitest";

import { automationLimitMessage } from "./limit-message";

describe("automationLimitMessage", () => {
  it("says the limit spans every org and prints the counts", () => {
    expect(automationLimitMessage({ count: 3, max: 3 })).toBe(
      "You have reached the maximum number of active automations for your plan across all your organizations (3 of 3). To create another, disable or delete an existing active automation.",
    );
  });

  it("omits the counts when the plan has no cap", () => {
    expect(automationLimitMessage({ count: 5, max: null })).not.toMatch(/\(/);
  });
});
