import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CELL_REFUSAL_KINDS, cellRefusalInfo } from "./cell-refusal-text";
import { CELL_EGRESS_REASONS, CellPlanRefusedError } from "./cell-www-client";

// The worker imports nothing from shared or www (the planes stay apart), so the
// mirrors are pinned against the source text instead of a value import.
const REPO = join(__dirname, "..", "..", "..", "..");
const source = (path: string): string => readFileSync(join(REPO, path), "utf8");

describe("cell refusal mirrors (#718)", () => {
  // card: protects=the worker's egress-reason allowlist equals shared's CELL_EGRESS_GUARD_REASONS; fails_when=a guard reason is added, removed or renamed on one side only; no_claim=the egress-catalog reasons
  it("CELL_EGRESS_REASONS matches CELL_EGRESS_GUARD_REASONS exactly", () => {
    const text = source("packages/shared/src/model/cell-egress-guard.ts");
    const block = /CELL_EGRESS_GUARD_REASONS = \[([\s\S]*?)\] as const/.exec(
      text,
    );
    expect(block).not.toBeNull();
    // One entry per line; the trailing comments quote other strings.
    const reasons = [...block![1]!.matchAll(/^\s*"([a-z_]+)",/gm)].map(
      (m) => m[1],
    );
    expect(reasons).toEqual([...CELL_EGRESS_REASONS]);
  });

  // card: protects=AC-1 every literal refusal code cell-plan can send has a named line; fails_when=the route gains a code the map lacks (it would print as unknown); no_claim=codes built from variables (opened.reason, CellPlanError.code)
  it("every literal code the cell-plan route refuses with is in CELL_REFUSAL_KINDS", () => {
    const text = source("apps/www/src/app/api/daemon/cell-plan/route.ts");
    const codes = new Set(
      [...text.matchAll(/(?:refuse\(|error: )"([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect(codes.size).toBeGreaterThan(10);
    const missing = [...codes].filter(
      (code) => code === undefined || !Object.hasOwn(CELL_REFUSAL_KINDS, code),
    );
    expect(missing).toEqual([]);
  });

  it("a reason outside the allowlist is never printed, however the error was built", () => {
    const info = cellRefusalInfo(
      new CellPlanRefusedError(
        "egress_not_enforced",
        409,
        // A caller that bypasses fetchCellPlan's allowlist.
        "token_abc" as (typeof CELL_EGRESS_REASONS)[number],
      ),
    );
    expect(info).toContain("(egress_not_enforced)");
    expect(info).not.toContain("token_abc");
  });
});
