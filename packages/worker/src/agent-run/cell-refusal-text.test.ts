import type { CellEgressGuardReason } from "@terragon/types/cell";
import { describe, expect, it } from "vitest";

import { cellRefusalInfo } from "./cell-refusal-text";
import { CellPlanRefusedError } from "./cell-www-client";

describe("cellRefusalInfo (#718)", () => {
  it("a reason outside the allowlist is never printed, however the error was built", () => {
    const info = cellRefusalInfo(
      new CellPlanRefusedError(
        "egress_not_enforced",
        409,
        // A caller that bypasses fetchCellPlan's allowlist.
        "token_abc" as CellEgressGuardReason,
      ),
    );
    expect(info).toContain("(egress_not_enforced)");
    expect(info).not.toContain("token_abc");
  });
});
