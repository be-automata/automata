import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Container wiring (hooks mocked): Restore default writes the self-heal
 * clear patch with the row's version, through the restore writer.
 */

const mutations = {
  setDefault: vi.fn(),
  setOverride: vi.fn(),
  restore: vi.fn(),
};

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: <T,>(initial: T) => [initial, vi.fn()] as const,
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("@/queries/supersede-policy-queries", () => ({
  useSupersedeDefaultQuery: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSetSupersedeDefaultMutation: () => ({
    mutate: mutations.setDefault,
    isPending: false,
  }),
}));
let call = 0;
vi.mock("@/queries/review-settings-queries", () => ({
  useReviewSettingsQuery: () => ({
    data: [],
    isLoading: false,
    refetch: vi.fn(),
  }),
  useSetReviewSettingMutation: () => {
    const isRestore = call++ % 2 === 1;
    return {
      mutate: isRestore ? mutations.restore : mutations.setOverride,
      isPending: false,
    };
  },
}));
vi.mock("@/queries/user-repo-queries", () => ({
  useUserReposQuery: () => ({ data: { repos: [] } }),
}));

import { SELF_HEAL_CLEAR_PATCH as SHARED_CLEAR_PATCH } from "@terragon/shared/model/self-heal-settings";
import { useSelfHealSectionModel } from "./self-heal-section";
import { NO_SELF_HEAL_VALUES } from "./self-heal-form";

function Probe({ onActions }: { onActions: (a: unknown) => void }) {
  onActions(useSelfHealSectionModel().actions);
  return null;
}

describe("useSelfHealSectionModel", () => {
  beforeEach(() => {
    call = 0;
    vi.clearAllMocks();
  });

  it("Restore default clears only self-heal fields via the restore writer", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    let captured: ReturnType<typeof useSelfHealSectionModel>["actions"] | null =
      null;
    renderToStaticMarkup(
      <Probe
        onActions={(a) => {
          captured = a as typeof captured;
        }}
      />,
    );
    if (captured === null) throw new Error("actions not captured");
    const actions = captured as ReturnType<
      typeof useSelfHealSectionModel
    >["actions"];
    actions.onRestoreDefault({
      ...NO_SELF_HEAL_VALUES,
      selfHealMode: "on",
      repoFullName: "acme/api",
      updatedAt: "v1",
    });
    expect(mutations.restore).toHaveBeenCalledTimes(1);
    expect(mutations.setOverride).not.toHaveBeenCalled();
    expect(mutations.restore.mock.calls[0]?.[0]).toEqual({
      repoFullName: "acme/api",
      patch: { ...SHARED_CLEAR_PATCH, expectedUpdatedAt: "v1" },
    });
  });
});
