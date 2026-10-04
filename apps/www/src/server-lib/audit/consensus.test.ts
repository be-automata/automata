import { describe, expect, it } from "vitest";

import { hasQuorum, pushSighting } from "./consensus";

describe("consensus", () => {
  it("keeps at most 3 sightings, newest first", () => {
    expect(pushSighting([], true)).toEqual([true]);
    expect(pushSighting([true, false, true], false)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("does not mutate its input", () => {
    const prev = [true];
    pushSighting(prev, false);
    expect(prev).toEqual([true]);
  });

  it("needs 2 of 3", () => {
    expect(hasQuorum([true, false, true])).toBe(true);
    expect(hasQuorum([true, false, false])).toBe(false);
    expect(hasQuorum([])).toBe(false);
  });
});
