import { describe, it, expect } from "vitest";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import {
  classifyNextMessageError,
  nonRetryablePreflight,
} from "./retry-classification";
import { NextMessageHttpError } from "./www-client";

describe("classifyNextMessageError (#6)", () => {
  it("maps a 403 next-message error to NonRetryableError", () => {
    const out = classifyNextMessageError(
      new NextMessageHttpError(
        403,
        "next-message failed: HTTP 403 (Forbidden)",
      ),
    );
    expect(out).toBeInstanceOf(NonRetryableError);
    expect((out as Error).message).toMatch(/403/);
  });

  it("maps a 404 (PR gone) to NonRetryableError", () => {
    const out = classifyNextMessageError(new NextMessageHttpError(404, "gone"));
    expect(out).toBeInstanceOf(NonRetryableError);
  });

  it("leaves a 503 as a plain (retryable) error", () => {
    const original = new NextMessageHttpError(
      503,
      "next-message failed: HTTP 503",
    );
    const out = classifyNextMessageError(original);
    expect(out).toBe(original);
    expect(out).not.toBeInstanceOf(NonRetryableError);
  });

  it("leaves a non-HTTP error (e.g. network/abort) untouched", () => {
    const original = new Error("ECONNRESET");
    expect(classifyNextMessageError(original)).toBe(original);
  });
});

describe("nonRetryablePreflight (#6)", () => {
  it("wraps a preflight failure as NonRetryableError", () => {
    const out = nonRetryablePreflight(new Error("gh not authenticated"));
    expect(out).toBeInstanceOf(NonRetryableError);
    expect(out.message).toMatch(/gh auth precondition failed/);
    expect(out.message).toMatch(/gh not authenticated/);
  });
});
