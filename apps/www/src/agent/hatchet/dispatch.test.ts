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
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";
import { repoReviewSettings } from "@terragon/shared/db/schema";
import { setFeatureFlagOverrideForTest } from "@terragon/shared/model/test-helpers";
import { eq } from "drizzle-orm";
import { getInstallationToken } from "@terragon/shared/github-app";
import { thread as threadTable } from "@terragon/shared/db/schema";
import {
  hatchetDispatchEnabled,
  dispatchAgentRun,
  engineOwnsSupersession,
} from "./dispatch";
import {
  createReviewAutomation,
  createBootingPRThread,
  routedHatchetFetch,
  triggerBody,
} from "./__fixtures__/review-thread";

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
  let orgId: string;
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
    orgId = org.id;
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

    // #66: no stored egress policy for this (org, repo) → the shape is ABSENT
    // from the wire input (undefined → dropped by JSON.stringify) = no
    // enforcement, today's behavior.
    expect(input.egressPolicy).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("#66: attaches the resolved egress SHAPE when the (org, repo) row sets a policy", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      patch: {
        egressPolicy: "domain",
        egressAllowlist: ["registry.npmjs.org"],
      },
    });
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

    const input = JSON.parse(fetchMock.mock.calls[0]![1].body).input;
    // The FINAL shape: operator entries + system hosts merged control-plane-side
    // — the worker receives level + allowlist only, never table/model
    // provenance. dispatch enforces on the WORKER plane, whose system hosts drop
    // github.com / api.github.com (#66 AC4): the agent reaches GitHub only
    // through loopback brokers (#81), leaving the callback host + api.anthropic.com.
    const callbackHost = new URL(process.env.NEXT_PUBLIC_APP_URL!).host;
    expect(input.egressPolicy).toEqual({
      level: "domain",
      allowlist: ["registry.npmjs.org", callbackHost, "api.anthropic.com"],
    });
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

  const makeAutomation = (t: "pull_request" | "github_mention") =>
    createReviewAutomation({ userId: user.id, orgId, triggerType: t });
  const makePRThread = (automationId: string, prNumber: number) =>
    createBootingPRThread({ userId: user.id, orgId, automationId, prNumber });
  const routedFetch = routedHatchetFetch;

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

