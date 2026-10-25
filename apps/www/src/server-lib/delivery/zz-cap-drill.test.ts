import { expect, it } from "vitest";

// #509 cap drill: a deliberately failing check on a delivery PR whose fix
// cycles are spent. Reverted right after the drill.
it("cap drill: fails on purpose", () => {
  expect("cap drill").toBe("reverted");
});
