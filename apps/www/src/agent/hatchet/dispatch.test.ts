import { describe, it, vi, beforeEach, afterEach, expect } from "vitest";
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
import { createTestRemoteRun } from "@terragon/shared/model/test-helpers";
import { eq } from "drizzle-orm";
import { env } from "@terragon/env/apps-www";
import { encryptValue } from "@terragon/utils/encryption";
import {
  getOrCreateEnvironment,
  updateEnvironment,
} from "@terragon/shared/model/environments";
import { remoteTaskBranchName } from "@/server-lib/task/remote-task-pr";
import {
  getInstallationToken,
  getReadOnlyInstallationToken,
  lookupInstallationId,
} from "@terragon/shared/github-app";
import {
  auditFixAttempts,
  auditRuns,
  selfHealBreakerEvent,
  thread as threadTable,
} from "@terragon/shared/db/schema";
import { upsertFeatureFlag } from "@terragon/shared/model/feature-flags";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import { claimFixAttempt } from "@terragon/shared/model/audit-fix-attempts";
import { fixBranchName } from "@/server-lib/audit/fix-run-prompt";
import {
  hashSelfHealToken,
  type SelfHealAuditRunInput,
  type SelfHealRunInput,
} from "@/server-lib/audit/plan-self-heal-run";
import { resolveTaskAgentFromRows } from "@/server-lib/task/resolve-task-agent";
import {
  hatchetDispatchEnabled,
  dispatchAgentRun,
  selfHealReadbackSettle,
} from "./dispatch";

// Pass-through spy: the real resolver runs on the rows the dispatch read from
// the test DB; the spy only lets a test assert it was (not) consulted.
vi.mock("@/server-lib/task/resolve-task-agent", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/server-lib/task/resolve-task-agent")
    >();
  return {
    ...actual,
    resolveTaskAgentFromRows: vi.fn(actual.resolveTaskAgentFromRows),
  };
});
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
        "workBranch",
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

describe("dispatchAgentRun — #165 engine-only supersession (www never cancels)", () => {
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

  it("a second review dispatch for the same PR NEVER cancels the prior run or touches its thread", async () => {
    const reviewAutomation = await makeAutomation("pull_request");
    const old = await makePRThread(reviewAutomation, 100);
    const fresh = await makePRThread(reviewAutomation, 100);

    const first = routedFetch("run-old");
    vi.stubGlobal("fetch", first.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: old.threadId,
      threadChatId: old.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    expect(first.cancelBodies).toHaveLength(0);
    vi.unstubAllGlobals();

    // Second (fresh) review dispatch for the SAME PR: the engine variant's
    // per-PR concurrency owns supersession (#165, ADR-007) — www issues no
    // cancel and the old thread is untouched.
    const second = routedFetch("run-new");
    vi.stubGlobal("fetch", second.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: fresh.threadId,
      threadChatId: fresh.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });

    expect(second.cancelBodies).toHaveLength(0);
    expect(triggerBody(second.mock).workflowName).toBe("agent-run-newest");
    const [oldRow] = await db.query.thread.findMany({
      where: (t, { eq }) => eq(t.id, old.threadId),
    });
    // Not terminally transitioned, not archived — its run's fate is the
    // engine's; the C4 sweep stamps the typed cause when that lands.
    expect(oldRow!.errorMessage).not.toBe("superseded");
    expect(oldRow!.activeRunExternalId).toBe("run-old");
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

describe("dispatchAgentRun — #125/#127/#165 policy-variant review dispatch", () => {
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

  const makeReviewThread = async (prNumber: number) =>
    createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({ userId: user.id, orgId }),
      prNumber,
    });

  it("review dispatch: variant by policy, prKey/deliveryId/supersedePolicy in input, versioned metadata, activeRunExternalId stamped", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      patch: { supersedePolicy: "complete-run-discard" },
    });
    const t = await makeReviewThread(77);
    const f = routedHatchetFetch("run-discard-1");
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
    // #165: www never cancels — supersession is the variant's per-PR strategy.
    expect(f.cancelBodies).toHaveLength(0);
    const [row] = await db.query.thread.findMany({
      where: (th, { eq: e }) => e(th.id, t.threadId),
    });
    expect(row!.activeRunExternalId).toBe("run-discard-1");
    vi.unstubAllGlobals();
  });

  it("mints a synthetic deliveryId when none is supplied (never empty)", async () => {
    const t = await makeReviewThread(78);
    const f = routedHatchetFetch("run-2");
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

  it("a stored retired 'app-side' row reads as UNSET: default policy applies, variant dispatch, no cancel", async () => {
    // The write boundary rejects 'app-side' since #165, so seed it raw — the
    // cutover-window case of a row written by a stale build.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "*",
      patch: { blockTolerance: "error" },
    });
    await db
      .update(repoReviewSettings)
      .set({ supersedePolicy: "app-side" })
      .where(eq(repoReviewSettings.organizationId, orgId));
    const t = await makeReviewThread(79);
    const f = routedHatchetFetch("run-79");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    const body = triggerBody(f.mock);
    expect(body.workflowName).toBe("agent-run-newest"); // default, not legacy
    expect(body.input.supersedePolicy).toBe("newest-wins");
    expect(f.cancelBodies).toHaveLength(0);
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
    const f = routedHatchetFetch("never");
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

  it("non-review thread: legacy payload (no prKey, no variant)", async () => {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    const f = routedHatchetFetch("run-plain");
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
    const f = routedHatchetFetch("never");
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

  it("a recorded prior in-flight run is never cancelled by a new dispatch under any policy", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      patch: { supersedePolicy: "complete-run-queue" },
    });
    await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 91,
      externalId: "run-prior-91",
      repoFullName: "be-automata/automata",
    });
    const t = await makeReviewThread(91);
    const f = routedHatchetFetch("run-new-91");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    expect(f.cancelBodies).toEqual([]); // #165: engine-owned, always
    expect(triggerBody(f.mock).workflowName).toBe("agent-run-strict");
    vi.unstubAllGlobals();
  });

  it("FAIL-CLOSED: a stamped (review) dispatch whose trigger response carries no run id neither stamps nor unfences", async () => {
    // transport.ts reads json.run?.metadata?.id — a shape mismatch (a
    // previously-hit bug class) yields externalId undefined AFTER a 200
    // trigger. The plan is stamped, so the fallback unfence must NOT fire:
    // shedding the terminal without a new stamp reopens the #125 C1 window
    // (the old run's id still matches the stale stamp). The thread stays
    // fenced until the watchdog or a retry sorts it out.
    const t = await makeReviewThread(92);
    // The thread carries a prior generation's terminal + stamp.
    await db
      .update(threadTable)
      .set({ terminalCause: "superseded", activeRunExternalId: "run-old-92" })
      .where(eq(threadTable.id, t.threadId));
    const badShape = vi.fn(async (url: string) => {
      if (url.includes("/tasks/cancel"))
        return new Response("{}", { status: 200 });
      // 200, but not the { run: { metadata: { id } } } shape.
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", badShape);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: "be-automata/automata",
      branch: "feature",
    });
    const [row] = await db
      .select({
        cause: threadTable.terminalCause,
        stamp: threadTable.activeRunExternalId,
      })
      .from(threadTable)
      .where(eq(threadTable.id, t.threadId));
    expect(row!.cause).toBe("superseded"); // still fenced
    expect(row!.stamp).toBe("run-old-92"); // untouched
    vi.unstubAllGlobals();
  });
});

