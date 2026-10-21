import crypto from "crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@terragon/env/apps-www";

import { waitUntil } from "@/lib/wait-until";
import { runIssueAutomation } from "@/server-lib/automations";
import { handleSelfHealPrClosed } from "@/server-lib/audit/fix-pr-lifecycle";
import { getIssueAutomationsForRepo } from "@terragon/shared/model/automations";
import type { Automation } from "@terragon/shared/db/types";
import {
  createMockNextRequest,
  mockWaitUntil,
  waitUntilResolved,
} from "@/test-helpers/mock-next";

import { createMirrorTask } from "./mirror-intake";
import { WebhookSkip } from "./webhook-skip";
import { POST } from "./route";

/**
 * #447: issues.opened / issues.labeled and pull_request.closed ack before
 * their slow work, and that work's failures name the delivery.
 *
 * GitHub gives a delivery 10s to get a 2xx and never retries a failed one on
 * its own. These cases hold the route to "reply first, work after" with stubs
 * that stay pending until the test releases them, so a route that awaited
 * them could not have produced the response the test reads.
 */

vi.mock("@terragon/shared/model/automations", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@terragon/shared/model/automations")
  >()),
  getIssueAutomationsForRepo: vi.fn(),
}));
vi.mock("@/server-lib/automations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server-lib/automations")>()),
  runIssueAutomation: vi.fn(),
}));
vi.mock("@terragon/shared/model/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@terragon/shared/model/github")>()),
  // Untracked PR: the status-sync handler returns at once.
  getGithubPR: vi.fn(async () => undefined),
}));
vi.mock("./mirror-intake", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mirror-intake")>()),
  createMirrorTask: vi.fn(),
}));
vi.mock("@/server-lib/audit/fix-pr-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/server-lib/audit/fix-pr-lifecycle")
  >()),
  handleSelfHealPrClosed: vi.fn(),
}));

const REPO = "owner/repo";
const DELIVERY_ID = "delivery-447";

function issueAutomation(id: string): Automation {
  return {
    id,
    userId: "user-1",
    organizationId: "org-1",
    repoFullName: REPO,
    triggerType: "issue",
    triggerConfig: { filter: { includeAllAuthors: true }, on: { open: true } },
    action: { type: "user_message", config: { message: {} } },
  } as unknown as Automation;
}

async function signedRequest(event: string, body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  const signature = `sha256=${crypto
    .createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;
  return createMockNextRequest(body, {
    "x-github-delivery": DELIVERY_ID,
    "x-hub-signature-256": signature,
    "x-github-event": event,
  });
}

function issueOpenedRequest() {
  return signedRequest("issues", {
    action: "opened",
    issue: {
      number: 42,
      state: "open",
      user: { login: "octocat" },
      labels: [],
    },
    repository: { full_name: REPO, owner: { login: "owner" }, name: "repo" },
  });
}

function prClosedRequest() {
  return signedRequest("pull_request", {
    action: "closed",
    pull_request: {
      number: 88,
      merged: true,
      draft: false,
      head: { ref: "feat/x", sha: "d".repeat(40) },
      base: { ref: "main" },
      title: "t",
      body: null,
      html_url: `https://github.com/${REPO}/pull/88`,
      merged_by: { login: "dev" },
      merge_commit_sha: "e".repeat(40),
      user: { login: "dev", id: 1 },
    },
    installation: { id: 7 },
    repository: { full_name: REPO, owner: { login: "owner" }, name: "repo" },
  });
}

