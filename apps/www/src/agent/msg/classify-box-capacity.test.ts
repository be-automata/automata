import { describe, expect, it } from "vitest";

import {
  BOX_AT_CAPACITY_ERROR,
  boxAtCapacityOfChat,
} from "./classify-box-capacity";

const EXHAUSTED =
  'run: {"message":"The box had no memory headroom for this run after 8 deferral(s) (366s deferred); last check: …"}';

describe("boxAtCapacityOfChat (#561)", () => {
  it("reads the stored classification", () => {
    expect(
      boxAtCapacityOfChat({
        errorMessage: BOX_AT_CAPACITY_ERROR,
        errorMessageInfo: EXHAUSTED,
      }),
    ).toBe(true);
  });

  it("recognises a chat stored as a generic error before the classification existed", () => {
    expect(
      boxAtCapacityOfChat({
        errorMessage: "agent-generic-error",
        errorMessageInfo: EXHAUSTED,
      }),
    ).toBe(true);
  });

  it("is false for any other end", () => {
    expect(
      boxAtCapacityOfChat({
        errorMessage: "agent-generic-error",
        errorMessageInfo: "daemon exited with code 1",
      }),
    ).toBe(false);
    expect(
      boxAtCapacityOfChat({
        errorMessage: "provider-unavailable",
        errorMessageInfo: EXHAUSTED,
      }),
    ).toBe(false);
    expect(boxAtCapacityOfChat({ errorMessage: null })).toBe(false);
    expect(boxAtCapacityOfChat(null)).toBe(false);
  });
});
