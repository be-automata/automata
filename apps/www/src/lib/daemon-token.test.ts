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
  revokeDaemonTokensForThread,
  revokeDaemonTokenById,
  hasActiveDaemonToken,
  retireDaemonTokenById,
  revokeRetiredDaemonTokenById,
  RETIRED_DAEMON_TOKEN_GRACE_MS,
} from "./daemon-token";

async function keysNamed(userId: string, name: string) {
  return db
    .select({ id: apikeyTable.id })
    .from(apikeyTable)
    .where(
      and(eq(apikeyTable.referenceId, userId), eq(apikeyTable.name, name)),
    );
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
      body: {
        name: sandboxId,
        userId: user.id,
        metadata: { tokenType: "daemon" },
      },
    });
    await auth.api.createApiKey({
      body: {
        name: sandboxId,
        userId: user.id,
        metadata: { tokenType: "daemon" },
      },
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
    expect(await hasActiveDaemonToken({ userId: user.id, name: runB })).toBe(
      true,
    );
    expect(await hasActiveDaemonToken({ userId: user.id, name: runA })).toBe(
      true,
    );
  });

  it("BURST SAFETY (S12): revokeDaemonTokenById revokes ONLY that run's token, never a sibling's", async () => {
    // Two live runs (A, B) — e.g. two of a burst of founder mentions. Each has its
    // own daemon token. When A's thread-finish revokes A's token by its EXACT
    // apikey id, B's token (a DIFFERENT run) must stay live, so B is not killed
    // mid-work. This is the fix for revoke-by-name/thread, which under a burst let
    // A's (possibly delayed) finish delete B's same-keyed token.
    const runName = `${nanoid(8)}:legacy-thread-chat-id`; // even a SHARED name…
    const a = await auth.api.createApiKey({
      body: {
        name: runName,
        userId: user.id,
        metadata: { tokenType: "daemon" },
      },
    });
    const b = await auth.api.createApiKey({
      body: {
        name: runName,
        userId: user.id,
        metadata: { tokenType: "daemon" },
      },
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
      .where(
        and(eq(apikeyTable.referenceId, user.id), eq(apikeyTable.id, b.id)),
      );
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

describe("revokeDaemonTokensForThread (#380 sweep rule iii)", () => {
  let user: User;

  beforeEach(async () => {
    user = (await createTestUser({ db })).user;
  });

  it("revokes every `<threadId>:<chat>` token of the thread and nothing else (other threads, sandbox-named, other users)", async () => {
    const threadId = `thr_${nanoid(8)}`;
    const other = (await createTestUser({ db })).user;
    const mint = async (userId: string, name: string) =>
      auth.api.createApiKey({
        body: { name, userId, metadata: { tokenType: "daemon" } },
      });
    await mint(user.id, `${threadId}:legacy-thread-chat-id`);
    await mint(user.id, `${threadId}:tc_2`);
    await mint(user.id, `${threadId}x:tc_1`); // a longer id sharing the prefix
    await mint(user.id, `sbx-${nanoid(6)}`); // an in-process sandbox token
    await mint(other.id, `${threadId}:tc_1`); // same name, another user
    expect(
      await revokeDaemonTokensForThread({ userId: user.id, threadId }),
    ).toBe(2);
    expect(
      await keysNamed(user.id, `${threadId}:legacy-thread-chat-id`),
    ).toHaveLength(0);
    expect(await keysNamed(user.id, `${threadId}:tc_2`)).toHaveLength(0);
    expect(await keysNamed(user.id, `${threadId}x:tc_1`)).toHaveLength(1);
    expect(await keysNamed(other.id, `${threadId}:tc_1`)).toHaveLength(1);
    expect(
      await revokeDaemonTokensForThread({ userId: user.id, threadId }),
    ).toBe(0);
  });
});

describe("retired daemon tokens (#656 PR-D)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
  });

  async function mint(name: string, expiresIn = 60 * 60 * 24) {
    const created = await auth.api.createApiKey({
      body: {
        name,
        userId: user.id,
        expiresIn,
        metadata: { tokenType: "daemon" },
      },
    });
    return created.id;
  }

  async function row(id: string) {
    const [r] = await db
      .select({ name: apikeyTable.name, expiresAt: apikeyTable.expiresAt })
      .from(apikeyTable)
      .where(eq(apikeyTable.id, id));
    return r;
  }

  it("retire renames once and caps expires_at at about now + 15 min, in UTC", async () => {
    const runKey = `${nanoid(8)}:${nanoid(8)}`;
    const id = await mint(runKey);
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      true,
    );

    const before = Date.now();
    expect(await retireDaemonTokenById({ userId: user.id, apiKeyId: id })).toBe(
      true,
    );
    const after = await row(id);
    expect(after?.name).toBe(`${runKey}:retired`);
    const expected = before + RETIRED_DAEMON_TOKEN_GRACE_MS;
    const at = after?.expiresAt?.getTime() ?? 0;
    // Wide enough for clock skew between app and db, far from the 1-day expiry.
    expect(Math.abs(at - expected)).toBeLessThan(2 * 60 * 1000);
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      false,
    );
  });

  it("a second retire returns false and never moves expires_at later", async () => {
    const id = await mint(`${nanoid(8)}:${nanoid(8)}`);
    await retireDaemonTokenById({ userId: user.id, apiKeyId: id });
    const first = await row(id);
    expect(await retireDaemonTokenById({ userId: user.id, apiKeyId: id })).toBe(
      false,
    );
    expect(await row(id)).toEqual(first);
  });

  it("a token with a NULL name is renamed too, so the retire is real (Automata review 5949309184)", async () => {
    const id = await mint(`${nanoid(8)}:${nanoid(8)}`);
    await db
      .update(apikeyTable)
      .set({ name: null })
      .where(eq(apikeyTable.id, id));
    expect(await retireDaemonTokenById({ userId: user.id, apiKeyId: id })).toBe(
      true,
    );
    expect((await row(id))?.name).toBe(":retired");
    // A second retire matches nothing: the row now carries the suffix.
    expect(await retireDaemonTokenById({ userId: user.id, apiKeyId: id })).toBe(
      false,
    );
  });

  it("an expires_at already earlier than the cap stays earlier", async () => {
    const id = await mint(`${nanoid(8)}:${nanoid(8)}`);
    const early = new Date(Date.now() + 60 * 1000);
    await db
      .update(apikeyTable)
      .set({ expiresAt: early })
      .where(eq(apikeyTable.id, id));
    await retireDaemonTokenById({ userId: user.id, apiKeyId: id });
    expect((await row(id))?.expiresAt?.getTime()).toBe(early.getTime());
  });

  it("a report after the retire never moves expires_at later", async () => {
    const id = await mint(`${nanoid(8)}:${nanoid(8)}`);
    await retireDaemonTokenById({ userId: user.id, apiKeyId: id });
    const retiredRow = await row(id);
    // The report path only deletes; a re-retire is a no-op on a kept row.
    await retireDaemonTokenById({ userId: user.id, apiKeyId: id });
    expect((await row(id))?.expiresAt).toEqual(retiredRow?.expiresAt);
  });

  it("another user's id changes nothing", async () => {
    const id = await mint(`${nanoid(8)}:${nanoid(8)}`);
    const other = (await createTestUser({ db })).user;
    const original = await row(id);
    expect(
      await retireDaemonTokenById({ userId: other.id, apiKeyId: id }),
    ).toBe(false);
    expect(await row(id)).toEqual(original);
  });

  it("revokeRetiredDaemonTokenById deletes a retired token only", async () => {
    const retiredId = await mint(`${nanoid(8)}:${nanoid(8)}`);
    await retireDaemonTokenById({ userId: user.id, apiKeyId: retiredId });
    expect(
      await revokeRetiredDaemonTokenById({
        userId: user.id,
        apiKeyId: retiredId,
      }),
    ).toBe(1);
    expect(await row(retiredId)).toBeUndefined();
  });

  it("revokeRetiredDaemonTokenById leaves a live token (control) and another user's", async () => {
    const liveId = await mint(`${nanoid(8)}:${nanoid(8)}`);
    expect(
      await revokeRetiredDaemonTokenById({ userId: user.id, apiKeyId: liveId }),
    ).toBe(0);
    expect(await row(liveId)).toBeDefined();

    const retiredId = await mint(`${nanoid(8)}:${nanoid(8)}`);
    await retireDaemonTokenById({ userId: user.id, apiKeyId: retiredId });
    const other = (await createTestUser({ db })).user;
    expect(
      await revokeRetiredDaemonTokenById({
        userId: other.id,
        apiKeyId: retiredId,
      }),
    ).toBe(0);
    expect(await row(retiredId)).toBeDefined();
  });

  it("an old run's report after a follow-up deletes only the retired row", async () => {
    const runKey = `${nanoid(8)}:${nanoid(8)}`;
    const oldId = await mint(runKey);
    await retireDaemonTokenById({ userId: user.id, apiKeyId: oldId });
    // The follow-up run mints under the same bare run key.
    const followUpId = await mint(runKey);
    expect(
      await revokeRetiredDaemonTokenById({ userId: user.id, apiKeyId: oldId }),
    ).toBe(1);
    expect(await row(oldId)).toBeUndefined();
    expect(await row(followUpId)).toBeDefined();
    expect(await hasActiveDaemonToken({ userId: user.id, name: runKey })).toBe(
      true,
    );
  });

  it("the thread sweep prefix also deletes a retired token", async () => {
    const threadId = nanoid(8);
    const id = await mint(`${threadId}:${nanoid(8)}`);
    await retireDaemonTokenById({ userId: user.id, apiKeyId: id });
    expect(
      await revokeDaemonTokensForThread({ userId: user.id, threadId }),
    ).toBe(1);
    expect(await row(id)).toBeUndefined();
  });
});
