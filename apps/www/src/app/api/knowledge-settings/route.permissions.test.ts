import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";

import { PUT } from "./route";
import { POST as OFFBOARD } from "./offboard/route";
import { db } from "@/lib/db";
import { getTenantContextOrNull, isPlatformAdmin } from "@/lib/auth-server";
import {
  createTestUser,
  createTestOrganization,
} from "@terragon/shared/model/test-helpers";
import {
  getKnowledgeControls,
  setKnowledgeBudgetCeiling,
} from "@terragon/shared/model/knowledge-controls";
import { listKnowledgeAdminActions } from "@terragon/shared/model/knowledge-admin-log";
import { getOrganizationById } from "@terragon/shared/model/organizations";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
  isPlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

function req(url: string, method: string, body: unknown) {
  return new NextRequest(`http://localhost/api/knowledge-settings${url}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const put = (body: unknown) => PUT(req("", "PUT", body));
const offboard = (body: unknown) => OFFBOARD(req("/offboard", "POST", body));

describe("knowledge-settings permissions (real DB)", () => {
  let userId: string;
  let orgId: string;

  async function actor(role: "owner" | "admin" | "member") {
    userId = (await createTestUser({ db })).user.id;
    const org = await createTestOrganization({ db, userId, role });
    orgId = org.organization.id;
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId: orgId,
    });
  }

  /** A platform admin with NO membership in the session org. */
  async function platformAdminNonMember() {
    const other = (await createTestUser({ db })).user.id;
    const org = await createTestOrganization({ db, userId: other });
    orgId = org.organization.id;
    userId = (await createTestUser({ db })).user.id;
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId: orgId,
    });
    vi.mocked(isPlatformAdmin).mockResolvedValue(true);
  }

  const controls = () => getKnowledgeControls({ db, organizationId: orgId });
  const actions = () =>
    listKnowledgeAdminActions({ db, organizationId: orgId });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPlatformAdmin).mockResolvedValue(false);
  });

  it.each(["owner", "admin"] as const)(
    "%s can turn the engine on and it persists with one log row",
    async (role) => {
      await actor(role);
      const res = await put({ engine: true });
      expect(res.status).toBe(200);
      expect((await controls()).engine).toBe(true);
      expect(await actions()).toHaveLength(1);
    },
  );

  it("a member gets 403 and nothing changes", async () => {
    await actor("member");
    expect((await put({ engine: true })).status).toBe(403);
    expect((await controls()).engine).not.toBe(true);
    expect(await actions()).toHaveLength(0);
  });

  it("offboard flow: engine forced off, log row, enabling is 409, undo keeps engine off", async () => {
    await actor("owner");
    expect((await put({ engine: true })).status).toBe(200);
    const org = await getOrganizationById({ db, organizationId: orgId });
    const bad = await offboard({ action: "offboard", confirm: "nope" });
    expect(bad.status).toBe(400);
    const ok = await offboard({ action: "offboard", confirm: org?.slug });
    expect(ok.status).toBe(200);
    const c = await controls();
    expect(c.engine).toBe(false);
    expect(c.offboardedAt).not.toBeNull();
    expect((await actions()).map((a) => a.action)).toContain("offboard");
    const again = await put({ engine: true });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "offboarded" });
    expect((await offboard({ action: "undo" })).status).toBe(200);
    const after = await controls();
    expect(after.offboardedAt).toBeNull();
    expect(after.engine).toBe(false);
  });

  it("a user of org B cannot change org A: writes touch only the session org", async () => {
    await actor("owner");
    const orgA = orgId;
    await actor("owner");
    const orgB = orgId;
    const res = await put({ engine: true, organizationId: orgA });
    expect(res.status).toBe(200);
    expect(
      (await getKnowledgeControls({ db, organizationId: orgB })).engine,
    ).toBe(true);
    expect(
      (await getKnowledgeControls({ db, organizationId: orgA })).engine,
    ).not.toBe(true);
  });

  it("platform admin non-member: budget 200 with a platform_admin log row; engine and offboard 403", async () => {
    await platformAdminNonMember();
    const res = await put({ budgetMicroUsd: 150_000_000 });
    expect(res.status).toBe(200);
    expect((await controls()).budgetMicroUsd).toBe(150_000_000);
    const row = (await actions()).find((a) => a.action === "budget_change");
    expect(row?.actorUserId).toBe(userId);
    expect((row?.target as { via?: string }).via).toBe("platform_admin");

    const before = await controls();
    expect((await put({ engine: true })).status).toBe(403);
    const org = await getOrganizationById({ db, organizationId: orgId });
    expect(
      (await offboard({ action: "offboard", confirm: org?.slug })).status,
    ).toBe(403);
    const after = await controls();
    expect(after.engine).toBe(before.engine);
    expect(after.offboardedAt).toBeNull();
  });

  it("org admin above the ceiling is 403 until the platform ceiling is raised", async () => {
    await actor("admin");
    const denied = await put({ budgetMicroUsd: 150_000_000 });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("budget_above_ceiling");
    expect((await controls()).budgetMicroUsd).toBeNull();
    try {
      await setKnowledgeBudgetCeiling(db, {
        micro: 200_000_000,
        actorUserId: userId,
      });
      expect((await put({ budgetMicroUsd: 150_000_000 })).status).toBe(200);
      expect((await controls()).budgetMicroUsd).toBe(150_000_000);
    } finally {
      await setKnowledgeBudgetCeiling(db, { micro: null, actorUserId: userId });
    }
  });
});
