import { describe, expect, it } from "vitest";

import { compareValueSets, extractValues, MAX_VALUE_TEXT } from "./values";

describe("extractValues", () => {
  it.each<[string, string[]]>([
    ["export const TRIAL_DAYS = 14;", ["14"]],
    [
      "Every workspace starts with a 14-day free trial. No card required.",
      ["14"],
    ],
    [
      "export const SEAT_PRICE_USD = 29;\nexport const MAX_SEATS_FREE = 3;",
      ["29", "3"],
    ],
    ["TRIAL_DAYS * 86_400_000", ["86400000"]],
    ["Each seat costs $29 per month", ["29"]],
    ["29 USD", ["29"]],
    ["15% off", ["15"]],
    ["1,200 requests", ["1200"]],
    ["seats 3, 4", ["3", "4"]],
    ["seats 3,4", ["3", "4"]],
    ["fixed in version 2.4.1.", ["2.4.1"]],
    ["29.50", ["29.5"]],
    ["29.00", ["29"]],
    ["0.5", ["0.5"]],
    ["007", ["7"]],
    ["0", ["0"]],
    ["v2 of SUP-12 uses ag_session", []],
    ["repo://billing.ts#L1-L3", []],
    ["007a8a0bbf458c93", []],
    ["id 123456789012", []],
    ["timeout 10ms", []],
    ["    requests_per_minute: 120", ["120"]],
    ["RATE_LIMIT_PER_MINUTE = 120", ["120"]],
    ["Trials last 30 days; a 30-day trial", ["30"]],
    ['"fixedIn": "2.4.1"', ["2.4.1"]],
    ["", []],
  ])("%j -> %j", (text, expected) => {
    expect(extractValues(text)).toEqual(expected);
  });

  it("scans only the first MAX_VALUE_TEXT characters", () => {
    expect(MAX_VALUE_TEXT).toBe(8192);
    const filler = " ".repeat(MAX_VALUE_TEXT);
    expect(extractValues(`${filler}42`)).toEqual([]);
    expect(extractValues(`7${filler}42`)).toEqual(["7"]);
  });

  it("drops a number cut by the MAX_VALUE_TEXT boundary", () => {
    const text = `${" ".repeat(MAX_VALUE_TEXT - 2)}12345`;
    expect(extractValues(text)).toEqual([]);
  });
});

describe("compareValueSets", () => {
  it.each<[string[][], "agree" | "conflict" | "unknown"]>([
    [[["30"], ["21"]], "conflict"],
    [[["29", "3"], ["3"]], "agree"],
    [
      [
        ["29", "3"],
        ["35", "3"],
      ],
      "conflict",
    ],
    [[["30"], ["30"]], "agree"],
    [[["30"], []], "unknown"],
    [[["30"]], "unknown"],
    [[], "unknown"],
    [[["30"], ["30"], ["21"]], "conflict"],
    [[["3"], ["29", "3"], ["29", "3", "5"]], "agree"],
  ])("%j -> %s", (sets, expected) => {
    expect(compareValueSets(sets)).toBe(expected);
  });
});
