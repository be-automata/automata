import { describe, expect, it } from "vitest";

import {
  SELF_HEAL_CLEAR_PATCH,
  SELF_HEAL_FIELDS,
  findSelfHealFieldError,
  isInRunWindow,
  parseRunWindow,
  pickSelfHealFields,
  severityRank,
} from "./self-heal-settings";

const REPO = { isOrgDefaultRow: false };
const ORG = { isOrgDefaultRow: true };

describe("SELF_HEAL_FIELDS", () => {
  it("has exactly the 11 names in order and no gate-command field", () => {
    expect([...SELF_HEAL_FIELDS]).toEqual([
      "selfHealMode",
      "selfHealKillSwitch",
      "selfHealMaxOpenIssues",
      "selfHealMaxAttempts",
      "selfHealCooldownMin",
      "selfHealMinSeverity",
      "selfHealAutoLabel",
      "selfHealAbsentAudits",
      "selfHealMaxDiffLines",
      "selfHealPrExpiryDays",
      "selfHealRunWindow",
    ]);
    expect(SELF_HEAL_FIELDS as readonly string[]).not.toContain(
      "selfHealGateCommands",
    );
  });
});

describe("findSelfHealFieldError", () => {
  it("accepts a known mode and rejects an unknown one", () => {
    expect(findSelfHealFieldError({ selfHealMode: "dry-run" }, REPO)).toBe(
      undefined,
    );
    const error = findSelfHealFieldError({ selfHealMode: "auto" }, REPO);
    expect(error).toContain("selfHealMode");
    expect(error).toContain("off, dry-run, on");
  });

  it("skips null and undefined", () => {
    expect(
      findSelfHealFieldError(
        { selfHealMode: null, selfHealMaxAttempts: undefined },
        REPO,
      ),
    ).toBe(undefined);
  });

  it.each([
    ["selfHealMaxOpenIssues", 1, 20],
    ["selfHealMaxAttempts", 1, 5],
    ["selfHealCooldownMin", 0, 10080],
    ["selfHealAbsentAudits", 1, 5],
    ["selfHealMaxDiffLines", 10, 2000],
    ["selfHealPrExpiryDays", 1, 30],
  ])("bounds %s to %i..%i", (field, min, max) => {
    expect(findSelfHealFieldError({ [field]: min }, REPO)).toBe(undefined);
    expect(findSelfHealFieldError({ [field]: max }, REPO)).toBe(undefined);
    expect(findSelfHealFieldError({ [field]: min - 1 }, REPO)).toContain(field);
    expect(findSelfHealFieldError({ [field]: max + 1 }, REPO)).toContain(field);
    expect(findSelfHealFieldError({ [field]: 2.5 }, REPO)).toContain(field);
    expect(findSelfHealFieldError({ [field]: "3" }, REPO)).toContain(field);
  });

  it("accepts low/medium/high severities only", () => {
    for (const s of ["low", "medium", "high"]) {
      expect(findSelfHealFieldError({ selfHealMinSeverity: s }, REPO)).toBe(
        undefined,
      );
    }
    expect(
      findSelfHealFieldError({ selfHealMinSeverity: "critical" }, REPO),
    ).toContain("selfHealMinSeverity");
  });

  it("requires a boolean for the auto label", () => {
    expect(findSelfHealFieldError({ selfHealAutoLabel: true }, REPO)).toBe(
      undefined,
    );
    expect(
      findSelfHealFieldError({ selfHealAutoLabel: "yes" }, REPO),
    ).toContain("selfHealAutoLabel");
  });

  it("validates the run window", () => {
    expect(
      findSelfHealFieldError({ selfHealRunWindow: "02:00-06:00" }, REPO),
    ).toBe(undefined);
    expect(
      findSelfHealFieldError({ selfHealRunWindow: "22:00-04:00" }, REPO),
    ).toBe(undefined);
    for (const bad of ["06:00-06:00", "24:00-01:00", "2:00-6:00", 600]) {
      expect(
        findSelfHealFieldError({ selfHealRunWindow: bad }, REPO),
      ).toContain("selfHealRunWindow");
    }
  });

  it("keeps the kill switch org-level", () => {
    expect(findSelfHealFieldError({ selfHealKillSwitch: true }, REPO)).toBe(
      "selfHealKillSwitch is an org-level setting; set it on the org default",
    );
    expect(findSelfHealFieldError({ selfHealKillSwitch: true }, ORG)).toBe(
      undefined,
    );
    expect(findSelfHealFieldError({ selfHealKillSwitch: null }, REPO)).toBe(
      undefined,
    );
  });
});

describe("run window", () => {
  it("parses and rejects", () => {
    expect(parseRunWindow("02:00-06:00")).toEqual({
      startMin: 120,
      endMin: 360,
    });
    expect(parseRunWindow("nope")).toBeNull();
  });

  it("is wrap-aware with an exclusive end", () => {
    const at = (hhmm: string) => new Date(`2026-10-04T${hhmm}:00Z`);
    expect(isInRunWindow("22:00-04:00", at("23:30"))).toBe(true);
    expect(isInRunWindow("22:00-04:00", at("05:00"))).toBe(false);
    expect(isInRunWindow("02:00-06:00", at("02:00"))).toBe(true);
    expect(isInRunWindow("02:00-06:00", at("06:00"))).toBe(false);
  });
});

describe("pick / clear / rank", () => {
  it("picks only the 11 keys", () => {
    const row = { id: "x", selfHealMode: "on", selfHealRunWindow: null };
    const picked = pickSelfHealFields(row as never);
    expect(Object.keys(picked).sort()).toEqual([...SELF_HEAL_FIELDS].sort());
  });

  it("clears all 11 to null", () => {
    expect(Object.keys(SELF_HEAL_CLEAR_PATCH)).toHaveLength(11);
    expect(Object.values(SELF_HEAL_CLEAR_PATCH).every((v) => v === null)).toBe(
      true,
    );
  });

  it("orders severities", () => {
    expect(severityRank("low")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("high"));
  });
});
