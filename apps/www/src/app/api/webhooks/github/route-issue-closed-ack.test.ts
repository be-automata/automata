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

  // protects=pull_request.closed acks while the merged-PR mirror task and the
  //   self-heal fix PR settle are still pending (p50 4.6s before #447);
  // fails_when=either closed handler is awaited before the reply again, or
  //   either stops being started for a closed delivery;
  // no_claim=that the status sync (updateGitHubPR) is off the reply path; it
  //   is not, and this case stubs it as untracked.
  it("pull_request.closed returns 200 while mirror intake and the self-heal settle are pending", async () => {
    const mirror = gate();
    const settle = gate();
    vi.mocked(createMirrorTask).mockImplementation(() => mirror.opened);
    vi.mocked(handleSelfHealPrClosed).mockImplementation(() => settle.opened);

    const response = await POST(await prClosedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(waitUntil).toHaveBeenCalledTimes(2);
    expect(createMirrorTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoFullName: REPO,
        intent: expect.objectContaining({ kind: "pr-merged", prNumber: 88 }),
      }),
    );
    expect(handleSelfHealPrClosed).toHaveBeenCalledTimes(1);

    mirror.release();
    settle.release();
    await waitUntilResolved();
    expect(consoleError).not.toHaveBeenCalled();
  });

  // protects=an operator can find and redeliver a delivery whose work failed
  //   after the ack (GitHub saw a 2xx, so its log shows success);
  // fails_when=a deferred failure is swallowed, or logged without the
  //   x-github-delivery id, or turns the already-sent reply into a 5xx;
  // no_claim=any automatic retry; there is none until #448.
  it("a closed-PR failure after the ack is logged with the delivery id", async () => {
    vi.mocked(createMirrorTask).mockRejectedValue(new Error("db down"));
    vi.mocked(handleSelfHealPrClosed).mockResolvedValue();

    const response = await POST(await prClosedRequest());
    expect(response.status).toBe(200);
    await waitUntilResolved();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("deferred work failed"),
      expect.objectContaining({
        deliveryId: DELIVERY_ID,
        eventName: "pull_request.closed",
        label: "mirror intake",
        error: expect.stringContaining("db down"),
      }),
    );
  });

  // protects=WI-8 survives the move: an unbound installation on a deferred
  //   closed delivery is a logged skip naming the delivery, not an error;
  // fails_when=a WebhookSkip from deferred work is logged as a failure, or the
  //   skip log loses the delivery id or category;
  // no_claim=the response body's `skipped` flag, which a deferred skip can no
  //   longer set (a documented behavior change).
  it("a WebhookSkip after the ack is logged as a skip with the delivery id", async () => {
    vi.mocked(createMirrorTask).mockRejectedValue(
      new WebhookSkip("unmapped_installation", "No org bound", {
        repoFullName: REPO,
      }),
    );
    vi.mocked(handleSelfHealPrClosed).mockResolvedValue();

    const response = await POST(await prClosedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    await waitUntilResolved();

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(
      "[github webhook] deferred work skipped",
      expect.objectContaining({
        deliveryId: DELIVERY_ID,
        category: "unmapped_installation",
      }),
    );
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
});
