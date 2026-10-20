import { describe, it, vi, beforeAll, beforeEach, expect } from "vitest";

// Mutable env mock so we can flip the kill-switch per test. github-side-effects
// reads env.GITHUB_SIDE_EFFECTS_ENABLED on each call, so the getter re-evaluates.
const mockEnv = vi.hoisted(() => ({ sideEffectsEnabled: true }));
vi.mock("@terragon/env/apps-www", () => ({
  env: {
    get GITHUB_SIDE_EFFECTS_ENABLED() {
      return mockEnv.sideEffectsEnabled;
    },
  },
}));

// The test setup's import graph can load this module (with the real env)
// before the mock above applies, so evaluate a fresh copy under the mock.
let effectiveShadow: typeof import("./github-side-effects").effectiveShadow;
let githubSideEffectsEnabled: typeof import("./github-side-effects").githubSideEffectsEnabled;

describe("github side-effects kill-switch", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ effectiveShadow, githubSideEffectsEnabled } = await import(
      "./github-side-effects"
    ));
  });

  beforeEach(() => {
    mockEnv.sideEffectsEnabled = true;
  });

  it("switch ON: per-installation mode governs (active boots, shadow suppresses)", () => {
    expect(githubSideEffectsEnabled()).toBe(true);
    expect(effectiveShadow("active")).toBe(false);
    expect(effectiveShadow("shadow")).toBe(true);
  });

  it("switch OFF: forces shadow for EVERY mode, including active", () => {
    mockEnv.sideEffectsEnabled = false;
    expect(githubSideEffectsEnabled()).toBe(false);
    expect(effectiveShadow("active")).toBe(true);
    expect(effectiveShadow("shadow")).toBe(true);
  });
});
