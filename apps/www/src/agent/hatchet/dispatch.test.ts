import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import {
  mintDaemonToken,
  hasActiveDaemonToken,
  daemonRunKey,
} from "@/lib/daemon-token";
import { createAutomation } from "@terragon/shared/model/automations";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { hatchetDispatchEnabled, dispatchAgentRun } from "./dispatch";

describe("hatchetDispatchEnabled", () => {
  it("false by default (no HATCHET_* env in tests) → in-process path", () => {
    expect(hatchetDispatchEnabled({})).toBe(false);
    expect(hatchetDispatchEnabled({ sandboxProvider: "e2b" })).toBe(false);
  });

  it("true for a thread pinned to the remote provider", () => {
    expect(hatchetDispatchEnabled({ sandboxProvider: "hatchet-remote" })).toBe(
      true,
    );
  });
});

describe("dispatchAgentRun", () => {
  let user: User;
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: org.id },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
  });

  it("triggers agent-run with REFERENCE-ONLY input and NO long-lived secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run: { metadata: { id: "run-1" } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAgentRun({
      userId: user.id,
      threadId,
      threadChatId,
      repoFullName: "be-automata/automata",
      branch: "main",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://hatchet-test.example.com/api/v1/stable/tenants/TENANT_TEST/workflow-runs/trigger",
    );
    const body = JSON.parse(init.body);
    expect(body.workflowName).toBe("agent-run");
    const input = body.input;

    // Exactly the reference-only fields — nothing more. `orgId` and `traceparent`
    // are always present; `prNumber` is omitted here (undefined → dropped by
    // JSON.stringify) because this fixture thread has no PR.
    expect(Object.keys(input).sort()).toEqual(
      [
        "branch",
        "daemonCallbackUrl",
        "daemonToken",
        "installationToken",
        "orgId",
        "repoFullName",
        "threadChatId",
        "threadId",
        "traceparent",
      ].sort(),
    );
    // #7: a well-formed W3C traceparent (version 00, 32-hex trace, 16-hex span,
    // sampled flag 01) is minted at dispatch for the end-to-end trace join.
    expect(input.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(input.threadId).toBe(threadId);
    expect(input.threadChatId).toBe(threadChatId);
    expect(input.repoFullName).toBe("be-automata/automata");
    // orgId is the thread's org id (a non-empty string), not the u:<userId> fallback.
    expect(typeof input.orgId).toBe("string");
    expect(input.orgId.length).toBeGreaterThan(0);
    expect(input.orgId.startsWith("u:")).toBe(false);
    // The short-lived tokens are present…
    expect(typeof input.installationToken).toBe("string");
    expect(input.installationToken.length).toBeGreaterThan(0);
    expect(typeof input.daemonToken).toBe("string");
    expect(input.daemonToken.length).toBeGreaterThan(0);

    // …but NO App private key / encryption master key anywhere in the payload.
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("GITHUB_APP_PRIVATE_KEY_TEST");
    expect(serialized).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(serialized.toLowerCase()).not.toContain("privatekey");
    expect(serialized.toLowerCase()).not.toContain("masterkey");

    vi.unstubAllGlobals();
  });

  it("falls back orgId to u:<userId> for a personal (no-org) thread", async () => {
    // A thread with no organizationId must still carry a stable, non-empty orgId so
    // the Phase-2 per-org concurrency CEL never dereferences null.
    const personal = await createTestThread({ db, userId: user.id });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run: { metadata: { id: "run" } } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAgentRun({
      userId: user.id,
      threadId: personal.threadId,
      threadChatId: personal.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "main",
    });

    const input = JSON.parse(fetchMock.mock.calls[0]![1].body).input;
    expect(input.orgId).toBe(`u:${user.id}`);
    vi.unstubAllGlobals();
  });

  it("skips the trigger (double-dispatch guard) when a dispatch is already in flight", async () => {
    // A daemon token named by the per-run key already exists = a dispatch in flight.
    await mintDaemonToken({
      userId: user.id,
      threadId,
      threadChatId,
      name: daemonRunKey({ threadId, threadChatId }),
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAgentRun({
      userId: user.id,
      threadId,
      threadChatId,
      repoFullName: "be-automata/automata",
      branch: "main",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does NOT dedup across two threads that share the legacy threadChat sentinel", async () => {
    // Regression: with enableThreadChatCreation OFF (its default) every thread's
    // threadChatId is the shared sentinel. Keying the dedup guard on threadChatId
    // alone made one thread's in-flight token block ALL other threads' dispatches.
    // The per-run key is threadId-scoped, so two distinct threads dispatch
    // independently even with identical (sentinel) threadChatIds.
    const other = await createTestThread({ db, userId: user.id });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ externalId: "run" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAgentRun({
      userId: user.id,
      threadId,
      threadChatId: LEGACY_THREAD_CHAT_ID,
      repoFullName: "be-automata/automata",
      branch: "main",
    });
    await dispatchAgentRun({
      userId: user.id,
      threadId: other.threadId,
      threadChatId: LEGACY_THREAD_CHAT_ID,
      repoFullName: "be-automata/automata",
      branch: "main",
    });

    // Both dispatched — the second was not falsely deduped by the first.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("retries, then revokes the token and throws when the trigger keeps failing", async () => {
    const runKey = daemonRunKey({ threadId, threadChatId });
    // Every attempt is a non-2xx → triggerAgentRun throws → after the retry budget
    // dispatch revokes the token and throws (so withThreadChat fails the thread).
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchAgentRun({
        userId: user.id,
        threadId,
        threadChatId,
        repoFullName: "be-automata/automata",
        branch: "main",
      }),
    ).rejects.toThrow();

    // Retried up to the budget, then gave up.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Token revoked (revoke is awaited before the throw) — no stale block.
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });

  it("absorbs a transient trigger failure via retry (no throw, token kept)", async () => {
    const runKey = daemonRunKey({ threadId, threadChatId });
    // First attempt fails, second succeeds — dispatch must NOT throw or revoke.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("blip", { status: 502 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ externalId: "run" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAgentRun({
      userId: user.id,
      threadId,
      threadChatId,
      repoFullName: "be-automata/automata",
      branch: "main",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      true,
    );
    vi.unstubAllGlobals();
  });
});

