import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { thread as threadTable } from "@terragon/shared/db/schema";
import { createOrganization } from "@terragon/shared/model/organizations";
import { setThreadActiveRun } from "@terragon/shared/model/threads";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));

function req(body: unknown, runExternalId?: string) {
  return new NextRequest(
    "http://localhost/api/daemon/run-credential-source",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "X-Daemon-Token": "tok",
        "content-type": "application/json",
        ...(runExternalId ? { "x-run-external-id": runExternalId } : {}),
      },
    },
  );
}

describe("POST /api/daemon/run-credential-source (#209 item 1)", () => {
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
        errorMessageInfo: threadTable.errorMessageInfo,
        terminalCause: threadTable.terminalCause,
        messages: threadTable.messages,
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
    // Legacy (sentinel threadChat) thread: messages live on thread.messages.
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    // The run is still booting when the worker reports its attribution.
    await db
      .update(threadTable)
      .set({ status: "booting" })
      .where(eq(threadTable.id, threadId));
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
  });

  const body = (source = "built-in-credits") => ({
    threadId,
    threadChatId,
    source,
  });

  it("401 without a token context; 403 for a non-daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(null);
    expect((await POST(req(body()))).status).toBe(401);
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ tokenType: null }),
    );
    expect((await POST(req(body()))).status).toBe(403);
    expect((await threadRow()).messages ?? []).toEqual([]);
  });

  it("403 when the token is bound to another thread (F2)", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ threadId: "thr_other" }),
    );
    expect((await POST(req(body()))).status).toBe(403);
    expect((await threadRow()).messages ?? []).toEqual([]);
  });

  it("400 on a source outside the enum, and nothing is appended", async () => {
    const res = await POST(req(body("anything-else")));
    expect(res.status).toBe(400);
    expect((await threadRow()).messages ?? []).toEqual([]);
  });

  it("appends exactly one message and moves no status machinery", async () => {
    const before = await threadRow();
    const res = await POST(req(body("built-in-credits"), "run-active"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    const after = await threadRow();
    expect(after.messages).toHaveLength(1);
    expect(after.messages![0]).toMatchObject({
      type: "credential-source",
      source: "built-in-credits",
    });
    expect({
      status: after.status,
      errorMessage: after.errorMessage,
      errorMessageInfo: after.errorMessageInfo,
      terminalCause: after.terminalCause,
    }).toEqual({
      status: before.status,
      errorMessage: before.errorMessage,
      errorMessageInfo: before.errorMessageInfo,
      terminalCause: before.terminalCause,
    });
  });

  it("persists the enum and nothing that could carry credential material", async () => {
    await POST(req(body("user-credential"), "run-active"));
    const [message] = (await threadRow()).messages!;
    expect(Object.keys(message!).sort()).toEqual([
      "source",
      "timestamp",
      "type",
    ]);
    expect(JSON.stringify(message)).not.toMatch(
      /sk-|sk-ant|ghp_|ghs_|Bearer |-----BEGIN|"contents"|"value"/,
    );
  });

  it("accepts each of the three sources", async () => {
    for (const source of [
      "user-credential",
      "built-in-credits",
      "box-key",
    ] as const) {
      vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(ctx());
      expect((await POST(req(body(source)))).status).toBe(200);
    }
    expect((await threadRow()).messages!.map((m) => m.type)).toEqual([
      "credential-source",
      "credential-source",
      "credential-source",
    ]);
  });

  it("409 when a NEWER generation owns the thread, and nothing is appended", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-new" });
    const res = await POST(req(body(), "run-old"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "superseded",
      activeRunExternalId: "run-new",
    });
    expect((await threadRow()).messages ?? []).toEqual([]);
  });

  it("fails OPEN when the caller sends no x-run-external-id", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-new" });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect((await threadRow()).messages).toHaveLength(1);
  });

  it("404 for an unknown thread", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ threadId: null, threadChatId: null }),
    );
    const res = await POST(
      req({
        ...body(),
        threadId: "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(res.status).toBe(404);
  });
});
