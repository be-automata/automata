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
import { recordHatchetRun } from "@terragon/shared/model/hatchet-run";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));

function req(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/run-staleness", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

describe("POST /api/daemon/run-staleness (#125 C4 queue-mode self-check)", () => {
  let user: User;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;

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
    const ctx: DaemonTokenContext = {
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: orgId,
      threadChatId,
      threadId,
      tokenType: "daemon",
    };
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx);
  });

  it("stale only when a NEWER run exists for the same PR; untracked runs are never stale", async () => {
    const body = { threadId, threadChatId, runExternalId: "run-me" };
    // Untracked → false.
    expect(await (await POST(req(body))).json()).toEqual({ stale: false });
    await recordHatchetRun({
      db,
      threadId,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      prNumber: 9,
      externalId: "run-me",
    });
    expect(await (await POST(req(body))).json()).toEqual({ stale: false });
    // A newer run on the same PR (another thread).
    const other = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    await recordHatchetRun({
      db,
      threadId: other.threadId,
      organizationId: orgId,
      repoFullName: "be-automata/automata",
      prNumber: 9,
      externalId: "run-newer",
    });
    expect(await (await POST(req(body))).json()).toEqual({ stale: true });
  });

  it("401 / 403 on bad tokens and bindings", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(null);
    expect(
      (await POST(req({ threadId, threadChatId, runExternalId: "x" }))).status,
    ).toBe(401);
    expect(
      (
        await POST(
          req({ threadId: "thr_other", threadChatId, runExternalId: "x" }),
        )
      ).status,
    ).toBe(403);
  });
});
