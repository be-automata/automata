import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { createTestThread, createTestUser } from "./test-helpers";
import {
  advanceCellSessionHead,
  getCellSessionHead,
  type CellSessionHeadMove,
} from "./cell-session-checkpoint";

const db = createDb(env.DATABASE_URL!);

const move = (n: number, extra?: Partial<CellSessionHeadMove>) => ({
  sessionId: "session-1",
  headManifestId: `manifest-${n}`,
  headTurn: n,
  nativeBytes: n * 100,
  callIndexSha256: null,
  lastRunExternalId: `run-${n}`,
  ...extra,
});

async function newThread() {
  const { user } = await createTestUser({ db });
  return createTestThread({ db, userId: user.id });
}

describe("#743 cell session head (CAS)", () => {
  it("has no head before the first insert", async () => {
    const { threadId, threadChatId } = await newThread();
    expect(await getCellSessionHead({ db, threadId, threadChatId })).toBeNull();
  });

  it("the first insert at version 0 writes the row at version 1", async () => {
    const { threadId, threadChatId } = await newThread();
    const res = await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 0,
      move: move(1),
    });
    expect(res).toEqual({ moved: true, version: 1 });
    const head = await getCellSessionHead({ db, threadId, threadChatId });
    expect(head).toMatchObject({
      headManifestId: "manifest-1",
      headTurn: 1,
      version: 1,
      lastRunExternalId: "run-1",
      callIndexSha256: null,
    });
  });

  it("a second insert at version 0 is refused and changes nothing", async () => {
    const { threadId, threadChatId } = await newThread();
    await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 0,
      move: move(1),
    });
    const res = await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 0,
      move: move(2),
    });
    expect(res).toEqual({ moved: false });
    const head = await getCellSessionHead({ db, threadId, threadChatId });
    expect(head).toMatchObject({ headManifestId: "manifest-1", version: 1 });
  });

  it("a CAS with the right version moves the head and the call index together", async () => {
    const { threadId, threadChatId } = await newThread();
    await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 0,
      move: move(1),
    });
    const res = await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 1,
      move: move(2, { callIndexSha256: "c".repeat(64) }),
    });
    expect(res).toEqual({ moved: true, version: 2 });
    const head = await getCellSessionHead({ db, threadId, threadChatId });
    expect(head).toMatchObject({
      headManifestId: "manifest-2",
      headTurn: 2,
      nativeBytes: 200,
      callIndexSha256: "c".repeat(64),
      lastRunExternalId: "run-2",
      version: 2,
    });
  });

  it("a stale version is refused and changes nothing", async () => {
    const { threadId, threadChatId } = await newThread();
    await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 0,
      move: move(1),
    });
    await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 1,
      move: move(2),
    });
    const before = await getCellSessionHead({ db, threadId, threadChatId });
    const res = await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 1,
      move: move(3, { callIndexSha256: "d".repeat(64) }),
    });
    expect(res).toEqual({ moved: false });
    expect(await getCellSessionHead({ db, threadId, threadChatId })).toEqual(
      before,
    );
  });

  it("an update with no row is refused", async () => {
    const { threadId, threadChatId } = await newThread();
    const res = await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 1,
      move: move(2),
    });
    expect(res).toEqual({ moved: false });
    expect(await getCellSessionHead({ db, threadId, threadChatId })).toBeNull();
  });

  it("two racing CAS calls on one version: exactly one wins", async () => {
    const { threadId, threadChatId } = await newThread();
    await advanceCellSessionHead({
      db,
      threadId,
      threadChatId,
      expectedVersion: 0,
      move: move(1),
    });
    const results = await Promise.all([
      advanceCellSessionHead({
        db,
        threadId,
        threadChatId,
        expectedVersion: 1,
        move: move(2, { headManifestId: "manifest-a" }),
      }),
      advanceCellSessionHead({
        db,
        threadId,
        threadChatId,
        expectedVersion: 1,
        move: move(2, { headManifestId: "manifest-b" }),
      }),
    ]);
    expect(results.filter((r) => r.moved)).toHaveLength(1);
    const head = await getCellSessionHead({ db, threadId, threadChatId });
    expect(head?.version).toBe(2);
    const winner = results.findIndex((r) => r.moved);
    expect(head?.headManifestId).toBe(
      winner === 0 ? "manifest-a" : "manifest-b",
    );
  });

  it("two racing first inserts: exactly one wins", async () => {
    const { threadId, threadChatId } = await newThread();
    const results = await Promise.all(
      [1, 2].map((n) =>
        advanceCellSessionHead({
          db,
          threadId,
          threadChatId,
          expectedVersion: 0,
          move: move(n),
        }),
      ),
    );
    expect(results.filter((r) => r.moved)).toHaveLength(1);
    expect(
      (await getCellSessionHead({ db, threadId, threadChatId }))?.version,
    ).toBe(1);
  });
});
