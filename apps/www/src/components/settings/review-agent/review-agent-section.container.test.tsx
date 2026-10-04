import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Container wiring (hooks mocked): which mutation each action calls, with
 * which fence, and that `saving` ORs every writer. The view suite cannot
 * catch the container handing it the wrong value.
 */

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div className={className} data-skeleton="" />
  ),
}));
vi.mock("@/components/settings/settings-row", () => ({
  SettingsSection: ({
    label,
    children,
  }: {
    label: string;
    description?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <section>
      <h3>{label}</h3>
      {children}
    </section>
  ),
}));

const DEFAULT_VERSION = "2026-10-01T00:00:00.000Z";
const OVERRIDE_ROW = {
  repoFullName: "acme/api",
  blockTolerance: "warning",
  reviewDraftPrs: null,
  supersedePolicy: null,
  recheckOnComplete: false,
  reviewMode: "orchestrated" as const,
  reviewBatteries: null,
  reviewRunTests: null,
  reviewCommandTimeoutS: null,
  reviewMaxTurns: null,
  updatedAt: "2026-10-02T00:00:00.000Z",
};
const SUPERSEDE_ONLY_ROW = {
  ...OVERRIDE_ROW,
  repoFullName: "acme/web",
  supersedePolicy: "newest-wins",
  reviewMode: null,
  updatedAt: "2026-10-02T05:00:00.000Z",
};

const pending = { setDefault: false, setOverride: false, restore: false };
const mutations = {
  setDefault: vi.fn(),
  setOverride: vi.fn(),
  restore: vi.fn(),
};

vi.mock("@/queries/supersede-policy-queries", () => ({
  useSupersedeDefaultQuery: () => ({
    data: {
      supersedePolicy: null,
      recheckOnComplete: false,
      reviewDraftPrs: null,
      reviewMode: null,
      reviewBatteries: null,
      reviewRunTests: null,
      reviewCommandTimeoutS: null,
      reviewMaxTurns: null,
      updatedAt: DEFAULT_VERSION,
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSetSupersedeDefaultMutation: () => ({
    mutate: mutations.setDefault,
    isPending: pending.setDefault,
  }),
}));

vi.mock("@/queries/review-settings-queries", () => ({
  useReviewSettingsQuery: () => ({
    data: [OVERRIDE_ROW, SUPERSEDE_ONLY_ROW],
    isLoading: false,
    refetch: vi.fn(),
  }),
  // The model creates the save writer FIRST and the restore writer SECOND.
  useSetReviewSettingMutation: (() => {
    let call = 0;
    return () => {
      const isRestore = call++ % 2 === 1;
      return isRestore
        ? { mutate: mutations.restore, isPending: pending.restore }
        : { mutate: mutations.setOverride, isPending: pending.setOverride };
    };
  })(),
}));

vi.mock("@/queries/user-repo-queries", () => ({
  useUserReposQuery: () => ({
    data: {
      repos: [
        { full_name: "acme/api" },
        { full_name: "acme/web" },
        { full_name: "acme/new" },
      ],
    },
    isLoading: false,
  }),
}));

const {
  ReviewAgentSection,
  useReviewAgentSectionModel,
  REVIEW_AGENT_CLEAR_PATCH,
} = await import("./review-agent-section");

function captureModel() {
  let model: ReturnType<typeof useReviewAgentSectionModel> | undefined;
  function Harness() {
    model = useReviewAgentSectionModel();
    return null;
  }
  renderToStaticMarkup(<Harness />);
  if (!model) throw new Error("harness did not render");
  return model;
}

const countDisabled = (html: string) =>
  (html.match(/disabled=""/g) ?? []).length;

describe("ReviewAgentSection (container)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.setDefault = false;
    pending.setOverride = false;
    pending.restore = false;
  });

  it("changing the org mode sends the default mutation with the stored version", () => {
    const { actions } = captureModel();
    actions.onSaveDefault({ reviewMode: "orchestrated" });
    expect(mutations.setDefault).toHaveBeenCalledWith(
      { reviewMode: "orchestrated", expectedUpdatedAt: DEFAULT_VERSION },
      expect.anything(),
    );
  });

  it("Restore default clears all five fields with the row's version, via the restore writer", () => {
    const { state, actions } = captureModel();
    if (state.kind !== "ready") throw new Error("not ready");
    const row = state.overrides[0]!;
    actions.onRestoreDefault(row);
    expect(mutations.restore).toHaveBeenCalledWith(
      {
        repoFullName: "acme/api",
        patch: {
          ...REVIEW_AGENT_CLEAR_PATCH,
          expectedUpdatedAt: row.updatedAt,
        },
      },
      expect.anything(),
    );
    expect(mutations.setOverride).not.toHaveBeenCalled();
  });

  it("Add override: no row → null fence; a supersede-only row → its version", () => {
    const { state, actions } = captureModel();
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.availableRepos).toEqual(["acme/new", "acme/web"]);
    actions.onAddOverride("acme/new", { reviewRunTests: true });
    expect(mutations.setOverride).toHaveBeenLastCalledWith(
      {
        repoFullName: "acme/new",
        patch: { reviewRunTests: true, expectedUpdatedAt: null },
      },
      expect.anything(),
    );
    actions.onAddOverride("acme/web", { reviewMode: "orchestrated" });
    expect(mutations.setOverride).toHaveBeenLastCalledWith(
      {
        repoFullName: "acme/web",
        patch: {
          reviewMode: "orchestrated",
          expectedUpdatedAt: SUPERSEDE_ONLY_ROW.updatedAt,
        },
      },
      expect.anything(),
    );
  });

  it("only rows with a review-agent override are listed", () => {
    const { state } = captureModel();
    if (state.kind !== "ready") throw new Error("not ready");
    expect(state.overrides.map((r) => r.repoFullName)).toEqual(["acme/api"]);
  });

  it.each(["setDefault", "setOverride", "restore"] as const)(
    "a pending %s writer disables the section",
    (writer) => {
      const idle = countDisabled(renderToStaticMarkup(<ReviewAgentSection />));
      pending[writer] = true;
      const html = renderToStaticMarkup(<ReviewAgentSection />);
      expect(captureModel().state).toMatchObject({ saving: true });
      expect(countDisabled(html)).toBeGreaterThan(idle);
    },
  );
});
