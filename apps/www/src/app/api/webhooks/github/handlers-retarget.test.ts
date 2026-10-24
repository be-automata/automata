import { beforeEach, describe, expect, it, vi } from "vitest";

import { runPullRequestAutomation } from "@/server-lib/automations";
import { getPullRequestAutomationsForRepo } from "@terragon/shared/model/automations";
import type { Automation } from "@terragon/shared/db/types";

import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";

import {
  baseRetargetedFrom,
  handlePullRequestUpdated,
  type PullRequestEvent,
} from "./handlers";

/**
 * A retarget (`pull_request.edited` with `changes.base`) is reviewed like a
 * push: a stacked PR whose parent merged is moved onto the parent's base by
 * GitHub, its diff changes, its head does not.
 *
 * protects: a retargeted child gets a fresh review instead of keeping the
 *   stale "no verdict" notice until someone pushes.
 * fails_when: a retarget starts no run, a title/body edit starts one, or a
 *   retarget at the head an earlier push already reviewed is dropped.
 * no_claim: the writer-side same-review key (execute-review-from-intent
 *   tests own that).
 */

vi.mock("@terragon/shared/model/automations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/automations")
  >()),
  getPullRequestAutomationsForRepo: vi.fn(),
}));
vi.mock("@/server-lib/automations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server-lib/automations")>()),
  runPullRequestAutomation: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));
vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  getIsPRAuthor: vi.fn(() => Promise.resolve(false)),
}));

const REPO = "owner/repo";
const HEAD = "c".repeat(40);

function automation(on: { open: boolean; update: boolean }): Automation {
  return {
    id: "review-1",
    userId: "user-1",
    organizationId: null,
    repoFullName: REPO,
    triggerType: "pull_request",
    triggerConfig: { filter: { includeAllAuthors: true }, on },
    action: {
      type: "skill_message",
      config: { skillName: "github-ops", version: "latest" },
    },
  } as unknown as Automation;
}

function event(
  action: "synchronize" | "edited",
  changes?: Record<string, unknown>,
): PullRequestEvent {
  return {
    action,
    ...(changes ? { changes } : {}),
    sender: { login: "dev", type: "User" },
    pull_request: {
      number: 481,
      draft: false,
      head: { sha: HEAD, ref: "feat/child" },
      base: { ref: "main", sha: "d".repeat(40) },
      updated_at: "2026-10-23T12:00:00Z",
      user: { login: "dev", type: "User" },
    },
    repository: { full_name: REPO },
  } as unknown as PullRequestEvent;
}

const RETARGET = {
  base: { ref: { from: "feat/parent" }, sha: { from: "e".repeat(40) } },
};

async function handleAndDrain(
  e: PullRequestEvent,
  deliveryId?: string,
): Promise<void> {
  await handlePullRequestUpdated(e, deliveryId);
  await waitUntilResolved();
}

describe("baseRetargetedFrom", () => {
  it("returns the old base for an edited event with changes.base", () => {
    expect(baseRetargetedFrom(event("edited", RETARGET))).toBe("feat/parent");
  });
  it("is undefined for a title/body edit and for every other action", () => {
    expect(
      baseRetargetedFrom(event("edited", { title: { from: "old" } })),
    ).toBeUndefined();
    expect(baseRetargetedFrom(event("edited"))).toBeUndefined();
    expect(baseRetargetedFrom(event("synchronize"))).toBeUndefined();
  });
});

describe("pull_request.edited retarget", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await mockWaitUntil();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("a retarget triggers a review run, like a synchronize, naming the old base", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ open: true, update: true }),
    ]);
    await handleAndDrain(event("edited", RETARGET), "delivery-retarget");
    expect(runPullRequestAutomation).toHaveBeenCalledTimes(1);
    expect(runPullRequestAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        prEventAction: "edited",
        prNumber: 481,
        deliveryId: "delivery-retarget",
        baseChangedFrom: "feat/parent",
      }),
    );
  });

  it("a retarget honours the same on.update switch as a push", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ open: true, update: false }),
    ]);
    await handleAndDrain(event("edited", RETARGET), "delivery-retarget");
    expect(runPullRequestAutomation).not.toHaveBeenCalled();
  });

  it("a title or body edit triggers nothing (no automation lookup at all)", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ open: true, update: true }),
    ]);
    await handleAndDrain(
      event("edited", { title: { from: "old title" } }),
      "delivery-title",
    );
    await handleAndDrain(
      event("edited", { body: { from: "old body" } }),
      "delivery-body",
    );
    expect(runPullRequestAutomation).not.toHaveBeenCalled();
    expect(getPullRequestAutomationsForRepo).not.toHaveBeenCalled();
  });

  it("a retarget at the head a push already reviewed is not deduped: both start a run", async () => {
    vi.mocked(getPullRequestAutomationsForRepo).mockResolvedValue([
      automation({ open: true, update: true }),
    ]);
    await handleAndDrain(event("synchronize"), "delivery-push");
    await handleAndDrain(event("edited", RETARGET), "delivery-retarget");
    expect(runPullRequestAutomation).toHaveBeenCalledTimes(2);
    const calls = vi
      .mocked(runPullRequestAutomation)
      .mock.calls.map(([args]) => args);
    // Distinct delivery ids: the engine's idempotency key never merges them.
    expect(calls.map((c) => c.deliveryId)).toEqual([
      "delivery-push",
      "delivery-retarget",
    ]);
    expect(calls[0]).not.toHaveProperty("baseChangedFrom");
    expect(calls[1]).toMatchObject({ baseChangedFrom: "feat/parent" });
  });
});
