import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";

import { GET, PUT } from "./route";
import { getTenantContextOrNull, isPlatformAdmin } from "@/lib/auth-server";
import { isOrgAdmin } from "@/lib/org-role";
import {
  getKnowledgeBudgetCeiling,
  getKnowledgeControls,
  getKnowledgeSpend,
  updateKnowledgeControls,
  KnowledgeControlsConflictError,
  KnowledgeOffboardedError,
} from "@terragon/shared/model/knowledge-controls";
import { listKnowledgeAdminActions } from "@terragon/shared/model/knowledge-admin-log";
import { getOrganizationById } from "@terragon/shared/model/organizations";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
  isPlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/org-role", () => ({ isOrgAdmin: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
const captureMock = vi.fn();
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: captureMock }),
}));
vi.mock("@terragon/shared/model/organizations", () => ({
  getOrganizationById: vi.fn(),
}));
vi.mock("@terragon/shared/model/knowledge-admin-log", () => ({
  listKnowledgeAdminActions: vi.fn(),
}));
vi.mock("@terragon/shared/model/knowledge-controls", async () => {
  const actual = await vi.importActual<
    typeof import("@terragon/shared/model/knowledge-controls")
  >("@terragon/shared/model/knowledge-controls");
  return {
    ...actual,
    getKnowledgeBudgetCeiling: vi.fn(),
    getKnowledgeControls: vi.fn(),
    getKnowledgeSpend: vi.fn(),
    updateKnowledgeControls: vi.fn(),
  };
});

const ORG = "org_1";
const USER = "user_1";
const UPDATED = new Date("2026-10-01T00:00:00.000Z");

