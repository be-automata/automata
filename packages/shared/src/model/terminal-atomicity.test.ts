import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * #153 prerequisite — STRUCTURAL regression guard.
 *
 * A chat-mode thread terminates across TWO tables: `threadChat` carries
 * `status`, the thread row carries the typed `terminalCause` that the #125 C1
 * generation fence keys on. Those used to be three independent statements, so
 * a late daemon event arriving between them observed `complete` with a NULL
 * cause and was ADMITTED when it should have been refused.
 *
 * The end state was always eventually correct, so a sequential real-DB test
 * cannot tell the two implementations apart — it is the WINDOW that changed.
 * This file pins the boundary itself: every write must be issued on the
 * transaction handle, and none directly on `db`. Revert the transaction and
 * these fail; the real-DB tests in hatchet-run.test.ts do not.
 */

const h = vi.hoisted(() => ({ broadcasts: 0 }));

vi.mock("../broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn(async () => {
    h.broadcasts += 1;
  }),
}));

import { markThreadsTerminal } from "./threads";

/** Records which handle each UPDATE was issued on. */
function makeRecordingDb() {
  const issuedOn: string[] = [];
  let transactionCalls = 0;
  let broadcastsInsideTx = 0;
  let insideTx = false;

  const chain = (handle: string, rows: Array<{ id: string; userId: string }>) => ({
    set: () => ({
      where: () => ({
        returning: async () => {
          issuedOn.push(handle);
          return rows;
        },
        // the follow-up stamp has no .returning()
        then: (resolve: (v: unknown) => unknown) => {
          issuedOn.push(handle);
          return Promise.resolve(resolve(undefined));
        },
      }),
    }),
  });

  const db = {
    // thread UPDATE matches nothing (chat-mode: thread row frozen, not reapable);
    // threadChat UPDATE matches -> forces the chat-only follow-up stamp path.
    update: (table: { _: { name?: string } } | unknown) => {
      const name = tableName(table);
      const rows =
        name === "thread_chat" ? [{ id: "thread_1", userId: "user_1" }] : [];
      return chain(insideTx ? "tx" : "db", rows);
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      transactionCalls += 1;
      insideTx = true;
      try {
        return await cb(db);
      } finally {
        insideTx = false;
        broadcastsInsideTx = h.broadcasts;
      }
    },
  };
  return {
    db,
    issuedOn,
    stats: () => ({ transactionCalls, broadcastsInsideTx }),
  };
}

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes("Name"),
  );
  return sym ? String((t as Record<symbol, unknown>)[sym]) : "";
}

describe("markThreadsTerminal — the terminal write is ONE transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.broadcasts = 0;
  });

  it("opens exactly one transaction", async () => {
    const { db, stats } = makeRecordingDb();
    await markThreadsTerminal({
      db: db as never,
      threadIds: ["thread_1"],
      cause: "superseded",
    });
    expect(stats().transactionCalls).toBe(1);
  });

  it("issues EVERY update on the transaction handle, never on db", async () => {
    const { db, issuedOn } = makeRecordingDb();
    await markThreadsTerminal({
      db: db as never,
      threadIds: ["thread_1"],
      cause: "superseded",
    });
    expect(issuedOn.length).toBeGreaterThanOrEqual(2);
    expect(issuedOn).not.toContain("db");
    expect(new Set(issuedOn)).toEqual(new Set(["tx"]));
  });

  it("broadcasts OUTSIDE the transaction — network I/O must not hold it open", async () => {
    const { db, stats } = makeRecordingDb();
    await markThreadsTerminal({
      db: db as never,
      threadIds: ["thread_1"],
      cause: "superseded",
    });
    // Zero broadcasts had fired by the time the transaction closed.
    expect(stats().broadcastsInsideTx).toBe(0);
    expect(h.broadcasts).toBeGreaterThan(0);
  });
});
