import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  KNOWLEDGE_KILL_SWITCH_NOTE,
  draftFromControls,
  type KnowledgeControlsDto,
  type KnowledgeSettingsResponse,
  type KnowledgeSpendDto,
  type KnowledgeViewer,
} from "./knowledge-form";
import {
  KnowledgeSectionView,
  OffboardConfirmForm,
  type KnowledgeSectionViewProps,
} from "./knowledge-section";

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
    cta,
    children,
  }: {
    label: string;
    description?: React.ReactNode;
    cta?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h3>{label}</h3>
      <p>{description}</p>
      <div data-testid="cta">{cta}</div>
      {children}
    </section>
  ),
}));

const NOW = new Date("2026-10-10T00:00:00.000Z");

const CONTROLS: KnowledgeControlsDto = {
  engine: null,
  budgetMicroUsd: null,
  effectiveBudgetMicroUsd: 100_000_000,
  ceilingMicroUsd: 50_000_000,
  offboardedAt: null,
  purgeAfter: null,
  purgedAt: null,
  enabled: false,
  gateReason: "engine_off",
  updatedAt: null,
};
const SPEND: KnowledgeSpendDto = {
  windowStart: "2026-10-01T00:00:00.000Z",
  capMicroUsd: 100_000_000,
  reservedMicroUsd: 0,
  spentMicroUsd: 0,
  remainingMicroUsd: 100_000_000,
  atCap: false,
  capAlertedAt: null,
};
const ADMIN: KnowledgeViewer = { isOrgAdmin: true, isPlatformAdmin: false };

function data(
  over: Partial<KnowledgeSettingsResponse> = {},
): KnowledgeSettingsResponse {
  return {
    orgSlug: "acme-org",
    controls: CONTROLS,
    spend: SPEND,
    actions: [],
    viewer: ADMIN,
    ...over,
  };
}

const noop = () => undefined;

/** The opening tag (button/input) that contains the marker. */
function tagWith(html: string, marker: string, name: string): string {
  const tags = html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
  return tags.find((t) => t.includes(marker)) ?? "";
}
function isDisabled(tag: string): boolean {
  return / disabled=""/.test(tag);
}

function render(over: Partial<KnowledgeSectionViewProps> = {}): string {
  const d = over.data === undefined ? data() : over.data;
  return renderToStaticMarkup(
    <KnowledgeSectionView
      status="ready"
      data={d}
      draft={draftFromControls(d?.controls ?? null)}
      onDraftChange={noop}
      serverError={null}
      saving={false}
      offboardPending={false}
      now={NOW}
      offboardOpen={false}
      onOffboardOpenChange={noop}
      offboardTyped=""
      onOffboardTypedChange={noop}
      onSave={noop}
      onReload={noop}
      onOffboard={noop}
      onUndo={noop}
      {...over}
    />,
  );
}

