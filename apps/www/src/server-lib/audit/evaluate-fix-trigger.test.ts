import { describe, expect, it } from "vitest";

import { SELF_HEAL_DEFAULTS } from "@terragon/shared/model/self-heal-settings";

import {
  evaluateFixTrigger,
  FIX_TRIGGER_PRECEDENCE,
  type FixTriggerInput,
  type FixTriggerRefusal,
} from "./evaluate-fix-trigger";
import type { ResolvedSelfHeal } from "./resolve-self-heal";

const NOW = new Date("2026-10-04T03:00:00.000Z");
const MIN = 60_000;

function base(): FixTriggerInput {
  const settings: ResolvedSelfHeal = {
    ...SELF_HEAL_DEFAULTS,
    mode: "on",
    runWindow: "02:00-06:00",
    maxAttempts: 2,
    cooldownMin: 360,
  };
  return {
    effective: { mode: "on", reason: "on", fixAllowed: true },
    capabilitiesOk: true,
    breakers: { execPlaneOpen: false, hatchetDispatchOpen: false },
    fixAutomation: { id: "auto-1", userId: "user-1" },
    reviewAutomationMatchesBot: true,
    finding: { attempts: 0, lastAttemptAt: null, activeAttemptId: null },
    settings,
    now: NOW,
  };
}

type Mutation = (input: FixTriggerInput) => FixTriggerInput;

/** One minimal input change per refusal (claim_refused is the CAS, not here). */
const MUTATIONS: Record<
  Exclude<FixTriggerRefusal, "claim_refused">,
  Mutation
> = {
  flag_off: (i) => ({
    ...i,
    effective: { mode: "off", reason: "flag_off", fixAllowed: false },
  }),
  killed: (i) => ({ ...i, settings: { ...i.settings, killSwitch: true } }),
  mode_off: (i) => ({
    ...i,
    effective: { ...i.effective, mode: "off", reason: "mode_off" },
    settings: { ...i.settings, mode: "off" },
  }),
  dry_run: (i) => ({
    ...i,
    effective: { ...i.effective, mode: "dry-run", reason: "mode_dry_run" },
    settings: { ...i.settings, mode: "dry-run" },
  }),
  shadow: (i) => ({
    ...i,
    effective: { ...i.effective, mode: "dry-run", reason: "shadow" },
  }),
  side_effects_disabled: (i) => ({
    ...i,
    effective: {
      ...i.effective,
      mode: "dry-run",
      reason: "side_effects_disabled",
    },
  }),
  missing_permission: (i) => ({ ...i, capabilitiesOk: false }),
  loop_fix_open: (i) => ({
    ...i,
    effective: { ...i.effective, fixAllowed: false },
  }),
  exec_plane_open: (i) => ({
    ...i,
    breakers: { ...i.breakers, execPlaneOpen: true },
  }),
  hatchet_dispatch_open: (i) => ({
    ...i,
    breakers: { ...i.breakers, hatchetDispatchOpen: true },
  }),
  outside_run_window: (i) => ({
    ...i,
    settings: { ...i.settings, runWindow: "10:00-11:00" },
  }),
  no_fix_automation: (i) => ({ ...i, fixAutomation: null }),
  no_review_automation: (i) => ({ ...i, reviewAutomationMatchesBot: false }),
  attempts_cap: (i) => ({ ...i, finding: { ...i.finding, attempts: 2 } }),
  cooldown: (i) => ({
    ...i,
    finding: { ...i.finding, lastAttemptAt: new Date(NOW.getTime() - MIN) },
  }),
  active_attempt: (i) => ({
    ...i,
    finding: { ...i.finding, activeAttemptId: "att-0" },
  }),
};

/** Mode-level refusals are one precedence tier (one effective reason at a time). */
const MODE_TIER: readonly FixTriggerRefusal[] = [
  "mode_off",
  "dry_run",
  "shadow",
  "side_effects_disabled",
];

