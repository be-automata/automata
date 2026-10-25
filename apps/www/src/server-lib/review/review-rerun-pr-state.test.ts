import { describe, it, vi, beforeEach, expect } from "vitest";
import { getOctokitForApp } from "@/lib/github";
import { resolveBotLogin } from "./bot-login";
import { DRAFT_ERA_NOTE_MARKER } from "./execute-review-from-intent";
import { readPrStateForRerun } from "./review-rerun";

/**
 * The re-run planner's PR read: a commit counts as having a verdict only when
 * a real bot verdict sits there. A degraded comment or a draft-era note (#504)
 * is not one, so a run whose real verdict never posted is still re-run.
 */

const reviews: { rows: unknown[] } = { rows: [] };

const HEAD = "h".repeat(40);

function review(body: string, state = "COMMENTED") {
  return {
    id: 1,
    user: { login: resolveBotLogin() },
    state,
    body,
    commit_id: HEAD,
    submitted_at: "2026-10-24T12:00:00Z",
    dismissed_at: null,
  };
}

describe("readPrStateForRerun — what counts as a verdict at HEAD", () => {
  beforeEach(() => {
    reviews.rows = [];
    vi.mocked(getOctokitForApp).mockImplementation(
      async () =>
        ({
          paginate: async () => reviews.rows,
          rest: {
            pulls: {
              get: async () => ({
                data: { state: "open", head: { sha: HEAD } },
              }),
              listReviews: {},
            },
          },
        }) as never,
    );
  });

  it("a draft-era note at HEAD is not a verdict: the re-run still happens", async () => {
    reviews.rows = [review(`Draft: fine.\n\n${DRAFT_ERA_NOTE_MARKER}`)];
    const state = await readPrStateForRerun("o/r", 5);
    expect(state).toEqual({ open: true, headSha: HEAD, verdictAtHead: false });
  });

  it("a real bot verdict at HEAD is one", async () => {
    reviews.rows = [review("LGTM.", "APPROVED")];
    const state = await readPrStateForRerun("o/r", 5);
    expect(state.verdictAtHead).toBe(true);
  });
});
