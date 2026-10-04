import { describe, expect, it } from "vitest";

import {
  BATTERY_PACK_IDS,
  BATTERY_PACK_LABELS,
  DEFAULT_REVIEW_MODE,
  REVIEW_AGENT_FIELDS,
  REVIEW_BATTERY_PACK_IDS,
  REVIEW_COMMAND_TIMEOUT_S_MAX,
  REVIEW_COMMAND_TIMEOUT_S_MIN,
  REVIEW_MAX_TURNS_MAX,
  REVIEW_MAX_TURNS_MIN,
  REVIEW_MODES,
  findReviewAgentFieldError,
  isBatteryPackId,
  isReviewBatteryPackId,
  isReviewMode,
} from "./review-agent-settings";

describe("review-agent settings constants", () => {
  it("pins the locked values and ranges", () => {
    expect(REVIEW_MODES).toEqual(["classic", "orchestrated"]);
    expect(DEFAULT_REVIEW_MODE).toBe("classic");
    expect(REVIEW_BATTERY_PACK_IDS).toEqual([
      "gstack-review",
      "somnio-review",
      "gsd-reviewers",
    ]);
    expect(REVIEW_COMMAND_TIMEOUT_S_MIN).toBe(60);
    expect(REVIEW_COMMAND_TIMEOUT_S_MAX).toBe(600);
    expect(REVIEW_MAX_TURNS_MIN).toBe(1);
    expect(REVIEW_MAX_TURNS_MAX).toBe(500);
    expect(REVIEW_AGENT_FIELDS).toEqual([
      "reviewMode",
      "reviewBatteries",
      "reviewRunTests",
      "reviewCommandTimeoutS",
      "reviewMaxTurns",
    ]);
  });
});

describe("isReviewMode", () => {
  it("accepts the two modes", () => {
    expect(isReviewMode("classic")).toBe(true);
    expect(isReviewMode("orchestrated")).toBe(true);
  });

  it.each(["Classic", "", null, 1, undefined])("rejects %j", (value) => {
    expect(isReviewMode(value)).toBe(false);
  });
});

describe("isReviewBatteryPackId", () => {
  it.each(["gstack-review", "somnio-review", "gsd-reviewers"])(
    "accepts %s",
    (value) => {
      expect(isReviewBatteryPackId(value)).toBe(true);
    },
  );

  it.each(["gstack", "GSTACK-REVIEW", 3])("rejects %j", (value) => {
    expect(isReviewBatteryPackId(value)).toBe(false);
  });
});

describe("BATTERY_PACK_IDS (phase 7)", () => {
  it("lists every manifest pack, review packs first, in manifest order", () => {
    expect(BATTERY_PACK_IDS).toEqual([
      "gstack-review",
      "somnio-review",
      "gsd-reviewers",
      "somnio-skills",
    ]);
  });

  it("keeps REVIEW_BATTERY_PACK_IDS unchanged as its first three entries", () => {
    expect(REVIEW_BATTERY_PACK_IDS).toHaveLength(3);
    expect(BATTERY_PACK_IDS.slice(0, 3)).toEqual([...REVIEW_BATTERY_PACK_IDS]);
  });

  it("isBatteryPackId accepts every id and rejects anything else", () => {
    for (const id of BATTERY_PACK_IDS) {
      expect(isBatteryPackId(id)).toBe(true);
    }
    expect(isBatteryPackId("nope")).toBe(false);
    expect(isBatteryPackId(4)).toBe(false);
  });

  it("does not widen the review setting", () => {
    expect(isReviewBatteryPackId("somnio-skills")).toBe(false);
    expect(
      findReviewAgentFieldError({ reviewBatteries: ["somnio-skills"] }),
    ).toContain("somnio-skills");
  });

  it("labels every pack", () => {
    for (const id of BATTERY_PACK_IDS) {
      expect(BATTERY_PACK_LABELS[id].trim()).not.toBe("");
    }
    expect(BATTERY_PACK_LABELS["somnio-skills"]).toBe(
      "Somnio skills (DORA, health, security)",
    );
  });
});

