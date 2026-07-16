import { describe, it, vi, beforeEach, expect } from "vitest";

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

import { effectiveShadow, githubSideEffectsEnabled } from "./github-side-effects";

describe("github side-effects kill-switch", () => {
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
