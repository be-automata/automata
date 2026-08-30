import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OrgDraftDefaultCardView,
  EFFECTIVE_DRAFT_DEFAULT,
  type OrgDraftDefaultActions,
  type OrgDraftDefaultState,
} from "./org-draft-default-card";

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

const actions: OrgDraftDefaultActions = {
  onChange: vi.fn(),
  onReload: vi.fn(),
};

function render(state: OrgDraftDefaultState): string {
  return renderToStaticMarkup(
    <OrgDraftDefaultCardView state={state} actions={actions} />,
  );
}

describe("OrgDraftDefaultCardView", () => {
  it("loading → skeleton, no switch", () => {
    const html = render({ kind: "loading" });
    expect(html).toContain('data-testid="org-draft-skeleton"');
    expect(html).not.toContain('role="switch"');
  });

  it("error → human copy with the message, no controls", () => {
    const html = render({ kind: "error", message: "boom from the API" });
    expect(html).toContain("Couldn&#x27;t load the draft-PR policy");
    expect(html).toContain("boom from the API");
    expect(html).not.toContain('role="switch"');
  });

  it("ready ON → checked switch + outcome copy about drafts being reviewed", () => {
    const html = render({
      kind: "ready",
      reviewDrafts: true,
      saving: false,
      conflict: false,
    });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(
      "reviewed as soon as they&#x27;re opened or updated",
    );
  });

  it("ready OFF → unchecked switch + copy naming the ready-for-review moment", () => {
    const html = render({
      kind: "ready",
      reviewDrafts: false,
      saving: false,
      conflict: false,
    });
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("skipped until they&#x27;re marked ready");
  });

  it("saving → the switch is disabled", () => {
    const html = render({
      kind: "ready",
      reviewDrafts: true,
      saving: true,
      conflict: false,
    });
    expect(html).toMatch(/role="switch"[^>]*disabled/);
  });

  it("conflict → banner with Reload; the switch stays rendered", () => {
    const html = render({
      kind: "ready",
      reviewDrafts: true,
      saving: false,
      conflict: true,
    });
    expect(html).toContain('data-testid="org-draft-conflict"');
    expect(html).toContain("changed since you loaded");
    expect(html).toContain(">Reload<");
    expect(html).toContain('role="switch"');
  });

  it("the effective default with no stored row is TRUE", () => {
    expect(EFFECTIVE_DRAFT_DEFAULT).toBe(true);
  });
});
