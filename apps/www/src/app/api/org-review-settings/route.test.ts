import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { isOrgAdmin } from "@/lib/org-role";
import {
  getOrganizationReviewSetting,
  upsertOrganizationReviewSetting,
  removeOrganizationReviewSetting,
} from "@terragon/shared/model/organization-review-settings";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
}));

vi.mock("@/lib/org-role", () => ({
  isOrgAdmin: vi.fn(),
}));

vi.mock("@terragon/shared/model/organization-review-settings", () => ({
  getOrganizationReviewSetting: vi.fn(),
  upsertOrganizationReviewSetting: vi.fn(),
  removeOrganizationReviewSetting: vi.fn(),
}));

const captureMock = vi.fn();
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: captureMock }),
}));

vi.mock("@/lib/db", () => ({ db: {} }));

const ORG = "org_1";
const USER = "user_1";

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/org-review-settings", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function baseRow(overrides: Partial<{ blockTolerance: string | null }> = {}) {
  return {
    organizationId: ORG,
    blockTolerance: "error",
    trustedAuthorThreshold: null,
    updatedByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("GET/PUT /api/org-review-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: ORG,
    });
    vi.mocked(isOrgAdmin).mockResolvedValue(true);
    vi.mocked(getOrganizationReviewSetting).mockResolvedValue(
      baseRow() as never,
    );
    vi.mocked(upsertOrganizationReviewSetting).mockResolvedValue(
      baseRow() as never,
    );
  });

  it("GET 401 when unauthenticated", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET 200 with setting: null when there is no active org (lenient)", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { setting: unknown };
    expect(json.setting).toBeNull();
  });

  it("GET returns the stored floor", async () => {
    vi.mocked(getOrganizationReviewSetting).mockResolvedValue(
      baseRow({ blockTolerance: "warning" }) as never,
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      setting: { blockTolerance: string | null };
    };
    expect(json.setting.blockTolerance).toBe("warning");
  });

  it("GET returns setting: null when no row exists (no floor set)", async () => {
    vi.mocked(getOrganizationReviewSetting).mockResolvedValue(undefined);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { setting: unknown };
    expect(json.setting).toBeNull();
  });

  it("GET does not require org-admin (any member can see the floor)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(isOrgAdmin).not.toHaveBeenCalled();
  });

  it("PUT 401 when unauthenticated", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    const res = await PUT(putReq({ blockTolerance: "error" }));
    expect(res.status).toBe(401);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 400 when the session has no active org", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: null,
    });
    const res = await PUT(putReq({ blockTolerance: "error" }));
    expect(res.status).toBe(400);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 403 when the caller is a plain member (upsert not called)", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(false);
    const res = await PUT(putReq({ blockTolerance: "error" }));
    expect(res.status).toBe(403);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 403 when the caller has no membership row (isOrgAdmin resolves false)", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(false);
    const res = await PUT(putReq({ blockTolerance: "warning" }));
    expect(res.status).toBe(403);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 403 is checked BEFORE body validation (invalid body, non-admin, still 403 not 400)", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(false);
    const res = await PUT(putReq({ blockTolerance: "not-a-real-value" }));
    expect(res.status).toBe(403);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 400 on an invalid tolerance value (rejected before any write)", async () => {
    const res = await PUT(putReq({ blockTolerance: "catastrophic" }));
    expect(res.status).toBe(400);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 400 when 'critical' is sent (representable but not operator-selectable)", async () => {
    const res = await PUT(putReq({ blockTolerance: "critical" }));
    expect(res.status).toBe(400);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 400 when blockTolerance is missing entirely", async () => {
    const res = await PUT(putReq({}));
    expect(res.status).toBe(400);
    expect(upsertOrganizationReviewSetting).not.toHaveBeenCalled();
  });

  it("PUT 200 as owner: sets the floor fenced to the active org, records audit event", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(true);
    vi.mocked(upsertOrganizationReviewSetting).mockResolvedValue(
      baseRow({ blockTolerance: "error" }) as never,
    );
    const res = await PUT(putReq({ blockTolerance: "error" }));
    expect(res.status).toBe(200);
    expect(upsertOrganizationReviewSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        patch: { blockTolerance: "error" },
        updatedByUserId: USER,
      }),
    );
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "org_review_floor_set" }),
    );
    const json = (await res.json()) as {
      setting: { blockTolerance: string | null };
    };
    expect(json.setting.blockTolerance).toBe("error");
  });

  it("PUT 200 as admin: sets the floor fenced to the active org, records audit event", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue(true);
    vi.mocked(upsertOrganizationReviewSetting).mockResolvedValue(
      baseRow({ blockTolerance: "info" }) as never,
    );
    const res = await PUT(putReq({ blockTolerance: "info" }));
    expect(res.status).toBe(200);
    expect(upsertOrganizationReviewSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        patch: { blockTolerance: "info" },
        updatedByUserId: USER,
      }),
    );
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "org_review_floor_set" }),
    );
  });

  it("PUT clears the floor via patch: { blockTolerance: null } — never trustedAuthorThreshold, never remove", async () => {
    vi.mocked(upsertOrganizationReviewSetting).mockResolvedValue(
      baseRow({ blockTolerance: null }) as never,
    );
    const res = await PUT(putReq({ blockTolerance: null }));
    expect(res.status).toBe(200);
    expect(upsertOrganizationReviewSetting).toHaveBeenCalledTimes(1);
    const call = vi.mocked(upsertOrganizationReviewSetting).mock.calls[0]![0];
    expect(call.patch).toEqual({ blockTolerance: null });
    expect(call.patch).not.toHaveProperty("trustedAuthorThreshold");
    expect(removeOrganizationReviewSetting).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "org_review_floor_cleared" }),
    );
    const json = (await res.json()) as {
      setting: { blockTolerance: string | null };
    };
    expect(json.setting.blockTolerance).toBeNull();
  });
});