describe("dispatchAgentRun — phase 4 reviewAgent payload", () => {
  let user: User;
  let orgId: string;
  const REPO = "be-automata/automata";
  const CLASSIC_DEFAULTS = {
    mode: "classic",
    batteries: ["gstack-review", "somnio-review", "gsd-reviewers"],
    runTests: false,
    commandTimeoutMs: 60000,
  };

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

  const makeReviewThread = async (
    prNumber: number,
    triggerType: "pull_request" | "github_mention" = "pull_request",
  ) =>
    createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({
        userId: user.id,
        orgId,
        triggerType,
      }),
      prNumber,
    });

  const setTrust = async (
    threadId: string,
    trust: { isFork: boolean; isCrossRepo: boolean; authorAssociation: string },
  ) =>
    db
      .update(threadTable)
      .set({
        trustContext: {
          source: "github-pr",
          capturedAt: new Date().toISOString(),
          ...trust,
        },
      })
      .where(eq(threadTable.id, threadId));

  const orchestratedWithRunTests = async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "*",
      patch: { reviewMode: "orchestrated" },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewRunTests: true },
    });
  };

  const dispatchAndRead = async (t: {
    threadId: string;
    threadChatId: string;
  }) => {
    const f = routedHatchetFetch("run-agent");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: REPO,
      branch: "feature",
    });
    const body = triggerBody(f.mock);
    vi.unstubAllGlobals();
    return body.input;
  };

  it("review thread with no settings rows carries the classic defaults", async () => {
    const t = await makeReviewThread(901);
    const input = await dispatchAndRead(t);
    expect(input.reviewAgent).toEqual(CLASSIC_DEFAULTS);
  });

  it("orchestrated + runTests on a fork PR → runTests false, reason fork", async () => {
    await orchestratedWithRunTests();
    const t = await makeReviewThread(902);
    await setTrust(t.threadId, {
      isFork: true,
      isCrossRepo: true,
      authorAssociation: "OWNER",
    });
    const input = await dispatchAndRead(t);
    expect(input.reviewAgent).toEqual({
      mode: "orchestrated",
      batteries: CLASSIC_DEFAULTS.batteries,
      runTests: false,
      runTestsDowngradedReason: "fork",
      commandTimeoutMs: 300000,
    });
  });

  it("orchestrated + runTests on a trusted same-repo PR → runTests true", async () => {
    await orchestratedWithRunTests();
    const t = await makeReviewThread(903);
    await setTrust(t.threadId, {
      isFork: false,
      isCrossRepo: false,
      authorAssociation: "MEMBER",
    });
    const input = await dispatchAndRead(t);
    expect(input.reviewAgent).toEqual({
      mode: "orchestrated",
      batteries: CLASSIC_DEFAULTS.batteries,
      runTests: true,
      commandTimeoutMs: 300000,
    });
  });

  it("classic repo row ignores stored runTests/timeout/maxTurns (W4)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: {
        reviewMode: "classic",
        reviewRunTests: true,
        reviewCommandTimeoutS: 600,
        reviewMaxTurns: 50,
      },
    });
    const t = await makeReviewThread(904);
    const input = await dispatchAndRead(t);
    expect(input.reviewAgent).toEqual(CLASSIC_DEFAULTS);
  });

  it("plain org thread carries no reviewAgent even with an orchestrated '*' row", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: "*",
      patch: { reviewMode: "orchestrated" },
    });
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    const input = await dispatchAndRead(t);
    expect("reviewAgent" in input).toBe(false);
  });

  it("mention thread carries no reviewAgent", async () => {
    const t = await makeReviewThread(905, "github_mention");
    const input = await dispatchAndRead(t);
    expect("reviewAgent" in input).toBe(false);
  });

  it("a corrupt stored review-agent value fails the dispatch and revokes the token", async () => {
    const t = await makeReviewThread(906);
    const runKey = daemonRunKey({
      threadId: t.threadId,
      threadChatId: t.threadChatId,
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewMode: "classic" },
    });
    await db
      .update(repoReviewSettings)
      .set({ reviewMode: "turbo" })
      .where(eq(repoReviewSettings.organizationId, orgId));
    const f = routedHatchetFetch("never");
    vi.stubGlobal("fetch", f.mock);
    await expect(
      dispatchAgentRun({
        userId: user.id,
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        repoFullName: REPO,
        branch: "feature",
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to dispatch/),
      cause: expect.objectContaining({
        message: expect.stringMatching(/reviewMode/),
      }),
    });
    expect(f.mock).not.toHaveBeenCalled();
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });
});

