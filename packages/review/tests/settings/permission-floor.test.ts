/**
 * ADR-005 §2 worked cases (verbatim) + boundary cases for the permission-mode
 * floor. Complements permission-floor.property.test.ts's exhaustive sweep.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  capPermissionMode,
  defaultPermissionMode,
  resolvePermissionMode,
  type PermissionContext,
} from "../../src/settings/permission-floor";

describe("ADR-005 §2 worked cases, verbatim", () => {
  test("trusted-internal PR configured allowAll -> allowAll", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "MEMBER" },
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(resolvePermissionMode("allowAll", ctx), "allowAll");
  });

  test("trusted-internal PR unconfigured -> review (default holds)", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "MEMBER" },
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(resolvePermissionMode(undefined, ctx), "review");
    assert.equal(defaultPermissionMode(ctx), "review");
  });

  test("untrusted PR configured allowAll -> review", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: true, authorAssociation: "MEMBER" },
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(resolvePermissionMode("allowAll", ctx), "review");
  });
});

describe("COLLABORATOR boundary at configured T_eff", () => {
  test("COLLABORATOR is trusted when T_eff = COLLABORATOR", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "COLLABORATOR" },
      trustedAuthorThreshold: "COLLABORATOR",
    };
    assert.equal(capPermissionMode(ctx), "allowAll");
    assert.equal(resolvePermissionMode("allowAll", ctx), "allowAll");
  });

  test("COLLABORATOR is untrusted when T_eff = MEMBER (default)", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "COLLABORATOR" },
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(capPermissionMode(ctx), "review");
    assert.equal(resolvePermissionMode("allowAll", ctx), "review");
  });

  test("CONTRIBUTOR just below COLLABORATOR threshold stays untrusted", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "CONTRIBUTOR" },
      trustedAuthorThreshold: "COLLABORATOR",
    };
    assert.equal(capPermissionMode(ctx), "review");
  });
});

describe("garbage authorAssociation -> untrusted", () => {
  test("an unrecognized authorAssociation string caps to review", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "NOT_A_REAL_ASSOCIATION" },
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(capPermissionMode(ctx), "review");
  });

  test("empty-string authorAssociation caps to review", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: { isFork: false, authorAssociation: "" },
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(capPermissionMode(ctx), "review");
  });
});

describe("missing trust context fails closed", () => {
  test("trust === null caps to review even for a non-fork PR context shape", () => {
    const ctx: PermissionContext = {
      isPrFamily: true,
      trust: null,
      trustedAuthorThreshold: "MEMBER",
    };
    assert.equal(capPermissionMode(ctx), "review");
    assert.equal(resolvePermissionMode("allowAll", ctx), "review");
  });
});
