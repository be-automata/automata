import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import * as schema from "../db/schema";
import { createTestThread, createTestUser } from "./test-helpers";
import { getThreadChat, setThreadChatDeliveredCredential } from "./threads";
import { LEGACY_THREAD_CHAT_ID } from "../utils/thread-utils";

const db = createDb(env.DATABASE_URL!);

/**
 * #442 (epic #440 C2): the delivered-credential record, on both chat shapes.
 * A legacy thread (production's shape while enableThreadChatCreation is off)
 * keeps it on the thread row; a chat-mode thread on its thread_chat row.
 */
describe("setThreadChatDeliveredCredential (#442)", () => {
  let userId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
  });

  async function read(threadId: string, threadChatId: string) {
    const chat = await getThreadChat({ db, userId, threadId, threadChatId });
    return chat!.deliveredCredentialId;
  }

  // Card: protects=a legacy thread records and reads the delivered id on the
  // thread row, and an overwrite to NULL sticks; fails_when=the legacy chat
  // reads NULL after a write or the write misses the thread row;
  // no_claim=who calls it (route suite).
  it("records and overwrites on a legacy thread's row", async () => {
    const { threadId, threadChatId } = await createTestThread({ db, userId });
    expect(threadChatId).toBe(LEGACY_THREAD_CHAT_ID);
    expect(await read(threadId, threadChatId)).toBeNull();

    expect(
      await setThreadChatDeliveredCredential({
        db,
        userId,
        threadId,
        threadChatId,
        credentialId: "cred-a",
      }),
    ).toBe(true);
    expect(await read(threadId, threadChatId)).toBe("cred-a");

    await setThreadChatDeliveredCredential({
      db,
      userId,
      threadId,
      threadChatId,
      credentialId: null,
    });
    expect(await read(threadId, threadChatId)).toBeNull();
  });

  // Card: protects=a chat-mode thread records on its thread_chat row and
  // leaves updated_at alone; fails_when=the id lands elsewhere or updated_at
  // moves; no_claim=legacy shape (previous test).
  it("records on a chat-mode thread's chat row without touching updated_at", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId,
      enableThreadChatCreation: true,
    });
    expect(threadChatId).not.toBe(LEGACY_THREAD_CHAT_ID);
    const before = await db.query.threadChat.findFirst({
      where: eq(schema.threadChat.id, threadChatId),
    });

    await setThreadChatDeliveredCredential({
      db,
      userId,
      threadId,
      threadChatId,
      credentialId: "cred-b",
    });
    const after = await db.query.threadChat.findFirst({
      where: eq(schema.threadChat.id, threadChatId),
    });
    expect(after!.deliveredCredentialId).toBe("cred-b");
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(await read(threadId, threadChatId)).toBe("cred-b");
  });

  it("is fenced by user", async () => {
    const { threadId, threadChatId } = await createTestThread({ db, userId });
    const other = (await createTestUser({ db })).user.id;
    expect(
      await setThreadChatDeliveredCredential({
        db,
        userId: other,
        threadId,
        threadChatId,
        credentialId: "cred-x",
      }),
    ).toBe(false);
    expect(await read(threadId, threadChatId)).toBeNull();
  });
});
