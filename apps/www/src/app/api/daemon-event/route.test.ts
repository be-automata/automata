import { describe, it, vi, beforeEach, expect } from "vitest";
import { POST } from "./route";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { DaemonTokenContext } from "@/lib/daemon-token-context";
import { getThreadGeneration } from "@terragon/shared/model/threads";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenContext: vi.fn(),
}));
vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("@terragon/shared/model/threads", () => ({
  // Default: no stamp, not superseded → the fence fails open for the
  // pre-existing cases.
  getThreadGeneration: vi
    .fn()
    .mockResolvedValue({ activeRunExternalId: null, superseded: false }),
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

describe("POST /api/daemon-event — #125 C1 generation fence", () => {
  function reqWith(extra: Record<string, unknown>) {
    return new Request("http://localhost/api/daemon-event", {
      method: "POST",
      body: JSON.stringify({
        messages: [],
        threadId: "thr_1",
        threadChatId: THREAD_CHAT_ID,
        ...extra,
      }),
      headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
    vi.mocked(getThreadGeneration).mockReset();
    vi.mocked(handleDaemonEvent).mockClear();
  });

  it("409 once the thread is terminal-superseded — a stale verdict never lands", async () => {
    vi.mocked(getThreadGeneration).mockResolvedValue({
      activeRunExternalId: "run-new",
      superseded: true,
    });
    const res = await POST(reqWith({}));
    expect(res.status).toBe(409);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("409 when the write names an older generation than the active run", async () => {
    vi.mocked(getThreadGeneration).mockResolvedValue({
      activeRunExternalId: "run-new",
      superseded: false,
    });
    const res = await POST(reqWith({ runExternalId: "run-old" }));
    expect(res.status).toBe(409);
    expect(handleDaemonEvent).not.toHaveBeenCalled();
  });

  it("accepts the active generation, and fails OPEN with no stamp", async () => {
    vi.mocked(getThreadGeneration).mockResolvedValue({
      activeRunExternalId: "run-new",
      superseded: false,
    });
    expect((await POST(reqWith({ runExternalId: "run-new" }))).status).toBe(
      200,
    );
    vi.mocked(getThreadGeneration).mockResolvedValue({
      activeRunExternalId: null,
      superseded: false,
    });
    expect((await POST(reqWith({ runExternalId: "whatever" }))).status).toBe(
      200,
    );
    // Daemon-originated events carry no runExternalId: only the superseded
    // flag can refuse them.
    expect((await POST(reqWith({}))).status).toBe(200);
  });
});
