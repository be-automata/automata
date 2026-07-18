import { describe, it, beforeEach, vi, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { apikey as apikeyTable } from "@terragon/shared/db/schema";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { nanoid } from "nanoid";
import { revokeDaemonTokensForSandbox } from "./daemon-token";

async function keysNamed(userId: string, name: string) {
  return db
    .select({ id: apikeyTable.id })
    .from(apikeyTable)
    .where(and(eq(apikeyTable.userId, userId), eq(apikeyTable.name, name)));
}

describe("revokeDaemonTokensForSandbox (ADR-003 F3)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
  });

  it("revokes all daemon tokens for the sandbox and leaves others intact", async () => {
    const sandboxId = `sbx-${nanoid(8)}`;
    const otherSandbox = `sbx-${nanoid(8)}`;
    // Two tokens for this run (as multiple messages would mint) + one unrelated.
    await auth.api.createApiKey({
      body: { name: sandboxId, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    await auth.api.createApiKey({
      body: { name: sandboxId, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    await auth.api.createApiKey({
      body: { name: otherSandbox, userId: user.id },
    });

    const count = await revokeDaemonTokensForSandbox({
      userId: user.id,
      sandboxId,
    });

    expect(count).toBe(2);
    expect(await keysNamed(user.id, sandboxId)).toHaveLength(0);
    expect(await keysNamed(user.id, otherSandbox)).toHaveLength(1);
  });

  it("returns 0 when there is nothing to revoke", async () => {
    expect(
      await revokeDaemonTokensForSandbox({
        userId: user.id,
        sandboxId: "no-such-sandbox",
      }),
    ).toBe(0);
  });
});
