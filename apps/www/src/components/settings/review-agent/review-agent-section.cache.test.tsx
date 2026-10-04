import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reviewSettingsQueryKeys,
  type RepoReviewSettingDto,
} from "@/queries/review-settings-queries";
import { supersedeDefaultQueryKeys } from "@/queries/supersede-policy-queries";
import { useReviewAgentSectionModel } from "./review-agent-section";

/**
 * W3, end to end through the REAL query hooks: two saves in a row on the same
 * repo row. Before the synchronous cache merge, the second save still sent
 * the first read's updatedAt and lost its own CAS (a self-inflicted 409).
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/queries/user-repo-queries", () => ({
  useUserReposQuery: () => ({ data: { repos: [] }, isLoading: false }),
}));

const T0 = "2026-10-03T00:00:00.000Z";
const T1 = "2026-10-03T00:01:00.000Z";
const T2 = "2026-10-03T00:02:00.000Z";

function dto(updatedAt: string, maxTurns: number | null): RepoReviewSettingDto {
  return {
    repoFullName: "acme/api",
    blockTolerance: "warning",
    reviewDraftPrs: null,
    supersedePolicy: null,
    recheckOnComplete: false,
    reviewMode: "orchestrated",
    reviewBatteries: null,
    reviewRunTests: null,
    reviewCommandTimeoutS: null,
    reviewMaxTurns: maxTurns,
    updatedAt,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReviewAgentSection — back-to-back saves (W3)", () => {
  it("the second PUT carries the first save's updatedAt and no conflict renders", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(reviewSettingsQueryKeys.list(), [dto(T0, null)]);
    client.setQueryData(supersedeDefaultQueryKeys.detail(), null);

    const putBodies: Record<string, unknown>[] = [];
    const responses = [dto(T1, 40), dto(T2, 50)];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBodies.push(JSON.parse(String(init.body)));
        const setting = responses.shift();
        return new Response(JSON.stringify({ setting }), { status: 200 });
      }
      // A background refetch of the list returns the latest cached state.
      return new Response(
        JSON.stringify({
          settings: client.getQueryData(reviewSettingsQueryKeys.list()),
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const render = () => {
      let model: ReturnType<typeof useReviewAgentSectionModel> | undefined;
      function Harness() {
        model = useReviewAgentSectionModel();
        return null;
      }
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      );
      if (!model || model.state.kind !== "ready") {
        throw new Error("model not ready");
      }
      return { state: model.state, actions: model.actions };
    };

    const first = render();
    first.actions.onSaveOverride(first.state.overrides[0]!, {
      reviewMaxTurns: 40,
    });
    await vi.waitFor(() => {
      const list = client.getQueryData<RepoReviewSettingDto[]>(
        reviewSettingsQueryKeys.list(),
      );
      expect(list?.[0]?.updatedAt).toBe(T1);
    });

    const second = render();
    second.actions.onSaveOverride(second.state.overrides[0]!, {
      reviewMaxTurns: 50,
    });
    await vi.waitFor(() => expect(putBodies).toHaveLength(2));

    expect(putBodies[0]).toMatchObject({ expectedUpdatedAt: T0 });
    expect(putBodies[1]).toMatchObject({ expectedUpdatedAt: T1 });
    expect(render().state.conflict).toBe(false);
  });
});
