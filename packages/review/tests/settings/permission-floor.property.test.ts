/**
 * Property tests for the permission-mode floor (ADR-005 §2/§3).
 *
 * Exhaustive enumeration over (configured × isPrFamily × isFork ×
 * authorAssociation × trustedAuthorThreshold) — the state space is small
 * enough (4 configured values including undefined × 2 × 2 × 6 × 6 = 576) to
 * enumerate rather than sample, mirroring
 * `../../tests/settings/posture-lattice.property.test.ts`.
 *
 * node:test + node:assert/strict, no fast-check (matches the package's
 * existing property-test style — see posture-lattice.property.test.ts).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  PERMISSION_ORDER,
  privilege,
  tightenPermissionMode,
  capPermissionMode,
  defaultPermissionMode,
  resolvePermissionMode,
  type PermissionMode,
  type PermissionContext,
} from "../../src/settings/permission-floor";
import {
  TRUST_ORDER,
  type TrustedAuthorThreshold,
} from "../../src/settings/posture-lattice";

const ALL_MODES: readonly PermissionMode[] = PERMISSION_ORDER;
const CONFIGURED: readonly (PermissionMode | undefined)[] = [
  undefined,
  ...ALL_MODES,
];
const ALL_TRUST: readonly TrustedAuthorThreshold[] = TRUST_ORDER;

function contexts(): PermissionContext[] {
  const out: PermissionContext[] = [];
  for (const isPrFamily of [true, false]) {
    for (const isFork of [true, false]) {
      for (const authorAssociation of ALL_TRUST) {
        for (const trustedAuthorThreshold of ALL_TRUST) {
          out.push({
            isPrFamily,
            trust: { isFork, authorAssociation },
            trustedAuthorThreshold,
          });
        }
      }
    }
  }
  // Plus the null-trust (fail-closed) case, for both isPrFamily values.
  for (const isPrFamily of [true, false]) {
    for (const trustedAuthorThreshold of ALL_TRUST) {
      out.push({ isPrFamily, trust: null, trustedAuthorThreshold });
    }
  }
  return out;
}

describe("privilege / PERMISSION_ORDER", () => {
  test("review=0, plan=1, allowAll=2", () => {
    assert.equal(privilege("review"), 0);
    assert.equal(privilege("plan"), 1);
    assert.equal(privilege("allowAll"), 2);
  });
});

describe("tightenPermissionMode — algebraic laws (exhaustive over 3 modes)", () => {
  test("idempotent", () => {
    for (const m of ALL_MODES) assert.equal(tightenPermissionMode(m, m), m);
  });
  test("commutative", () => {
    for (const a of ALL_MODES)
      for (const b of ALL_MODES)
        assert.equal(tightenPermissionMode(a, b), tightenPermissionMode(b, a));
  });
  test("associative", () => {
    for (const a of ALL_MODES)
      for (const b of ALL_MODES)
        for (const c of ALL_MODES) {
          const left = tightenPermissionMode(tightenPermissionMode(a, b), c);
          const right = tightenPermissionMode(a, tightenPermissionMode(b, c));
          assert.equal(left, right, `a=${a} b=${b} c=${c}`);
        }
  });
});

describe("cap_eff monotone under added scopeCaps", () => {
  test("adding more scopeCaps never raises resolvePermissionMode's result", () => {
    for (const ctx of contexts()) {
      for (const configured of CONFIGURED) {
        const noExtraCaps = resolvePermissionMode(configured, ctx, []);
        for (const extra of ALL_MODES) {
          const withExtraCap = resolvePermissionMode(configured, ctx, [extra]);
          assert.ok(
            privilege(withExtraCap) <= privilege(noExtraCaps),
            `ctx=${JSON.stringify(ctx)} configured=${configured} extra=${extra}`,
          );
        }
      }
    }
  });
});

describe("privilege(effective) <= privilege(cap_eff) over ALL enumerated tuples", () => {
  test("exhaustive over (configured x isPrFamily x isFork x authorAssociation x T_eff)", () => {
    for (const ctx of contexts()) {
      const cap = capPermissionMode(ctx);
      for (const configured of CONFIGURED) {
        const effective = resolvePermissionMode(configured, ctx);
        assert.ok(
          privilege(effective) <= privilege(cap),
          `ctx=${JSON.stringify(ctx)} configured=${configured} effective=${effective} cap=${cap}`,
        );
      }
    }
  });
});

describe("untrusted PR content -> review regardless of configured value", () => {
  test("fork PR: effective === review for every configured mode", () => {
    for (const trustedAuthorThreshold of ALL_TRUST) {
      const ctx: PermissionContext = {
        isPrFamily: true,
        trust: { isFork: true, authorAssociation: "OWNER" },
        trustedAuthorThreshold,
      };
      for (const configured of CONFIGURED) {
        assert.equal(resolvePermissionMode(configured, ctx), "review");
      }
    }
  });

  test("author below T_eff: effective === review for every configured mode", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "NONE" },
      trustedAuthorThreshold: "MEMBER",
    };
    for (const configured of CONFIGURED) {
      assert.equal(resolvePermissionMode(configured, ctx), "review");
    }
  });

  test("trust === null (fail-closed): effective === review for every configured mode", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: null,
      trustedAuthorThreshold: "MEMBER",
    };
    for (const configured of CONFIGURED) {
      assert.equal(resolvePermissionMode(configured, ctx), "review");
    }
  });

  test("garbage authorAssociation: effective === review for every configured mode", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "bogus-value" },
      trustedAuthorThreshold: "MEMBER",
    };
    for (const configured of CONFIGURED) {
      assert.equal(resolvePermissionMode(configured, ctx), "review");
    }
  });
});

describe("non-PR family — uncapped, AC4 regression", () => {
  test("cap is always allowAll for non-PR-family contexts", () => {
    for (const trust of [null, { isFork: false, authorAssociation: "NONE" }]) {
      for (const trustedAuthorThreshold of ALL_TRUST) {
        const ctx: PermissionContext = {
          isPrFamily: false,
          trust,
          trustedAuthorThreshold,
        };
        assert.equal(capPermissionMode(ctx), "allowAll");
      }
    }
  });

  test("unconfigured non-PR -> allowAll (today's default, unchanged)", () => {
    const ctx: PermissionContext = {
      isPrFamily: false,
      trust: null,
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(defaultPermissionMode(ctx), "allowAll");
    assert.equal(resolvePermissionMode(undefined, ctx), "allowAll");
  });

  test("configured plan/review on non-PR reaches the daemon at that mode", () => {
    const ctx: PermissionContext = {
      isPrFamily: false,
      trust: null,
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(resolvePermissionMode("plan", ctx), "plan");
    assert.equal(resolvePermissionMode("review", ctx), "review");
  });
});

describe("trusted-internal PR — worked cases (ADR-005 §2, verbatim)", () => {
  const trustedCtx: PermissionContext = {
    isPrFamily: true,
    trust: { isFork: false, authorAssociation: "MEMBER" },
    trustedAuthorThreshold: "MEMBER",
  };

  test("configured allowAll -> min(allowAll, cap=allowAll) = allowAll", () => {
    assert.equal(resolvePermissionMode("allowAll", trustedCtx), "allowAll");
  });

  test("unconfigured -> min(review, allowAll) = review (default holds)", () => {
    assert.equal(resolvePermissionMode(undefined, trustedCtx), "review");
  });
});

describe("untrusted PR — worked case (ADR-005 §2, verbatim)", () => {
  test("configured allowAll -> min(allowAll, cap=review) = review (pinned)", () => {
    const untrustedCtx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: true, authorAssociation: "OWNER" },
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(resolvePermissionMode("allowAll", untrustedCtx), "review");
  });
});
