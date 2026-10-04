import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { DB } from "@terragon/shared/db";
import type { RepoReviewSetting } from "@terragon/shared/db/types";

const getFeatureFlag = vi.hoisted(() => vi.fn());
vi.mock("@terragon/shared/model/feature-flags", () => ({ getFeatureFlag }));

import {
  isSelfHealLoopEnabled,
  resolveSelfHealEffective,
  resolveSelfHealFromRows,
  type SelfHealEffectiveInput,
  type SelfHealEffectiveReason,
} from "./resolve-self-heal";

const ORG = "org-1";

function row(
  repoFullName: string,
  overrides: Partial<RepoReviewSetting> = {},
): RepoReviewSetting {
  return {
    repoFullName,
    selfHealMode: null,
    selfHealKillSwitch: null,
    selfHealMaxOpenIssues: null,
    selfHealMaxAttempts: null,
    selfHealCooldownMin: null,
    selfHealMinSeverity: null,
    selfHealAutoLabel: null,
    selfHealAbsentAudits: null,
    selfHealMaxDiffLines: null,
    selfHealPrExpiryDays: null,
    selfHealRunWindow: null,
    ...overrides,
  } as RepoReviewSetting;
}

function resolve(repo?: RepoReviewSetting, orgDefault?: RepoReviewSetting) {
  return resolveSelfHealFromRows({ organizationId: ORG, repo, orgDefault });
}

describe("resolveSelfHealFromRows", () => {
  it("no rows resolves the defaults with mode off", () => {
    const r = resolve();
    expect(r.settings.mode).toBe("off");
    expect(r.settings.maxOpenIssues).toBe(3);
    expect(r.killed).toBe(false);
    expect(r.invalid).toBeUndefined();
  });

  it("'*' on with a null repo row resolves on", () => {
    const r = resolve(row("a/b"), row("*", { selfHealMode: "on" }));
    expect(r.settings.mode).toBe("on");
  });

  it("a repo dry-run beats a '*' on", () => {
    const r = resolve(
      row("a/b", { selfHealMode: "dry-run" }),
      row("*", { selfHealMode: "on" }),
    );
    expect(r.settings.mode).toBe("dry-run");
  });

  it("mixes fields per row", () => {
    const r = resolve(
      row("a/b", { selfHealMaxAttempts: 4 }),
      row("*", {
        selfHealMode: "on",
        selfHealMaxAttempts: 1,
        selfHealCooldownMin: 5,
      }),
    );
    expect(r.settings).toMatchObject({
      mode: "on",
      maxAttempts: 4,
      cooldownMin: 5,
    });
  });

  it("the '*' kill switch wins over a repo on", () => {
    const r = resolve(
      row("a/b", { selfHealMode: "on" }),
      row("*", { selfHealKillSwitch: true }),
    );
    expect(r.killed).toBe(true);
    expect(r.settings.killSwitch).toBe(true);
  });

  it("a kill switch on a repo row is ignored", () => {
    const r = resolve(row("a/b", { selfHealKillSwitch: true }), row("*"));
    expect(r.killed).toBe(false);
  });

  it("an invalid winning value resolves off and names the row and field", () => {
    const r = resolve(
      row("a/b", { selfHealMode: "auto" as never }),
      row("*", { selfHealMode: "on" }),
    );
    expect(r.settings.mode).toBe("off");
    expect(r.invalid).toContain("a/b");
    expect(r.invalid).toContain("selfHealMode");
  });

  it("an invalid value on the losing row is ignored", () => {
    const r = resolve(
      row("a/b", { selfHealMode: "dry-run" }),
      row("*", { selfHealMode: "auto" as never }),
    );
    expect(r.invalid).toBeUndefined();
    expect(r.settings.mode).toBe("dry-run");
  });
});

function input(
  overrides: Partial<SelfHealEffectiveInput> = {},
  mode: "off" | "dry-run" | "on" = "on",
): SelfHealEffectiveInput {
  return {
    flagEnabled: true,
    sideEffectsEnabled: true,
    shadow: false,
    resolved: resolve(row("a/b"), row("*", { selfHealMode: mode })),
    breakers: {
      permissionLatched: false,
      loopAuditOpen: false,
      loopFixOpen: false,
    },
    ...overrides,
  };
}

