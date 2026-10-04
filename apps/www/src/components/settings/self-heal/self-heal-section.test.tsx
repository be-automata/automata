import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  SELF_HEAL_CLEAR_PATCH as SHARED_CLEAR_PATCH,
  type SelfHealValues,
} from "@terragon/shared/model/self-heal-settings";
import {
  KILL_SWITCH_NOTE,
  SELF_HEAL_ON_PRECONDITIONS_NOTE,
  SelfHealFieldsView,
  SelfHealSectionView,
  type SelfHealSectionActions,
  type SelfHealSectionState,
} from "./self-heal-section";
import {
  NO_SELF_HEAL_VALUES,
  SELF_HEAL_CLEAR_PATCH,
  selfHealDraftFromValues,
  type SelfHealOverrideRow,
} from "./self-heal-form";

// The app compiles JSX with the automatic runtime; vitest here uses the
// classic one, so wrappers without an explicit React import are stubbed.
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

const noop = () => undefined;

function render(
  scope: "org" | "repo",
  orgValues: SelfHealValues | null,
  disabled = false,
  values: SelfHealValues = NO_SELF_HEAL_VALUES,
) {
  return renderToStaticMarkup(
    <SelfHealFieldsView
      scope={scope}
      values={values}
      orgValues={orgValues}
      draft={selfHealDraftFromValues(values)}
      onChange={noop}
      disabled={disabled}
    />,
  );
}

const DRY_RUN_ORG: SelfHealValues = {
  ...NO_SELF_HEAL_VALUES,
  selfHealMode: "dry-run",
};

describe("SelfHealFieldsView", () => {
  it("org scope: kill switch, mode inherit label, preconditions note", () => {
    const html = render("org", null);
    expect(html).toContain("Kill switch");
    expect(html).toContain(KILL_SWITCH_NOTE);
    expect(html).toContain("Inherit (system default: Off)");
    expect(html).toContain("Mode");
    expect(html).toContain("Max open issues");
    expect(html).toContain("Max attempts per finding");
    expect(html).toContain("Cooldown (minutes)");
    expect(html).toContain("Minimum severity");
    expect(html).toContain("Auto-label new issues for fixing");
    expect(html).toContain(
      "Rubric findings: audits absent before needs-human-approve",
    );
    expect(html).toContain("Max fix diff lines");
    expect(html).toContain("Unreviewed fix PR expiry (days)");
    expect(html).toContain("Run window (UTC, HH:MM-HH:MM)");
    expect(html).toContain(
      SELF_HEAL_ON_PRECONDITIONS_NOTE.replaceAll("'", "&#x27;"),
    );
  });

  it("repo scope: no kill switch; inherit label shows the org mode", () => {
    const html = render("repo", DRY_RUN_ORG);
    expect(html).not.toContain("Kill switch");
    expect(html).not.toContain(KILL_SWITCH_NOTE);
    expect(html).toContain("Inherit (org default: Dry-run)");
    expect(html).toContain("issues: write");
  });

  it("repo scope with an unset org mode resolves to Off", () => {
    expect(render("repo", NO_SELF_HEAL_VALUES)).toContain(
      "Inherit (org default: Off)",
    );
  });

  it("disabled disables every control", () => {
    const html = render("org", null, true);
    const controls = html.match(/<(input|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control).toContain("disabled");
    }
  });

  it("has no gate-command text and no cost or spend field", () => {
    for (const html of [render("org", null), render("repo", DRY_RUN_ORG)]) {
      expect(html).not.toMatch(/gate[ -]?command/i);
      expect(html).not.toMatch(/spend|cost|budget/i);
    }
  });

  it("shows an inline error for an out-of-range draft and blocks Save", () => {
    const draft = {
      ...selfHealDraftFromValues(NO_SELF_HEAL_VALUES),
      maxOpenIssues: "99",
    };
    const html = renderToStaticMarkup(
      <SelfHealFieldsView
        scope="org"
        values={NO_SELF_HEAL_VALUES}
        orgValues={null}
        draft={draft}
        onChange={noop}
        disabled={false}
        saveLabel="Save org default"
        onSave={noop}
      />,
    );
    expect(html).toContain("self-heal-maxOpenIssues-error");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save org default/);
  });
});

const ROW: SelfHealOverrideRow = {
  ...NO_SELF_HEAL_VALUES,
  selfHealMode: "on",
  repoFullName: "acme/api",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

const actions: SelfHealSectionActions = {
  onSaveDefault: vi.fn(),
  onSaveOverride: vi.fn(),
  onRestoreDefault: vi.fn(),
  onAddOverride: vi.fn(),
  onReload: vi.fn(),
};

function ready(
  overrides: Partial<Extract<SelfHealSectionState, { kind: "ready" }>> = {},
): SelfHealSectionState {
  return {
    kind: "ready",
    orgDefault: NO_SELF_HEAL_VALUES,
    orgDefaultVersion: null,
    conflict: false,
    saving: false,
    overridesLoading: false,
    overrides: [],
    availableRepos: [],
    ...overrides,
  };
}

describe("SelfHealSectionView", () => {
  it("renders the Self-heal label, the org block and the empty state", () => {
    const html = renderToStaticMarkup(
      <SelfHealSectionView state={ready()} actions={actions} />,
    );
    expect(html).toContain("Self-heal");
    expect(html).toContain("Org default");
    expect(html).toContain("self-heal-overrides-empty");
  });

  it("renders one override with Restore default and a repo-scope block", () => {
    const html = renderToStaticMarkup(
      <SelfHealSectionView
        state={ready({ overrides: [ROW] })}
        actions={actions}
      />,
    );
    expect(html.match(/Restore default/g)).toHaveLength(1);
    expect(html).toContain("acme/api");
    expect(html.match(/Kill switch/g)).toHaveLength(1);
  });

  it("loading and error states", () => {
    expect(
      renderToStaticMarkup(
        <SelfHealSectionView state={{ kind: "loading" }} actions={actions} />,
      ),
    ).toContain("self-heal-skeleton");
    expect(
      renderToStaticMarkup(
        <SelfHealSectionView
          state={{ kind: "error", message: "boom" }}
          actions={actions}
        />,
      ),
    ).toContain("boom");
  });

  it("the clear patch is the shared one and touches only self-heal keys", () => {
    expect(SELF_HEAL_CLEAR_PATCH).toBe(SHARED_CLEAR_PATCH);
    for (const key of Object.keys(SELF_HEAL_CLEAR_PATCH)) {
      expect(key.startsWith("selfHeal")).toBe(true);
    }
  });
});
