/**
 * posture-lattice — worked cases, identity edges, and corrupt-input handling
 * for the monotone `tighten()` meet (ADR-005 §1/§4) and the composed
 * resolvers built on top of it.
 *
 * node:test + node:assert/strict, no fast-check (see posture-lattice.property.test.ts
 * for the exhaustive/enumerated property coverage).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  TRUST_ORDER,
  DEFAULT_TRUSTED_AUTHOR_THRESHOLD,
  isTrustedAuthorThreshold,
  trustRank,
  tighten,
  tightenSeverityPolicy,
  tightenTrustedAuthorThreshold,
  type ReviewPosture,
} from "../../src/settings/posture-lattice";
import {
  DEFAULT_APPROVE_SEVERITY_POLICY,
  toleranceToPolicy,
  type ApproveSeverityPolicy,
} from "../../src/review/severity-policy";
import {
  resolveApproveFloorPolicy,
  resolveComposedFloorPolicy,
  resolveComposedTrustedAuthorThreshold,
} from "../../src/settings/review-floor-resolver";

describe("trust vocabulary", () => {
  test("TRUST_ORDER is the full strictest-loosest-ascending vocabulary", () => {
    assert.deepEqual(TRUST_ORDER, [
      "NONE",
      "FIRST_TIME_CONTRIBUTOR",
      "CONTRIBUTOR",
      "COLLABORATOR",
      "MEMBER",
      "OWNER",
    ]);
  });

  test("trustRank orders NONE < ... < OWNER", () => {
    assert.equal(trustRank("NONE"), 0);
    assert.equal(trustRank("OWNER"), 5);
    assert.ok(trustRank("MEMBER") > trustRank("COLLABORATOR"));
  });

  test("isTrustedAuthorThreshold guards the vocabulary", () => {
    for (const v of TRUST_ORDER) assert.ok(isTrustedAuthorThreshold(v));
    for (const v of ["", "owner", "member", null, undefined, 42, "BOGUS"]) {
      assert.equal(isTrustedAuthorThreshold(v), false);
    }
  });

  test("DEFAULT_TRUSTED_AUTHOR_THRESHOLD is MEMBER", () => {
    assert.equal(DEFAULT_TRUSTED_AUTHOR_THRESHOLD, "MEMBER");
  });
});

describe("tighten — worked cases (AC3)", () => {
  test("repo 'error' under org 'warning' -> {warning, warning}", () => {
    const org = toleranceToPolicy("warning");
    const repo = toleranceToPolicy("error");
    assert.deepEqual(tightenSeverityPolicy(org, repo), {
      blockSeverity: "warning",
      surfaceSeverity: "warning",
    });
  });

  test("repo 'info' under org 'warning' -> {info, info}", () => {
    const org = toleranceToPolicy("warning");
    const repo = toleranceToPolicy("info");
    assert.deepEqual(tightenSeverityPolicy(org, repo), {
      blockSeverity: "info",
      surfaceSeverity: "info",
    });
  });

  test("trust: org MEMBER, repo COLLABORATOR -> MEMBER (org floor wins, repo tried to loosen)", () => {
    assert.equal(
      tightenTrustedAuthorThreshold("MEMBER", "COLLABORATOR"),
      "MEMBER",
    );
  });

  test("trust: org MEMBER, repo OWNER -> OWNER (repo raised the bar, allowed)", () => {
    assert.equal(tightenTrustedAuthorThreshold("MEMBER", "OWNER"), "OWNER");
  });

  test("full ReviewPosture tighten combines all three fields independently", () => {
    const a: ReviewPosture = {
      blockSeverity: "warning",
      surfaceSeverity: "warning",
      trustedAuthorThreshold: "MEMBER",
    };
    const b: ReviewPosture = {
      blockSeverity: "error",
      surfaceSeverity: "info",
      trustedAuthorThreshold: "COLLABORATOR",
    };
    assert.deepEqual(tighten(a, b), {
      blockSeverity: "warning", // argmin severity rank
      surfaceSeverity: "info", // argmin severity rank
      trustedAuthorThreshold: "MEMBER", // argmax trust rank
    });
  });
});

describe("resolveComposedFloorPolicy — identity edges (AC2)", () => {
  test("org absent -> base unchanged (repo row present)", () => {
    const base = resolveApproveFloorPolicy({ blockTolerance: "error" });
    assert.deepEqual(
      resolveComposedFloorPolicy(undefined, { blockTolerance: "error" }),
      base,
    );
    assert.deepEqual(
      resolveComposedFloorPolicy(null, { blockTolerance: "error" }),
      base,
    );
  });

  test("org invalid -> base unchanged", () => {
    const base = resolveApproveFloorPolicy({ blockTolerance: "info" });
    assert.deepEqual(
      resolveComposedFloorPolicy(
        { blockTolerance: "bogus" },
        { blockTolerance: "info" },
      ),
      base,
    );
  });

  test("org absent + envPolicy tier still applies underneath (base = envPolicy)", () => {
    const envPolicy: ApproveSeverityPolicy = {
      blockSeverity: "error",
      surfaceSeverity: "warning",
    };
    assert.deepEqual(
      resolveComposedFloorPolicy(undefined, undefined, envPolicy),
      envPolicy,
    );
  });

  test("repo absent -> org floor (via locked default base)", () => {
    const orgFloor = toleranceToPolicy("error");
    assert.deepEqual(
      resolveComposedFloorPolicy({ blockTolerance: "error" }, undefined),
      tightenSeverityPolicy(orgFloor, DEFAULT_APPROVE_SEVERITY_POLICY),
    );
  });

  test("both absent -> locked default", () => {
    assert.deepEqual(
      resolveComposedFloorPolicy(undefined, undefined),
      DEFAULT_APPROVE_SEVERITY_POLICY,
    );
  });

  test("return shape is exactly the 2-field ApproveSeverityPolicy", () => {
    const result = resolveComposedFloorPolicy(
      { blockTolerance: "error" },
      { blockTolerance: "warning" },
    );
    assert.deepEqual(Object.keys(result).sort(), [
      "blockSeverity",
      "surfaceSeverity",
    ]);
  });
});

describe("resolveComposedTrustedAuthorThreshold", () => {
  test("both absent -> DEFAULT_TRUSTED_AUTHOR_THRESHOLD", () => {
    assert.equal(
      resolveComposedTrustedAuthorThreshold(undefined, undefined),
      "MEMBER",
    );
    assert.equal(resolveComposedTrustedAuthorThreshold(null, null), "MEMBER");
  });

  test("org present, repo absent -> org value", () => {
    assert.equal(
      resolveComposedTrustedAuthorThreshold(
        { trustedAuthorThreshold: "OWNER" },
        undefined,
      ),
      "OWNER",
    );
  });

  test("org absent, repo present -> tighten(default, repo)", () => {
    // org absent falls back to DEFAULT ("MEMBER"); repo COLLABORATOR is looser
    // than MEMBER so the org-default floor wins.
    assert.equal(
      resolveComposedTrustedAuthorThreshold(undefined, {
        trustedAuthorThreshold: "COLLABORATOR",
      }),
      "MEMBER",
    );
    // repo OWNER is stricter than the MEMBER default -> repo wins.
    assert.equal(
      resolveComposedTrustedAuthorThreshold(undefined, {
        trustedAuthorThreshold: "OWNER",
      }),
      "OWNER",
    );
  });

  test("repo cannot loosen below org floor", () => {
    assert.equal(
      resolveComposedTrustedAuthorThreshold(
        { trustedAuthorThreshold: "MEMBER" },
        { trustedAuthorThreshold: "COLLABORATOR" },
      ),
      "MEMBER",
    );
  });

  test("repo can raise above org floor", () => {
    assert.equal(
      resolveComposedTrustedAuthorThreshold(
        { trustedAuthorThreshold: "COLLABORATOR" },
        { trustedAuthorThreshold: "OWNER" },
      ),
      "OWNER",
    );
  });

  test("corrupt org value is treated as absent (fail open, mirrors repo-tier precedent)", () => {
    const cases: Array<string | null | undefined> = [
      "bogus",
      "",
      "owner", // wrong case
      "COLLAB",
    ];
    for (const bad of cases) {
      assert.equal(
        resolveComposedTrustedAuthorThreshold(
          bad === null || bad === undefined
            ? bad
            : { trustedAuthorThreshold: bad },
          { trustedAuthorThreshold: "OWNER" },
        ),
        "OWNER",
        `bad org value ${JSON.stringify(bad)} should be treated as absent`,
      );
    }
  });

  test("corrupt repo value is treated as absent -> org (or default) wins", () => {
    assert.equal(
      resolveComposedTrustedAuthorThreshold(
        { trustedAuthorThreshold: "OWNER" },
        { trustedAuthorThreshold: "bogus" },
      ),
      "OWNER",
    );
  });
});
