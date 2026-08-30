import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildOrgDraftActions,
  OrgDraftDefaultCardView,
  type OrgDraftDefaultActions,
  type OrgDraftDefaultState,
} from "./org-draft-default-card";
import { ConflictError } from "@/queries/error-from-response";

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
});

describe("buildOrgDraftActions (container wiring)", () => {
  /** Tracks the conflict flag the way useState would, in call order. */
  function harness(latest: { updatedAt: string } | null) {
    let conflict = false;
    const calls: string[] = [];
    const mutate = vi.fn(
      (
        _input: { reviewDraftPrs: boolean; expectedUpdatedAt: string | null },
        _options: { onError: (error: unknown) => void },
      ) => {
        calls.push(`mutate(conflict=${conflict})`);
      },
    );
    const setConflict = (value: boolean) => {
      conflict = value;
      calls.push(`setConflict(${value})`);
    };
    const refetch = vi.fn();
    const actions = buildOrgDraftActions({
      latest,
      mutate,
      setConflict,
      refetch,
    });
    return {
      actions,
      mutate,
      refetch,
      calls,
      get conflict() {
        return conflict;
      },
    };
  }

  it("passes the loaded updatedAt as the CAS fence, null when the sentinel row is absent", () => {
    const withRow = harness({ updatedAt: "2026-08-30T00:00:00.000Z" });
    withRow.actions.onChange(false);
    expect(withRow.mutate.mock.calls[0]![0]).toEqual({
      reviewDraftPrs: false,
      expectedUpdatedAt: "2026-08-30T00:00:00.000Z",
    });

    const firstWrite = harness(null);
    firstWrite.actions.onChange(true);
    expect(firstWrite.mutate.mock.calls[0]![0]).toEqual({
      reviewDraftPrs: true,
      expectedUpdatedAt: null,
    });
  });

  it("a lost CAS race raises the conflict banner; non-conflict errors do not", () => {
    const h = harness({ updatedAt: "2026-08-30T00:00:00.000Z" });
    h.actions.onChange(false);
    h.mutate.mock.calls[0]![1].onError(new Error("500 from the API"));
    expect(h.conflict).toBe(false);
    h.mutate.mock.calls[0]![1].onError(new ConflictError(null));
    expect(h.conflict).toBe(true);
  });

  it("REGRESSION: a retry clears the stale conflict banner BEFORE mutating, so a successful save never leaves 'changed since you loaded' up", () => {
    const h = harness({ updatedAt: "2026-08-30T00:00:00.000Z" });
    // First toggle loses the race → banner up.
    h.actions.onChange(false);
    h.mutate.mock.calls[0]![1].onError(new ConflictError(null));
    expect(h.conflict).toBe(true);
    // Retry succeeds (onError never fires): the banner must already be down,
    // and it must have been cleared before the mutate was issued.
    h.actions.onChange(false);
    expect(h.conflict).toBe(false);
    expect(h.calls).toEqual([
      "setConflict(false)",
      "mutate(conflict=false)",
      "setConflict(true)",
      "setConflict(false)",
      "mutate(conflict=false)",
    ]);
  });

  it("Reload clears the banner and refetches", () => {
    const h = harness({ updatedAt: "2026-08-30T00:00:00.000Z" });
    h.actions.onChange(true);
    h.mutate.mock.calls[0]![1].onError(new ConflictError(null));
    expect(h.conflict).toBe(true);
    h.actions.onReload();
    expect(h.conflict).toBe(false);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});
