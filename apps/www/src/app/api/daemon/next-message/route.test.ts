import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { buildRemoteDaemonMessage } from "@/server-lib/remote-daemon-message";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";

vi.mock("@/lib/auth-server", () => ({
  getDaemonTokenContext: vi.fn(),
}));

vi.mock("@/server-lib/remote-daemon-message", () => ({
  buildRemoteDaemonMessage: vi.fn(),
}));

const CANNED = {
  type: "claude" as const,
  model: "claude-x",
  agent: "claudeCode",
  agentVersion: 1,
  prompt: "do the thing",
  sessionId: null,
  permissionMode: "allowAll" as const,
  featureFlags: {},
};

function req(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost/api/daemon/next-message?${qs}`, {
    headers: { "X-Daemon-Token": "tok" },
  });
}

describe("GET /api/daemon/next-message", () => {
  let user: User;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(buildRemoteDaemonMessage).mockResolvedValue(CANNED);
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
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: user.id,
      organizationId: orgId,
    });
  });

  it("401 without a valid daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    const res = await GET(req({ threadId, threadChatId }));
    expect(res.status).toBe(401);
    expect(buildRemoteDaemonMessage).not.toHaveBeenCalled();
  });

  it("400 when threadId/threadChatId missing", async () => {
    expect((await GET(req({ threadChatId }))).status).toBe(400);
    expect((await GET(req({ threadId }))).status).toBe(400);
  });

  it("H1: 403 when a valid token's user does not own the thread", async () => {
    const other = (await createTestUser({ db })).user;
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: other.id,
      organizationId: orgId,
    });
    const res = await GET(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(buildRemoteDaemonMessage).not.toHaveBeenCalled();
  });

  it("H1: 403 when a valid token's org != the thread's org", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: user.id,
      organizationId: "some-other-org",
    });
    const res = await GET(req({ threadId, threadChatId }));
    expect(res.status).toBe(403);
    expect(buildRemoteDaemonMessage).not.toHaveBeenCalled();
  });

  it("200 with the prepared message when the token↔thread binding holds", async () => {
    const res = await GET(req({ threadId, threadChatId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CANNED);
    expect(buildRemoteDaemonMessage).toHaveBeenCalledWith({
      userId: user.id,
      threadId,
      threadChatId,
    });
  });

  it("204 when there is nothing to send yet", async () => {
    vi.mocked(buildRemoteDaemonMessage).mockResolvedValue(null);
    const res = await GET(req({ threadId, threadChatId }));
    expect(res.status).toBe(204);
  });
});
