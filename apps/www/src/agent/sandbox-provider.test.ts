import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { getSandboxProvider, serverDefaultSandboxProvider } from "./sandbox";

// ADR-014 amends ADR-013 I7: one path per profile, chosen only by the
// resolver; no setting or client input selects a path. Until the resolver is
// wired, a new thread gets the deployment default and nothing a user sets.
describe("serverDefaultSandboxProvider", () => {
  it("tests always get the mock provider", () => {
    expect(serverDefaultSandboxProvider({ isTest: true, e2bApiKey: "k" })).toBe(
      "mock",
    );
    expect(serverDefaultSandboxProvider({ isTest: true, e2bApiKey: "" })).toBe(
      "mock",
    );
  });

  it("a deployment with an E2B key stamps e2b", () => {
    expect(
      serverDefaultSandboxProvider({ isTest: false, e2bApiKey: "e2b_key" }),
    ).toBe("e2b");
  });

  it("production (no E2B key) stamps docker, as it does today", () => {
    expect(serverDefaultSandboxProvider({ isTest: false, e2bApiKey: "" })).toBe(
      "docker",
    );
  });
});

describe("getSandboxProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("takes no user input: the provider is decided server-side only", () => {
    // The signature is the guarantee: there is no setting, flag or user id to pass.
    expect(getSandboxProvider.length).toBe(0);
    expect(getSandboxProvider()).toBe("mock");
  });

  it("outside tests it reads the deployment env, not the user", () => {
    vi.stubEnv("NODE_ENV", "production");
    // vite.config.ts sets a test E2B key, so the env-derived default is e2b.
    expect(getSandboxProvider()).toBe("e2b");
  });
});
