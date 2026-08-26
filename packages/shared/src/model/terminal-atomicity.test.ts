import { describe, expect, it, vi, beforeEach } from "vitest";
import { nanoid } from "nanoid";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { markThreadsTerminal } from "./threads";
import { createOrganization } from "./organizations";
import { createTestRemoteRun, createTestUser } from "./test-helpers";

/**
 * #153 prerequisite — STRUCTURAL regression guard.
 *
 * A chat-mode thread terminates across TWO tables, so its three writes used to
 * be three independent statements and a reader could observe `complete` with a
 * NULL cause between them. See markThreadsTerminal for the full mechanism.
 *
 * The end state was always eventually correct, so the real-DB assertions in
 * hatchet-run.test.ts cannot tell the two implementations apart — it is the
 * WINDOW that changed. This file pins the boundary itself against the REAL db:
 * every write must go through the transaction handle, and none directly on
 * `db`. Revert the transaction and these fail.
 */

const db = createDb(env.DATABASE_URL!);

async function makeOrg(slug: string) {
  const org = await createOrganization({
    db,
    name: slug,
    slug: `${slug}-${nanoid(6)}`,
  });
  return org.id;
}

describe("markThreadsTerminal — the terminal write is ONE transaction", () => {
  let userId: string;
  let orgA: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    userId = (await createTestUser({ db })).user.id;
    orgA = await makeOrg("acme-atomic");
  });

  it("opens exactly one transaction and issues NO update outside it", async () => {
    const { threadId } = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgA,
      prNumber: 91,
      externalId: nanoid(),
      enableThreadChatCreation: true,
    });

    const txSpy = vi.spyOn(db, "transaction");
    // The drizzle transaction handle is a DISTINCT object from `db`, so any
    // write that reached `db.update` directly escaped the transaction.
    const updateSpy = vi.spyOn(db, "update");

    await markThreadsTerminal({
      db,
      threadIds: [threadId],
      cause: "superseded",
    });

    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("commits before broadcasting — network I/O never holds the transaction open", async () => {
    const { threadId } = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgA,
      prNumber: 92,
      externalId: nanoid(),
      enableThreadChatCreation: true,
    });

    // Order of events, not timing: the transaction must have COMMITTED before
    // the first broadcast is published. Guards against someone moving the
    // publish loop inside the transaction, which would hold a DB connection
    // open across network I/O.
    const seq: string[] = [];
    const realTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((async (cb: never) => {
      const result = await realTransaction(cb);
      seq.push("tx-commit");
      return result;
    }) as typeof db.transaction);

    const broadcast = await import("../broadcast-server");
    vi.spyOn(broadcast, "publishBroadcastUserMessage").mockImplementation(
      (async () => {
        seq.push("broadcast");
      }) as typeof broadcast.publishBroadcastUserMessage,
    );

    await markThreadsTerminal({
      db,
      threadIds: [threadId],
      cause: "superseded",
    });

    expect(seq[0]).toBe("tx-commit");
    expect(seq).toContain("broadcast");
  });
});