describe("evaluateFixTrigger", () => {
  it("all guards satisfied → ok", () => {
    expect(evaluateFixTrigger(base())).toEqual({ ok: true });
  });

  for (const [reason, mutate] of Object.entries(MUTATIONS)) {
    it(`reaches ${reason} with a minimal input`, () => {
      const result = evaluateFixTrigger(mutate(base()));
      expect(result).toMatchObject({ ok: false, reason });
    });
  }

  it("the precedence list names every refusal except claim_refused", () => {
    expect([...FIX_TRIGGER_PRECEDENCE].sort()).toEqual(
      Object.keys(MUTATIONS).sort(),
    );
  });

  it("pairwise: the earlier refusal in the precedence always wins", () => {
    const order = FIX_TRIGGER_PRECEDENCE;
    let pairs = 0;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const hi = order[i] as keyof typeof MUTATIONS;
        const lo = order[j] as keyof typeof MUTATIONS;
        // Two mode reasons cannot hold at once: they share one tier.
        if (MODE_TIER.includes(hi) && MODE_TIER.includes(lo)) continue;
        // Apply the lower one first, so the higher one's fields win.
        const input = MUTATIONS[hi](MUTATIONS[lo](base()));
        const result = evaluateFixTrigger(input);
        expect(result, `${hi} over ${lo}`).toMatchObject({
          ok: false,
          reason: hi,
        });
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(100);
  });

  it("precedence pins the documented order", () => {
    expect(FIX_TRIGGER_PRECEDENCE).toEqual([
      "flag_off",
      "killed",
      "mode_off",
      "dry_run",
      "shadow",
      "side_effects_disabled",
      "missing_permission",
      "loop_fix_open",
      "exec_plane_open",
      "hatchet_dispatch_open",
      "outside_run_window",
      "no_fix_automation",
      "no_review_automation",
      "attempts_cap",
      "cooldown",
      "active_attempt",
    ]);
  });

  it("wouldDispatch is true only for dry_run, shadow and side_effects_disabled", () => {
    for (const [reason, mutate] of Object.entries(MUTATIONS)) {
      const result = evaluateFixTrigger(mutate(base()));
      if (result.ok) throw new Error(`${reason} unexpectedly ok`);
      expect(result.wouldDispatch, reason).toBe(
        ["dry_run", "shadow", "side_effects_disabled"].includes(reason),
      );
    }
  });

  it("REV-01: no review automation matching the bot refuses", () => {
    const result = evaluateFixTrigger({
      ...base(),
      reviewAutomationMatchesBot: false,
    });
    expect(result).toEqual({
      ok: false,
      reason: "no_review_automation",
      wouldDispatch: false,
    });
  });

  it("a breaker-narrowed dry-run (loop_audit open) is a dry run", () => {
    const result = evaluateFixTrigger({
      ...base(),
      effective: {
        mode: "dry-run",
        reason: "loop_audit_open",
        fixAllowed: true,
      },
    });
    expect(result).toMatchObject({ reason: "dry_run", wouldDispatch: true });
  });

  it("a repo in dry-run with a latched permission reports dry_run (mode first)", () => {
    const result = evaluateFixTrigger({
      ...base(),
      effective: {
        mode: "off",
        reason: "missing_permission",
        fixAllowed: false,
      },
      settings: { ...base().settings, mode: "dry-run" },
    });
    expect(result).toMatchObject({ reason: "dry_run" });
  });

  it("a latched permission in mode on is missing_permission", () => {
    const result = evaluateFixTrigger({
      ...base(),
      effective: {
        mode: "off",
        reason: "missing_permission",
        fixAllowed: false,
      },
    });
    expect(result).toMatchObject({ reason: "missing_permission" });
  });

  it("invalid settings resolve to mode_off", () => {
    const result = evaluateFixTrigger({
      ...base(),
      effective: { mode: "off", reason: "invalid_settings", fixAllowed: false },
    });
    expect(result).toMatchObject({ reason: "mode_off" });
  });

  describe("run window (UTC, the repo's resolved window)", () => {
    const at = (iso: string) => new Date(`2026-10-04T${iso}:00.000Z`);
    const window = (runWindow: string, now: Date) =>
      evaluateFixTrigger({
        ...base(),
        settings: { ...base().settings, runWindow },
        now,
      });

    it("inside a same-day window → ok; end is exclusive", () => {
      expect(window("02:00-06:00", at("02:00")).ok).toBe(true);
      expect(window("02:00-06:00", at("05:59")).ok).toBe(true);
      expect(window("02:00-06:00", at("06:00"))).toMatchObject({
        reason: "outside_run_window",
      });
    });

    it("wrap-around window 22:00-04:00 covers both sides of midnight", () => {
      expect(window("22:00-04:00", at("23:30")).ok).toBe(true);
      expect(window("22:00-04:00", at("01:00")).ok).toBe(true);
      expect(window("22:00-04:00", at("12:00"))).toMatchObject({
        reason: "outside_run_window",
      });
    });

    it("a malformed window is closed (fail closed)", () => {
      expect(window("nonsense", at("03:00"))).toMatchObject({
        reason: "outside_run_window",
      });
    });
  });

  it("cooldown ends exactly at cooldownMin after the last attempt", () => {
    const at = (ms: number) =>
      evaluateFixTrigger({
        ...base(),
        finding: {
          attempts: 1,
          lastAttemptAt: new Date(NOW.getTime() - ms),
          activeAttemptId: null,
        },
      });
    expect(at(360 * MIN - 1)).toMatchObject({ reason: "cooldown" });
    expect(at(360 * MIN).ok).toBe(true);
  });

  it("attempts below the cap pass; at the cap refuse", () => {
    const at = (attempts: number) =>
      evaluateFixTrigger({
        ...base(),
        finding: { attempts, lastAttemptAt: null, activeAttemptId: null },
      });
    expect(at(1).ok).toBe(true);
    expect(at(2)).toMatchObject({ reason: "attempts_cap" });
  });
});
