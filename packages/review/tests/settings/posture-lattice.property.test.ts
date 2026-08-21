/**
 * Property tests for the posture lattice (ADR-005 §1/§4).
 *
 * The state space is small enough to ENUMERATE EXHAUSTIVELY rather than
 * sample: 10 well-formed ApproveSeverityPolicy values (surface rank ≤ block
 * rank, over the 4 severities) ⇒ 100 ordered pairs; 6 trust levels ⇒ 36
 * ordered pairs; 3 block tolerances ⇒ 9 ordered pairs. Exhaustion over a
 * space this size is a stronger guarantee than sampling and is cheap.
 *
 * A seeded LCG (style copied from
 * ../review/state/break-glass-matcher.property.test.ts) is used only for the
 * corrupt-input fuzz, where the input domain (arbitrary strings/null/
 * undefined) is not enumerable.
 *
 * node:test + node:assert/strict, no fast-check (not a dependency of this
 * package and this ticket must not add one).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  TRUST_ORDER,
  tighten,
  tightenSeverityPolicy,
  tightenTrustedAuthorThreshold,
  trustRank,
  type ReviewPosture,
  type TrustedAuthorThreshold,
} from "../../src/settings/posture-lattice";
import {
  BLOCK_TOLERANCES,
  SEVERITY_ORDER,
  severityRank,
  toleranceToPolicy,
  type ApproveSeverityPolicy,
  type BlockTolerance,
} from "../../src/review/severity-policy";
import { resolveComposedTrustedAuthorThreshold } from "../../src/settings/review-floor-resolver";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** All well-formed ApproveSeverityPolicy values: surfaceRank <= blockRank. Exactly 10. */
function allWellFormedPolicies(): ApproveSeverityPolicy[] {
  const out: ApproveSeverityPolicy[] = [];
  for (const block of SEVERITY_ORDER) {
    for (const surface of SEVERITY_ORDER) {
      if (severityRank(surface) <= severityRank(block)) {
        out.push({ blockSeverity: block, surfaceSeverity: surface });
      }
    }
  }
  return out;
}

const ALL_POLICIES = allWellFormedPolicies();
const ALL_TRUST: readonly TrustedAuthorThreshold[] = TRUST_ORDER;
const ALL_TOLERANCES: readonly BlockTolerance[] = BLOCK_TOLERANCES;

function policyPairs(): Array<[ApproveSeverityPolicy, ApproveSeverityPolicy]> {
  const out: Array<[ApproveSeverityPolicy, ApproveSeverityPolicy]> = [];
  for (const a of ALL_POLICIES) for (const b of ALL_POLICIES) out.push([a, b]);
  return out;
}

function trustPairs(): Array<[TrustedAuthorThreshold, TrustedAuthorThreshold]> {
  const out: Array<[TrustedAuthorThreshold, TrustedAuthorThreshold]> = [];
  for (const a of ALL_TRUST) for (const b of ALL_TRUST) out.push([a, b]);
  return out;
}

function tolerancePairs(): Array<[BlockTolerance, BlockTolerance]> {
  const out: Array<[BlockTolerance, BlockTolerance]> = [];
  for (const a of ALL_TOLERANCES)
    for (const b of ALL_TOLERANCES) out.push([a, b]);
  return out;
}

function posture(
  policy: ApproveSeverityPolicy,
  trust: TrustedAuthorThreshold,
): ReviewPosture {
  return { ...policy, trustedAuthorThreshold: trust };
}

describe("well-formedness: ALL_POLICIES really is the exhaustive 10-element set", () => {
  test("exactly 10 well-formed (surface <= block) policies over 4 severities", () => {
    assert.equal(ALL_POLICIES.length, 10);
  });
  test("36 trust pairs, 9 tolerance pairs", () => {
    assert.equal(trustPairs().length, 36);
    assert.equal(tolerancePairs().length, 9);
  });
});

describe("floor-preserving (AC1 for severity; trust axis inverted per ADR-005 §4)", () => {
  test("severityRank(tighten(org,repo).block/surface) <= severityRank(org.block/surface) over all 100 pairs", () => {
    for (const [org, repo] of policyPairs()) {
      const eff = tightenSeverityPolicy(org, repo);
      assert.ok(
        severityRank(eff.blockSeverity) <= severityRank(org.blockSeverity),
        `org=${JSON.stringify(org)} repo=${JSON.stringify(repo)} eff.block=${eff.blockSeverity}`,
      );
      assert.ok(
        severityRank(eff.surfaceSeverity) <= severityRank(org.surfaceSeverity),
        `org=${JSON.stringify(org)} repo=${JSON.stringify(repo)} eff.surface=${eff.surfaceSeverity}`,
      );
    }
  });

  test("trustRank(T_eff) >= trustRank(T_org) over all 36 pairs (inequality flips vs. severity)", () => {
    for (const [org, repo] of trustPairs()) {
      const eff = tightenTrustedAuthorThreshold(org, repo);
      assert.ok(
        trustRank(eff) >= trustRank(org),
        `org=${org} repo=${repo} eff=${eff}`,
      );
    }
  });
});

describe("well-formedness preserved by tighten (surface <= block)", () => {
  test("min preserves surface<=block: over all 100 well-formed pairs, tighten stays well-formed", () => {
    for (const [a, b] of policyPairs()) {
      const eff = tightenSeverityPolicy(a, b);
      assert.ok(
        severityRank(eff.surfaceSeverity) <= severityRank(eff.blockSeverity),
        `a=${JSON.stringify(a)} b=${JSON.stringify(b)} eff=${JSON.stringify(eff)}`,
      );
    }
  });
});

