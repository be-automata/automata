/**
 * review-floor-resolver — the per-repo approve-floor precedence chain.
 *
 * Precedence: stored per-repo row (dashboard) > env-derived policy > locked
 * default. This kernel is I/O-free: apps/www reads the Neon row (LIVE, so a
 * dashboard write applies to the next run without a restart) and hands it here.
 * node:test + node:assert/strict.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveApproveFloorPolicy } from "../../src/settings/review-floor-resolver";
import {
  DEFAULT_APPROVE_SEVERITY_POLICY,
  toleranceToPolicy,
  type ApproveSeverityPolicy,
} from "../../src/review/severity-policy";
import type { BlockTolerance } from "../../src/settings/types";

describe("resolveApproveFloorPolicy — precedence matrix", () => {
  test("row present → toleranceToPolicy(row.blockTolerance) wins over env and default", () => {
    const envPolicy: ApproveSeverityPolicy = {
      blockSeverity: "critical",
      surfaceSeverity: "info",
    };
    const policy = resolveApproveFloorPolicy(
      { blockTolerance: "error" },
      envPolicy,
    );
    assert.deepEqual(policy, toleranceToPolicy("error"));
    assert.deepEqual(policy, {
      blockSeverity: "error",
      surfaceSeverity: "warning",
    });
  });

  test("no row + envPolicy → envPolicy", () => {
    const envPolicy: ApproveSeverityPolicy = {
      blockSeverity: "error",
      surfaceSeverity: "warning",
    };
    assert.deepEqual(
      resolveApproveFloorPolicy(undefined, envPolicy),
      envPolicy,
    );
    assert.deepEqual(resolveApproveFloorPolicy(null, envPolicy), envPolicy);
  });

  test("no row + no envPolicy → the locked DEFAULT policy", () => {
    assert.deepEqual(
      resolveApproveFloorPolicy(undefined),
      DEFAULT_APPROVE_SEVERITY_POLICY,
    );
  });

  test("each tolerance maps to its full policy when present as a row", () => {
    const cases: Array<[BlockTolerance, ApproveSeverityPolicy]> = [
      ["info", { blockSeverity: "info", surfaceSeverity: "info" }],
      ["warning", { blockSeverity: "warning", surfaceSeverity: "warning" }],
      ["error", { blockSeverity: "error", surfaceSeverity: "warning" }],
    ];
    for (const [tol, policy] of cases) {
      assert.deepEqual(
        resolveApproveFloorPolicy({ blockTolerance: tol }),
        policy,
        `tolerance ${tol}`,
      );
    }
  });

  test("a corrupt / unrecognized stored tolerance is treated as absent (fall back, never crash)", () => {
    const envPolicy: ApproveSeverityPolicy = {
      blockSeverity: "error",
      surfaceSeverity: "warning",
    };
    // e.g. a 'critical' value (representable but not offered) or garbage.
    assert.deepEqual(
      resolveApproveFloorPolicy({ blockTolerance: "critical" }, envPolicy),
      envPolicy,
    );
    assert.deepEqual(
      resolveApproveFloorPolicy({ blockTolerance: "" }, envPolicy),
      envPolicy,
    );
    assert.deepEqual(
      resolveApproveFloorPolicy({ blockTolerance: "bogus" }),
      DEFAULT_APPROVE_SEVERITY_POLICY,
    );
  });
});
