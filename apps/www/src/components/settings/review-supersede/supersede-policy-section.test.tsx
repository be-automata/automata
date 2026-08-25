import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SupersedePolicySectionView,
  type SupersedeSectionActions,
  type SupersedeSectionState,
  availableRepoNames,
  RESTORE_DEFAULT_PATCH,
  policyPatch,
} from "./supersede-policy-section";

// The app compiles JSX with the automatic runtime; vitest here uses the
// classic one, so presentational wrappers without an explicit React import
// are stubbed with plain elements (they carry no logic under test).
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-skeleton="" />
  ),
}));
vi.mock("@/components/settings/settings-row", () => ({
  SettingsSection: ({
    label,
    description,
    children,
  }: {
    label: string;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h3>{label}</h3>
      <p>{description}</p>
      {children}
    </section>
  ),
}));

const actions: SupersedeSectionActions = {
  onSelectPolicy: vi.fn(),
  onRecheckChange: vi.fn(),
  onOverridePolicy: vi.fn(),
  onRestoreDefault: vi.fn(),
  onOverrideRecheck: vi.fn(),
  onAddOverride: vi.fn(),
  onReload: vi.fn(),
};

const render = (state: SupersedeSectionState) =>
  renderToStaticMarkup(
    <SupersedePolicySectionView state={state} actions={actions} />,
  );

const ready = (
  over: Partial<Extract<SupersedeSectionState, { kind: "ready" }>> = {},
): SupersedeSectionState => ({
  kind: "ready",
  policy: null,
  recheckOnComplete: false,
  conflict: false,
  saving: false,
  overridesLoading: false,
  overrides: [],
  availableRepos: [],
  ...over,
});

/** #125 C6 — the section's state table, rendered state by state. */
describe("SupersedePolicySectionView", () => {
  it("loading → skeleton, no controls", () => {
    const html = render({ kind: "loading" });
    expect(html).toContain('data-testid="supersede-skeleton"');
    expect(html).not.toContain('role="radiogroup"');
  });

  it("error → human copy, no controls", () => {
    const html = render({
      kind: "error",
      message: "Select an organization first — this setting belongs to one.",
    });
    expect(html).toContain("Couldn&#x27;t load the review policy");
    expect(html).toContain("Select an organization first");
    expect(html).not.toContain('role="radiogroup"');
  });

  it("ready + no overrides → radio group with the org policy selected and the empty-state copy", () => {
    const html = render(ready({ policy: "complete-run-queue" }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(
      /value="complete-run-queue"[^>]*aria-checked="true"|aria-checked="true"[^>]*value="complete-run-queue"/,
    );
    expect(html).toContain('data-testid="supersede-overrides-empty"');
    expect(html).not.toContain('data-testid="supersede-conflict"');
  });

  it("ready + overrides → one row per repo with its policy, an override chip and Restore default", () => {
    const html = render(
      ready({
        overrides: [
          {
            repoFullName: "acme/widgets",
            supersedePolicy: "app-side",
            recheckOnComplete: false,
            updatedAt: "2026-08-24T00:00:00.000Z",
          },
          {
            repoFullName: "acme/api",
            supersedePolicy: "complete-run-discard",
            recheckOnComplete: true,
            updatedAt: "2026-08-24T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(html).toContain("acme/widgets");
    expect(html).toContain("acme/api");
    expect((html.match(/>Repo override</g) ?? []).length).toBe(2);
    expect((html.match(/Restore default/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="Supersede policy for acme/widgets"');
    // The discard override carries the same amber warning + re-verify toggle
    // as the org default — never a silent "no feedback" repo.
    expect(
      (html.match(/data-testid="override-discard-warning"/g) ?? []).length,
    ).toBe(1);
    expect(html).toContain("Commits pushed to acme/api during a review");
    expect(html).toMatch(
      /id="override-recheck-acme\/api"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="override-recheck-acme\/api"/,
    );
    expect(html).not.toContain('data-testid="supersede-overrides-empty"');
  });

  it("ready + repos without an override → the Add-override row is the path to a repo's FIRST override; empty copy points at it", () => {
    const html = render(
      ready({ availableRepos: ["acme/widgets", "acme/api"] }),
    );
    expect(html).toContain('data-testid="supersede-add-override"');
    expect(html).toContain('aria-label="Repository to add an override for"');
    expect(html).toContain(">Add override<");
    expect(html).toContain("Add an override below");
    expect(html).not.toContain("Review tolerance"); // no reference to a control that does not exist
  });

  it("no repos left to override → no Add-override row", () => {
    const html = render(ready({ availableRepos: [] }));
    expect(html).not.toContain('data-testid="supersede-add-override"');
  });

  it("conflict → banner with Reload, controls still rendered (and disabled while saving)", () => {
    const html = render(ready({ conflict: true, saving: true }));
    expect(html).toContain('data-testid="supersede-conflict"');
    expect(html).toContain("Another admin just saved changes");
    expect(html).toContain("Your change was not applied");
    expect(html).toContain(">Reload<");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("disabled");
  });
});

describe("availableRepoNames — Add-override picker excludes repos that already have an override", () => {
  it("matches case-insensitively: GitHub's cased slug vs the model's lowercased key", () => {
    const settings = [
      { repoFullName: "acme/widgets", supersedePolicy: "newest-wins" },
      // tolerance-only row: no supersede override → still offerable
      { repoFullName: "acme/api", supersedePolicy: null },
    ];
    expect(
      availableRepoNames(["Acme/Widgets", "acme/api", "Beta/Tool"], settings),
    ).toEqual(["Beta/Tool", "acme/api"]);
  });
});

describe("override lifecycle patches name BOTH supersede columns — the row outlives the override", () => {
  it("choosing a policy (Add override, org radio, override Select) always turns recheck OFF — re-arming it is an explicit toggle", () => {
    expect(policyPatch("complete-run-discard")).toEqual({
      supersedePolicy: "complete-run-discard",
      recheckOnComplete: false,
    });
  });
  it("Restore default clears the policy AND the recheck flag", () => {
    expect(RESTORE_DEFAULT_PATCH).toEqual({
      supersedePolicy: null,
      recheckOnComplete: false,
    });
  });
});
