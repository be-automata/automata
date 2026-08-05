import { describe, it, expect } from "vitest";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "./auth-session-config";

/**
 * These pin the security-relevant invariants of the session config (#40).
 *
 * `auth.ts` itself is unassertable in tests — it pulls in env, the database and
 * every plugin, so every suite that touches it does `vi.mock("@/lib/auth")`.
 * That is exactly why these constants live in their own module: without this,
 * `freshAge` could be reverted to 0 (silently disabling better-auth's freshness
 * gate on /unlink-account and /list-sessions) with no test failing anywhere.
 */
describe("session config invariants", () => {
  it("keeps the freshness gate ENABLED (freshAge must never be 0)", () => {
    // better-auth treats 0 as an explicit short-circuit that skips the check
    // entirely — see the `freshAge !== 0` guards in its session/update-user
    // routes. This is the assertion that would have caught the original opt-out.
    expect(SESSION_FRESH_AGE_SECONDS).not.toBe(0);
    expect(SESSION_FRESH_AGE_SECONDS).toBeGreaterThan(0);
  });

  it("keeps the fresh window shorter than the session lifetime", () => {
    // A freshAge >= expiresIn can never bite: the session expires before it
    // could ever be judged stale, which is 0 by another name.
    expect(SESSION_FRESH_AGE_SECONDS).toBeLessThan(SESSION_EXPIRES_IN_SECONDS);
  });

  it("keeps the fresh window longer than the session update interval", () => {
    // Shorter than updateAge would mean a session could be refreshed yet still
    // count as stale on every gated call — re-auth prompts with no way to clear.
    expect(SESSION_FRESH_AGE_SECONDS).toBeGreaterThan(
      SESSION_UPDATE_AGE_SECONDS,
    );
  });

  it("pins the current values", () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(60 * 60 * 24 * 60); // 60 days
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(60 * 60 * 24); // 1 day
    expect(SESSION_FRESH_AGE_SECONDS).toBe(60 * 60 * 24 * 7); // 7 days
  });
});
