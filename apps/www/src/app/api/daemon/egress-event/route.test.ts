import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { createTestUser, createTestThread } from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { listEgressEvents } from "@terragon/shared/model/egress-events";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));

function req(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/egress-event", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

const okEvent = {
  destinationHost: "evil.example.com",
  destinationPort: 443,
  action: "deny",
  policyLevel: "domain",
  source: "worker",
};

describe("POST /api/daemon/egress-event", () => {
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

  it("401 without a valid token; 403 for a non-daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(null);
    expect((await POST(req({ events: [okEvent] }))).status).toBe(401);
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx({ tokenType: null }));
    expect((await POST(req({ events: [okEvent] }))).status).toBe(403);
  });

  it("403 for a legacy token with no threadChat binding (no run identity)", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValue(
      ctx({ threadChatId: null }),
    );
    expect((await POST(req({ events: [okEvent] }))).status).toBe(403);
  });

  it("happy path: inserts the batch stamped with the TOKEN's org/thread/run", async () => {
    const res = await POST(
      req({
        events: [
          okEvent,
          {
            destinationHost: "api.anthropic.com",
            action: "allow",
            source: "worker",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 2 });

    const rows = await listEgressEvents({
      db,
      organizationId: orgId,
      runId: threadChatId,
    });
    expect(rows).toHaveLength(2);
    const byHost = Object.fromEntries(rows.map((r) => [r.destinationHost, r]));
    expect(byHost["evil.example.com"]).toMatchObject({
      action: "deny",
      destinationPort: 443,
      policyLevel: "domain",
      source: "worker",
      organizationId: orgId,
      threadId,
      runId: threadChatId,
    });
    expect(byHost["api.anthropic.com"]).toMatchObject({
      action: "allow",
      destinationPort: null,
      policyLevel: null,
    });
  });

  it("persists the observe/enforce mode marker, defaulting absent to enforce (#108 F4)", async () => {
    // An observe-mode plane allows EVERYTHING, so its allow rows are evidence
    // that traffic happened — never that a policy permitted it. Without the
    // marker the two are indistinguishable in the audit trail.
    const res = await POST(
      req({
        events: [
          {
            destinationHost: "observed.example.com",
            action: "allow",
            policyLevel: "none",
            source: "worker",
            mode: "observe",
          },
          {
            destinationHost: "enforced.example.com",
            action: "allow",
            policyLevel: "domain",
            source: "worker",
            mode: "enforce",
          },
          // No marker at all — an older plane, which always meant "enforce".
          {
            destinationHost: "legacy.example.com",
            action: "allow",
            source: "worker",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const rows = await listEgressEvents({
      db,
      organizationId: orgId,
      runId: threadChatId,
    });
    const byHost = Object.fromEntries(rows.map((r) => [r.destinationHost, r]));
    expect(byHost["observed.example.com"]?.mode).toBe("observe");
    expect(byHost["enforced.example.com"]?.mode).toBe("enforce");
    expect(byHost["legacy.example.com"]?.mode).toBe("enforce");
  });

  it("400 on malformed body: not JSON, missing events, bad action/source, empty batch", async () => {
    const notJson = new NextRequest("http://localhost/api/daemon/egress-event", {
      method: "POST",
      body: "not-json",
      headers: { "X-Daemon-Token": "tok" },
    });
    expect((await POST(notJson)).status).toBe(400);
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ events: [] }))).status).toBe(400);
    expect(
      (
        await POST(
          req({ events: [{ ...okEvent, action: "audit" }] }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          req({ events: [{ ...okEvent, source: "mars" }] }),
        )
      ).status,
    ).toBe(400);
    // #108 F4: an unknown posture is a rejection, never a silently-dropped
    // field that would leave the row claiming "enforce".
    expect(
      (
        await POST(
          req({ events: [{ ...okEvent, mode: "audit-only" }] }),
        )
      ).status,
    ).toBe(400);
  });

  it("rejects an oversize batch (cap 100) outright — never silently truncates", async () => {
    const events = Array.from({ length: 101 }, () => okEvent);
    expect((await POST(req({ events }))).status).toBe(400);
    // Nothing inserted.
    expect(
      await listEgressEvents({ db, organizationId: orgId, runId: threadChatId }),
    ).toHaveLength(0);

    // Exactly at the cap is fine.
    const atCap = Array.from({ length: 100 }, () => okEvent);
    expect((await POST(req({ events: atCap }))).status).toBe(200);
  });
});
