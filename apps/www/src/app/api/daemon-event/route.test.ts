import { describe, it, vi, beforeEach, expect } from "vitest";
import { POST } from "./route";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { DaemonTokenContext } from "@/lib/daemon-token-context";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenContext: vi.fn(),
}));
vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn().mockResolvedValue({ success: true }),
}));

const THREAD_CHAT_ID = "tc_1";

function ctx(over: Partial<DaemonTokenContext> = {}): DaemonTokenContext {
  return {
    userId: "user_1",
    apiKeyId: "apikey_test",
    organizationId: "org_1",
    threadChatId: THREAD_CHAT_ID,
    // Default null (legacy token) so existing cases pass the threadId anchor;
    // the threadId-binding case sets it explicitly.
    threadId: null,
    tokenType: "daemon",
    ...over,
  };
}

function req(threadChatId: string) {
  return new Request("http://localhost/api/daemon-event", {
    method: "POST",
    body: JSON.stringify({
      messages: [],
      threadId: "thr_1",
      threadChatId,
    }),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon-event — F1/F2 token binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
  });

  it("401 without a valid daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    const res = await POST(req(THREAD_CHAT_ID));
    expect(res.status).toBe(401);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("F1: 403 for a non-daemon (CLI) token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ tokenType: null }),
    );
    const res = await POST(req(THREAD_CHAT_ID));
    expect(res.status).toBe(403);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("F2: 403 when the token is bound to a DIFFERENT threadChat", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: "tc_other" }),
    );
    const res = await POST(req(THREAD_CHAT_ID));
    expect(res.status).toBe(403);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("F2: ingests when the token's threadChat matches", async () => {
    const res = await POST(req(THREAD_CHAT_ID));
    expect(res.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });

  it("back-compat: a legacy token with no threadChatId is allowed through", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: null }),
    );
    const res = await POST(req(THREAD_CHAT_ID));
    expect(res.status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/daemon-event — #125 C1 generation header", () => {
  beforeEach(() => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
    vi.mocked(handleDaemonEvent).mockClear();
  });

  it("forwards x-run-external-id to the handler (null when absent)", async () => {
    await POST(req(THREAD_CHAT_ID));
    expect(vi.mocked(handleDaemonEvent).mock.calls[0]![0]).toMatchObject({
      runExternalId: null,
    });
    await POST(
      new Request("http://localhost/api/daemon-event", {
        method: "POST",
        body: JSON.stringify({
          messages: [],
          threadId: "thr_1",
          threadChatId: THREAD_CHAT_ID,
        }),
        headers: {
          "X-Daemon-Token": "tok",
          "content-type": "application/json",
          "x-run-external-id": "run-7",
        },
      }),
    );
    expect(vi.mocked(handleDaemonEvent).mock.calls[1]![0]).toMatchObject({
      runExternalId: "run-7",
    });
  });

  it("maps the handler's 409 to the response", async () => {
    vi.mocked(handleDaemonEvent).mockResolvedValueOnce({
      success: false,
      error: "superseded",
      status: 409,
    });
    expect((await POST(req(THREAD_CHAT_ID))).status).toBe(409);
  });
});
