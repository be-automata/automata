import { describe, it, beforeEach, vi, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { apikey as apikeyTable } from "@terragon/shared/db/schema";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { nanoid } from "nanoid";
import {
  revokeDaemonTokensForSandbox,
  revokeDaemonTokenById,
  hasActiveDaemonToken,
} from "./daemon-token";

async function keysNamed(userId: string, name: string) {
  return db
    .select({ id: apikeyTable.id })
    .from(apikeyTable)
    .where(and(eq(apikeyTable.referenceId, userId), eq(apikeyTable.name, name)));
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

  it("BURST SAFETY (S12): a null/empty sandboxId must NOT revoke the user's other live tokens", async () => {
    // Remote (Hatchet) threads have no sandbox → handleThreadFinish passes
    // sandboxId = thread.codesandboxId (null). If the null revoke drops its name
    // condition, it deletes EVERY daemon token for the user — killing sibling runs
    // mid-work under a burst (S12: only the first of 4 mentions replied).
    const runA = `${nanoid(8)}:legacy-thread-chat-id`;
    const runB = `${nanoid(8)}:legacy-thread-chat-id`;
    await auth.api.createApiKey({
      body: { name: runA, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    await auth.api.createApiKey({
      body: { name: runB, userId: user.id, metadata: { tokenType: "daemon" } },
    });

    // Simulate thread A's remote finish: the null sandboxId revoke.
    await revokeDaemonTokensForSandbox({
      userId: user.id,
      sandboxId: null as unknown as string,
    });

    // B's token (a DIFFERENT run) must still be live.
    expect(await hasActiveDaemonToken({ userId: user.id, name: runB })).toBe(true);
    expect(await hasActiveDaemonToken({ userId: user.id, name: runA })).toBe(true);
  });

  it("BURST SAFETY (S12): revokeDaemonTokenById revokes ONLY that run's token, never a sibling's", async () => {
    // Two live runs (A, B) — e.g. two of a burst of founder mentions. Each has its
    // own daemon token. When A's thread-finish revokes A's token by its EXACT
    // apikey id, B's token (a DIFFERENT run) must stay live, so B is not killed
    // mid-work. This is the fix for revoke-by-name/thread, which under a burst let
    // A's (possibly delayed) finish delete B's same-keyed token.
    const runName = `${nanoid(8)}:legacy-thread-chat-id`; // even a SHARED name…
    const a = await auth.api.createApiKey({
      body: { name: runName, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    const b = await auth.api.createApiKey({
      body: { name: runName, userId: user.id, metadata: { tokenType: "daemon" } },
    });

    const count = await revokeDaemonTokenById({
      userId: user.id,
      apiKeyId: a.id,
    });

    expect(count).toBe(1); // exactly A's token
    expect(await keysNamed(user.id, runName)).toHaveLength(1); // B survives
    // And B's specific token is the survivor.
    const survivors = await db
      .select({ id: apikeyTable.id })
      .from(apikeyTable)
      .where(and(eq(apikeyTable.referenceId, user.id), eq(apikeyTable.id, b.id)));
    expect(survivors).toHaveLength(1);
  });

  it("revokeDaemonTokenById is a no-op for an unknown id (returns 0)", async () => {
    expect(
      await revokeDaemonTokenById({ userId: user.id, apiKeyId: "no-such-id" }),
    ).toBe(0);
  });

  it("returns 0 when there is nothing to revoke", async () => {
    expect(
      await revokeDaemonTokensForSandbox({
        userId: user.id,
        sandboxId: "no-such-sandbox",
      }),
    ).toBe(0);
  });

  it("hasActiveDaemonToken: true while a token with that name exists, false after revoke", async () => {
    const name = `tc-${nanoid(8)}`;
    expect(await hasActiveDaemonToken({ userId: user.id, name })).toBe(false);
    await auth.api.createApiKey({
      body: { name, userId: user.id, metadata: { tokenType: "daemon" } },
    });
    expect(await hasActiveDaemonToken({ userId: user.id, name })).toBe(true);
    await revokeDaemonTokensForSandbox({ userId: user.id, sandboxId: name });
    expect(await hasActiveDaemonToken({ userId: user.id, name })).toBe(false);
  });
});
