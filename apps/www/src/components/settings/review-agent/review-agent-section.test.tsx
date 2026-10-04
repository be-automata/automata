import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  BATTERY_PACK_IDS,
  BATTERY_PACK_LABELS,
  effectiveReviewMode,
  type ReviewAgentValues,
} from "@terragon/shared/model/review-agent-settings";
import {
  CLASSIC_HINT,
  ReviewAgentFieldsView,
  TASK_PACKS_OVERLAP_NOTE,
  ReviewAgentSectionView,
  type ReviewAgentSectionActions,
  type ReviewAgentSectionState,
} from "./review-agent-section";
import {
  MAX_TURNS_LABEL,
  MAX_TURNS_NOTE,
  REVIEW_AGENT_CLEAR_PATCH,
  availableReviewAgentRepos,
  draftFromValues,
  draftToPatch,
  firstWriteFence,
  hasReviewAgentOverride,
  parseOptionalInt,
  reviewAgentOverrides,
  type ReviewAgentOverrideRow,
} from "./review-agent-form";

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

const NO_AGENT = {
  reviewMode: null,
  reviewBatteries: null,
  reviewRunTests: null,
  reviewCommandTimeoutS: null,
  reviewMaxTurns: null,
  taskBatteries: null,
};

function row(
  repoFullName: string,
  over: Partial<{
    reviewMode: "classic" | "orchestrated" | null;
    reviewBatteries:
      | ("gstack-review" | "somnio-review" | "gsd-reviewers")[]
      | null;
    reviewRunTests: boolean | null;
    reviewCommandTimeoutS: number | null;
    reviewMaxTurns: number | null;
    supersedePolicy: string | null;
  }> = {},
  updatedAt = "2026-10-03T00:00:00.000Z",
) {
  return {
    repoFullName,
    supersedePolicy: null,
    ...NO_AGENT,
    ...over,
    updatedAt,
  };
}

describe("effectiveReviewMode", () => {
  it("falls back to classic when nothing is set", () => {
    expect(effectiveReviewMode(null, null)).toBe("classic");
  });

  it("inherits the org value", () => {
    expect(effectiveReviewMode(null, "orchestrated")).toBe("orchestrated");
  });

  it("prefers the repo value", () => {
    expect(effectiveReviewMode("classic", "orchestrated")).toBe("classic");
  });
});

describe("reviewAgentOverrides", () => {
  it("keeps rows with any review-agent field set, including an empty pack list", () => {
    const rows = [
      row("acme/none", { supersedePolicy: "newest-wins" }),
      row("acme/mode", { reviewMode: "orchestrated" }),
      row("acme/packs", { reviewBatteries: [] }),
      row("acme/turns", { reviewMaxTurns: 10 }),
    ];
    expect(reviewAgentOverrides(rows).map((r) => r.repoFullName)).toEqual([
      "acme/mode",
      "acme/packs",
      "acme/turns",
    ]);
  });
});

describe("availableReviewAgentRepos", () => {
  it("offers repos without a review-agent override, case-insensitively, sorted", () => {
    const settings = [
      row("acme/api", { reviewMode: "classic" }),
      row("acme/web", { supersedePolicy: "newest-wins" }),
    ];
    expect(
      availableReviewAgentRepos(["Acme/Web", "zeta/x", "Acme/API"], settings),
    ).toEqual(["Acme/Web", "zeta/x"]);
  });
});

