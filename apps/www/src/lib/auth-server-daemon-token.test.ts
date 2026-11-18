import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import { eq } from "drizzle-orm";
import { PgDatabase } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { apikey as apikeyTable } from "@terragon/shared/db/schema";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";
import { verifyDaemonApiKey } from "@/lib/daemon-api-key";
import { RETIRED_TOKEN_SUFFIX } from "@/lib/daemon-token-context";

/**
 * A drizzle query builder whose every step chains and whose await rejects —
 * what a Neon connect timeout looks like to the caller.
 */
const failingQuery: object = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "then") {
        return (_resolve: unknown, reject: (reason: unknown) => void) =>
          reject(new Error('Failed query: select "id" from "apikey"'));
      }
      return () => failingQuery;
    },
  },
);

function daemonRequest(token: string | null) {
  const headers = new Headers();
  if (token !== null) {
    headers.set("X-Daemon-Token", token);
  }
  return { headers };
}

describe("getDaemonTokenContext: unavailable vs unauthorized", () => {
  let user: User;
  let token: string;
  let apiKeyId: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    user = (await createTestUser({ db })).user;
    const created = await auth.api.createApiKey({
      body: {
        name: `run-${nanoid(8)}`,
        userId: user.id,
        expiresIn: 60 * 60 * 24,
        metadata: {
          threadChatId: "tc_1",
          threadId: "t_1",
          tokenType: "daemon",
        },
      },
    });
    token = created.key;
    apiKeyId = created.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null without a token", async () => {
    await expect(getDaemonTokenContext(daemonRequest(null))).resolves.toBe(
      null,
    );
  });

  it("returns the context for a valid key", async () => {
    await expect(getDaemonTokenContext(daemonRequest(token))).resolves.toEqual(
      expect.objectContaining({
        userId: user.id,
        apiKeyId,
        threadChatId: "tc_1",
        threadId: "t_1",
        tokenType: "daemon",
      }),
    );
  });

  it("returns null (401) for an unknown key without calling verifyApiKey", async () => {
    const verify = vi.spyOn(auth.api, "verifyApiKey");
    await expect(
      getDaemonTokenContext(daemonRequest(`unknown-${nanoid(32)}`)),
    ).resolves.toBe(null);
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns null (401) for a revoked key", async () => {
    await db.delete(apikeyTable).where(eq(apikeyTable.id, apiKeyId));
    await expect(getDaemonTokenContext(daemonRequest(token))).resolves.toBe(
      null,
    );
  });

  it("returns null (401) for a disabled key", async () => {
    await db
      .update(apikeyTable)
      .set({ enabled: false })
      .where(eq(apikeyTable.id, apiKeyId));
    await expect(getDaemonTokenContext(daemonRequest(token))).resolves.toBe(
      null,
    );
  });

  it("returns null (401) for an expired key", async () => {
    await db
      .update(apikeyTable)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apikeyTable.id, apiKeyId));
    await expect(getDaemonTokenContext(daemonRequest(token))).resolves.toBe(
      null,
    );
  });

  it("throws DaemonAuthUnavailableError (503) when the key lookup fails", async () => {
    // `db` resolves to a drizzle PgDatabase; fault every select on it.
    vi.spyOn(PgDatabase.prototype, "select").mockImplementation(
      () => failingQuery as never,
    );
    const verify = vi.spyOn(auth.api, "verifyApiKey");
    await expect(
      getDaemonTokenContext(daemonRequest(token)),
    ).rejects.toBeInstanceOf(DaemonAuthUnavailableError);
    expect(verify).not.toHaveBeenCalled();
  });

  it("throws DaemonAuthUnavailableError (503) when the row exists but verify says INVALID_API_KEY", async () => {
    // What better-auth answers when its own query throws (e.g. a DB timeout).
    vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: { message: "Invalid API key.", code: "INVALID_API_KEY" },
      key: null,
    } as unknown as Awaited<ReturnType<typeof auth.api.verifyApiKey>>);
    await expect(
      getDaemonTokenContext(daemonRequest(token)),
    ).rejects.toBeInstanceOf(DaemonAuthUnavailableError);
  });

  it("throws DaemonAuthUnavailableError (503) when verifyApiKey itself throws", async () => {
    vi.spyOn(auth.api, "verifyApiKey").mockRejectedValue(
      new Error("connection terminated"),
    );
    await expect(
      getDaemonTokenContext(daemonRequest(token)),
    ).rejects.toBeInstanceOf(DaemonAuthUnavailableError);
  });
});

describe("retired daemon tokens: refused unless allowRetired", () => {
  let token: string;
  let liveToken: string;
  let apiKeyId: string;

  async function mint(name: string) {
    const { user } = await createTestUser({ db });
    const created = await auth.api.createApiKey({
      body: {
        name,
        userId: user.id,
        expiresIn: 60 * 60 * 24,
        metadata: {
          threadChatId: "tc_1",
          threadId: "t_1",
          tokenType: "daemon",
        },
      },
    });
    return created;
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    const retired = await mint(`run-${nanoid(8)}`);
    token = retired.key;
    apiKeyId = retired.id;
    await db
      .update(apikeyTable)
      .set({ name: `run-${nanoid(8)}${RETIRED_TOKEN_SUFFIX}` })
      .where(eq(apikeyTable.id, apiKeyId));
    liveToken = (await mint(`run-${nanoid(8)}`)).key;
  });

  it("a retired key verifies to null by default, through the real verify", async () => {
    await expect(verifyDaemonApiKey(token)).resolves.toBe(null);
    await expect(getDaemonTokenContext(daemonRequest(token))).resolves.toBe(
      null,
    );
  });

  it("allowRetired returns the key, and the context resolves", async () => {
    await expect(
      verifyDaemonApiKey(token, { allowRetired: true }),
    ).resolves.toEqual(expect.objectContaining({ id: apiKeyId }));
    await expect(
      getDaemonTokenContext(daemonRequest(token), { allowRetired: true }),
    ).resolves.toEqual(expect.objectContaining({ apiKeyId }));
  });

  it("a live key is unaffected either way (control)", async () => {
    await expect(verifyDaemonApiKey(liveToken)).resolves.not.toBe(null);
    await expect(
      verifyDaemonApiKey(liveToken, { allowRetired: true }),
    ).resolves.not.toBe(null);
    await expect(
      getDaemonTokenContext(daemonRequest(liveToken)),
    ).resolves.not.toBe(null);
  });

  it("an expired retired key is still null with allowRetired", async () => {
    await db
      .update(apikeyTable)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apikeyTable.id, apiKeyId));
    await expect(
      verifyDaemonApiKey(token, { allowRetired: true }),
    ).resolves.toBe(null);
  });
});