function controls(over: Record<string, unknown> = {}) {
  return {
    engine: true,
    budgetMicroUsd: 50_000_000,
    effectiveBudgetMicroUsd: 50_000_000,
    ceilingMicroUsd: 100_000_000,
    offboardedAt: null,
    purgeAfter: null,
    purgedAt: null,
    enabled: true,
    gateReason: null,
    updatedAt: UPDATED,
    ...over,
  };
}

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/knowledge-settings", {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("/api/knowledge-settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: ORG,
    });
    vi.mocked(isOrgAdmin).mockResolvedValue(true);
    vi.mocked(isPlatformAdmin).mockResolvedValue(false);
    vi.mocked(getKnowledgeBudgetCeiling).mockResolvedValue(100_000_000);
    vi.mocked(getKnowledgeControls).mockResolvedValue(controls() as never);
    vi.mocked(updateKnowledgeControls).mockResolvedValue(controls() as never);
    vi.mocked(getKnowledgeSpend).mockResolvedValue({
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      capMicroUsd: 50_000_000,
      reservedMicroUsd: 1,
      spentMicroUsd: 2,
      remainingMicroUsd: 3,
      atCap: false,
      capAlertedAt: null,
    });
    vi.mocked(listKnowledgeAdminActions).mockResolvedValue([
      {
        id: "a1",
        action: "toggle",
        target: { to: true },
        actorUserId: USER,
        createdAt: UPDATED,
      },
    ] as never);
    vi.mocked(getOrganizationById).mockResolvedValue({
      slug: "acme",
    } as never);
  });

  describe("GET", () => {
    it("401 without a session", async () => {
      vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
      expect((await GET()).status).toBe(401);
    });

    it("200 empty payload with no active org", async () => {
      vi.mocked(getTenantContextOrNull).mockResolvedValue({
        userId: USER,
        organizationId: null,
      });
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        orgSlug: null,
        controls: null,
        spend: null,
        actions: [],
        viewer: { isOrgAdmin: false, isPlatformAdmin: false },
      });
    });

    it("200 for a plain member with ISO dates, orgSlug, ceiling and viewer flags", async () => {
      vi.mocked(isOrgAdmin).mockResolvedValue(false);
      const res = await GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orgSlug).toBe("acme");
      expect(body.controls.updatedAt).toBe(UPDATED.toISOString());
      expect(body.controls.ceilingMicroUsd).toBe(100_000_000);
      expect(body.spend.spentMicroUsd).toBe(2);
      expect(body.actions).toHaveLength(1);
      expect(body.viewer).toEqual({
        isOrgAdmin: false,
        isPlatformAdmin: false,
      });
      expect(listKnowledgeAdminActions).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG, limit: 20 }),
      );
    });
  });

  describe("PUT authz", () => {
    it("401 without a session", async () => {
      vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
      expect((await put({ engine: true })).status).toBe(401);
    });

    it("400 without an active org", async () => {
      vi.mocked(getTenantContextOrNull).mockResolvedValue({
        userId: USER,
        organizationId: null,
      });
      expect((await put({ engine: true })).status).toBe(400);
    });

    it("403 for a member who is not a platform admin", async () => {
      vi.mocked(isOrgAdmin).mockResolvedValue(false);
      expect((await put({ engine: true })).status).toBe(403);
      expect(updateKnowledgeControls).not.toHaveBeenCalled();
    });

    it("403 before body validation", async () => {
      vi.mocked(isOrgAdmin).mockResolvedValue(false);
      expect((await put("not json")).status).toBe(403);
      expect((await put({ engine: "yes" })).status).toBe(403);
    });

    it("platform admin non-member: budget 200 via platform_admin", async () => {
      vi.mocked(isOrgAdmin).mockResolvedValue(false);
      vi.mocked(isPlatformAdmin).mockResolvedValue(true);
      const res = await put({ budgetMicroUsd: 150_000_000 });
      expect(res.status).toBe(200);
      expect(updateKnowledgeControls).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: USER,
          via: "platform_admin",
          patch: { budgetMicroUsd: 150_000_000 },
        }),
      );
    });

    it("platform admin non-member: engine fields are 403 org_admin_required", async () => {
      vi.mocked(isOrgAdmin).mockResolvedValue(false);
      vi.mocked(isPlatformAdmin).mockResolvedValue(true);
      for (const body of [
        { engine: true },
        { engine: false, budgetMicroUsd: 1 },
      ]) {
        const res = await put(body);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "org_admin_required" });
      }
      expect(updateKnowledgeControls).not.toHaveBeenCalled();
    });

    it("org admin who is also platform admin writes via org_admin", async () => {
      vi.mocked(isPlatformAdmin).mockResolvedValue(true);
      await put({ engine: true });
      expect(updateKnowledgeControls).toHaveBeenCalledWith(
        expect.objectContaining({ via: "org_admin" }),
      );
    });
  });

  describe("PUT validation", () => {
    it.each([
      ["invalid JSON", "{nope"],
      ["non-object", "[1]"],
      ["empty patch", {}],
      ["engine not boolean", { engine: "on" }],
      ["budget a string", { budgetMicroUsd: "5" }],
      ["budget negative", { budgetMicroUsd: -1 }],
      ["budget fractional", { budgetMicroUsd: 1.5 }],
      ["expectedUpdatedAt garbage", { engine: true, expectedUpdatedAt: "x" }],
      ["expectedUpdatedAt number", { engine: true, expectedUpdatedAt: 5 }],
    ])("400 %s", async (_n, body) => {
      expect((await put(body)).status).toBe(400);
      expect(updateKnowledgeControls).not.toHaveBeenCalled();
    });

    it("ignores unknown keys and an organizationId in the body", async () => {
      const res = await put({
        engine: true,
        organizationId: "org-evil",
        junk: 1,
      });
      expect(res.status).toBe(200);
      const call = vi.mocked(updateKnowledgeControls).mock.calls[0]?.[0];
      expect(call?.organizationId).toBe(ORG);
      expect(call?.patch).toEqual({ engine: true });
    });

    it("parses expectedUpdatedAt into a Date and null stays null", async () => {
      await put({ engine: true, expectedUpdatedAt: UPDATED.toISOString() });
      expect(updateKnowledgeControls).toHaveBeenLastCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          actorUserId: USER,
          patch: { engine: true },
          expectedUpdatedAt: UPDATED,
        }),
      );
      await put({ engine: true, expectedUpdatedAt: null });
      expect(updateKnowledgeControls).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedUpdatedAt: null }),
      );
    });
  });

  describe("PUT budget ceiling", () => {
    it("org admin above the ceiling is 403; platform admin is 200", async () => {
      const res = await put({ budgetMicroUsd: 150_000_000 });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "budget_above_ceiling",
        ceilingMicroUsd: 100_000_000,
      });
      expect(updateKnowledgeControls).not.toHaveBeenCalled();
      vi.mocked(isPlatformAdmin).mockResolvedValue(true);
      expect((await put({ budgetMicroUsd: 150_000_000 })).status).toBe(200);
    });

    it("an org admin who is also platform admin logs an above-ceiling raise via platform_admin", async () => {
      vi.mocked(isPlatformAdmin).mockResolvedValue(true);
      await put({ budgetMicroUsd: 150_000_000 });
      expect(updateKnowledgeControls).toHaveBeenLastCalledWith(
        expect.objectContaining({ via: "platform_admin" }),
      );
      await put({ budgetMicroUsd: 50_000_000 });
      expect(updateKnowledgeControls).toHaveBeenLastCalledWith(
        expect.objectContaining({ via: "org_admin" }),
      );
    });

    it("uses the DB ceiling, not the default", async () => {
      vi.mocked(getKnowledgeBudgetCeiling).mockResolvedValue(50_000_000);
      const res = await put({ budgetMicroUsd: 60_000_000 });
      expect(res.status).toBe(403);
      expect((await res.json()).ceilingMicroUsd).toBe(50_000_000);
      expect((await put({ budgetMicroUsd: 40_000_000 })).status).toBe(200);
    });

    it("lowering a platform-set value above the ceiling is allowed", async () => {
      vi.mocked(getKnowledgeControls).mockResolvedValue(
        controls({ budgetMicroUsd: 300_000_000 }) as never,
      );
      expect((await put({ budgetMicroUsd: 200_000_000 })).status).toBe(200);
    });

    it("above the absolute max is 400 even for a platform admin", async () => {
      vi.mocked(isPlatformAdmin).mockResolvedValue(true);
      const res = await put({ budgetMicroUsd: 10_000_000_001 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "out_of_range" });
    });

    it("null (reset to default) is allowed", async () => {
      expect((await put({ budgetMicroUsd: null })).status).toBe(200);
    });
  });

  describe("PUT errors and analytics", () => {
    it("409 conflict with currentUpdatedAt", async () => {
      vi.mocked(updateKnowledgeControls).mockRejectedValue(
        new KnowledgeControlsConflictError(),
      );
      const res = await put({ engine: true, expectedUpdatedAt: null });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "conflict",
        currentUpdatedAt: UPDATED.toISOString(),
      });
    });

    it("409 offboarded", async () => {
      vi.mocked(updateKnowledgeControls).mockRejectedValue(
        new KnowledgeOffboardedError(),
      );
      const res = await put({ engine: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "offboarded" });
    });

    it("rethrows other errors", async () => {
      vi.mocked(updateKnowledgeControls).mockRejectedValue(new Error("boom"));
      await expect(put({ engine: true })).rejects.toThrow("boom");
    });

    it("captures ids/enums/integers only", async () => {
      const res = await put({ engine: true, budgetMicroUsd: 1000 });
      expect(res.status).toBe(200);
      expect(captureMock).toHaveBeenCalledWith({
        distinctId: USER,
        event: "knowledge_controls_updated",
        properties: {
          organizationId: ORG,
          engine: true,
          budgetMicroUsd: 1000,
        },
      });
      expect((await res.json()).controls.updatedAt).toBe(UPDATED.toISOString());
    });
  });
});