describe("firstWriteFence", () => {
  it("returns the existing row's version (case-insensitive)", () => {
    const settings = [
      row(
        "acme/web",
        { supersedePolicy: "newest-wins" },
        "2026-10-01T00:00:00.000Z",
      ),
    ];
    expect(firstWriteFence("Acme/Web", settings)).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("returns null when the repo has no row at all", () => {
    expect(firstWriteFence("acme/new", [])).toBeNull();
  });
});

describe("REVIEW_AGENT_CLEAR_PATCH", () => {
  it("clears all six fields, task packs included", () => {
    expect(REVIEW_AGENT_CLEAR_PATCH).toEqual(NO_AGENT);
    expect(Object.keys(REVIEW_AGENT_CLEAR_PATCH)).toHaveLength(6);
    expect(REVIEW_AGENT_CLEAR_PATCH.taskBatteries).toBeNull();
  });
});

describe("task packs (phase 7) — form helpers", () => {
  it("a row with only task packs is an override, an empty list included", () => {
    expect(hasReviewAgentOverride({ ...NO_AGENT, taskBatteries: [] })).toBe(
      true,
    );
    expect(
      hasReviewAgentOverride({ ...NO_AGENT, taskBatteries: ["somnio-skills"] }),
    ).toBe(true);
    expect(hasReviewAgentOverride(NO_AGENT)).toBe(false);
  });

  it("draftFromValues / draftToPatch round-trip taskBatteries", () => {
    const stored: ReviewAgentValues = {
      ...NO_AGENT,
      taskBatteries: ["somnio-skills"],
    };
    const draft = draftFromValues(stored);
    expect(draft.taskBatteries).toEqual(["somnio-skills"]);
    expect(draftToPatch(draft, stored)).toEqual({ patch: {} });
  });

  it("changing only the task packs sends exactly {taskBatteries}", () => {
    const stored: ReviewAgentValues = {
      ...NO_AGENT,
      reviewMode: "orchestrated",
    };
    const draft = {
      ...draftFromValues(stored),
      taskBatteries: ["somnio-skills" as const],
    };
    expect(draftToPatch(draft, stored)).toEqual({
      patch: { taskBatteries: ["somnio-skills"] },
    });
  });

  it("choosing Inherit again clears to null", () => {
    const stored: ReviewAgentValues = { ...NO_AGENT, taskBatteries: [] };
    const draft = { ...draftFromValues(stored), taskBatteries: null };
    expect(draftToPatch(draft, stored).patch).toEqual({ taskBatteries: null });
  });
});

describe("parseOptionalInt", () => {
  it("empty means inherit", () => {
    expect(parseOptionalInt("")).toBeNull();
    expect(parseOptionalInt("  ")).toBeNull();
  });

  it("parses a whole number", () => {
    expect(parseOptionalInt("120")).toBe(120);
  });

  it.each(["abc", "12.5", "-3", "1e2"])("rejects %j", (text) => {
    expect(parseOptionalInt(text)).toBeUndefined();
  });
});

describe("draftToPatch", () => {
  const stored: ReviewAgentValues = {
    ...NO_AGENT,
    reviewMode: "orchestrated",
    reviewCommandTimeoutS: 120,
  };

  it("sends only changed fields", () => {
    const draft = { ...draftFromValues(stored), maxTurnsText: "40" };
    expect(draftToPatch(draft, stored)).toEqual({
      patch: { reviewMaxTurns: 40 },
    });
  });

  it("an emptied number input clears to inherit", () => {
    const draft = { ...draftFromValues(stored), timeoutText: "" };
    expect(draftToPatch(draft, stored).patch).toEqual({
      reviewCommandTimeoutS: null,
    });
  });

  it("an out-of-range timeout is an inline error and is not sent", () => {
    const draft = { ...draftFromValues(stored), timeoutText: "30" };
    const result = draftToPatch(draft, stored);
    expect(result.timeoutError).toBe("60-600 seconds");
    expect(result.patch).toEqual({});
  });
});

const actions: ReviewAgentSectionActions = {
  onSaveDefault: vi.fn(),
  onSaveOverride: vi.fn(),
  onRestoreDefault: vi.fn(),
  onAddOverride: vi.fn(),
  onReload: vi.fn(),
};

const render = (state: ReviewAgentSectionState) =>
  renderToStaticMarkup(
    <ReviewAgentSectionView state={state} actions={actions} />,
  );

const ready = (
  over: Partial<Extract<ReviewAgentSectionState, { kind: "ready" }>> = {},
): ReviewAgentSectionState => ({
  kind: "ready",
  orgDefault: { ...NO_AGENT },
  orgDefaultVersion: null,
  conflict: false,
  saving: false,
  overridesLoading: false,
  overrides: [],
  availableRepos: [],
  ...over,
});

/** The opening tag of the element with this id. */
function tagWithId(html: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = html.match(new RegExp(`<[^>]*id="${escaped}"[^>]*>`));
  if (!match) throw new Error(`no element with id ${id}`);
  return match[0];
}

const isDisabled = (html: string, id: string) =>
  tagWithId(html, id).includes('disabled=""');

const ORCHESTRATED_ONLY = [
  "pack-gstack-review",
  "packs-inherit",
  "run-tests",
  "timeout",
  "max-turns",
];

describe("ReviewAgentSectionView", () => {
  it("loading → skeleton", () => {
    expect(render({ kind: "loading" })).toContain(
      'data-testid="review-agent-skeleton"',
    );
  });

  it("error → the message", () => {
    const html = render({ kind: "error", message: "boom happened" });
    expect(html).toContain("boom happened");
  });

  it("all-null org default (classic): orchestrated-only fields disabled, hint and notes shown", () => {
    const html = render(ready());
    expect(html).toContain("Inherit (classic)");
    expect(html).toContain(CLASSIC_HINT);
    for (const suffix of ORCHESTRATED_ONLY) {
      expect(isDisabled(html, `review-agent-org-${suffix}`)).toBe(true);
    }
    expect(isDisabled(html, "review-agent-org-mode")).toBe(false);
    expect(html).toContain(
      "Pull requests from forks or untrusted authors never run tests.",
    );
    expect(html).toContain(MAX_TURNS_LABEL);
    expect(html).toContain(MAX_TURNS_NOTE.replace(/'/g, "&#x27;"));
  });

  it("orchestrated org default: fields enabled, no hint, default placeholders", () => {
    const html = render(
      ready({ orgDefault: { ...NO_AGENT, reviewMode: "orchestrated" } }),
    );
    for (const suffix of ORCHESTRATED_ONLY) {
      expect(isDisabled(html, `review-agent-org-${suffix}`)).toBe(false);
    }
    expect(html).not.toContain(CLASSIC_HINT);
    expect(tagWithId(html, "review-agent-org-timeout")).toContain(
      'placeholder="300"',
    );
    expect(tagWithId(html, "review-agent-org-max-turns")).toContain(
      'placeholder="unset"',
    );
  });

  const overrideRow = (
    repoFullName: string,
    over: Partial<ReviewAgentValues>,
  ): ReviewAgentOverrideRow => ({
    repoFullName,
    ...NO_AGENT,
    ...over,
    updatedAt: "2026-10-03T00:00:00.000Z",
  });

  it("a repo row inheriting an orchestrated org default is enabled; a classic repo row is disabled with the hint", () => {
    const html = render(
      ready({
        orgDefault: { ...NO_AGENT, reviewMode: "orchestrated" },
        overrides: [
          overrideRow("acme/inherits", { reviewRunTests: true }),
          overrideRow("acme/classic", { reviewMode: "classic" }),
        ],
      }),
    );
    for (const suffix of ORCHESTRATED_ONLY) {
      expect(
        isDisabled(html, `review-agent-repo-acme/inherits-${suffix}`),
      ).toBe(false);
      expect(isDisabled(html, `review-agent-repo-acme/classic-${suffix}`)).toBe(
        true,
      );
    }
    expect(html).toContain(
      'data-testid="review-agent-repo-acme/classic-classic-hint"',
    );
    expect(html).not.toContain(
      'data-testid="review-agent-repo-acme/inherits-classic-hint"',
    );
  });

  it("conflict → banner with Reload", () => {
    const html = render(ready({ conflict: true }));
    expect(html).toContain('data-testid="review-agent-conflict"');
    expect(html).toContain("Another admin just saved changes");
    expect(html).toContain("Reload");
  });

  it("empty overrides → empty-state copy; overrides → one row each with Restore default", () => {
    expect(render(ready())).toContain(
      'data-testid="review-agent-overrides-empty"',
    );
    const html = render(
      ready({
        overrides: [
          overrideRow("acme/a", { reviewMode: "classic" }),
          overrideRow("acme/b", { reviewMaxTurns: 9 }),
        ],
      }),
    );
    expect(html.match(/data-testid="review-agent-override"/g)).toHaveLength(2);
    expect(html.match(/Restore default/g)).toHaveLength(2);
    expect(html).not.toContain('data-testid="review-agent-overrides-empty"');
  });

  it("saving disables every control", () => {
    const html = render(ready({ saving: true }));
    expect(isDisabled(html, "review-agent-org-mode")).toBe(true);
    expect(isDisabled(html, "review-agent-org-save")).toBe(true);
  });
});

describe("ReviewAgentFieldsView — inline validation", () => {
  it("an out-of-range timeout shows the error and keeps Save disabled", () => {
    const stored: ReviewAgentValues = {
      ...NO_AGENT,
      reviewMode: "orchestrated",
    };
    const html = renderToStaticMarkup(
      <ReviewAgentFieldsView
        idPrefix="t"
        scope="org"
        draft={{ ...draftFromValues(stored), timeoutText: "30" }}
        stored={stored}
        inherited={null}
        disabled={false}
        saveLabel="Save"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain('data-testid="t-timeout-error"');
    expect(html).toContain("60-600 seconds");
    expect(isDisabled(html, "t-save")).toBe(true);
  });

  it("a valid change enables Save", () => {
    const stored: ReviewAgentValues = {
      ...NO_AGENT,
      reviewMode: "orchestrated",
    };
    const html = renderToStaticMarkup(
      <ReviewAgentFieldsView
        idPrefix="t"
        scope="org"
        draft={{ ...draftFromValues(stored), maxTurnsText: "40" }}
        stored={stored}
        inherited={null}
        disabled={false}
        saveLabel="Save"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(isDisabled(html, "t-save")).toBe(false);
  });
});

describe("ReviewAgentFieldsView — Task agent packs (phase 7)", () => {
  const view = (
    over: Partial<{
      scope: "org" | "repo";
      stored: ReviewAgentValues;
      inherited: ReviewAgentValues | null;
      disabled: boolean;
    }> = {},
  ) => {
    const stored = over.stored ?? { ...NO_AGENT };
    return renderToStaticMarkup(
      <ReviewAgentFieldsView
        idPrefix="t"
        scope={over.scope ?? "org"}
        draft={draftFromValues(stored)}
        stored={stored}
        inherited={over.inherited ?? null}
        disabled={over.disabled ?? false}
        saveLabel="Save"
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
  };

  it("renders one checkbox per manifest pack plus Inherit, labelled from the shared labels", () => {
    const html = view();
    expect(html).toContain("Task agent packs");
    for (const id of BATTERY_PACK_IDS) {
      expect(tagWithId(html, `t-task-pack-${id}`)).toBeTruthy();
      expect(html).toContain(BATTERY_PACK_LABELS[id]);
    }
    expect(tagWithId(html, "t-task-packs-inherit")).toBeTruthy();
    expect(html).toContain("Inherit (none)");
  });

  it("classic mode keeps the task checkboxes enabled while the review packs are disabled", () => {
    const html = view();
    expect(isDisabled(html, "t-pack-gstack-review")).toBe(true);
    expect(isDisabled(html, "t-task-packs-inherit")).toBe(false);
    for (const id of BATTERY_PACK_IDS) {
      expect(isDisabled(html, `t-task-pack-${id}`)).toBe(false);
    }
  });

  it("disabled (saving) disables the task checkboxes too", () => {
    const html = view({ disabled: true });
    expect(isDisabled(html, "t-task-packs-inherit")).toBe(true);
    for (const id of BATTERY_PACK_IDS) {
      expect(isDisabled(html, `t-task-pack-${id}`)).toBe(true);
    }
  });

  it("the help text names the runs that get the packs and the security-audit overlap", () => {
    const html = view();
    expect(html).toContain("manual, scheduled and mention task runs");
    expect(html).toContain("none = today");
    expect(html).toContain(TASK_PACKS_OVERLAP_NOTE);
    expect(TASK_PACKS_OVERLAP_NOTE).toMatch(/security-audit/);
  });

  it("a repo row inheriting an org list shows it; the stored list is checked", () => {
    const html = view({
      scope: "repo",
      inherited: { ...NO_AGENT, taskBatteries: ["somnio-skills"] },
    });
    expect(html).toContain(
      `Inherit (org default: ${BATTERY_PACK_LABELS["somnio-skills"]})`,
    );
    expect(tagWithId(html, "t-task-pack-somnio-skills")).toContain(
      'data-state="checked"',
    );
    expect(tagWithId(html, "t-task-packs-inherit")).toContain(
      'data-state="checked"',
    );
  });

  it("a repo row inheriting nothing says so", () => {
    const html = view({ scope: "repo", inherited: { ...NO_AGENT } });
    expect(html).toContain("Inherit (org default)");
  });

  it("a stored empty list unchecks Inherit and every pack", () => {
    const html = view({ stored: { ...NO_AGENT, taskBatteries: [] } });
    expect(tagWithId(html, "t-task-packs-inherit")).toContain(
      'data-state="unchecked"',
    );
    for (const id of BATTERY_PACK_IDS) {
      expect(tagWithId(html, `t-task-pack-${id}`)).toContain(
        'data-state="unchecked"',
      );
    }
  });
});
