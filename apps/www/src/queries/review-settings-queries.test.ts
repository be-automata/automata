import { createElement } from "react";
import { SELF_HEAL_CLEAR_PATCH } from "@terragon/shared/model/self-heal-settings";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  mergeReviewSetting,
  reviewSettingsQueryKeys,
  useSetReviewSettingMutation,
  type RepoReviewSettingDto,
} from "./review-settings-queries";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function dto(
  repoFullName: string,
  updatedAt: string,
  over: Partial<RepoReviewSettingDto> = {},
): RepoReviewSettingDto {
  return {
    repoFullName,
    blockTolerance: "warning",
    reviewDraftPrs: null,
    supersedePolicy: null,
    recheckOnComplete: false,
    reviewMode: null,
    reviewBatteries: null,
    reviewRunTests: null,
    reviewCommandTimeoutS: null,
    reviewMaxTurns: null,
    taskBatteries: null,
    ...SELF_HEAL_CLEAR_PATCH,
    updatedAt,
    ...over,
  };
}

describe("mergeReviewSetting", () => {
  it("replaces the row with the same repo, case-insensitively", () => {
    const list = [dto("acme/web", "T0"), dto("acme/api", "T0")];
    const merged = mergeReviewSetting(
      list,
      dto("Acme/Web", "T1", { reviewMode: "orchestrated" }),
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      updatedAt: "T1",
      reviewMode: "orchestrated",
    });
    expect(merged[1]).toBe(list[1]);
  });

  it("appends a new repo", () => {
    const list = [dto("acme/web", "T0")];
    const merged = mergeReviewSetting(list, dto("acme/new", "T1"));
    expect(merged.map((r) => r.repoFullName)).toEqual(["acme/web", "acme/new"]);
  });

  it("does not mutate its input", () => {
    const list = [dto("acme/web", "T0")];
    mergeReviewSetting(list, dto("acme/web", "T1"));
    expect(list[0]!.updatedAt).toBe("T0");
  });
});

describe("useSetReviewSettingMutation — W3 synchronous cache write", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the returned row into the list cache without a refetch", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(reviewSettingsQueryKeys.list(), [
      dto("acme/web", "T0"),
    ]);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              setting: dto("acme/web", "T1", { reviewMode: "orchestrated" }),
            }),
            { status: 200 },
          ),
      ),
    );

    let mutation: ReturnType<typeof useSetReviewSettingMutation> | undefined;
    function Harness() {
      mutation = useSetReviewSettingMutation();
      return null;
    }
    renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(Harness)),
    );
    if (!mutation) throw new Error("harness did not render");

    await mutation.mutateAsync({
      repoFullName: "acme/web",
      patch: { reviewMode: "orchestrated", expectedUpdatedAt: "T0" },
    });

    const cached = client.getQueryData<RepoReviewSettingDto[]>(
      reviewSettingsQueryKeys.list(),
    );
    expect(cached?.[0]?.updatedAt).toBe("T1");
    expect(cached?.[0]?.reviewMode).toBe("orchestrated");
    expect(invalidate).not.toHaveBeenCalled();
  });
});
