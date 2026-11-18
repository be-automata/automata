import { describe, expect, it } from "vitest";
import {
  UNKNOWN_RESET_MARK_MS,
  credentialMarkFor,
} from "./credential-unavailability";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

/**
 * #442: which classified kinds mark the delivered credential, and how.
 * Card: protects=the kind → mark mapping (usage_limit timed at its reset,
 * unknown or past reset one hour ahead, subscription_disabled and
 * auth_rejected indefinite, credit_exhausted never); fails_when=a kind maps
 * to the wrong shape, a past reset writes an already-expired mark, or
 * credit_exhausted marks a row; no_claim=the UPDATE semantics (shared model
 * suite) and the wiring (handle-daemon-event provider suite).
 */
describe("credentialMarkFor (#442)", () => {
  it("usage_limit marks until its reset", () => {
    const resetsAt = NOW + 5 * 60 * 60 * 1000;
    expect(
      credentialMarkFor(
        { kind: "usage_limit", window: "weekly", resetsAt },
        NOW,
      ),
    ).toEqual({ reason: "usage_limit", until: new Date(resetsAt) });
  });

  it("usage_limit with an unknown reset marks one hour ahead", () => {
    expect(credentialMarkFor({ kind: "usage_limit" }, NOW)).toEqual({
      reason: "usage_limit",
      until: new Date(NOW + UNKNOWN_RESET_MARK_MS),
    });
  });

  it("usage_limit with an already-past reset marks one hour ahead", () => {
    expect(
      credentialMarkFor({ kind: "usage_limit", resetsAt: NOW - 1000 }, NOW),
    ).toEqual({
      reason: "usage_limit",
      until: new Date(NOW + UNKNOWN_RESET_MARK_MS),
    });
  });

  it("subscription_disabled and auth_rejected are indefinite", () => {
    expect(credentialMarkFor({ kind: "subscription_disabled" }, NOW)).toEqual({
      reason: "subscription_disabled",
      until: null,
    });
    expect(credentialMarkFor({ kind: "auth_rejected" }, NOW)).toEqual({
      reason: "auth_rejected",
      until: null,
    });
  });

  it("credit_exhausted is never a mark", () => {
    expect(credentialMarkFor({ kind: "credit_exhausted" }, NOW)).toBeNull();
  });
});
