import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { getAndVerifyCredentialsWithSource } from "@/agent/credentials";
import { ThreadError } from "@/agent/error";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";
import {
  getThreadChat,
  setThreadChatDeliveredCredential,
} from "@terragon/shared/model/threads";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenContext: vi.fn(),
}));

vi.mock("@/agent/credentials", () => ({
  getAndVerifyCredentialsWithSource: vi.fn(),
}));

// The real setter by default; a test can make it throw (#442: a recording
// failure must never turn into a non-OK response).
vi.mock("@terragon/shared/model/threads", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@terragon/shared/model/threads")>();
  return {
    ...actual,
    setThreadChatDeliveredCredential: vi.fn(
      actual.setThreadChatDeliveredCredential,
    ),
  };
});

const CLAUDE_SUBSCRIPTION = {
  type: "json-file" as const,
  contents: JSON.stringify({ claudeAiOauth: { accessToken: "at" } }),
};
const DELIVERED_ID = "cred-delivered-1";

async function deliveredId(
  userId: string,
  threadId: string,
  threadChatId: string,
) {
  const chat = await getThreadChat({ db, userId, threadId, threadChatId });
  return chat!.deliveredCredentialId;
}

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
    vi.mocked(getAndVerifyCredentialsWithSource).mockResolvedValue({
      credentials: CLAUDE_SUBSCRIPTION,
      credentialId: DELIVERED_ID,
    });
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
    expect(getAndVerifyCredentialsWithSource).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, organizationId: orgId }),
    );
  });

  it("400 Invalid body for a null, array or non-object JSON body", async () => {
    for (const raw of ["null", "[]", '"x"', "7"]) {
      const res = await POST(
        new NextRequest("http://localhost/api/daemon/agent-credentials", {
          method: "POST",
          body: raw,
          headers: { "X-Daemon-Token": "tok" },
        }),
      );
      expect(res.status, raw).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid body" });
    }
    expect(getAndVerifyCredentialsWithSource).not.toHaveBeenCalled();
  });

  it("401 without a valid daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(401);
    expect(getAndVerifyCredentialsWithSource).not.toHaveBeenCalled();
  });

  it("F1: 403 for a non-daemon (e.g. CLI) token — a user token cannot exfiltrate a credential", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ tokenType: null }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(getAndVerifyCredentialsWithSource).not.toHaveBeenCalled();
  });

  it("F2: 403 when the token is bound to a DIFFERENT threadChat", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: "some-other-threadchat" }),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(getAndVerifyCredentialsWithSource).not.toHaveBeenCalled();
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
    expect(getAndVerifyCredentialsWithSource).not.toHaveBeenCalled();
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
    expect(getAndVerifyCredentialsWithSource).not.toHaveBeenCalled();
  });

  it("400 when threadId/threadChatId missing from the body", async () => {
    expect((await POST(req({ threadChatId }))).status).toBe(400);
    expect((await POST(req({ threadId }))).status).toBe(400);
  });

  it("a missing credential is built-in-credits, not a 500 — the run proceeds on the proxy", async () => {
    vi.mocked(getAndVerifyCredentialsWithSource).mockRejectedValue(
      new ThreadError("invalid-claude-credentials", "nope", null),
    );
    const res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      agent: "claudeCode",
      credentials: { type: "built-in-credits" },
    });
  });

  // #442 (epic #440 C2): attribution of the delivered credential.
  describe("records the delivered credential (#442)", () => {
    // Card: protects=a legacy thread (production's shape) records the
    // delivered id on its thread row and the body is unchanged;
    // fails_when=nothing is recorded, or the id leaks into the response;
    // no_claim=what marks it (handle-daemon-event suite).
    it("on a legacy thread, without changing the response", async () => {
      const res = await POST(req({ threadId, threadChatId }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        agent: "claudeCode",
        credentials: CLAUDE_SUBSCRIPTION,
      });
      expect(await deliveredId(user.id, threadId, threadChatId)).toBe(
        DELIVERED_ID,
      );
    });

    it("on a chat-mode thread's chat row", async () => {
      const t = await createTestThread({
        db,
        userId: user.id,
        overrides: { organizationId: orgId },
        enableThreadChatCreation: true,
      });
      vi.mocked(getDaemonTokenContext).mockResolvedValue(
        ctx({ threadId: t.threadId, threadChatId: t.threadChatId }),
      );
      const res = await POST(
        req({ threadId: t.threadId, threadChatId: t.threadChatId }),
      );
      expect(res.status).toBe(200);
      expect(await deliveredId(user.id, t.threadId, t.threadChatId)).toBe(
        DELIVERED_ID,
      );
    });

    // Card: protects=a built-in-credits delivery overwrites an earlier id with
    // NULL, so a later credit-exhausted result cannot mark a row this run
    // never used; fails_when=the previous id survives; no_claim=the mark.
    it("NULL when the run falls back to built-in credits", async () => {
      await POST(req({ threadId, threadChatId }));
      expect(await deliveredId(user.id, threadId, threadChatId)).toBe(
        DELIVERED_ID,
      );
      vi.mocked(getAndVerifyCredentialsWithSource).mockRejectedValue(
        new ThreadError("invalid-claude-credentials", "nope", null),
      );
      await POST(req({ threadId, threadChatId }));
      expect(await deliveredId(user.id, threadId, threadChatId)).toBeNull();
    });

    it("NULL for a built-in-credits resolution with no source row", async () => {
      await POST(req({ threadId, threadChatId }));
      vi.mocked(getAndVerifyCredentialsWithSource).mockResolvedValue({
        credentials: { type: "built-in-credits" },
        credentialId: null,
      });
      await POST(req({ threadId, threadChatId }));
      expect(await deliveredId(user.id, threadId, threadChatId)).toBeNull();
    });

    // Card: protects=a recording failure still answers 200 with the
    // credential; fails_when=it becomes a 5xx, which the worker reads as
    // "use built-in credits"; no_claim=the worker's own fallback.
    it("a recording failure still serves the credential with 200", async () => {
      vi.mocked(setThreadChatDeliveredCredential).mockRejectedValueOnce(
        new Error("db down"),
      );
      const res = await POST(req({ threadId, threadChatId }));
      expect(res.status).toBe(200);
      expect((await res.json()).credentials).toEqual(CLAUDE_SUBSCRIPTION);
    });
  });
});
