import { describe, expect, it } from "vitest";

import {
  dollarsToMicroUsd,
  draftFromControls,
  draftToPatch,
  knowledgeActionDetail,
  knowledgeActionLabel,
  microUsdToDollars,
  purgeCountdown,
  spendView,
  type KnowledgeControlsDto,
  type KnowledgeSpendDto,
} from "./knowledge-form";

const CONTROLS: KnowledgeControlsDto = {
  engine: false,
  budgetMicroUsd: null,
  effectiveBudgetMicroUsd: 100_000_000,
  ceilingMicroUsd: 50_000_000,
  offboardedAt: null,
  purgeAfter: null,
  purgedAt: null,
  enabled: false,
  gateReason: "engine_off",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const ADMIN = { isOrgAdmin: true, isPlatformAdmin: false };

function spend(over: Partial<KnowledgeSpendDto> = {}): KnowledgeSpendDto {
  return {
    windowStart: "2026-10-01T00:00:00.000Z",
    capMicroUsd: 100_000_000,
    reservedMicroUsd: 0,
    spentMicroUsd: 0,
    remainingMicroUsd: 100_000_000,
    atCap: false,
    capAlertedAt: null,
    ...over,
  };
}

describe("dollarsToMicroUsd", () => {
  it("parses whole and fractional dollars exactly", () => {
    expect(dollarsToMicroUsd("20")).toEqual({ value: 20_000_000 });
    expect(dollarsToMicroUsd("0.5")).toEqual({ value: 500_000 });
    expect(dollarsToMicroUsd("0.000001")).toEqual({ value: 1 });
  });
  it("treats empty as the platform default", () => {
    expect(dollarsToMicroUsd("")).toEqual({ value: null });
  });
  it.each(["-1", "abc", "1e3x", "1.1234567", "1.", ".5"])(
    "rejects %s",
    (text) => {
      const r = dollarsToMicroUsd(text);
      expect("error" in r && r.error.field).toBe("budget");
    },
  );
});

describe("microUsdToDollars", () => {
  it("formats with two decimals, half up", () => {
    expect(microUsdToDollars(20_000_000)).toBe("20.00");
    expect(microUsdToDollars(1_234_567)).toBe("1.23");
    expect(microUsdToDollars(1_235_000)).toBe("1.24");
  });
});

describe("draftToPatch", () => {
  it("returns an empty patch for an unchanged draft", () => {
    expect(draftToPatch(draftFromControls(CONTROLS), CONTROLS, ADMIN)).toEqual({
      patch: {},
    });
  });
  it("returns only changed fields", () => {
    expect(draftToPatch({ engine: true, budget: "" }, CONTROLS, ADMIN)).toEqual(
      { patch: { engine: true } },
    );
    expect(
      draftToPatch({ engine: false, budget: "20" }, CONTROLS, ADMIN),
    ).toEqual({ patch: { budgetMicroUsd: 20_000_000 } });
  });
  it("keeps an exact stored budget unchanged through the draft", () => {
    const c = { ...CONTROLS, budgetMicroUsd: 1_234_567 };
    expect(draftToPatch(draftFromControls(c), c, ADMIN)).toEqual({ patch: {} });
  });
  it("blocks a budget above the ceiling for non-platform admins", () => {
    const r = draftToPatch({ engine: false, budget: "60" }, CONTROLS, ADMIN);
    expect(r).toEqual({
      error: {
        field: "budget",
        message: "Above the platform ceiling of $50.00. Ask a platform admin.",
      },
    });
  });
  it("allows it for platform admins", () => {
    const viewer = { isOrgAdmin: false, isPlatformAdmin: true };
    expect(
      draftToPatch({ engine: false, budget: "60" }, CONTROLS, viewer),
    ).toEqual({ patch: { budgetMicroUsd: 60_000_000 } });
  });
  it("allows lowering a value that is above the ceiling", () => {
    const c = { ...CONTROLS, budgetMicroUsd: 80_000_000 };
    expect(draftToPatch({ engine: false, budget: "70" }, c, ADMIN)).toEqual({
      patch: { budgetMicroUsd: 70_000_000 },
    });
  });
  it("never sends engine for a non-org-admin", () => {
    const viewer = { isOrgAdmin: false, isPlatformAdmin: true };
    expect(
      draftToPatch({ engine: true, budget: "10" }, CONTROLS, viewer),
    ).toEqual({ patch: { budgetMicroUsd: 10_000_000 } });
  });
  it("surfaces a parse error", () => {
    const r = draftToPatch({ engine: false, budget: "x" }, CONTROLS, ADMIN);
    expect("error" in r).toBe(true);
  });
});

describe("spendView", () => {
  it("computes percent used including reserved", () => {
    expect(
      spendView(
        spend({ spentMicroUsd: 20_000_000, reservedMicroUsd: 5_000_000 }),
      ),
    ).toEqual({ percentUsed: 25, paused: false });
  });
  it("clamps to 100", () => {
    expect(spendView(spend({ spentMicroUsd: 500_000_000 })).percentUsed).toBe(
      100,
    );
  });
  it("is paused at cap or after a cap alert", () => {
    expect(spendView(spend({ atCap: true })).paused).toBe(true);
    expect(
      spendView(spend({ capAlertedAt: "2026-10-05T00:00:00.000Z" })).paused,
    ).toBe(true);
  });
  it("treats a zero cap as 100% and paused", () => {
    expect(spendView(spend({ capMicroUsd: 0 }))).toEqual({
      percentUsed: 100,
      paused: true,
    });
  });
});

describe("purgeCountdown", () => {
  it("counts whole days remaining, never negative", () => {
    const now = new Date("2026-10-01T00:00:00.000Z");
    expect(purgeCountdown("2026-10-08T00:00:00.000Z", now)).toBe(7);
    expect(purgeCountdown("2026-09-01T00:00:00.000Z", now)).toBe(0);
  });
});

describe("action labels", () => {
  it("labels the stored enums", () => {
    expect(knowledgeActionLabel("engine_toggle")).toBe("Engine toggled");
    expect(knowledgeActionLabel("offboard_undo")).toBe("Offboarding undone");
  });
  it("renders only from/to primitives", () => {
    expect(
      knowledgeActionDetail("engine_toggle", {
        from: false,
        to: true,
        via: "x",
      }),
    ).toBe("Off to On");
    expect(
      knowledgeActionDetail("budget_change", {
        fromMicroUsd: null,
        toMicroUsd: 20_000_000,
      }),
    ).toBe("default to $20.00");
    expect(knowledgeActionDetail("offboard", { engineWas: true })).toBeNull();
  });
});
