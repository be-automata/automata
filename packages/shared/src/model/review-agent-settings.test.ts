import { describe, expect, it } from "vitest";

import {
  BATTERY_PACK_IDS,
  BATTERY_PACK_LABELS,
  DEFAULT_REVIEW_MODE,
  DEFAULT_TASK_BATTERIES,
  REVIEW_AGENT_FIELDS,
  REVIEW_BATTERY_PACK_IDS,
  REVIEW_COMMAND_TIMEOUT_S_MAX,
  REVIEW_COMMAND_TIMEOUT_S_MIN,
  REVIEW_MAX_TURNS_MAX,
  REVIEW_MAX_TURNS_MIN,
  REVIEW_MODES,
  REVIEW_ONLY_AGENT_FIELDS,
  TASK_AGENT_FIELD,
  findReviewAgentFieldError,
  isBatteryPackId,
  isReviewBatteryPackId,
  isReviewMode,
  pickReviewAgentFields,
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
      "taskBatteries",
    ]);
  });

  it("names the review-only fields and the task field apart (phase 7)", () => {
    // Review resolution iterates REVIEW_ONLY_AGENT_FIELDS, so a bad task
    // value can never fail a review dispatch.
    expect(REVIEW_ONLY_AGENT_FIELDS).toEqual([
      "reviewMode",
      "reviewBatteries",
      "reviewRunTests",
      "reviewCommandTimeoutS",
      "reviewMaxTurns",
    ]);
    expect(TASK_AGENT_FIELD).toBe("taskBatteries");
    expect(DEFAULT_TASK_BATTERIES).toEqual([]);
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

describe("taskBatteries (phase 7)", () => {
  it.each<[string, unknown]>([
    ["a manifest pack", ["somnio-skills"]],
    ["a review pack", ["gsd-reviewers"]],
    [
      "every pack",
      ["gstack-review", "somnio-review", "gsd-reviewers", "somnio-skills"],
    ],
    ["an empty list (explicit none)", []],
    ["null (inherit)", null],
  ])("accepts %s", (_name, value) => {
    expect(findReviewAgentFieldError({ taskBatteries: value })).toBeUndefined();
  });

  it("rejects a duplicate pack id", () => {
    const error = findReviewAgentFieldError({
      taskBatteries: ["somnio-skills", "somnio-skills"],
    });
    expect(error).toContain("taskBatteries");
    expect(error).toContain("duplicate");
  });

  it("rejects an unknown pack id, naming the field and the allowed ids", () => {
    const error = findReviewAgentFieldError({ taskBatteries: ["nope"] });
    expect(error).toContain("taskBatteries");
    expect(error).toContain('"nope"');
    expect(error).toContain("somnio-skills");
  });

  it("rejects a bare string", () => {
    expect(
      findReviewAgentFieldError({ taskBatteries: "somnio-skills" }),
    ).toContain("taskBatteries");
  });

  it("leaves the review setting narrow", () => {
    expect(
      findReviewAgentFieldError({ reviewBatteries: ["somnio-skills"] }),
    ).toContain("reviewBatteries");
  });

  it("is picked with the rest of the family", () => {
    const row = {
      reviewMode: null,
      reviewBatteries: null,
      reviewRunTests: null,
      reviewCommandTimeoutS: null,
      reviewMaxTurns: null,
      taskBatteries: ["somnio-skills"],
      blockTolerance: "warning",
    };
    expect(pickReviewAgentFields(row)).toEqual({
      reviewMode: null,
      reviewBatteries: null,
      reviewRunTests: null,
      reviewCommandTimeoutS: null,
      reviewMaxTurns: null,
      taskBatteries: ["somnio-skills"],
    });
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
