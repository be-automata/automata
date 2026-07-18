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
import { thread as threadTable } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/daemon/thread-status", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon/thread-status", () => {
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
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
  });

  it("401 without a token; 403 for a non-daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(401);
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx({ tokenType: null }));
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(403);
  });

  it("F2: 403 when the token is bound to a different threadChat", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: "tc_other" }),
    );
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(403);
  });

  it("403 when the token's org != the thread's org", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ organizationId: "other-org" }),
    );
    expect((await POST(req({ threadId, threadChatId }))).status).toBe(403);
  });

  it("reports terminal=false while working and terminal=true when complete", async () => {
    await db
      .update(threadTable)
      .set({ status: "working" })
      .where(eq(threadTable.id, threadId));
    let res = await POST(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "working", terminal: false });

    await db
      .update(threadTable)
      .set({ status: "complete" })
      .where(eq(threadTable.id, threadId));
    res = await POST(req({ threadId, threadChatId }));
    expect(await res.json()).toEqual({ status: "complete", terminal: true });
  });
});
