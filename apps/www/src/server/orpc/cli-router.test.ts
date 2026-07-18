import { describe, it, vi, beforeEach, expect } from "vitest";
import { createRouterClient } from "@orpc/server";
import { cliRouter } from "./cli-router";
import { getDaemonTokenContext } from "@/lib/auth-server";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));

const client = createRouterClient(cliRouter, {
  context: {
    headers: new Headers(),
    userId: null as unknown as string,
    organizationId: null,
  },
});

describe("cli-router middleware — F1 daemon-token purpose scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("REJECTS a daemon-scoped token (a compromised box gets no CLI access)", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: "u1",
      organizationId: null,
      threadChatId: "tc1",
      threadId: "t1",
      tokenType: "daemon",
    });
    await expect(client.auth.whoami()).rejects.toThrow();
  });

  it("accepts a non-daemon (CLI) token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: "u1",
      organizationId: null,
      threadChatId: null,
      threadId: null,
      tokenType: null,
    });
    await expect(client.auth.whoami()).resolves.toEqual({ userId: "u1" });
  });

  it("rejects when there is no token at all", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    await expect(client.auth.whoami()).rejects.toThrow();
  });
});