describe("findReviewAgentFieldError", () => {
  it("accepts an empty patch", () => {
    expect(findReviewAgentFieldError({})).toBeUndefined();
  });

  it("accepts null for every field (null = inherit)", () => {
    expect(
      findReviewAgentFieldError({
        reviewMode: null,
        reviewBatteries: null,
        reviewRunTests: null,
        reviewCommandTimeoutS: null,
        reviewMaxTurns: null,
      }),
    ).toBeUndefined();
  });

  it("ignores keys that are present but undefined", () => {
    expect(
      findReviewAgentFieldError({ reviewMode: undefined }),
    ).toBeUndefined();
  });

  describe("reviewMode", () => {
    it("rejects an unknown mode and names the allowed values", () => {
      const error = findReviewAgentFieldError({ reviewMode: "turbo" });
      expect(error).toContain("reviewMode");
      expect(error).toContain("classic, orchestrated");
    });

    it("rejects a non-string", () => {
      expect(findReviewAgentFieldError({ reviewMode: 5 })).toBeDefined();
    });

    it("accepts a known mode", () => {
      expect(
        findReviewAgentFieldError({ reviewMode: "orchestrated" }),
      ).toBeUndefined();
    });
  });

  describe("reviewBatteries", () => {
    it("accepts an empty list (explicit choice)", () => {
      expect(
        findReviewAgentFieldError({ reviewBatteries: [] }),
      ).toBeUndefined();
    });

    it("accepts known pack ids", () => {
      expect(
        findReviewAgentFieldError({
          reviewBatteries: ["gstack-review", "gsd-reviewers"],
        }),
      ).toBeUndefined();
    });

    it("rejects an unknown pack id and names it", () => {
      const error = findReviewAgentFieldError({ reviewBatteries: ["nope"] });
      expect(error).toContain("reviewBatteries");
      expect(error).toContain("nope");
    });

    it("rejects a duplicate pack id", () => {
      const error = findReviewAgentFieldError({
        reviewBatteries: ["gstack-review", "gstack-review"],
      });
      expect(error).toContain("duplicate");
    });

    it("rejects a non-array", () => {
      expect(
        findReviewAgentFieldError({ reviewBatteries: "gstack-review" }),
      ).toBeDefined();
    });

    it("rejects a non-string element", () => {
      expect(findReviewAgentFieldError({ reviewBatteries: [1] })).toBeDefined();
    });
  });

  describe("reviewRunTests", () => {
    it.each([true, false])("accepts %s", (value) => {
      expect(
        findReviewAgentFieldError({ reviewRunTests: value }),
      ).toBeUndefined();
    });

    it("rejects a string", () => {
      expect(
        findReviewAgentFieldError({ reviewRunTests: "true" }),
      ).toBeDefined();
    });
  });

  describe("reviewCommandTimeoutS", () => {
    it.each([60, 600])("accepts the bound %s", (value) => {
      expect(
        findReviewAgentFieldError({ reviewCommandTimeoutS: value }),
      ).toBeUndefined();
    });

    it.each([59, 601, 120.5, "120", Number.NaN])("rejects %j", (value) => {
      const error = findReviewAgentFieldError({ reviewCommandTimeoutS: value });
      expect(error).toContain("reviewCommandTimeoutS");
      expect(error).toContain("60");
      expect(error).toContain("600");
    });
  });

  describe("reviewMaxTurns", () => {
    it.each([1, 500])("accepts the bound %s", (value) => {
      expect(
        findReviewAgentFieldError({ reviewMaxTurns: value }),
      ).toBeUndefined();
    });

    it.each([0, 501, 2.5])("rejects %j", (value) => {
      const error = findReviewAgentFieldError({ reviewMaxTurns: value });
      expect(error).toContain("reviewMaxTurns");
      expect(error).toContain("1");
      expect(error).toContain("500");
    });
  });

  it("ignores unrelated keys", () => {
    expect(
      findReviewAgentFieldError({ supersedePolicy: "junk" }),
    ).toBeUndefined();
  });
});
