import { describe, expect, it } from "vitest";

import { resolveRunDisplayLane } from "./run-lane";

describe("resolveRunDisplayLane", () => {
  it("a self-heal plan wins over every other signal", () => {
    expect(
      resolveRunDisplayLane({
        selfHeal: { kind: "audit" },
        prKey: "org_1/acme/widgets/1",
        prNumber: 1,
      }),
    ).toBe("self-heal-audit");
    expect(
      resolveRunDisplayLane({ selfHeal: { kind: "fix" }, prNumber: 3 }),
    ).toBe("self-heal-fix");
  });

  it("a null self-heal plan falls through", () => {
    expect(resolveRunDisplayLane({ selfHeal: null })).toBe("task");
  });

  it("a review-plan stamp (prKey or policy snapshot) is review", () => {
    expect(
      resolveRunDisplayLane({ prKey: "org_1/acme/widgets/9", prNumber: 9 }),
    ).toBe("review");
    expect(resolveRunDisplayLane({ supersedePolicy: "newest-wins" })).toBe(
      "review",
    );
  });

  it("a PR number without the review plan is pr", () => {
    expect(resolveRunDisplayLane({ prNumber: 12 })).toBe("pr");
  });

  it("nothing at all is task", () => {
    expect(resolveRunDisplayLane({})).toBe("task");
  });
});