describe("dispatchAgentRun — phase 7 taskAgent payload", () => {
  let user: User;
  let orgId: string;
  const REPO = "be-automata/automata";
  const INVALID_LOG =
    "[hatchet] task agent: invalid stored taskBatteries — dispatching without packs";

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

  const setTaskBatteries = (repoFullName: string, taskBatteries: string[]) =>
    upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName,
      patch: { taskBatteries },
    });

  /** Bypasses the write-boundary validator: a pack id removed after it was stored. */
  const corruptTaskBatteries = async () => {
    await setTaskBatteries(REPO, ["somnio-skills"]);
    await db
      .update(repoReviewSettings)
      .set({ taskBatteries: ["nope"] })
      .where(eq(repoReviewSettings.organizationId, orgId));
  };

  const orgTaskThread = () =>
    createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });

  const reviewThread = async (prNumber: number) =>
    createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({
        userId: user.id,
        orgId,
        triggerType: "pull_request",
      }),
      prNumber,
    });

  const dispatchAndRead = async (
    t: { threadId: string; threadChatId: string },
    branch = "feature",
  ) => {
    const f = routedHatchetFetch("run-agent");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: REPO,
      branch,
    });
    const body = triggerBody(f.mock);
    vi.unstubAllGlobals();
    return body.input;
  };

  it("a task run on a repo row with packs carries taskAgent", async () => {
    await setTaskBatteries(REPO, ["somnio-skills"]);
    const input = await dispatchAndRead(await orgTaskThread());
    expect(input.taskAgent).toEqual({ batteries: ["somnio-skills"] });
  });

  it("a task run inherits the '*' row's packs", async () => {
    await setTaskBatteries("*", ["somnio-skills"]);
    const input = await dispatchAndRead(await orgTaskThread());
    expect(input.taskAgent).toEqual({ batteries: ["somnio-skills"] });
  });

  it("an explicit empty repo list over a '*' list sends no taskAgent key", async () => {
    await setTaskBatteries("*", ["somnio-skills"]);
    await setTaskBatteries(REPO, []);
    const input = await dispatchAndRead(await orgTaskThread());
    expect("taskAgent" in input).toBe(false);
  });

  it("a review dispatch never carries taskAgent; reviewAgent is unchanged", async () => {
    await setTaskBatteries(REPO, ["somnio-skills"]);
    const input = await dispatchAndRead(await reviewThread(911));
    expect("taskAgent" in input).toBe(false);
    expect(input.reviewAgent).toEqual({
      mode: "classic",
      batteries: ["gstack-review", "somnio-review", "gsd-reviewers"],
      runTests: false,
      commandTimeoutMs: 60000,
    });
    expect(vi.mocked(resolveTaskAgentFromRows)).not.toHaveBeenCalled();
  });

  it("a personal (no-org) thread neither carries taskAgent nor reads the setting", async () => {
    const t = await createTestThread({ db, userId: user.id });
    const input = await dispatchAndRead(t);
    expect("taskAgent" in input).toBe(false);
    expect(vi.mocked(resolveTaskAgentFromRows)).not.toHaveBeenCalled();
  });

  it("an invalid stored value dispatches the task run without packs, logs once and keeps the token", async () => {
    await corruptTaskBatteries();
    const warn = vi.spyOn(console, "warn");
    const t = await orgTaskThread();
    const input = await dispatchAndRead(t);
    expect("taskAgent" in input).toBe(false);
    const hits = warn.mock.calls.filter((call) => call[0] === INVALID_LOG);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.[1]).toMatchObject({
      threadId: t.threadId,
      organizationId: orgId,
      repoFullName: REPO,
      detail: expect.stringContaining("taskBatteries"),
    });
    expect(
      await hasActiveDaemonToken({
        userId: user.id,
        name: daemonRunKey({
          threadId: t.threadId,
          threadChatId: t.threadChatId,
        }),
      }),
    ).toBe(true);
    warn.mockRestore();
  });

  it("the same invalid row on a review dispatch succeeds with no task-agent log", async () => {
    await corruptTaskBatteries();
    const warn = vi.spyOn(console, "warn");
    const input = await dispatchAndRead(await reviewThread(912));
    expect("taskAgent" in input).toBe(false);
    expect(input.reviewAgent).toMatchObject({ mode: "classic" });
    expect(warn.mock.calls.some((call) => call[0] === INVALID_LOG)).toBe(false);
    warn.mockRestore();
  });

  describe("repo environment (prompt-defined automations)", () => {
    const setRepoEnv = async (variables: Record<string, string>) => {
      const environment = await getOrCreateEnvironment({
        db,
        userId: user.id,
        organizationId: orgId,
        repoFullName: REPO,
      });
      await updateEnvironment({
        db,
        userId: user.id,
        environmentId: environment.id,
        organizationId: orgId,
        updates: {
          environmentVariables: Object.entries(variables).map(
            ([key, value]) => ({
              key,
              valueEncrypted: encryptValue(value, env.ENCRYPTION_MASTER_KEY),
            }),
          ),
        },
      });
    };

    it("a task run carries the agent-visible variables, never the control-plane tracker token", async () => {
      await setRepoEnv({
        YOUTRACK_URL: "https://tracker.example",
        YOUTRACK_AGENT_TOKEN: "perm:agent",
        YOUTRACK_TOKEN: "perm:platform",
      });
      const input = await dispatchAndRead(await orgTaskThread());
      expect(input.repoEnv).toEqual({
        YOUTRACK_URL: "https://tracker.example",
        YOUTRACK_AGENT_TOKEN: "perm:agent",
      });
    });

    it("without an agent token, the tracker token reaches the agent only as YOUTRACK_AGENT_TOKEN", async () => {
      await setRepoEnv({
        YOUTRACK_URL: "https://tracker.example",
        YOUTRACK_TOKEN: "perm:owner",
      });
      const input = await dispatchAndRead(await orgTaskThread());
      expect(input.repoEnv).toEqual({
        YOUTRACK_URL: "https://tracker.example",
        YOUTRACK_AGENT_TOKEN: "perm:owner",
      });
    });

    it("a review run never gets the tracker token fallback", async () => {
      await setRepoEnv({ YOUTRACK_TOKEN: "perm:owner" });
      const input = await dispatchAndRead(await reviewThread(912));
      expect("repoEnv" in input).toBe(false);
    });

    it("a task run with no variables sends no repoEnv key", async () => {
      const input = await dispatchAndRead(await orgTaskThread());
      expect("repoEnv" in input).toBe(false);
    });

    it("a review run never carries the variables", async () => {
      await setRepoEnv({ YOUTRACK_AGENT_TOKEN: "perm:agent" });
      const input = await dispatchAndRead(await reviewThread(912));
      expect("repoEnv" in input).toBe(false);
    });
  });

  describe("work branch (remote task PRs)", () => {
    it("a task run starting on its base branch gets its own work branch", async () => {
      const t = await orgTaskThread();
      const input = await dispatchAndRead(t, "main");
      expect(input.workBranch).toBe(remoteTaskBranchName(t.threadId));
    });

    it("a task run already on its own branch keeps working there", async () => {
      const input = await dispatchAndRead(await orgTaskThread(), "feature");
      expect("workBranch" in input).toBe(false);
    });

    it("a review run never gets one", async () => {
      const input = await dispatchAndRead(await reviewThread(913), "main");
      expect("workBranch" in input).toBe(false);
    });
  });

  describe("read-only GitHub token (phase 7, DORA auth = Option 3)", () => {
    const READ_TOKEN = "mock-github-read-token";
    const MINT_FAILED_LOG =
      "[hatchet] task agent: read token mint failed — dispatching without it";

    it("a task run whose packs require it carries a read-only token and its expiry, never the write-capable token", async () => {
      await setTaskBatteries(REPO, ["somnio-skills"]);
      const input = await dispatchAndRead(await orgTaskThread());
      expect(vi.mocked(getReadOnlyInstallationToken)).toHaveBeenCalledTimes(1);
      // Minted against the installation the clone token already looked up.
      expect(vi.mocked(getReadOnlyInstallationToken)).toHaveBeenCalledWith(
        "be-automata",
        "automata",
        424242,
      );
      expect(vi.mocked(lookupInstallationId)).toHaveBeenCalledTimes(1);
      expect(input.githubReadToken).toBe(READ_TOKEN);
      expect(input.githubReadToken).not.toBe(input.installationToken);
      expect(input.githubReadTokenExpiresAt).toBe("2026-10-04T03:00:00Z");
      expect(input.taskAgent).toEqual({ batteries: ["somnio-skills"] });
    });

    it("packs that require nothing: no mint, no token keys", async () => {
      await setTaskBatteries(REPO, ["somnio-review"]);
      const input = await dispatchAndRead(await orgTaskThread());
      expect(input.taskAgent).toEqual({ batteries: ["somnio-review"] });
      expect(vi.mocked(getReadOnlyInstallationToken)).not.toHaveBeenCalled();
      expect("githubReadToken" in input).toBe(false);
      expect("githubReadTokenExpiresAt" in input).toBe(false);
    });

    it("no taskAgent: no mint, no token keys", async () => {
      const input = await dispatchAndRead(await orgTaskThread());
      expect(vi.mocked(getReadOnlyInstallationToken)).not.toHaveBeenCalled();
      expect("githubReadToken" in input).toBe(false);
      expect("githubReadTokenExpiresAt" in input).toBe(false);
    });

    it("a review dispatch never mints or carries it, even with a requiring pack stored", async () => {
      await setTaskBatteries(REPO, ["somnio-skills"]);
      await setTaskBatteries("*", ["somnio-skills"]);
      const input = await dispatchAndRead(await reviewThread(913));
      expect(vi.mocked(getReadOnlyInstallationToken)).not.toHaveBeenCalled();
      expect("githubReadToken" in input).toBe(false);
      expect("githubReadTokenExpiresAt" in input).toBe(false);
    });

    it("a personal (no-org) thread never mints", async () => {
      const t = await createTestThread({ db, userId: user.id });
      const input = await dispatchAndRead(t);
      expect(vi.mocked(getReadOnlyInstallationToken)).not.toHaveBeenCalled();
      expect("githubReadToken" in input).toBe(false);
    });

    it("a mint failure dispatches with taskAgent and without the token, warns once (message only, redacted) and keeps the daemon token", async () => {
      await setTaskBatteries(REPO, ["somnio-skills"]);
      vi.mocked(getReadOnlyInstallationToken).mockRejectedValueOnce(
        Object.assign(
          new Error("Resource not accessible (saw ghs_leakedTokenValue123)"),
          { request: { body: '{"permissions":{"contents":"read"}}' } },
        ),
      );
      const warn = vi.spyOn(console, "warn");
      const t = await orgTaskThread();
      const input = await dispatchAndRead(t);
      expect(input.taskAgent).toEqual({ batteries: ["somnio-skills"] });
      expect("githubReadToken" in input).toBe(false);
      expect("githubReadTokenExpiresAt" in input).toBe(false);
      const hits = warn.mock.calls.filter(
        (call) => call[0] === MINT_FAILED_LOG,
      );
      expect(hits).toHaveLength(1);
      const logged = JSON.stringify(hits[0]);
      expect(logged).toContain(t.threadId);
      expect(logged).not.toContain("ghs_leakedTokenValue123");
      expect(logged).not.toContain("permissions");
      expect(
        await hasActiveDaemonToken({
          userId: user.id,
          name: daemonRunKey({
            threadId: t.threadId,
            threadChatId: t.threadChatId,
          }),
        }),
      ).toBe(true);
      warn.mockRestore();
    });

    it("log hygiene: no console argument of a requiring dispatch contains the read token", async () => {
      await setTaskBatteries(REPO, ["somnio-skills"]);
      const spies = (["log", "warn", "error", "info", "debug"] as const).map(
        (level) => vi.spyOn(console, level),
      );
      const input = await dispatchAndRead(await orgTaskThread());
      expect(input.githubReadToken).toBe(READ_TOKEN);
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(READ_TOKEN);
        }
        spy.mockRestore();
      }
    });
  });
});

