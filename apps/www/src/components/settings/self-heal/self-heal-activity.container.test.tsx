import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Container wiring (hooks mocked): the Drain confirm path sends
 * {action:"drain"}; Reset sends the breaker's scopeKind/scopeKey; the section
 * view renders the activity slot once ready.
 */

const mutate = vi.fn();

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) =>
      [
        typeof initial === "function" ? (initial as () => T)() : initial,
        vi.fn(),
      ] as const,
  };
});
vi.mock("@/queries/self-heal-queries", () => ({
  useSelfHealActivityQuery: () => ({ data: undefined, isLoading: false }),
  useSelfHealActionMutation: () => ({ mutate, isPending: false }),
}));
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div data-skeleton="" />,
}));

vi.mock("@/components/settings/settings-row", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { useSelfHealActivityModel } from "./self-heal-activity";
import {
  SelfHealSectionView,
  type SelfHealSectionActions,
  type SelfHealSectionState,
} from "./self-heal-section";
import { NO_SELF_HEAL_VALUES } from "./self-heal-form";

type Model = ReturnType<typeof useSelfHealActivityModel>;

function capture(scope: "org" | "repo"): Model {
  let model: Model | null = null;
  function Probe() {
    model = useSelfHealActivityModel({ repoFullName: "acme/api", scope });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (model === null) throw new Error("model not captured");
  return model;
}

describe("useSelfHealActivityModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Drain sends the drain action (org scope only)", () => {
    const org = capture("org");
    org.viewProps.onDrain?.();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({ action: "drain" });
    expect(capture("repo").viewProps.onDrain).toBeUndefined();
  });

  it("Reset sends the breaker's scope", () => {
    capture("repo").viewProps.onReset({
      scopeKind: "github_write",
      scopeKey: "123",
      state: "open",
      openUntil: null,
      lastTripReason: null,
    });
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      action: "reset_breaker",
      scopeKind: "github_write",
      scopeKey: "123",
    });
  });
});

describe("SelfHealSectionView activity slot", () => {
  const actions: SelfHealSectionActions = {
    onSaveDefault: () => {},
    onSaveOverride: () => {},
    onRestoreDefault: () => {},
    onAddOverride: () => {},
    onReload: () => {},
  };
  const ready: SelfHealSectionState = {
    kind: "ready",
    orgDefault: NO_SELF_HEAL_VALUES,
    orgDefaultVersion: null,
    conflict: false,
    saving: false,
    overridesLoading: false,
    overrides: [],
    availableRepos: [],
  };

  it("renders the activity slot when ready, not while loading", () => {
    const slot = <div data-testid="slot" />;
    expect(
      renderToStaticMarkup(
        <SelfHealSectionView state={ready} actions={actions} activity={slot} />,
      ),
    ).toContain("slot");
    expect(
      renderToStaticMarkup(
        <SelfHealSectionView
          state={{ kind: "loading" }}
          actions={actions}
          activity={slot}
        />,
      ),
    ).not.toContain('data-testid="slot"');
  });
});
