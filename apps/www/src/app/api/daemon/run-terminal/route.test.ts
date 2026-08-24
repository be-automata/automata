import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { setThreadActiveRun } from "@terragon/shared/model/threads";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));

function req(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/run-terminal", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon/run-terminal (#125 C1 generation fence)", () => {
  let user: User;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;

  function ctx(over: Partial<DaemonTokenContext> = {}): DaemonTokenContext {
    return {
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: orgId,
      threadChatId,
      threadId,
      tokenType: "daemon",
      ...over,
    };
  }

  async function threadRow() {
    const [row] = await db
      .select({
        status: threadTable.status,
        errorMessage: threadTable.errorMessage,
      })
      .from(threadTable)
      .where(eq(threadTable.id, threadId));
    return row!;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    // A live (reapable) run.
    await db
      .update(threadTable)
      .set({ status: "working" })
      .where(eq(threadTable.id, threadId));
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
  });

  const body = (runExternalId: string) => ({
    threadId,
    threadChatId,
    runExternalId,
    cause: "superseded",
    detail: { policy: "newest-wins" },
  });

  it("401 without a token context; 403 for a non-daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(null);
    expect((await POST(req(body("r1")))).status).toBe(401);
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ tokenType: null }),
    );
    expect((await POST(req(body("r1")))).status).toBe(403);
  });

  it("403 when the token is bound to another thread (F2)", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ threadId: "thr_other" }),
    );
    expect((await POST(req(body("r1")))).status).toBe(403);
  });

  it("400 on an unknown cause", async () => {
    const res = await POST(req({ ...body("r1"), cause: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("applies the superseded terminal when runExternalId matches the active run (AC3)", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-active" });
    const res = await POST(req(body("run-active")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    expect(await threadRow()).toEqual({
      status: "complete",
      errorMessage: "superseded",
    });
  });

  it("409 when a NEWER generation owns the thread (AC5 — cancel race closed)", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-new" });
    const res = await POST(req(body("run-old")));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "superseded",
      activeRunExternalId: "run-new",
    });
    // The live (newer) run's thread is untouched.
    expect((await threadRow()).status).toBe("working");
  });

  it("fails OPEN when no active run is stamped (legacy dispatch)", async () => {
    const res = await POST(req(body("anything")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
  });

  it("is idempotent: a retry after success is applied:false, never a second transition", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-active" });
    expect(await (await POST(req(body("run-active")))).json()).toEqual({
      applied: true,
    });
    expect(await (await POST(req(body("run-active")))).json()).toEqual({
      applied: false,
    });
    expect((await threadRow()).errorMessage).toBe("superseded");
  });

  it("404 for an unknown thread", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ threadId: null, threadChatId: null }),
    );
    const res = await POST(
      req({ ...body("r1"), threadId: "00000000-0000-0000-0000-000000000000" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/daemon/run-terminal — typed causes (#125 C4)", () => {
  it("accepts every cause in the taxonomy and persists terminalCause", async () => {
    // Reuse the outer describe's fixtures via a fresh thread per cause.
    const user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    for (const cause of ["stale-skipped", "discarded", "timeout"] as const) {
      const t = await createTestThread({
        db,
        userId: user.id,
        overrides: { organizationId: org.id },
      });
      await db
        .update(threadTable)
        .set({ status: "working" })
        .where(eq(threadTable.id, t.threadId));
      vi.mocked(getDaemonTokenContext).mockResolvedValueOnce({
        userId: user.id,
        apiKeyId: "apikey_test",
        organizationId: org.id,
        threadChatId: t.threadChatId,
        threadId: t.threadId,
        tokenType: "daemon",
      });
      const res = await POST(
        req({
          threadId: t.threadId,
          threadChatId: t.threadChatId,
          runExternalId: `run-${cause}`,
          cause,
        }),
      );
      expect(res.status).toBe(200);
      const [row] = await db
        .select({ terminalCause: threadTable.terminalCause })
        .from(threadTable)
        .where(eq(threadTable.id, t.threadId));
      expect(row!.terminalCause).toBe(cause);
    }
  });
});