describe("dispatchAgentRun — #8 supersede stale in-flight review", () => {
  let user: User;
  let orgId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  async function makeAutomation(
    triggerType: "pull_request" | "github_mention",
  ) {
    const automation = await createAutomation({
      db,
      userId: user.id,
      accessTier: "pro",
      organizationId: orgId,
      automation: {
        name: `${triggerType} automation`,
        repoFullName: "be-automata/automata",
        branchName: "main",
        enabled: true,
        triggerType,
        triggerConfig: {},
        action: {
          type: "user_message",
          config: {
            message: {
              type: "user",
              model: null,
              parts: [],
              timestamp: new Date().toISOString(),
            },
          },
        },
      },
    });
    return automation.id;
  }

  async function makePRThread(automationId: string, prNumber: number) {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        githubRepoFullName: "be-automata/automata",
        githubPRNumber: prNumber,
        automationId,
      },
    });
    // In production dispatch runs only after startAgentMessage transitions the thread
    // to `booting`, so a superseded prior run is in the active set that
    // markThreadsSuperseded targets (mirrors stopStalledThreads). ThreadInsert omits
    // `status`, so set it directly.
    await db
      .update(threadTable)
      .set({ status: "booting" })
      .where(eq(threadTable.id, t.threadId));
    return t;
  }

  /** A fetch mock that routes trigger vs cancel and records the cancel bodies. */
  function routedFetch(triggerRunId: string) {
    const cancelBodies: unknown[] = [];
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/tasks/cancel")) {
        cancelBodies.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({ run: { metadata: { id: triggerRunId } } }),
        { status: 200 },
      );
    });
    return { mock, cancelBodies };
  }

  it("a second review dispatch cancels the prior run's externalId and supersedes its thread", async () => {
    const reviewAutomation = await makeAutomation("pull_request");
    const old = await makePRThread(reviewAutomation, 100);
    const fresh = await makePRThread(reviewAutomation, 100);

    // First (old) review dispatch records run 'run-old'.
    const first = routedFetch("run-old");
    vi.stubGlobal("fetch", first.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: old.threadId,
      threadChatId: old.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    expect(first.cancelBodies).toHaveLength(0); // nothing prior to supersede
    vi.unstubAllGlobals();

    // Second (fresh) review dispatch for the SAME PR must cancel 'run-old'.
    const second = routedFetch("run-new");
    vi.stubGlobal("fetch", second.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: fresh.threadId,
      threadChatId: fresh.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });

    // The prior run was cancelled by externalId.
    expect(second.cancelBodies).toEqual([{ externalIds: ["run-old"] }]);
    // …and the OLD thread was terminally transitioned (no longer zombie "working").
    const [oldRow] = await db.query.thread.findMany({
      where: (t, { eq }) => eq(t.id, old.threadId),
    });
    expect(oldRow!.status).toBe("complete");
    expect(oldRow!.errorMessage).toBe("superseded");
    vi.unstubAllGlobals();
  });

  it("a MENTION dispatch never cancels/supersedes anything", async () => {
    const mentionAutomation = await makeAutomation("github_mention");
    const reviewAutomation = await makeAutomation("pull_request");
    // A prior in-flight REVIEW run exists for PR 200…
    const priorReview = await makePRThread(reviewAutomation, 200);
    const firstReview = routedFetch("run-review");
    vi.stubGlobal("fetch", firstReview.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: priorReview.threadId,
      threadChatId: priorReview.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    vi.unstubAllGlobals();

    // …but a MENTION on the same PR must NOT cancel it.
    const mention = await makePRThread(mentionAutomation, 200);
    const mentionFetch = routedFetch("run-mention");
    vi.stubGlobal("fetch", mentionFetch.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: mention.threadId,
      threadChatId: mention.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });

    expect(mentionFetch.cancelBodies).toHaveLength(0);
    // The prior review thread is untouched (still active).
    const [reviewRow] = await db.query.thread.findMany({
      where: (t, { eq }) => eq(t.id, priorReview.threadId),
    });
    expect(reviewRow!.errorMessage).not.toBe("superseded");
    vi.unstubAllGlobals();
  });
});