describe("dispatchAgentRun — phase 8 selfHeal payload", () => {
  let user: User;
  let orgId: string;
  const REPO = "be-automata/automata";

  const setFlag = (on: boolean) =>
    upsertFeatureFlag({
      db,
      name: "selfHealLoop",
      updates: { defaultValue: false, globalOverride: on },
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    await setFlag(true);
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { selfHealMode: "dry-run" },
    });
  });

  const dispatchAndRead = async (t: {
    threadId: string;
    threadChatId: string;
  }) => {
    const f = routedHatchetFetch("run-agent");
    vi.stubGlobal("fetch", f.mock);
    await dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: REPO,
      branch: "feature",
    });
    const body = triggerBody(f.mock);
    vi.unstubAllGlobals();
    return body.input;
  };

  const auditThread = () =>
    createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        sourceMetadata: {
          type: "automation-skill",
          skillName: "audit-findings",
          contentSha: "sha",
          source: "db",
        },
      },
    });

  const seedFinding = () =>
    insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: "0123456789abcdef",
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: "Lockfile missing",
        subject: "pnpm-lock.yaml",
        status: "open",
      },
    });

  it("an audit-stamped dispatch carries the planned selfHeal and never logs the token", async () => {
    await seedFinding();
    const spies = (["log", "warn", "error", "info", "debug"] as const).map(
      (level) => vi.spyOn(console, level),
    );
    const t = await auditThread();
    const input = await dispatchAndRead(t);
    const selfHeal = input.selfHeal as SelfHealAuditRunInput;
    expect(selfHeal.kind).toBe("audit");
    expect(selfHeal.checks).toEqual([
      {
        fingerprint: "0123456789abcdef",
        check: "file-exists",
        subject: "pnpm-lock.yaml",
      },
    ]);
    const token = selfHeal.checkToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [run] = await db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.threadId, t.threadId));
    expect(run?.checkTokenHash).toBe(hashSelfHealToken(token));
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(token);
      }
      spy.mockRestore();
    }
  });

  it("flag off: an audit-stamped dispatch has no selfHeal key and no audit run", async () => {
    await setFlag(false);
    const t = await auditThread();
    const input = await dispatchAndRead(t);
    expect("selfHeal" in input).toBe(false);
    const rows = await db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.threadId, t.threadId));
    expect(rows).toHaveLength(0);
  });

  it("a plain task dispatch has no selfHeal key", async () => {
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    const input = await dispatchAndRead(t);
    expect("selfHeal" in input).toBe(false);
  });

  it("a review dispatch never carries selfHeal", async () => {
    const t = await createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({
        userId: user.id,
        orgId,
        triggerType: "pull_request",
      }),
      prNumber: 7,
    });
    const input = await dispatchAndRead(t);
    expect("selfHeal" in input).toBe(false);
  });
});

