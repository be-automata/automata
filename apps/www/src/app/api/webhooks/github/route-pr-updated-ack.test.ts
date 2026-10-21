import crypto from "crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@terragon/env/apps-www";

import { getIsPRAuthor } from "@/lib/github";
import { waitUntil } from "@/lib/wait-until";
import { runPullRequestAutomation } from "@/server-lib/automations";
import { getPullRequestAutomationsForRepo } from "@terragon/shared/model/automations";
import { upsertDesiredHead } from "@terragon/shared/model/supersede-recheck";
import type { Automation } from "@terragon/shared/db/types";
import {
  createMockNextRequest,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";

import { POST } from "./route";

/**
 * A pull_request delivery acks before the automation runs.
 *
 * protects: GitHub's 10s delivery timeout. A run makes many sequential GitHub
 *   round trips (token mints, the PR read, the skill override, the
 *   review-context prefetch); awaited inside the response they outran it and
 *   GitHub recorded a failed delivery, which it never retries.
 * fails_when: the route waits for a run to finish, a run no longer starts
 *   after the ack, the desired head stops being recorded before the ack, or a
 *   run's failure stops being logged.
 * no_claim: the Workers runtime's waitUntil lifetime (30s after the response).
 */

vi.mock("@terragon/shared/model/automations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/automations")
  >()),
  getPullRequestAutomationsForRepo: vi.fn(),
}));
vi.mock("@terragon/shared/model/supersede-recheck", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/supersede-recheck")
  >()),
  upsertDesiredHead: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/server-lib/automations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server-lib/automations")>()),
  runPullRequestAutomation: vi.fn(),
}));

const REPO = "owner/repo";
const DELIVERY_ID = "delivery-ack-1";

function automation(filter: Record<string, unknown>): Automation {
  return {
    id: "review-1",
    userId: "user-1",
    organizationId: "org-1",
    repoFullName: REPO,
    triggerType: "pull_request",
    triggerConfig: { filter, on: { open: true, update: true } },
    action: {
      type: "skill_message",
      config: { skillName: "github-ops", version: "latest" },
    },
  } as unknown as Automation;
}

async function synchronizeRequest() {
  const body = {
    action: "synchronize",
    sender: { login: "dev", type: "User" },
    pull_request: {
      number: 88,
      draft: false,
      head: { sha: "d".repeat(40), ref: "feat/x" },
      updated_at: "2026-10-21T00:37:27Z",
      user: { login: "dev", id: 1 },
    },
    repository: { full_name: REPO, owner: { login: "owner" }, name: "repo" },
  };
  const payload = JSON.stringify(body);
  const signature = `sha256=${crypto
    .createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;
  return createMockNextRequest(body, {
    "x-github-delivery": DELIVERY_ID,
    "x-hub-signature-256": signature,
    "x-github-event": "pull_request",
  });
}

describe("pull_request.synchronize acks before the automation runs", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await mockWaitUntil();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("returns 200 while the run is still in flight, then the run completes", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ includeAllAuthors: true }),
    ]);
    let release!: () => void;
    let runFinished = false;
    vi.mocked(runPullRequestAutomation).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      runFinished = true;
      return true;
    });

    const response = await POST(await synchronizeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    // The desired head is durable before the ack; the run is not done.
    expect(upsertDesiredHead).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "d".repeat(40), deliveryId: DELIVERY_ID }),
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(runFinished).toBe(false);

    await vi.waitFor(() => expect(runPullRequestAutomation).toHaveBeenCalled());
    release();
    await waitUntilResolved();

    expect(runFinished).toBe(true);
    expect(runPullRequestAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: "review-1",
        prEventAction: "synchronize",
        prNumber: 88,
        deliveryId: DELIVERY_ID,
      }),
    );
  });

  it("a run that fails after the ack is logged, and the delivery stays acked", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ includeAllAuthors: false }),
    ]);
    vi.mocked(getIsPRAuthor).mockRejectedValue(new Error("GitHub is slow"));

    const response = await POST(await synchronizeRequest());
    expect(response.status).toBe(200);

    await waitUntilResolved();
    expect(runPullRequestAutomation).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Error handling 1 pull request automations: Error: GitHub is slow",
      ),
    );
  });

  it("runs at most five automations at once and refills a free slot without pausing", async () => {
    // Every run shares one waitUntil budget, so a slow run must not hold the
    // rest behind a lock-step batch plus a 1s pause.
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        ...automation({ includeAllAuthors: true }),
        id: `review-${i}`,
      })),
    );
    const release = new Map<string, () => void>();
    vi.mocked(runPullRequestAutomation).mockImplementation(
      ({ automationId }) =>
        new Promise<boolean>((resolve) => {
          release.set(automationId, () => resolve(true));
        }),
    );

    const response = await POST(await synchronizeRequest());
    expect(response.status).toBe(200);
    // One org on the delivery: one desired-head write.
    expect(upsertDesiredHead).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(release.size).toBe(5));
    expect([...release.keys()].sort()).toEqual(
      ["review-0", "review-1", "review-2", "review-3", "review-4"].sort(),
    );
    // One run finishing frees one slot; the next run starts well inside the
    // old 1s inter-batch pause while the other four are still in flight.
    release.get("review-3")!();
    await vi.waitFor(() => expect(release.size).toBe(6), { timeout: 300 });
    expect(release.has("review-5")).toBe(true);
    expect(release.has("review-6")).toBe(false);

    for (const id of ["review-0", "review-1", "review-2", "review-4"]) {
      release.get(id)!();
    }
    await vi.waitFor(() => expect(release.size).toBe(7), { timeout: 300 });
    release.get("review-5")!();
    release.get("review-6")!();
    await waitUntilResolved();
    expect(runPullRequestAutomation).toHaveBeenCalledTimes(7);
  });

  it("a repo with no pull request automation schedules nothing", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([]);

    const response = await POST(await synchronizeRequest());

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(upsertDesiredHead).not.toHaveBeenCalled();
  });
});