/** A stub that stays pending until the test calls `release`. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

describe("#447: issue and closed deliveries ack before their work", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await mockWaitUntil();
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // protects=issues.opened acks while its automation run is still pending (the
  //   path that hit GitHub's 10s timeout twice on 2026-10-21);
  // fails_when=handleIssueEvent awaits the fan-out before returning, or the run
  //   no longer starts after the ack;
  // no_claim=the Workers waitUntil lifetime, or prod ack latency (AC1 is a
  //   48h delivery-log measurement).
  it("issues.opened returns 200 while the automation run is still pending", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      issueAutomation("issue-1"),
    ]);
    const run = gate();
    let runFinished = false;
    vi.mocked(runIssueAutomation).mockImplementation(async () => {
      await run.opened;
      runFinished = true;
      return undefined as never;
    });

    const response = await POST(await issueOpenedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(runIssueAutomation).toHaveBeenCalled());
    expect(runFinished).toBe(false);

    run.release();
    await waitUntilResolved();
    expect(runFinished).toBe(true);
    expect(runIssueAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: "issue-1",
        issueEventAction: "opened",
        issueNumber: 42,
      }),
    );
  });

  // protects=no unconditional pause between issue automations (the old 1s
  //   sleep after every batch of 5 ate the delivery budget and now would eat
  //   the waitUntil budget);
  // fails_when=any timer is scheduled while the runs fan out, or the 6th run
  //   waits for one (it crosses the old batch boundary);
  // no_claim=throughput against GitHub's secondary rate limits.
  it("six issue automations all run with no timer scheduled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => issueAutomation(`issue-${i}`)),
    );
    vi.mocked(runIssueAutomation).mockResolvedValue(undefined as never);

    const response = await POST(await issueOpenedRequest());
    expect(response.status).toBe(200);
    await waitUntilResolved();

    expect(runIssueAutomation).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  // protects=pull_request.closed acks while the self-heal fix PR settle is
  //   still pending, and the merged-PR mirror task is still awaited;
  // fails_when=the settle is awaited before the reply again, stops being
  //   started for a closed delivery, or the mirror task is deferred (its
  //   failure would then lose the 500 an operator redelivers from);
  // no_claim=that the status sync (updateGitHubPR) is off the reply path; it
  //   is not, and this case stubs the PR as untracked.
  it("pull_request.closed returns 200 while the self-heal settle is pending, after mirror intake settles", async () => {
    const settle = gate();
    let mirrorFinished = false;
    vi.mocked(createMirrorTask).mockImplementation(async () => {
      await Promise.resolve();
      mirrorFinished = true;
      return undefined as never;
    });
    vi.mocked(handleSelfHealPrClosed).mockImplementation(() => settle.opened);

    const response = await POST(await prClosedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mirrorFinished).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(createMirrorTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: REPO,
        intent: expect.objectContaining({ kind: "pr-merged", prNumber: 88 }),
      }),
    );
    expect(handleSelfHealPrClosed).toHaveBeenCalledTimes(1);

    settle.release();
    await waitUntilResolved();
    expect(consoleError).not.toHaveBeenCalled();
  });

  // protects=the operator's redelivery signal for a merged-PR audit: an
  //   unexpected mirror-task failure on pull_request.closed marks the delivery
  //   failed (5xx) in GitHub's delivery log, as before #447;
  // fails_when=the mirror task moves after the ack and its failure is only
  //   logged behind a 200;
  // no_claim=any automatic retry; there is none until #448.
  it("a closed-PR mirror failure still returns 500", async () => {
    vi.mocked(createMirrorTask).mockRejectedValue(new Error("db down"));
    vi.mocked(handleSelfHealPrClosed).mockResolvedValue();

    const response = await POST(await prClosedRequest());

    expect(response.status).toBe(500);
    await waitUntilResolved();
    expect(handleSelfHealPrClosed).toHaveBeenCalledTimes(1);
  });

  // protects=WI-8 on pull_request.closed: an unbound installation in the
  //   mirror task fast-acks with `skipped: true` and its category, the body and
  //   `[github webhook] skipped` log the pilot runbook reads;
  // fails_when=the skip turns into a 5xx, or the body loses `skipped` or the
  //   category;
  // no_claim=the skip log's detail fields beyond the delivery id and category.
  it("a closed-PR WebhookSkip still fast-acks with skipped: true", async () => {
    vi.mocked(createMirrorTask).mockRejectedValue(
      new WebhookSkip("unmapped_installation", "No org bound", {
        repoFullName: REPO,
      }),
    );
    vi.mocked(handleSelfHealPrClosed).mockResolvedValue();

    const response = await POST(await prClosedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      skipped: true,
      category: "unmapped_installation",
    });
    expect(consoleLog).toHaveBeenCalledWith(
      "[github webhook] skipped",
      expect.objectContaining({
        deliveryId: DELIVERY_ID,
        category: "unmapped_installation",
      }),
    );
    await waitUntilResolved();
  });

  // protects=a failed issue automation run names the delivery it came from;
  // fails_when=the per-run failure log drops the x-github-delivery id;
  // no_claim=that the failure reaches GitHub; the delivery is already acked.
  it("an issue automation failure after the ack is logged with the delivery id", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue([
      issueAutomation("issue-1"),
    ]);
    vi.mocked(runIssueAutomation).mockRejectedValue(new Error("GitHub 502"));

    const response = await POST(await issueOpenedRequest());
    expect(response.status).toBe(200);
    await waitUntilResolved();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(`(delivery ${DELIVERY_ID})`),
      expect.any(Error),
    );
  });

  // protects=issue automations past the waitUntil budget are named, not lost:
  //   Workers cancels waitUntil work 30s after the response, so no run starts
  //   after 20s and the ones not started are logged with the delivery id;
  // fails_when=a run starts past the budget, or the not-started automations
  //   are dropped without a log naming them and the delivery;
  // no_claim=that runs already in flight finish inside the 30s cap, or the
  //   real per-run latency in prod.
  it("issue automations past the start budget are not started and are logged with the delivery id", async () => {
    vi.mocked(getIssueAutomationsForRepo).mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => issueAutomation(`issue-${i}`)),
    );
    const request = await issueOpenedRequest();
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    // Each run takes 25s of the budget: the first 5 lanes start at t=0, and
    // the 6th and 7th would start past 20s.
    vi.mocked(runIssueAutomation).mockImplementation(async () => {
      // Yield first, so all 5 lanes start before any run spends the clock.
      await Promise.resolve();
      now += 25_000;
      return undefined as never;
    });

    try {
      const response = await POST(request);
      expect(response.status).toBe(200);
      await waitUntilResolved();
    } finally {
      nowSpy.mockRestore();
    }

    expect(runIssueAutomation).toHaveBeenCalledTimes(5);
    expect(consoleError).toHaveBeenCalledWith(
      "[github webhook] issue automations not started: past the waitUntil budget",
      expect.objectContaining({
        deliveryId: DELIVERY_ID,
        eventName: "issues.opened",
        issueNumber: 42,
        automationIds: ["issue-5", "issue-6"],
      }),
    );
  });
});
