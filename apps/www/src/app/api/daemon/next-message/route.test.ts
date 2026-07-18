import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { buildRemoteDaemonMessage } from "@/server-lib/remote-daemon-message";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenContext: vi.fn(),
}));

vi.mock("@/server-lib/remote-daemon-message", () => ({
  buildRemoteDaemonMessage: vi.fn(),
}));

const CANNED = {
  type: "claude" as const,
  model: "claude-x",
  agent: "claudeCode",
  agentVersion: 1,
  prompt: "do the thing",
  sessionId: null,
  permissionMode: "allowAll" as const,
  featureFlags: {},
};

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/daemon/next-message", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon/next-message", () => {
  let user: User;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;

  function ctx(over: Partial<DaemonTokenContext> = {}): DaemonTokenContext {
    return {
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: orgId,
      threadChatId,
      threadId,
      tokenType: "daemon",
      ...over,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(buildRemoteDaemonMessage).mockResolvedValue(CANNED);
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
      overrides: { organizationId: orgId },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
  });

  it("401 without a valid daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(401);
    expect(buildRemoteDaemonMessage).not.toHaveBeenCalled();
  });

  it("F1: 403 for a non-daemon (e.g. CLI) token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx({ tokenType: null }));
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(buildRemoteDaemonMessage).not.toHaveBeenCalled();
  });

  it("400 when threadId/threadChatId missing from the body", async () => {
    expect((await POST(req({ threadChatId }))).status).toBe(400);
    expect((await POST(req({ threadId }))).status).toBe(400);
  });

  it("F2: 403 when the token is bound to a DIFFERENT threadChat", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: "some-other-threadchat" }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(buildRemoteDaemonMessage).not.toHaveBeenCalled();
  });

  it("F2 anchor: 403 when a token minted for thread A pulls thread B (same shared threadChat sentinel)", async () => {
    // The security case: with enableThreadChatCreation off, thread A and thread B
    // both carry the shared legacy threadChat sentinel, so the threadChatId check
    // alone passes. The threadId anchor rejects thread A's token on thread B.
    const other = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      // Token minted for thread A (this test's threadId), same threadChatId…
      ctx({ threadId }),
    );
    // …used to pull thread B (other.threadId) with the SAME threadChatId.
    const res = await POST(
      req({ threadId: other.threadId, threadChatId }),
    );
    expect(res.status).toBe(403);
    expect(buildRemoteDaemonMessage).not.toHaveBeenCalled();
  });

  it("F2 anchor: a legacy token with no bound threadId passes through (rollout back-compat)", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx({ threadId: null }));
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
  });

  it("403 when the token's user does not own the thread", async () => {
    const other = (await createTestUser({ db })).user;
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ userId: other.id }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
  });

  it("403 when the token's org != the thread's org", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ organizationId: "some-other-org" }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
  });

  it("200 with the prepared message when token↔thread binding + purpose hold", async () => {
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CANNED);
    expect(buildRemoteDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
    });
  });

  it("204 when there is nothing to send yet", async () => {
    vi.mocked(buildRemoteDaemonMessage).mockResolvedValue(null);
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(204);
  });
});
