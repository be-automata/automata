import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { createTestThread, createTestUser } from "./test-helpers";
import {
  CELL_SESSION_CONTINUATION_BUDGET,
  claimContinuation,
  countContinuations,
  getContinuationBySourceRun,
  markContinuationDispatched,
  releaseContinuation,
} from "./cell-session-continuation";

const db = createDb(env.DATABASE_URL!);

async function newThread() {
  const { user } = await createTestUser({ db });
  return createTestThread({ db, userId: user.id });
}

const r = (n: string) => `${n}-${nanoid(6)}`;
const claim = (
  t: { threadId: string; threadChatId: string },
  run = `run-${nanoid(6)}`,
  budget?: number,
) =>
  claimContinuation({
    db,
    ...t,
    sourceRunExternalId: run,
    checkpointManifestId: "m-1",
    checkpointTurn: 3,
    budget,
  });

describe("#743 cell session continuation ledger", () => {
  it("the budget is one per thread", () => {
    expect(CELL_SESSION_CONTINUATION_BUDGET).toBe(1);
  });

  it("claims ordinal 1 in state claimed, then marks it dispatched", async () => {
    const t = await newThread();
    const runA = r("a");
    const res = await claim(t, runA);
    expect(res).toMatchObject({ claimed: true, ordinal: 1 });
    const row = await getContinuationBySourceRun({
      db,
      sourceRunExternalId: runA,
    });
    expect(row).toMatchObject({
      state: "claimed",
      checkpointTurn: 3,
      checkpointManifestId: "m-1",
    });
    if (!res.claimed) throw new Error("unreachable");
    expect(await markContinuationDispatched({ db, id: res.id })).toBe(true);
    expect(
      (await getContinuationBySourceRun({ db, sourceRunExternalId: runA }))
        ?.state,
    ).toBe("dispatched");
  });

  it("the same source run twice is already-claimed", async () => {
    const t = await newThread();
    const runA = r("a");
    await claim(t, runA);
    expect(await claim(t, runA)).toEqual({
      claimed: false,
      reason: "already-claimed",
    });
    expect(await countContinuations({ db, threadId: t.threadId })).toBe(1);
  });

  it("a second run on the same thread is budget-spent", async () => {
    const t = await newThread();
    const runA = r("a");
    const runB = r("b");
    await claim(t, runA);
    expect(await claim(t, runB)).toEqual({
      claimed: false,
      reason: "budget-spent",
    });
  });

  it("a larger budget allows a second ordinal", async () => {
    const t = await newThread();
    const runA = r("a");
    const runB = r("b");
    await claim(t, runA, 2);
    expect(await claim(t, runB, 2)).toMatchObject({
      claimed: true,
      ordinal: 2,
    });
  });

  it("racing claims on one source run leave exactly one winner", async () => {
    const t = await newThread();
    const runA = r("a");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claim(t, runA)),
    );
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(await countContinuations({ db, threadId: t.threadId })).toBe(1);
  });

  it("racing claims from different runs of one thread leave one winner", async () => {
    const t = await newThread();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => claim(t, `run-${i}`)),
    );
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(
      results.filter((r) => !r.claimed && r.reason === "budget-spent"),
    ).toHaveLength(5);
    expect(await countContinuations({ db, threadId: t.threadId })).toBe(1);
  });

  it("release removes a claimed row so a retry can claim; a dispatched row stays", async () => {
    const t = await newThread();
    const runA = r("a");
    const first = await claim(t, runA);
    if (!first.claimed) throw new Error("unreachable");
    expect(await releaseContinuation({ db, id: first.id })).toBe(true);
    const again = await claim(t, runA);
    expect(again).toMatchObject({ claimed: true, ordinal: 1 });
    if (!again.claimed) throw new Error("unreachable");
    await markContinuationDispatched({ db, id: again.id });
    expect(await releaseContinuation({ db, id: again.id })).toBe(false);
    expect(await claim(t, runA)).toEqual({
      claimed: false,
      reason: "already-claimed",
    });
  });

  it("marking an unknown id changes nothing", async () => {
    expect(await markContinuationDispatched({ db, id: nanoid() })).toBe(false);
  });
});
