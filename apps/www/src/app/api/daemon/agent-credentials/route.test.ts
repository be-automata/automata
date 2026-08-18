import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { getAndVerifyCredentials } from "@/agent/credentials";
import { ThreadError } from "@/agent/error";
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

vi.mock("@/agent/credentials", () => ({
  getAndVerifyCredentials: vi.fn(),
}));

const CLAUDE_SUBSCRIPTION = {
  type: "json-file" as const,
  contents: JSON.stringify({ claudeAiOauth: { accessToken: "at" } }),
};

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/daemon/agent-credentials", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon/agent-credentials", () => {
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
    vi.mocked(getAndVerifyCredentials).mockResolvedValue(CLAUDE_SUBSCRIPTION);
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

  it("serves the run's credential with the agent it belongs to", async () => {
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials).toEqual(CLAUDE_SUBSCRIPTION);
    // The agent travels with the credential: the worker fixes HOME (and so the
    // credential file path) before it can pull next-message.
    expect(body.agent).toBe("claudeCode");
  });

  it("fences the lookup on the THREAD's org, never the user's other orgs", async () => {
    await POST(req({ threadId, threadChatId }));
    expect(getAndVerifyCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, organizationId: orgId }),
    );
  });

  it("401 without a valid daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(401);
    expect(getAndVerifyCredentials).not.toHaveBeenCalled();
  });

  it("F1: 403 for a non-daemon (e.g. CLI) token — a user token cannot exfiltrate a credential", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx({ tokenType: null }));
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(getAndVerifyCredentials).not.toHaveBeenCalled();
  });

  it("F2: 403 when the token is bound to a DIFFERENT threadChat", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: "some-other-threadchat" }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(getAndVerifyCredentials).not.toHaveBeenCalled();
  });

  it("F2 anchor: 403 when a token minted for thread A pulls thread B", async () => {
    const other = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadId: other.threadId }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(getAndVerifyCredentials).not.toHaveBeenCalled();
  });

  it("403 when the token's org does not match the thread's org", async () => {
    const otherOrg = await createOrganization({
      db,
      name: "Other",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ organizationId: otherOrg.id }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(getAndVerifyCredentials).not.toHaveBeenCalled();
  });

  it("400 when threadId/threadChatId missing from the body", async () => {
    expect((await POST(req({ threadChatId }))).status).toBe(400);
    expect((await POST(req({ threadId }))).status).toBe(400);
  });

  it("a missing credential is built-in-credits, not a 500 — the run proceeds on the proxy", async () => {
    vi.mocked(getAndVerifyCredentials).mockRejectedValue(
      new ThreadError("invalid-claude-credentials", "nope", null),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agent: "claudeCode",
      credentials: { type: "built-in-credits" },
    });
  });
});
