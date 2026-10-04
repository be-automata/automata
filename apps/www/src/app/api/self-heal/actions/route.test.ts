import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { selfHealBreaker } from "@terragon/shared/db/schema";
import { listSelfHealAdminActions } from "@terragon/shared/model/self-heal-admin-log";
import { getBreakerState } from "@terragon/shared/model/self-heal-breaker";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { POST } from "./route";

vi.mock("@/lib/auth-server", () => ({ getTenantContextOrNull: vi.fn() }));
vi.mock("@/agent/hatchet/dispatch", () => ({
  hatchetConfig: () => ({ apiUrl: "http://x", tenantId: "t", apiToken: "k" }),
}));
vi.mock("@/agent/hatchet/transport", () => ({
  listAgentRunsForThread: vi.fn(async () => []),
  cancelAgentRun: vi.fn(async () => undefined),
}));

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/self-heal/actions", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/self-heal/actions", () => {
  let userId: string;
  let orgId: string;

  async function actor(role: "owner" | "admin" | "member") {
    userId = (await createTestUser({ db })).user.id;
    const org = await createTestOrganization({
      db,
      userId,
      name: `Org ${nanoid(6)}`,
      role,
    });
    orgId = org.organization.id;
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId: orgId,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when unauthenticated", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    expect((await post({ action: "drain" })).status).toBe(401);
  });

  it("403 for a member and nothing happens", async () => {
    await actor("member");
    expect((await post({ action: "drain" })).status).toBe(403);
    expect(
      await listSelfHealAdminActions({ db, organizationId: orgId }),
    ).toEqual([]);
  });

  it("admin drain returns the result and logs the actor", async () => {
    await actor("admin");
    const res = await post({ action: "drain" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      killSwitchSet: true,
      cancelled: [],
      nothingInFlight: true,
    });
    const log = await listSelfHealAdminActions({ db, organizationId: orgId });
    expect(log.map((row) => row.action)).toContain("drain");
  });

  it("reset_breaker closes a paused_manual loop_fix row and logs it", async () => {
    await actor("owner");
    await db.insert(selfHealBreaker).values({
      organizationId: orgId,
      scopeKind: "loop_fix",
      scopeKey: "acme/widgets",
      state: "paused_manual",
      tripCount: 3,
    });
    const res = await post({
      action: "reset_breaker",
      scopeKind: "loop_fix",
      scopeKey: "acme/widgets",
    });
    expect(res.status).toBe(200);
    const row = await getBreakerState({
      db,
      organizationId: orgId,
      scopeKind: "loop_fix",
      scopeKey: "acme/widgets",
    });
    expect(row.state).toBe("closed");
    expect(row.tripCount).toBe(3);
    const log = await listSelfHealAdminActions({ db, organizationId: orgId });
    expect(log.map((r) => r.action)).toContain("breaker_reset");
    await db
      .delete(selfHealBreaker)
      .where(eq(selfHealBreaker.organizationId, orgId));
  });

  it("400 on a bad body", async () => {
    await actor("admin");
    expect((await post("not json")).status).toBe(400);
    expect((await post({ action: "nope" })).status).toBe(400);
    expect(
      (
        await post({
          action: "reset_breaker",
          scopeKind: "bogus",
          scopeKey: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ action: "reset_breaker", scopeKind: "loop_fix" })).status,
    ).toBe(400);
  });
});
