import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CellWorkflowWriteCardView,
  type CellWorkflowWriteState,
} from "./cell-workflow-write-card";

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

function render(state: CellWorkflowWriteState): string {
  return renderToStaticMarkup(
    <CellWorkflowWriteCardView state={state} onChange={vi.fn()} />,
  );
}

describe("CellWorkflowWriteCardView", () => {
  it("loading shows a skeleton and no switch", () => {
    const html = render({ kind: "loading" });
    expect(html).toContain('data-testid="cell-workflow-write-skeleton"');
    expect(html).not.toContain('role="switch"');
  });

  it("error shows the message and no switch", () => {
    const html = render({ kind: "error", message: "boom from the API" });
    expect(html).toContain("boom from the API");
    expect(html).not.toContain('role="switch"');
  });

  it("is off when the stored value is null or false (the container maps both to enabled: false)", () => {
    const html = render({ kind: "ready", enabled: false, saving: false });
    expect(html).toContain("Let remote cells change CI workflow files");
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("are rejected");
  });

  it("is on when enabled", () => {
    const html = render({ kind: "ready", enabled: true, saving: false });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("can push changes to .github/workflows");
  });

  it("always shows the secrets warning, on or off", () => {
    for (const enabled of [true, false]) {
      const html = render({ kind: "ready", enabled, saving: false });
      expect(html).toContain('data-testid="cell-workflow-write-warning"');
      expect(html).toContain("with the repository&#x27;s secrets");
      expect(html).toContain("environments with required reviewers");
    }
  });

  it("saving disables the switch; otherwise it is enabled (role is enforced by the 403 on PUT, as in the sibling cards)", () => {
    expect(render({ kind: "ready", enabled: true, saving: true })).toMatch(
      /role="switch"[^>]*disabled=""/,
    );
    expect(render({ kind: "ready", enabled: true, saving: false })).not.toMatch(
      /role="switch"[^>]*disabled=""/,
    );
  });
});