describe("algebraic laws — exhaustive over severity policies", () => {
  test("idempotent: tighten(p, p) === p", () => {
    for (const p of ALL_POLICIES) {
      assert.deepEqual(tightenSeverityPolicy(p, p), p);
    }
  });

  test("commutative: tighten(a, b) === tighten(b, a)", () => {
    for (const [a, b] of policyPairs()) {
      assert.deepEqual(
        tightenSeverityPolicy(a, b),
        tightenSeverityPolicy(b, a),
      );
    }
  });

  test("associative: tighten(tighten(a,b),c) === tighten(a,tighten(b,c))", () => {
    // Full 10^3 = 1000 triples — still tiny.
    for (const a of ALL_POLICIES) {
      for (const b of ALL_POLICIES) {
        for (const c of ALL_POLICIES) {
          const left = tightenSeverityPolicy(tightenSeverityPolicy(a, b), c);
          const right = tightenSeverityPolicy(a, tightenSeverityPolicy(b, c));
          assert.deepEqual(
            left,
            right,
            `a=${JSON.stringify(a)} b=${JSON.stringify(b)} c=${JSON.stringify(c)}`,
          );
        }
      }
    }
  });
});

describe("algebraic laws — exhaustive over trust levels", () => {
  test("idempotent", () => {
    for (const t of ALL_TRUST) {
      assert.equal(tightenTrustedAuthorThreshold(t, t), t);
    }
  });

  test("commutative", () => {
    for (const [a, b] of trustPairs()) {
      assert.equal(
        tightenTrustedAuthorThreshold(a, b),
        tightenTrustedAuthorThreshold(b, a),
      );
    }
  });

  test("associative", () => {
    for (const a of ALL_TRUST) {
      for (const b of ALL_TRUST) {
        for (const c of ALL_TRUST) {
          const left = tightenTrustedAuthorThreshold(
            tightenTrustedAuthorThreshold(a, b),
            c,
          );
          const right = tightenTrustedAuthorThreshold(
            a,
            tightenTrustedAuthorThreshold(b, c),
          );
          assert.equal(left, right, `a=${a} b=${b} c=${c}`);
        }
      }
    }
  });
});

describe("full ReviewPosture tighten — exhaustive laws combining both axes", () => {
  const postures: ReviewPosture[] = ALL_POLICIES.flatMap((p) =>
    ALL_TRUST.slice(0, 3).map((t) => posture(p, t)),
  ); // 10 * 3 = 30 postures, kept smaller than the full 60 to bound the O(n^3) associativity check

  test("idempotent", () => {
    for (const p of postures) {
      assert.deepEqual(tighten(p, p), p);
    }
  });

  test("commutative", () => {
    for (const a of postures) {
      for (const b of postures) {
        assert.deepEqual(tighten(a, b), tighten(b, a));
      }
    }
  });
});

describe("worked cases (AC3) via toleranceToPolicy, exhaustive over 9 tolerance pairs", () => {
  test("tighten(toleranceToPolicy(org), toleranceToPolicy(repo)) is well-formed and floor-preserving for all 9 pairs", () => {
    for (const [orgTol, repoTol] of tolerancePairs()) {
      const org = toleranceToPolicy(orgTol);
      const repo = toleranceToPolicy(repoTol);
      const eff = tightenSeverityPolicy(org, repo);
      assert.ok(
        severityRank(eff.blockSeverity) <= severityRank(org.blockSeverity),
      );
      assert.ok(
        severityRank(eff.surfaceSeverity) <= severityRank(org.surfaceSeverity),
      );
      assert.ok(
        severityRank(eff.surfaceSeverity) <= severityRank(eff.blockSeverity),
      );
    }
  });

  test("repo 'error' under org 'warning' -> {warning, warning}", () => {
    const eff = tightenSeverityPolicy(
      toleranceToPolicy("warning"),
      toleranceToPolicy("error"),
    );
    assert.deepEqual(eff, {
      blockSeverity: "warning",
      surfaceSeverity: "warning",
    });
  });

  test("repo 'info' under org 'warning' -> {info, info}", () => {
    const eff = tightenSeverityPolicy(
      toleranceToPolicy("warning"),
      toleranceToPolicy("info"),
    );
    assert.deepEqual(eff, { blockSeverity: "info", surfaceSeverity: "info" });
  });
});

describe("corrupt org value fuzz — treated as absent (fail open, seeded)", () => {
  const TRIALS = 300;
  const GARBAGE: Array<string | null | undefined> = [
    "",
    "bogus",
    "owner",
    "Member",
    "OWNERX",
    " OWNER",
    "OWNER ",
    "null",
    "undefined",
    "0",
    "NaN",
    null,
    undefined,
  ];

  test(`${TRIALS} seeded trials: any unrecognized org value resolves as if org were absent`, () => {
    const rng = makeRng(0xc0ffee01);
    for (let i = 0; i < TRIALS; i++) {
      const garbage = GARBAGE[Math.floor(rng() * GARBAGE.length)];
      const repoTrust = ALL_TRUST[Math.floor(rng() * ALL_TRUST.length)];
      const withGarbage = resolveComposedTrustedAuthorThreshold(
        garbage === null || garbage === undefined
          ? garbage
          : { trustedAuthorThreshold: garbage },
        { trustedAuthorThreshold: repoTrust },
      );
      const withAbsent = resolveComposedTrustedAuthorThreshold(undefined, {
        trustedAuthorThreshold: repoTrust,
      });
      assert.equal(
        withGarbage,
        withAbsent,
        `trial=${i}: garbage=${JSON.stringify(garbage)} repo=${repoTrust} -> ${withGarbage} != absent-org result ${withAbsent}`,
      );
    }
  });
});