describe("resolveSelfHealEffective", () => {
  it("all clear and protected is on", () => {
    expect(resolveSelfHealEffective(input())).toEqual({
      mode: "on",
      reason: "on",
      fixAllowed: true,
    });
  });

  it("flag off beats everything", () => {
    const r = resolveSelfHealEffective(
      input({
        flagEnabled: false,
        sideEffectsEnabled: false,
        breakers: {
          permissionLatched: true,
          loopAuditOpen: true,
          loopFixOpen: true,
        },
      }),
    );
    expect(r).toMatchObject({ mode: "off", reason: "flag_off" });
  });

  it("side effects disabled with mode on is dry-run", () => {
    expect(
      resolveSelfHealEffective(input({ sideEffectsEnabled: false })),
    ).toMatchObject({ mode: "dry-run", reason: "side_effects_disabled" });
  });

  it("the kill switch overrides closed breakers", () => {
    const resolved = resolve(
      row("a/b"),
      row("*", { selfHealMode: "on", selfHealKillSwitch: true }),
    );
    expect(resolveSelfHealEffective(input({ resolved }))).toMatchObject({
      mode: "off",
      reason: "killed",
    });
  });

  it("invalid settings fail closed", () => {
    const resolved = resolve(row("a/b", { selfHealMode: "x" as never }));
    expect(resolveSelfHealEffective(input({ resolved }))).toMatchObject({
      mode: "off",
      reason: "invalid_settings",
    });
  });

  it("an open permission latch fails closed", () => {
    expect(
      resolveSelfHealEffective(
        input({
          breakers: {
            permissionLatched: true,
            loopAuditOpen: false,
            loopFixOpen: false,
          },
        }),
      ),
    ).toMatchObject({ mode: "off", reason: "missing_permission" });
  });

  it("loop_audit open downgrades on to dry-run", () => {
    expect(
      resolveSelfHealEffective(
        input({
          breakers: {
            permissionLatched: false,
            loopAuditOpen: true,
            loopFixOpen: false,
          },
        }),
      ),
    ).toMatchObject({ mode: "dry-run", reason: "loop_audit_open" });
  });

  it("loop_fix open keeps the mode but blocks fixes", () => {
    expect(
      resolveSelfHealEffective(
        input({
          breakers: {
            permissionLatched: false,
            loopAuditOpen: false,
            loopFixOpen: true,
          },
        }),
      ),
    ).toEqual({ mode: "on", reason: "on", fixAllowed: false });
  });

  it("on mode needs no branch protection (free-plan repos can turn it on)", () => {
    expect(resolveSelfHealEffective(input())).toEqual({
      mode: "on",
      reason: "on",
      fixAllowed: true,
    });
  });

  it("branch protection is never a resolver input or reason", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "resolve-self-heal.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/unprotected|protection_unknown|protection:/);
  });

  it("a breaker never turns anything on", () => {
    const r = resolveSelfHealEffective(input({}, "off"));
    expect(r).toMatchObject({ mode: "off", reason: "mode_off" });
  });

  describe("pairwise ordering: the earlier rule always wins", () => {
    interface Rule {
      reason: SelfHealEffectiveReason;
      apply: (i: SelfHealEffectiveInput) => SelfHealEffectiveInput;
      modeRule?: "off" | "dry-run";
    }
    const withMode = (
      i: SelfHealEffectiveInput,
      mode: "off" | "dry-run",
    ): SelfHealEffectiveInput => ({
      ...i,
      resolved: {
        ...i.resolved,
        settings: { ...i.resolved.settings, mode },
      },
    });
    const rules: Rule[] = [
      { reason: "flag_off", apply: (i) => ({ ...i, flagEnabled: false }) },
      {
        reason: "side_effects_disabled",
        apply: (i) => ({ ...i, sideEffectsEnabled: false }),
      },
      { reason: "shadow", apply: (i) => ({ ...i, shadow: true }) },
      {
        reason: "killed",
        apply: (i) => ({
          ...i,
          resolved: { ...i.resolved, killed: true },
        }),
      },
      {
        reason: "mode_off",
        modeRule: "off",
        apply: (i) => withMode(i, "off"),
      },
      {
        reason: "missing_permission",
        apply: (i) => ({
          ...i,
          breakers: { ...i.breakers, permissionLatched: true },
        }),
      },
      {
        reason: "loop_audit_open",
        apply: (i) => ({
          ...i,
          breakers: { ...i.breakers, loopAuditOpen: true },
        }),
      },
      {
        reason: "mode_dry_run",
        modeRule: "dry-run",
        apply: (i) => withMode(i, "dry-run"),
      },
    ];

    for (let a = 0; a < rules.length; a++) {
      for (let b = a + 1; b < rules.length; b++) {
        const first = rules[a]!;
        const second = rules[b]!;
        // Mode-defining rules are mutually exclusive in one input.
        if (first.modeRule && second.modeRule) continue;
        it(`${first.reason} beats ${second.reason}`, () => {
          const both = second.apply(first.apply(input()));
          expect(resolveSelfHealEffective(both).reason).toBe(first.reason);
        });
      }
    }
  });
});

describe("isSelfHealLoopEnabled", () => {
  const db = {} as DB;

  it("no flag row is false", async () => {
    getFeatureFlag.mockResolvedValueOnce(undefined);
    expect(await isSelfHealLoopEnabled(db)).toBe(false);
  });

  it("a global override true is true", async () => {
    getFeatureFlag.mockResolvedValueOnce({
      globalOverride: true,
      defaultValue: false,
    });
    expect(await isSelfHealLoopEnabled(db)).toBe(true);
  });

  it("a per-user override is ignored", async () => {
    getFeatureFlag.mockResolvedValueOnce({
      globalOverride: null,
      defaultValue: false,
      userOverride: true,
    });
    expect(await isSelfHealLoopEnabled(db)).toBe(false);
  });
});