describe("dispatchAgentRun — phase 9 fix dispatch (RACE-01, TMO-01, RES-06)", () => {
  let user: User;
  let orgId: string;
  let findingId: string;
  let issueNumber: number;
  const REPO = "be-automata/automata";
  const FP = "0123456789abcdef";
  const TRIGGER = "/workflow-runs/trigger";

  const setFlag = (on: boolean) =>
    upsertFeatureFlag({
      db,
      name: "selfHealLoop",
      updates: { defaultValue: false, globalOverride: on },
    });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    selfHealReadbackSettle.ms = 2_000;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // R4: the settle is real time; the order of calls is what is asserted.
    selfHealReadbackSettle.ms = 0;
    user = (await createTestUser({ db })).user;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    await setFlag(true);
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { selfHealMode: "on" },
    });
    issueNumber = Math.floor(Math.random() * 100_000) + 1;
    findingId = (
      await insertFinding({
        db,
        organizationId: orgId,
        finding: {
          repoFullName: REPO,
          fingerprint: FP,
          audit: "security-audit",
          ruleId: "supply.lockfile-missing",
          severity: "high",
          checkKind: "script",
          title: "Lockfile missing",
          subject: "pnpm-lock.yaml",
          status: "open",
          planFiles: ["package.json", "pnpm-lock.yaml"],
          issueNumber,
          autoFixLabeled: true,
          fixReadyAt: new Date(Date.now() - 60_000),
        },
      })
    ).id;
  });

  const claim = async () => {
    const claimed = await claimFixAttempt({
      db,
      organizationId: orgId,
      findingId,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor: (attemptNo) =>
        fixBranchName({ issueNumber, fingerprint: FP, attemptNo }),
    });
    if (!claimed) throw new Error("claim failed");
    return claimed.attempt;
  };

  const fixThread = (attemptId: string) =>
    createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        sourceMetadata: {
          type: "automation-skill",
          skillName: "audit-fix",
          contentSha: "sha",
          source: "db",
          selfHealAttemptId: attemptId,
        },
      },
    });

  const dispatch = (t: { threadId: string; threadChatId: string }) =>
    dispatchAgentRun({
      userId: user.id,
      threadId: t.threadId,
      threadChatId: t.threadChatId,
      repoFullName: REPO,
      branch: "main",
    });

  const ok = (id: string) =>
    new Response(JSON.stringify({ run: { metadata: { id } } }), {
      status: 200,
    });
  const listing = (rows: Array<{ id: string; status: string }>) =>
    new Response(
      JSON.stringify({
        rows: rows.map((r) => ({ metadata: { id: r.id }, status: r.status })),
        pagination: { num_pages: 1 },
      }),
      { status: 200 },
    );
  /** A trigger POST that never answers until its signal aborts. */
  const hang = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });

  type Call = [string, RequestInit | undefined];
  const triggerCalls = (mock: ReturnType<typeof vi.fn>) =>
    (mock.mock.calls as unknown as Call[]).filter(([u]) =>
      String(u).includes(TRIGGER),
    );
  const listCalls = (mock: ReturnType<typeof vi.fn>) =>
    (mock.mock.calls as unknown as Call[]).filter(
      ([u]) => !String(u).includes(TRIGGER),
    );

  /** Every AbortSignal.timeout(ms) fires almost at once; the requested ms is recorded. */
  const fastTimeouts = () => {
    const requested: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      requested.push(ms);
      const controller = new AbortController();
      setTimeout(
        () =>
          controller.abort(
            new DOMException("The operation timed out.", "TimeoutError"),
          ),
        5,
      );
      return controller.signal;
    });
    return requested;
  };

  const events = () =>
    db
      .select()
      .from(selfHealBreakerEvent)
      .where(eq(selfHealBreakerEvent.organizationId, orgId));

  const readAttempt = async (id: string) => {
    const [row] = await db
      .select()
      .from(auditFixAttempts)
      .where(eq(auditFixAttempts.id, id));
    return row;
  };

  it("a fix dispatch carries selfHeal.kind fix from the stamped attempt, bounded, and never logs the token", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map(
      (level) => vi.spyOn(console, level),
    );
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    const f = vi.fn(async (url: string) =>
      String(url).includes(TRIGGER) ? ok("run-fix") : listing([]),
    );
    vi.stubGlobal("fetch", f);
    await dispatch(t);
    vi.unstubAllGlobals();

    const calls = triggerCalls(f);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const input = JSON.parse(String(calls[0]?.[1]?.body)).input;
    expect(input.branch).toBe("main");
    const selfHeal = input.selfHeal as SelfHealRunInput;
    if (selfHeal.kind !== "fix") throw new Error("expected a fix payload");
    expect(selfHeal.attemptId).toBe(attempt.id);
    expect(selfHeal.branch).toBe(attempt.branch);
    expect(selfHeal.baseBranch).toBe("main");
    // 09-10 base pin: the worker pins refs/remotes/origin/<selfHeal.baseBranch>
    // right after the clone, so the clone branch must BE the base.
    expect(selfHeal.baseBranch).toBe(input.branch);
    expect(selfHeal.checks).toEqual([
      { fingerprint: FP, check: "file-exists", subject: "pnpm-lock.yaml" },
    ]);
    expect(selfHeal.denyExceptions).toEqual([]);
    const row = await readAttempt(attempt.id);
    expect(row?.threadId).toBe(t.threadId);
    expect(row?.gateTokenHash).toBe(hashSelfHealToken(selfHeal.gateToken));
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(selfHeal.gateToken);
      }
      spy.mockRestore();
    }
    expect(
      (await events()).map((e) => [e.scopeKind, e.scopeKey, e.outcome]),
    ).toEqual([["hatchet_dispatch", "*", "success"]]);
  });

  it.each([
    [
      "the kill switch",
      () =>
        upsertRepoReviewSetting({
          db,
          organizationId: orgId,
          repoFullName: "*",
          patch: { selfHealKillSwitch: true },
        }),
      "killed",
    ],
    ["the flag off", () => setFlag(false), "killed"],
    [
      "dry-run",
      () =>
        upsertRepoReviewSetting({
          db,
          organizationId: orgId,
          repoFullName: REPO,
          patch: { selfHealMode: "dry-run" },
        }),
      "killed",
    ],
  ])(
    "fail closed (%s): Hatchet is never triggered, the thread fails and the attempt is refunded",
    async (_label, arrange, outcome) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const attempt = await claim();
      const t = await fixThread(attempt.id);
      await arrange();
      const f = vi.fn(async () => ok("never"));
      vi.stubGlobal("fetch", f);
      await expect(dispatch(t)).rejects.toThrow(
        "Failed to dispatch the remote agent run.",
      );
      vi.unstubAllGlobals();
      expect(triggerCalls(f)).toHaveLength(0);
      const runKey = daemonRunKey(t);
      expect(
        await hasActiveDaemonToken({ userId: user.id, name: runKey }),
      ).toBe(false);
      const row = await readAttempt(attempt.id);
      expect(row?.phase).toBe("closed");
      expect(row?.outcome).toBe(outcome);
    },
  );

  it("fail closed: a stamp whose attempt does not exist is never triggered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await fixThread("00000000-0000-4000-8000-000000000000");
    const f = vi.fn(async () => ok("never"));
    vi.stubGlobal("fetch", f);
    await expect(dispatch(t)).rejects.toThrow();
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(0);
  });

  it("fail closed: a personal (no-org) thread with the fix stamp is never triggered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sourceMetadata: {
          type: "automation-skill",
          skillName: "audit-fix",
          contentSha: "sha",
          source: "db",
          selfHealAttemptId: "00000000-0000-4000-8000-000000000000",
        },
      },
    });
    const f = vi.fn(async () => ok("never"));
    vi.stubGlobal("fetch", f);
    await expect(dispatch(t)).rejects.toThrow();
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(0);
  });

  it("RES-06: a hung trigger is aborted at 5 s; the read-back finds it QUEUED → no second POST, the run id comes from the read-back", async () => {
    const requested = fastTimeouts();
    const log = vi.spyOn(console, "log");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    const f = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).includes(TRIGGER)
        ? hang(init)
        : listing([{ id: "run-readback", status: "QUEUED" }]),
    );
    vi.stubGlobal("fetch", f);
    await dispatch(t);
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(1);
    expect(listCalls(f)).toHaveLength(1);
    expect(requested[0]).toBe(5000);
    expect(String(listCalls(f)[0]?.[0])).toContain(
      encodeURIComponent(`threadId:${t.threadId}`),
    );
    expect(JSON.stringify(log.mock.calls)).toContain("run-readback");
    expect(
      await hasActiveDaemonToken({
        userId: user.id,
        name: daemonRunKey(t),
      }),
    ).toBe(true);
    expect((await events()).map((e) => [e.outcome, e.signal])).toEqual([
      ["success", "dispatch_visible"],
    ]);
  });

  it("RES-06: a RUNNING read-back also counts as dispatched", async () => {
    fastTimeouts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    const f = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).includes(TRIGGER)
        ? hang(init)
        : listing([{ id: "run-live", status: "RUNNING" }]),
    );
    vi.stubGlobal("fetch", f);
    await dispatch(t);
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(1);
  });

  it("R4: a run invisible on the first read-back but found after the settle → no second POST", async () => {
    fastTimeouts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    let lists = 0;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes(TRIGGER)) return hang(init);
      lists += 1;
      return lists === 1
        ? listing([])
        : listing([{ id: "run-late", status: "QUEUED" }]);
    });
    vi.stubGlobal("fetch", f);
    await dispatch(t);
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(1);
    expect(listCalls(f)).toHaveLength(2);
    expect((await events()).map((e) => [e.outcome, e.signal])).toEqual([
      ["success", "dispatch_visible"],
    ]);
  });

  it("RES-06: an empty read-back after a timeout → exactly one retry", async () => {
    fastTimeouts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    let triggers = 0;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).includes(TRIGGER)) return listing([]);
      triggers += 1;
      return triggers === 1 ? hang(init) : ok("run-retry");
    });
    vi.stubGlobal("fetch", f);
    await dispatch(t);
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(2);
    // R4: an empty read-back is read again after the settle before the retry.
    expect(listCalls(f)).toHaveLength(2);
    expect((await events()).map((e) => [e.outcome, e.signal])).toEqual([
      ["success", "dispatch_visible"],
    ]);
  });

  it("RES-06: an ambiguous 5xx is read back before the one retry; a second miss fails the thread and records dispatch_lost", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    const f = vi.fn(async (url: string) =>
      String(url).includes(TRIGGER)
        ? new Response("bad gateway", { status: 502 })
        : listing([{ id: "old", status: "COMPLETED" }]),
    );
    vi.stubGlobal("fetch", f);
    await expect(dispatch(t)).rejects.toThrow(
      "Failed to dispatch the remote agent run.",
    );
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(2);
    expect(listCalls(f)).toHaveLength(4);
    const order = (f.mock.calls as unknown as Call[]).map(([u]) =>
      String(u).includes(TRIGGER) ? "trigger" : "list",
    );
    expect(order).toEqual([
      "trigger",
      "list",
      "list",
      "trigger",
      "list",
      "list",
    ]);
    expect((await events()).map((e) => [e.outcome, e.signal])).toEqual([
      ["failure", "dispatch_lost"],
    ]);
    expect(
      await hasActiveDaemonToken({ userId: user.id, name: daemonRunKey(t) }),
    ).toBe(false);
  });

  it("RES-06: a definitive 4xx is not retried and not read back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    const f = vi.fn(async () => new Response("bad input", { status: 400 }));
    vi.stubGlobal("fetch", f);
    await expect(dispatch(t)).rejects.toThrow();
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(1);
    expect(listCalls(f)).toHaveLength(0);
    expect((await events()).map((e) => [e.outcome, e.signal])).toEqual([
      ["failure", "dispatch_lost"],
    ]);
  });

  it("RES-06: a failed read-back never retries blindly", async () => {
    fastTimeouts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = await claim();
    const t = await fixThread(attempt.id);
    const f = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).includes(TRIGGER)
        ? hang(init)
        : new Response("nope", { status: 500 }),
    );
    vi.stubGlobal("fetch", f);
    await expect(dispatch(t)).rejects.toThrow();
    vi.unstubAllGlobals();
    expect(triggerCalls(f)).toHaveLength(1);
    expect(listCalls(f)).toHaveLength(1);
    expect((await events()).map((e) => [e.outcome, e.signal])).toEqual([
      ["failure", "dispatch_lost"],
    ]);
  });

  it("an audit-stamped dispatch is bounded too", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { selfHealMode: "dry-run" },
    });
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        organizationId: orgId,
        sourceMetadata: {
          type: "automation-skill",
          skillName: "audit-findings",
          contentSha: "sha",
          source: "db",
        },
      },
    });
    const f = vi.fn(async () => ok("run-audit"));
    vi.stubGlobal("fetch", f);
    await dispatch(t);
    vi.unstubAllGlobals();
    expect(triggerCalls(f)[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect((await events()).map((e) => e.scopeKind)).toEqual([
      "hatchet_dispatch",
    ]);
  });

  it("plain task and review dispatches keep the legacy trigger: no signal, no breaker event", async () => {
    const plain = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    const review = await createBootingPRThread({
      userId: user.id,
      orgId,
      automationId: await createReviewAutomation({
        userId: user.id,
        orgId,
        triggerType: "pull_request",
      }),
      prNumber: 7,
    });
    for (const t of [plain, review]) {
      const f = routedHatchetFetch("run-x");
      vi.stubGlobal("fetch", f.mock);
      await dispatch(t);
      vi.unstubAllGlobals();
      const calls = triggerCalls(f.mock);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1] && "signal" in calls[0][1]).toBe(false);
    }
    expect(await events()).toEqual([]);
  });
});
