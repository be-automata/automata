import { describe, it, vi, beforeEach, expect } from "vitest";
import { createRouterClient, ORPCError } from "@orpc/server";
import { cliRouter } from "./cli-router";
import { verifyDaemonApiKey } from "@/lib/daemon-api-key";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";

vi.mock("@/lib/daemon-api-key", () => ({ verifyDaemonApiKey: vi.fn() }));

const client = createRouterClient(cliRouter, {
  context: { headers: new Headers({ "X-Daemon-Token": "tok" }) },
});

function verifiedKey(metadata: Record<string, unknown>) {
  return {
    id: "apikey_test",
    referenceId: "u1",
    metadata,
  } as NonNullable<Awaited<ReturnType<typeof verifyDaemonApiKey>>>;
}

describe("cli-router middleware — F1 daemon-token purpose scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("REJECTS a daemon-scoped token (a compromised box gets no CLI access)", async () => {
    vi.mocked(verifyDaemonApiKey).mockResolvedValue(
      verifiedKey({ threadChatId: "tc1", threadId: "t1", tokenType: "daemon" }),
    );
    await expect(client.auth.whoami()).rejects.toThrow();
  });

  it("accepts a non-daemon (CLI) token", async () => {
    vi.mocked(verifyDaemonApiKey).mockResolvedValue(verifiedKey({}));
    await expect(client.auth.whoami()).resolves.toEqual({ userId: "u1" });
  });

  it("rejects when there is no token at all", async () => {
    vi.mocked(verifyDaemonApiKey).mockResolvedValue(null);
    await expect(client.auth.whoami()).rejects.toThrow();
  });

  it("reads X-Daemon-Token only: no header or a Bearer never reaches the verifier", async () => {
    const bearer = createRouterClient(cliRouter, {
      context: { headers: new Headers({ Authorization: "Bearer tok" }) },
    });
    await expect(bearer.auth.whoami()).rejects.toThrow();
    expect(verifyDaemonApiKey).not.toHaveBeenCalled();
  });

  it("answers SERVICE_UNAVAILABLE (503), not UNAUTHORIZED, when daemon auth is unavailable", async () => {
    vi.mocked(verifyDaemonApiKey).mockRejectedValue(
      new DaemonAuthUnavailableError("api key lookup failed"),
    );
    const error = await client.auth.whoami().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect((error as ORPCError<string, unknown>).status).toBe(503);
    // Declared in the contract (CLI practices rule 6): the typed reason travels.
    expect((error as ORPCError<string, unknown>).data).toEqual({
      reason: "auth_unavailable",
    });
  });
});
