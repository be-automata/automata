import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Container wiring, not presentation. The view suite renders
 * `SupersedePolicySectionView` with an explicit `saving` prop, so it can never
 * catch the container handing it the WRONG value — which is exactly how the
 * bug below shipped.
 *
 * `saving` disables every control in the section. `Restore default` runs
 * through its own `useSetReviewSettingMutation` instance (it carries different
 * toast copy), and that instance was missing from the `saving` expression. So
 * during a restore the controls stayed live, a double-click fired two PUTs
 * carrying the same `expectedUpdatedAt`, the second lost the DB-level CAS race,
 * and its 409 rendered as "Another admin just saved changes" — a conflict the
 * user had with nobody but themselves, in the one component whose whole job is
 * to make concurrent writes legible.
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

const OVERRIDE_ROW = {
  repoFullName: "acme/api",
  supersedePolicy: "newest-wins" as const,
  recheckOnComplete: false,
  updatedAt: "2026-08-25T00:00:00.000Z",
};

/** Each writer's pending flag, flipped per test. */
const pending = {
  setDefault: false,
  setOverride: false,
  restoreOverride: false,
};

const mutationStub = (isPending: boolean) => ({
  mutate: vi.fn(),
  isPending,
});

vi.mock("@/queries/supersede-policy-queries", () => ({
  useSupersedeDefaultQuery: () => ({
    data: {
      supersedePolicy: "newest-wins",
      recheckOnComplete: false,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useSetSupersedeDefaultMutation: () => mutationStub(pending.setDefault),
}));

vi.mock("@/queries/review-settings-queries", () => ({
  useReviewSettingsQuery: () => ({
    data: [OVERRIDE_ROW],
    isLoading: false,
    refetch: vi.fn(),
  }),
  // The container creates the plain override writer FIRST and the
  // restore-default writer SECOND; distinguish them by call order so each
  // instance's pending flag is independently controllable.
  useSetReviewSettingMutation: (() => {
    let call = 0;
    return () => {
      const isRestore = call++ % 2 === 1;
      return mutationStub(
        isRestore ? pending.restoreOverride : pending.setOverride,
      );
    };
  })(),
}));

vi.mock("@/queries/user-repo-queries", () => ({
  useUserReposQuery: () => ({ data: { repos: [] }, isLoading: false }),
}));

const { SupersedePolicySection } = await import("./supersede-policy-section");

const renderContainer = () => renderToStaticMarkup(<SupersedePolicySection />);

/**
 * React serializes a true boolean attribute as `disabled=""`. Matching bare
 * "disabled" would also hit Tailwind's `disabled:` class variants, which are
 * in the markup whether or not anything is actually disabled.
 */
const countDisabled = (html: string) =>
  (html.match(/disabled=""/g) ?? []).length;

describe("SupersedePolicySection (container) — every writer disables the section", () => {
  beforeEach(() => {
    pending.setDefault = false;
    pending.setOverride = false;
    pending.restoreOverride = false;
  });

  it("idle → controls are live", () => {
    expect(countDisabled(renderContainer())).toBe(0);
  });

  it("saving the org default disables the section", () => {
    pending.setDefault = true;
    expect(countDisabled(renderContainer())).toBeGreaterThan(0);
  });

  it("saving a repo override disables the section", () => {
    pending.setOverride = true;
    expect(countDisabled(renderContainer())).toBeGreaterThan(0);
  });

  it("REGRESSION: restoring a default disables the section too, so it cannot be double-clicked into a self-inflicted 409", () => {
    pending.restoreOverride = true;
    expect(countDisabled(renderContainer())).toBeGreaterThan(0);
  });
});
