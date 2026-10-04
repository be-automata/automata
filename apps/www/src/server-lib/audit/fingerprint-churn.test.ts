import { describe, expect, it } from "vitest";

import { computeFingerprintChurn } from "./fingerprint-churn";

const run = (id: string, fingerprints: string[], complete = true) => ({
  id,
  complete,
  fingerprints,
});

describe("computeFingerprintChurn", () => {
  it("is 0.5 for {a,b,c} -> {a,b,d}", () => {
    expect(
      computeFingerprintChurn([
        run("r1", ["a", "b", "c"]),
        run("r2", ["a", "b", "d"]),
      ]),
    ).toEqual([{ fromRunId: "r1", toRunId: "r2", churn: 0.5 }]);
  });

  it("is 0 for identical sets and for two empty sets", () => {
    expect(
      computeFingerprintChurn([run("r1", ["a", "b"]), run("r2", ["b", "a"])])[0]
        ?.churn,
    ).toBe(0);
    expect(
      computeFingerprintChurn([run("r1", []), run("r2", [])])[0]?.churn,
    ).toBe(0);
  });

  it("skips an incomplete run between two complete runs", () => {
    const out = computeFingerprintChurn([
      run("r1", ["a"]),
      run("r2", ["z"], false),
      run("r3", ["a"]),
    ]);
    expect(out).toEqual([{ fromRunId: "r1", toRunId: "r3", churn: 0 }]);
  });

  it("returns [] with fewer than two complete runs", () => {
    expect(computeFingerprintChurn([])).toEqual([]);
    expect(
      computeFingerprintChurn([run("r1", ["a"]), run("r2", ["b"], false)]),
    ).toEqual([]);
  });
});
