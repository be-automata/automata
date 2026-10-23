import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "./route";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { isOrgAdmin } from "@/lib/org-role";
import {
  clearKnowledgeOffboard,
  offboardKnowledge,
} from "@terragon/shared/model/knowledge-controls";
import { getOrganizationById } from "@terragon/shared/model/organizations";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
  isPlatformAdmin: vi.fn().mockResolvedValue(true),
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
vi.mock("@terragon/shared/model/knowledge-controls", () => ({
  offboardKnowledge: vi.fn(),
  clearKnowledgeOffboard: vi.fn(),
}));

const ORG = "org_1";
const USER = "user_1";
const NOW = new Date("2026-10-22T00:00:00.000Z");

const OFFBOARDED = {
  engine: false,
  budgetMicroUsd: null,
  effectiveBudgetMicroUsd: 100,
  ceilingMicroUsd: 200,
  offboardedAt: NOW,
  purgeAfter: new Date(NOW.getTime() + 7 * 86_400_000),
  purgedAt: null,
  enabled: false,
  gateReason: "offboarded",
  updatedAt: NOW,
};

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/knowledge-settings/offboard", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("POST /api/knowledge-settings/offboard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: ORG,
    });
    vi.mocked(isOrgAdmin).mockResolvedValue(true);
    vi.mocked(getOrganizationById).mockResolvedValue({
      slug: "acme",
    } as never);
    vi.mocked(offboardKnowledge).mockResolvedValue(OFFBOARDED as never);
    vi.mocked(clearKnowledgeOffboard).mockResolvedValue({
      ...OFFBOARDED,
      offboardedAt: null,
      purgeAfter: null,
    } as never);
  });

  it("401 without a session", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    expect((await post({ action: "undo" })).status).toBe(401);
  });

  it("400 without an active org", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: null,
    });
    expect((await post({ action: "undo" })).status).toBe(400);
  });

  it("403 for a non-org-admin (even a platform admin) before body validation", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(false);
    expect((await post("not json")).status).toBe(403);
    expect((await post({ action: "offboard", confirm: "acme" })).status).toBe(
      403,
    );
    expect(offboardKnowledge).not.toHaveBeenCalled();
    expect(clearKnowledgeOffboard).not.toHaveBeenCalled();
  });

  it("offboards with the exact slug", async () => {
    const res = await post({ action: "offboard", confirm: "acme" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.controls.engine).toBe(false);
    expect(body.controls.offboardedAt).toBe(NOW.toISOString());
    expect(offboardKnowledge).toHaveBeenCalledWith({
      db: {},
      organizationId: ORG,
      actorUserId: USER,
    });
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: USER,
      event: "knowledge_offboard_changed",
      properties: { organizationId: ORG, action: "offboard" },
    });
  });

  it.each([
    ["missing", { action: "offboard" }],
    ["different case", { action: "offboard", confirm: "ACME" }],
    ["wrong", { action: "offboard", confirm: "other" }],
    ["non-string", { action: "offboard", confirm: 5 }],
  ])("400 confirmation_mismatch when confirm is %s", async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "confirmation_mismatch" });
    expect(offboardKnowledge).not.toHaveBeenCalled();
  });

  it("undo clears the mark", async () => {
    const res = await post({ action: "undo" });
    expect(res.status).toBe(200);
    expect((await res.json()).controls.offboardedAt).toBeNull();
    expect(clearKnowledgeOffboard).toHaveBeenCalledWith({
      db: {},
      organizationId: ORG,
      actorUserId: USER,
    });
  });

  it("400 on an unknown action or invalid body", async () => {
    expect((await post({ action: "purge" })).status).toBe(400);
    expect((await post("{x")).status).toBe(400);
  });
});
