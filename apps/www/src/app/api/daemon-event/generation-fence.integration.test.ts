import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as daemonEvent } from "./route";
import { POST as runTerminal } from "../daemon/run-terminal/route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { DaemonTokenContext } from "@/lib/daemon-token-context";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  markThreadTerminal,
  setThreadActiveRun,
  THREAD_RESUME_UPDATES,
  THREAD_CHAT_RESUME_UPDATES,
} from "@terragon/shared/model/threads";
import {
  thread as threadTable,
  threadChat as threadChatTable,
} from "@terragon/shared/db/schema";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { getClaudeResultMessage } from "@/test-helpers/agent";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

// Only token custody and sandbox side-effects are mocked. The generation
// state is REAL rows and the event goes through the REAL handleDaemonEvent —
// this is the cross-route race the fence exists for (#125 C1): run-terminal
// marks the thread superseded, and daemon-event must read that back and
// refuse the stale verdict. Runs for both the legacy chat alias and a real
// threadChat row (the stamp lives on the thread table either way).
vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));
vi.mock("@/server-lib/checkpoint-thread", () => ({
  checkpointThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@terragon/sandbox", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, extendSandboxLife: vi.fn().mockResolvedValue(undefined) };
});

describe.each([
  { label: "legacy chat alias", enableThreadChatCreation: false },
  { label: "real threadChat row", enableThreadChatCreation: true },
])(
  "generation fence across run-terminal → daemon-event (real DB, $label)",
  ({ enableThreadChatCreation }) => {
    let threadId: string;
    let threadChatId: string;

    beforeEach(async () => {
      await mockWaitUntil();
      const user = (await createTestUser({ db })).user;
      const org = await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      });
      const t = await createTestThread({
        db,
        userId: user.id,
        overrides: {
          organizationId: org.id,
          sandboxProvider: "hatchet-remote",
        },
        chatOverrides: { status: "working" },
        enableThreadChatCreation,
      });
      threadId = t.threadId;
      threadChatId = t.threadChatId;
      expect(threadChatId === LEGACY_THREAD_CHAT_ID).toBe(
        !enableThreadChatCreation,
      );
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
            messages: [getClaudeResultMessage()],
            threadId,
            threadChatId,
          }),
          headers: {
            "X-Daemon-Token": "tok",
            "content-type": "application/json",
            // The worker carries its generation on the header (#126).
            ...(runExternalId ? { "x-run-external-id": runExternalId } : {}),
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

    // The EFFECTIVE status row: the thread row for legacy threads, the chat
    // row otherwise (what getThreadChat aliases and what the fence reads).
    const effective = () =>
      enableThreadChatCreation
        ? db
            .select({
              status: threadChatTable.status,
              errorMessage: threadChatTable.errorMessage,
            })
            .from(threadChatTable)
            .where(eq(threadChatTable.id, threadChatId))
        : db
            .select({
              status: threadTable.status,
              errorMessage: threadTable.errorMessage,
            })
            .from(threadTable)
            .where(eq(threadTable.id, threadId));
    async function row() {
      const [r] = await effective();
      return r!;
    }
    async function setLive() {
      await db
        .update(threadTable)
        .set({ status: "working", errorMessage: null })
        .where(eq(threadTable.id, threadId));
      if (enableThreadChatCreation) {
        await db
          .update(threadChatTable)
          .set({ status: "working", errorMessage: null })
          .where(eq(threadChatTable.id, threadChatId));
      }
    }

    it("a live run lands; after its explicit superseded terminal, its late verdict is refused (409) and the terminal is idempotent", async () => {
      await setThreadActiveRun({ db, threadId, externalId: "run-1" });

      // Live generation → the event lands (real handler).
      expect((await event("run-1")).status).toBe(200);
      await waitUntilResolved();
      // The daemon's result completes the thread; put it back to a live
      // status so the terminal below is the thing that ends it.
      await setLive();

      // The engine cancelled run-1 under newest-wins; the worker posts the
      // explicit terminal for its OWN generation → applied.
      const t1 = await terminal("run-1");
      expect(t1.status).toBe(200);
      expect(await t1.json()).toEqual({ applied: true });
      expect(await row()).toEqual({
        status: "complete",
        errorMessage: "superseded",
      });

      // The cancel race: run-1 still streams its verdict → the REAL thread
      // row says superseded → refused, with or without a run id.
      expect((await event("run-1")).status).toBe(409);
      expect((await event()).status).toBe(409);
      expect(await row()).toEqual({
        status: "complete",
        errorMessage: "superseded",
      });

      // Retry of the terminal after success is a no-op, never a second write.
      const t2 = await terminal("run-1");
      expect(t2.status).toBe(200);
      expect(await t2.json()).toEqual({ applied: false });
    });

    it.each([
      "timeout",
      "daemon-failed",
      "plane-offline",
      "user-cancelled",
    ] as const)(
      "ANY typed terminal (%s), not only 'superseded', refuses a late daemon-event",
      async (cause) => {
        await setThreadActiveRun({ db, threadId, externalId: "run-1" });
        expect(await markThreadTerminal({ db, threadId, cause })).toBe(true);
        // These causes leave errorMessage NULL — the fence must key on the
        // typed cause, not the superseded sentinel.
        expect((await event("run-1")).status).toBe(409);
        expect((await event()).status).toBe(409);
      },
    );

    it("a RESUME clears the typed terminal: after user-cancelled the fence closes, after THREAD_RESUME_UPDATES it opens again", async () => {
      await setThreadActiveRun({ db, threadId, externalId: "run-1" });
      expect(
        await markThreadTerminal({ db, threadId, cause: "user-cancelled" }),
      ).toBe(true);
      expect((await event("run-1")).status).toBe(409);
      // What startAgentMessage applies on every boot/resume transition: the
      // resume PAIR — thread row + chat mirror (#153 read-tear fix; the fence
      // decides from the chat row, so clearing only the thread row would
      // leave the thread fenced forever).
      await setLive();
      await db
        .update(threadTable)
        .set(THREAD_RESUME_UPDATES)
        .where(eq(threadTable.id, threadId));
      await db
        .update(threadChatTable)
        .set(THREAD_CHAT_RESUME_UPDATES)
        .where(eq(threadChatTable.threadId, threadId));
      expect((await event("run-1")).status).toBe(200);
      await waitUntilResolved();
    });

    it("a newer dispatch re-stamps the thread: the old generation can neither terminate nor write, the new one can", async () => {
      await setThreadActiveRun({ db, threadId, externalId: "run-1" });
      // C2 dispatch of the newer commit stamps run-2 before run-1 has died.
      await setThreadActiveRun({ db, threadId, externalId: "run-2" });

      const t = await terminal("run-1");
      expect(t.status).toBe(409);
      expect(await t.json()).toMatchObject({
        error: "superseded",
        activeRunExternalId: "run-2",
      });
      expect((await row()).status).toBe("working");
      expect((await event("run-1")).status).toBe(409);
      expect((await row()).status).toBe("working");

      // The live generation is unaffected.
      expect((await event("run-2")).status).toBe(200);
      await waitUntilResolved();
    });
  },
);