describe("KnowledgeSectionView", () => {
  it("renders a skeleton while loading", () => {
    expect(render({ status: "loading", data: null })).toContain(
      "knowledge-skeleton",
    );
  });

  it("asks for an organization when none is active", () => {
    expect(
      render({
        data: data({ controls: null, spend: null, orgSlug: null }),
      }),
    ).toContain("Select an organization");
  });

  it("shows the default-off state, the note, an empty budget and 0%", () => {
    const html = render();
    expect(html).toContain(KNOWLEDGE_KILL_SWITCH_NOTE);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('placeholder="100.00"');
    expect(html).toContain("0% used");
    expect(html).not.toContain("knowledge-paused-banner");
  });

  it("puts the org scope badge in the header", () => {
    const html = render();
    expect(html).toContain("border-double");
    expect(html).toContain(">org<");
  });

  it("disables everything for a member", () => {
    const html = render({
      data: data({ viewer: { isOrgAdmin: false, isPlatformAdmin: false } }),
    });
    expect(html).toContain("Only org owners and admins can change this");
    expect(isDisabled(tagWith(html, 'id="knowledge-budget"', "input"))).toBe(
      true,
    );
    expect(isDisabled(tagWith(html, 'id="knowledge-engine"', "button"))).toBe(
      true,
    );
    expect(isDisabled(tagWith(html, "knowledge-offboard-open", "button"))).toBe(
      true,
    );
  });

  it("lets a non-member platform admin edit the budget only", () => {
    const html = render({
      data: data({ viewer: { isOrgAdmin: false, isPlatformAdmin: true } }),
    });
    expect(isDisabled(tagWith(html, 'id="knowledge-budget"', "input"))).toBe(
      false,
    );
    expect(isDisabled(tagWith(html, 'id="knowledge-engine"', "button"))).toBe(
      true,
    );
    expect(html).toContain("Only org owners and admins can change this");
  });

  it("shows the paused banner when the cap alert is set", () => {
    const html = render({
      data: data({
        spend: { ...SPEND, capAlertedAt: "2026-10-05T00:00:00.000Z" },
      }),
    });
    expect(html).toContain("knowledge-paused-banner");
    expect(html).toContain("state-needs-you");
    expect(html).toContain("model-spending knowledge work is paused");
  });

  it("shows an inline error and disables Save above the ceiling", () => {
    const html = render({
      draft: { engine: false, budget: "60" },
    });
    expect(html).toContain("knowledge-budget-error");
    expect(html).toContain("Above the platform ceiling of $50.00");
    expect(isDisabled(tagWith(html, "knowledge-save", "button"))).toBe(true);
  });

  it("enables Save for a valid change", () => {
    const html = render({ draft: { engine: true, budget: "" } });
    expect(isDisabled(tagWith(html, "knowledge-save", "button"))).toBe(false);
  });

  it("shows the conflict banner and the ceiling alert", () => {
    expect(render({ serverError: { kind: "conflict" } })).toContain(
      "knowledge-conflict",
    );
    const html = render({
      serverError: { kind: "above_ceiling", ceilingMicroUsd: 50_000_000 },
    });
    expect(html).toContain("knowledge-ceiling-error");
    expect(html).toContain("$50.00");
  });

  it("shows the offboarded banner with countdown and undo", () => {
    const html = render({
      data: data({
        controls: {
          ...CONTROLS,
          engine: false,
          offboardedAt: "2026-10-09T00:00:00.000Z",
          purgeAfter: "2026-10-16T00:00:00.000Z",
        },
      }),
    });
    expect(html).toContain("Offboarded on 2026-10-09");
    expect(html).toContain("2026-10-16");
    expect(html).toContain("days)");
    expect(html).toContain("Undo offboarding");
    expect(isDisabled(tagWith(html, 'id="knowledge-engine"', "button"))).toBe(
      true,
    );
  });

  it("shows the purged state with a re-enable action", () => {
    const html = render({
      data: data({
        controls: {
          ...CONTROLS,
          offboardedAt: "2026-10-01T00:00:00.000Z",
          purgeAfter: "2026-10-08T00:00:00.000Z",
          purgedAt: "2026-10-08T00:00:00.000Z",
        },
      }),
    });
    expect(html).toContain("Knowledge data was deleted on 2026-10-08");
    expect(html).toContain("Re-enable onboarding");
  });

  it("renders enum labels and from/to values, never raw targets", () => {
    const html = render({
      data: data({
        actions: [
          {
            id: "1",
            action: "engine_toggle",
            target: { from: false, to: true, via: "secret-ish" },
            actorUserId: "u1",
            createdAt: "2026-10-02T10:00:00.000Z",
          },
          {
            id: "2",
            action: "offboard_undo",
            target: { purged: false },
            actorUserId: "u1",
            createdAt: "2026-10-03T10:00:00.000Z",
          },
        ],
      }),
    });
    expect(html).toContain("Engine toggled");
    expect(html).toContain("Off to On");
    expect(html).toContain("Offboarding undone");
    expect(html).not.toContain("secret-ish");
    expect(html).not.toContain("actorUserId");
  });

  it("shows the read-only platform ceiling with no input in it", () => {
    const html = render({
      data: data({ viewer: { isOrgAdmin: false, isPlatformAdmin: false } }),
    });
    expect(html).toContain("Platform ceiling: $50.00, set by platform admins");
    const m = /<p[^>]*knowledge-platform-ceiling[^>]*>([\s\S]*?)<\/p>/.exec(
      html,
    );
    expect(m?.[1]).not.toContain("<input");
  });
});

describe("OffboardConfirmForm", () => {
  function confirm(typed: string, mismatch = false): string {
    return renderToStaticMarkup(
      <OffboardConfirmForm
        orgSlug="acme-org"
        typed={typed}
        onTypedChange={noop}
        pending={false}
        mismatch={mismatch}
        onConfirm={noop}
      />,
    );
  }

  it("shows the slug and keeps confirm disabled until an exact match", () => {
    expect(confirm("")).toContain("acme-org");
    expect(
      isDisabled(tagWith(confirm("acme-or"), "confirm-button", "button")),
    ).toBe(true);
    expect(
      isDisabled(tagWith(confirm("Acme-org"), "confirm-button", "button")),
    ).toBe(true);
    expect(
      isDisabled(tagWith(confirm("acme-org "), "confirm-button", "button")),
    ).toBe(true);
    expect(
      isDisabled(tagWith(confirm("acme-org"), "confirm-button", "button")),
    ).toBe(false);
  });

  it("shows the server mismatch error", () => {
    expect(confirm("acme-org", true)).toContain("knowledge-offboard-error");
  });
});
