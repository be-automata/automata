import { describe, expect, it } from "vitest";

import {
  SELF_HEAL_CLEAR_PATCH as SHARED_CLEAR_PATCH,
  type SelfHealValues,
} from "@terragon/shared/model/self-heal-settings";
import {
  NO_SELF_HEAL_VALUES,
  SELF_HEAL_CLEAR_PATCH,
  changedSelfHealFields,
  hasSelfHealOverride,
  selfHealDraftFromValues,
  selfHealDraftToPatch,
} from "./self-heal-form";

const FULL: SelfHealValues = {
  selfHealMode: "dry-run",
  selfHealKillSwitch: true,
  selfHealMaxOpenIssues: 5,
  selfHealMaxAttempts: 3,
  selfHealCooldownMin: 0,
  selfHealMinSeverity: "high",
  selfHealAutoLabel: false,
  selfHealAbsentAudits: 4,
  selfHealMaxDiffLines: 500,
  selfHealPrExpiryDays: 10,
  selfHealRunWindow: "22:00-04:00",
};

describe("self-heal form", () => {
  it("round-trips values -> draft -> patch for set fields", () => {
    const result = selfHealDraftToPatch(selfHealDraftFromValues(FULL), {
      scope: "org",
    });
    expect(result).toEqual({ patch: FULL });
  });

  it("maps inherit and empty text to null", () => {
    const result = selfHealDraftToPatch(
      selfHealDraftFromValues(NO_SELF_HEAL_VALUES),
      { scope: "org" },
    );
    expect(result).toEqual({ patch: SELF_HEAL_CLEAR_PATCH });
  });

  it("never carries the kill switch at repo scope", () => {
    const result = selfHealDraftToPatch(selfHealDraftFromValues(FULL), {
      scope: "repo",
    });
    if (!("patch" in result)) throw new Error("expected a patch");
    expect("selfHealKillSwitch" in result.patch).toBe(false);
    expect(result.patch.selfHealMode).toBe("dry-run");
  });

  it.each([
    ["maxOpenIssues", "0", "selfHealMaxOpenIssues"],
    ["maxOpenIssues", "21", "selfHealMaxOpenIssues"],
    ["maxAttempts", "abc", "selfHealMaxAttempts"],
    ["cooldownMin", "-1", "selfHealCooldownMin"],
    ["maxDiffLines", "9", "selfHealMaxDiffLines"],
    ["prExpiryDays", "31", "selfHealPrExpiryDays"],
    ["absentAudits", "1.5", "selfHealAbsentAudits"],
  ] as const)("rejects %s=%s before save", (key, text, field) => {
    const draft = { ...selfHealDraftFromValues(FULL), [key]: text };
    const result = selfHealDraftToPatch(draft, { scope: "org" });
    expect(result).toMatchObject({ error: { field } });
  });

  it.each(["25:00-04:00", "02:00-02:00", "2:00-4:00", "nonsense"])(
    "rejects malformed run window %s",
    (runWindow) => {
      const draft = { ...selfHealDraftFromValues(FULL), runWindow };
      expect(selfHealDraftToPatch(draft, { scope: "org" })).toMatchObject({
        error: { field: "selfHealRunWindow" },
      });
    },
  );

  it("hasSelfHealOverride is false for an all-null row, true otherwise", () => {
    expect(hasSelfHealOverride(NO_SELF_HEAL_VALUES)).toBe(false);
    expect(
      hasSelfHealOverride({ ...NO_SELF_HEAL_VALUES, selfHealAutoLabel: false }),
    ).toBe(true);
  });

  it("changedSelfHealFields keeps only differing fields", () => {
    const result = selfHealDraftToPatch(
      { ...selfHealDraftFromValues(FULL), mode: "on" },
      { scope: "org" },
    );
    if (!("patch" in result)) throw new Error("expected a patch");
    expect(changedSelfHealFields(result.patch, FULL)).toEqual({
      selfHealMode: "on",
    });
  });

  it("re-exports the shared clear patch and has no gate-command or spend key", () => {
    expect(SELF_HEAL_CLEAR_PATCH).toBe(SHARED_CLEAR_PATCH);
    const keys = Object.keys(selfHealDraftFromValues(FULL)).join(" ");
    expect(keys).not.toMatch(/gate|command|spend|cost/i);
  });
});
