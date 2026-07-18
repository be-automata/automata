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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ externalId: "run-1" }), { status: 200 }),
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

    // Exactly the reference-only fields — nothing more.
    expect(Object.keys(input).sort()).toEqual(
      [
        "branch",
        "daemonCallbackUrl",
        "daemonToken",
        "installationToken",
        "repoFullName",
        "threadChatId",
        "threadId",
      ].sort(),
    );
    expect(input.threadId).toBe(threadId);
    expect(input.threadChatId).toBe(threadChatId);
    expect(input.repoFullName).toBe("be-automata/automata");
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

  it("revokes the just-minted daemon token when the trigger fails (no stale token)", async () => {
    const runKey = daemonRunKey({ threadId, threadChatId });
    // The trigger returns a non-2xx → triggerAgentRun throws → dispatch must revoke.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await dispatchAgentRun({
      userId: user.id,
      threadId,
      threadChatId,
      repoFullName: "be-automata/automata",
      branch: "main",
    });

    // The revoke runs in the background (registered on the waitUntil seam); poll.
    await vi.waitFor(async () => {
      expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
        false,
      );
    });
    vi.unstubAllGlobals();
  });
});
