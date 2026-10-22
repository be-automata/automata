import { describe, it, vi, beforeEach, expect } from "vitest";
import { createRouterClient, ORPCError } from "@orpc/server";
import { cliRouter } from "./cli-router";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";

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
      apiKeyId: "apikey_test",
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
      apiKeyId: "apikey_test",
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

  it("answers SERVICE_UNAVAILABLE (503), not UNAUTHORIZED, when daemon auth is unavailable", async () => {
    vi.mocked(getDaemonTokenContext).mockRejectedValue(
      new DaemonAuthUnavailableError("api key lookup failed"),
    );
    const error = await client.auth.whoami().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect((error as ORPCError<string, unknown>).status).toBe(503);
  });
});
