import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as daemonEvent } from "./route";
import { POST as runTerminal } from "../daemon/run-terminal/route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { DaemonTokenContext } from "@/lib/daemon-token-context";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { setThreadActiveRun } from "@terragon/shared/model/threads";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

// Only the token custody and the downstream event handler are mocked; the
// generation state itself is REAL rows — this is the cross-route race the
// fence exists for (#125 C1): run-terminal marks the thread superseded, and
// daemon-event must then read that back and refuse the stale verdict.
vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));
vi.mock("@/server-lib/handle-daemon-event", () => ({
  handleDaemonEvent: vi.fn().mockResolvedValue({ success: true }),
}));

describe("generation fence across run-terminal → daemon-event (real DB)", () => {
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    vi.mocked(handleDaemonEvent).mockClear();
    const user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: org.id },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    await db
      .update(threadTable)
      .set({ status: "working" })
      .where(eq(threadTable.id, threadId));
    const ctx: DaemonTokenContext = {
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: org.id,
      threadChatId,
      threadId,
      tokenType: "daemon",
    };
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx);
  });

  const event = (runExternalId?: string) =>
    daemonEvent(
      new Request("http://localhost/api/daemon-event", {
        method: "POST",
        body: JSON.stringify({
          messages: [],
          threadId,
          threadChatId,
          ...(runExternalId ? { runExternalId } : {}),
        }),
        headers: {
          "X-Daemon-Token": "tok",
          "content-type": "application/json",
        },
      }),
    );

  const terminal = (runExternalId: string) =>
    runTerminal(
      new NextRequest("http://localhost/api/daemon/run-terminal", {
        method: "POST",
        body: JSON.stringify({
          threadId,
          threadChatId,
          runExternalId,
          cause: "superseded",
          detail: { policy: "newest-wins" },
        }),
        headers: {
          "X-Daemon-Token": "tok",
          "content-type": "application/json",
        },
      }),
    );

  async function row() {
    const [r] = await db
      .select({
        status: threadTable.status,
        errorMessage: threadTable.errorMessage,
      })
      .from(threadTable)
      .where(eq(threadTable.id, threadId));
    return r!;
  }

  it("a live run streams; after its explicit superseded terminal, its late verdict is refused (409) and the terminal is idempotent", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-1" });

    // Live generation → the event lands.
    expect((await event("run-1")).status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);

    // The engine cancelled run-1 under newest-wins; the worker posts the
    // explicit terminal for its OWN generation → applied.
    const t1 = await terminal("run-1");
    expect(t1.status).toBe(200);
    expect(await t1.json()).toEqual({ applied: true });
    expect(await row()).toEqual({
      status: "complete",
      errorMessage: "superseded",
    });

    // The cancel race: run-1 still streams its verdict → REAL row says
    // superseded → refused, handler never invoked.
    expect((await event("run-1")).status).toBe(409);
    expect((await event()).status).toBe(409); // even without a run id
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);

    // Retry of the terminal after success is a no-op, never a second write.
    const t2 = await terminal("run-1");
    expect(t2.status).toBe(200);
    expect(await t2.json()).toEqual({ applied: false });
  });

  it("a newer dispatch re-stamps the thread: the old generation can neither terminate nor write, the new one can", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-1" });
    // C2 dispatch of the newer commit stamps run-2 before run-1 has died.
    await setThreadActiveRun({ db, threadId, externalId: "run-2" });

    // Old generation cannot rewrite the newer run's thread.
    const t = await terminal("run-1");
    expect(t.status).toBe(409);
    expect(await t.json()).toMatchObject({
      error: "superseded",
      activeRunExternalId: "run-2",
    });
    expect((await row()).status).toBe("working");
    expect((await event("run-1")).status).toBe(409);
    expect(handleDaemonEvent).not.toHaveBeenCalled();

    // The live generation is unaffected.
    expect((await event("run-2")).status).toBe(200);
    expect(handleDaemonEvent).toHaveBeenCalledTimes(1);
  });
});