describe("dispatchAgentRun — #125/#127 supersedePolicy flag ON", () => {
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
    await setFeatureFlagOverrideForTest({
      db,
      userId: user.id,
      name: "supersedePolicy",
      value: true,
    });
  });

  const makeReviewThread = async (prNumber: number) =>
    createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({ userId: user.id, orgId }),
      prNumber,
    });
  const okFetch = (runId: string) => {
    const r = routedHatchetFetch(runId);
    return { mock: r.mock, cancels: r.cancelBodies };
  };

  it("review dispatch: variant by policy, prKey/deliveryId/supersedePolicy in input, versioned metadata, activeRunExternalId stamped", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      patch: { supersedePolicy: "complete-run-discard" },
    });
    const t = await makeReviewThread(77);
    const f = okFetch("run-discard-1");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: "Be-Automata/Automata",
      branch: "feature",
      deliveryId: "gh-delivery-abc",
    });
    const body = triggerBody(f.mock);
    expect(body.workflowName).toBe("agent-run-discard");
    expect(body.input.prKey).toBe(`${orgId}/be-automata/automata/77`);
    expect(body.input.deliveryId).toBe("gh-delivery-abc");
    expect(body.input.supersedePolicy).toBe("complete-run-discard");
    expect(body.input.recheckOnComplete).toBe(false);
    expect(body.additionalMetadata).toEqual({
      metaVersion: "1",
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      orgId,
      repoFullName: "be-automata/automata",
      prNumber: "77",
      lane: "review",
      supersedePolicy: "complete-run-discard",
      recheckOnComplete: "false",
    });
    // Native policy → app-side cancel pass NOT run.
    expect(f.cancels).toHaveLength(0);
    const [row] = await db.query.thread.findMany({
      where: (th, { eq: e }) => e(th.id, t.threadId),
    });
    expect(row!.activeRunExternalId).toBe("run-discard-1");
    vi.unstubAllGlobals();
  });

  it("mints a synthetic deliveryId when none is supplied (never empty)", async () => {
    const t = await makeReviewThread(78);
    const f = okFetch("run-2");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    const body = triggerBody(f.mock);
    expect(body.workflowName).toBe("agent-run-newest"); // default newest-wins
    expect(body.input.deliveryId).toMatch(
      new RegExp(`^manual:${t.threadId}:[0-9a-f]{16}$`),
    );
    vi.unstubAllGlobals();
  });

  it("app-side policy keeps the legacy cancel pass AND routes to agent-run", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "*",
      patch: { supersedePolicy: "app-side" },
    });
    const old = await makeReviewThread(79);
    const fresh = await makeReviewThread(79);
    const f1 = okFetch("run-old-appside");
    vi.stubGlobal("fetch", f1.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: old.threadId,
      threadChatId: old.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    vi.unstubAllGlobals();
    const f2 = okFetch("run-new-appside");
    vi.stubGlobal("fetch", f2.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: fresh.threadId,
      threadChatId: fresh.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    expect(f2.cancels).toEqual([{ externalIds: ["run-old-appside"] }]);
    expect(triggerBody(f2.mock).workflowName).toBe("agent-run");
    vi.unstubAllGlobals();
  });

  it("unknown stored policy → dispatch FAILS the thread loudly, nothing is triggered, and the minted token is revoked (no phantom run)", async () => {
    const t = await makeReviewThread(80);
    const runKey = daemonRunKey({
      threadId: t.threadId,
      threadChatId: t.threadChatId,
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      patch: { blockTolerance: "error" },
    });
    await db
      .update(repoReviewSettings)
      .set({ supersedePolicy: "zzz" })
      .where(eq(repoReviewSettings.organizationId, orgId));
    const f = okFetch("never");
    vi.stubGlobal("fetch", f.mock);
    await expect(
      dispatchAgentRun({
        userId: user.id,
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        repoFullName: "be-automata/automata",
        branch: "feature",
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to dispatch/),
      cause: expect.objectContaining({
        message: expect.stringMatching(/Unknown supersedePolicy 'zzz'/),
      }),
    });
    expect(f.mock).not.toHaveBeenCalled();
    // The token minted before planSupersede must not survive the failure —
    // otherwise hasActiveDaemonToken() reports a phantom run for this runKey
    // and every retry for the token's TTL silently no-ops.
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });

  it("non-review thread under the flag: legacy payload (no prKey, no variant)", async () => {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    const f = okFetch("run-plain");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "main",
    });
    const body = triggerBody(f.mock);
    expect(body.workflowName).toBe("agent-run");
    expect(body.input.prKey).toBeUndefined();
    expect(body.additionalMetadata).toEqual({
      threadId: t.threadId,
      threadChatId: t.threadChatId,
    });
    // No fence stamp for a non-review run: activeRunExternalId is a REVIEW
    // generation marker and must never carry an out-of-scope value.
    const [row] = await db
      .select({ activeRunExternalId: threadTable.activeRunExternalId })
      .from(threadTable)
      .where(eq(threadTable.id, t.threadId));
    expect(row!.activeRunExternalId).toBeNull();
    vi.unstubAllGlobals();
  });

  it("a sibling of the mint rejecting (installation-token lookup fails) still revokes the minted token — no phantom run", async () => {
    const t = await makeReviewThread(81);
    const runKey = daemonRunKey({
      threadId: t.threadId,
      threadChatId: t.threadChatId,
    });
    const f = okFetch("never");
    vi.stubGlobal("fetch", f.mock);
    // getInstallationToken shares the pre-trigger Promise.all with the mint;
    // Promise.all rejects on its failure without waiting for the mint's row.
    vi.mocked(getInstallationToken).mockRejectedValueOnce(
      new Error("github down"),
    );
    await expect(
      dispatchAgentRun({
        userId: user.id,
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        repoFullName: "be-automata/automata",
        branch: "feature",
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to dispatch/),
      cause: expect.objectContaining({ message: "github down" }),
    });
    expect(f.mock).not.toHaveBeenCalled();
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });

  it("engineOwnsSupersession: false with the flag OFF; true for a native policy; false for app-side; false (legacy) on a corrupt stored policy", async () => {
    const t = await makeReviewThread(90);
    const args = {
      userId: user.id,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
    };
    // Flag ON is set for this describe's user in beforeEach; default policy is
    // newest-wins (native).
    expect(await engineOwnsSupersession(args)).toBe(true);
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      patch: { supersedePolicy: "app-side" },
    });
    expect(await engineOwnsSupersession(args)).toBe(false);
    await db
      .update(repoReviewSettings)
      .set({ supersedePolicy: "zzz" })
      .where(eq(repoReviewSettings.organizationId, orgId));
    expect(await engineOwnsSupersession(args)).toBe(false); // fail-safe
    await setFeatureFlagOverrideForTest({
      db,
      userId: user.id,
      name: "supersedePolicy",
      value: false,
    });
    expect(await engineOwnsSupersession(args)).toBe(false);
    expect(
      await engineOwnsSupersession({ ...args, organizationId: null }),
    ).toBe(false);
    void t;
  });
});
