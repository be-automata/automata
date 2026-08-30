import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { PUT, DELETE } from "./route";
import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  upsertRepoReviewSetting,
  removeRepoReviewSetting,
  getRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";

// #125 C6: these cases exercise validation/DTO shape; the permission gate has
// its own suite (route.permissions.test.ts) — pin it open here.
vi.mock("@/lib/org-role", () => ({
  isOrgAdmin: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
}));

// Partial mock: route.ts (via supersede-route-shared.ts) also uses
// getRepoReviewSetting / isSupersedePolicy / SUPERSEDE_POLICIES — keep the
// real ones so a future case that sends supersedePolicy or expectedUpdatedAt
// fails on its assertion, not on a "not a function" TypeError.
vi.mock(
  "@terragon/shared/model/repo-review-settings",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    upsertRepoReviewSetting: vi.fn(),
    removeRepoReviewSetting: vi.fn(),
    // The 409 bodies read the current row back; mocked so the conflict tests
    // pin the body shape without a database.
    getRepoReviewSetting: vi.fn(),
  }),
);

const captureMock = vi.fn();
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: captureMock }),
}));

vi.mock("@/lib/db", () => ({ db: {} }));

const ORG = "org_1";
const USER = "user_1";

function putReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/review-settings/acme/widgets", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = Promise.resolve({ owner: "acme", repo: "widgets" });

describe("PUT/DELETE /api/review-settings/[owner]/[repo]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: ORG,
    });
    vi.mocked(upsertRepoReviewSetting).mockResolvedValue({
      id: "s1",
      organizationId: ORG,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
      reviewDraftPrs: true,
      trustedAuthorThreshold: null,
      egressPolicy: null,
      egressAllowlist: null,
      supersedePolicy: null,
      recheckOnComplete: false,
      updatedByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(removeRepoReviewSetting).mockResolvedValue({
      removed: true,
      conflict: false,
    });
  });

  it("401 when unauthenticated", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    const res = await PUT(putReq({ blockTolerance: "error" }), { params });
    expect(res.status).toBe(401);
    expect(upsertRepoReviewSetting).not.toHaveBeenCalled();
  });

  it("400 when the session has no active org", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: null,
    });
    const res = await PUT(putReq({ blockTolerance: "error" }), { params });
    expect(res.status).toBe(400);
    expect(upsertRepoReviewSetting).not.toHaveBeenCalled();
  });

  it("400 on an invalid tolerance value (rejected before any write)", async () => {
    const res = await PUT(putReq({ blockTolerance: "catastrophic" }), {
      params,
    });
    expect(res.status).toBe(400);
    expect(upsertRepoReviewSetting).not.toHaveBeenCalled();
  });

  it("400 when 'critical' is sent (representable but not operator-selectable)", async () => {
    const res = await PUT(putReq({ blockTolerance: "critical" }), { params });
    expect(res.status).toBe(400);
    expect(upsertRepoReviewSetting).not.toHaveBeenCalled();
  });

  it("400 on an empty patch (neither field provided)", async () => {
    const res = await PUT(putReq({}), { params });
    expect(res.status).toBe(400);
    expect(upsertRepoReviewSetting).not.toHaveBeenCalled();
  });

  it("400 when reviewDraftPrs is not a boolean", async () => {
    const res = await PUT(putReq({ reviewDraftPrs: "yes" }), { params });
    expect(res.status).toBe(400);
    expect(upsertRepoReviewSetting).not.toHaveBeenCalled();
  });

  it("sets the tolerance fenced to the active org, records provenance + audit event", async () => {
    const res = await PUT(putReq({ blockTolerance: "error" }), { params });
    expect(res.status).toBe(200);
    expect(upsertRepoReviewSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        repoFullName: "acme/widgets",
        patch: { blockTolerance: "error" },
        updatedByUserId: USER,
      }),
    );
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: "review_tolerance_set" }),
    );
    const json = (await res.json()) as { setting: { blockTolerance: string } };
    expect(json.setting.blockTolerance).toBe("error");
  });

  it("sets ONLY the draft policy when only reviewDraftPrs is sent (partial patch)", async () => {
    vi.mocked(upsertRepoReviewSetting).mockResolvedValue({
      id: "s1",
      organizationId: ORG,
      repoFullName: "acme/widgets",
      blockTolerance: "warning",
      reviewDraftPrs: false,
      trustedAuthorThreshold: null,
      egressPolicy: null,
      egressAllowlist: null,
      supersedePolicy: null,
      recheckOnComplete: false,
      updatedByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PUT(putReq({ reviewDraftPrs: false }), { params });
    expect(res.status).toBe(200);
    expect(upsertRepoReviewSetting).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { reviewDraftPrs: false } }),
    );
    const json = (await res.json()) as { setting: { reviewDraftPrs: boolean } };
    expect(json.setting.reviewDraftPrs).toBe(false);
  });

  it("PUT reviewDraftPrs:null clears the repo override back to inherit (tri-state)", async () => {
    vi.mocked(upsertRepoReviewSetting).mockResolvedValue({
      id: "s1",
      organizationId: ORG,
      repoFullName: "acme/widgets",
      blockTolerance: "warning",
      reviewDraftPrs: null,
      trustedAuthorThreshold: null,
      egressPolicy: null,
      egressAllowlist: null,
      supersedePolicy: null,
      recheckOnComplete: false,
      updatedByUserId: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await PUT(putReq({ reviewDraftPrs: null }), { params });
    expect(res.status).toBe(200);
    expect(upsertRepoReviewSetting).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { reviewDraftPrs: null } }),
    );
    const json = (await res.json()) as {
      setting: { reviewDraftPrs: boolean | null };
    };
    expect(json.setting.reviewDraftPrs).toBeNull();
  });

  it("DELETE clears the override fenced to the active org", async () => {
    const res = await DELETE(putReq({ blockTolerance: "error" }), { params });
    expect(res.status).toBe(200);
    expect(removeRepoReviewSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        repoFullName: "acme/widgets",
      }),
    );
    const json = (await res.json()) as { removed: boolean };
    expect(json.removed).toBe(true);
  });

  it("PUT with expectedUpdatedAt:null passes the first-write absence fence to the model", async () => {
    const res = await PUT(
      putReq({ supersedePolicy: "newest-wins", expectedUpdatedAt: null }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(upsertRepoReviewSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        expectAbsentSupersedeOverride: true,
        expectedUpdatedAt: undefined,
      }),
    );
  });

  it("DELETE 409 on a lost CAS race carries currentUpdatedAt — the same body shape as PUT", async () => {
    const current = new Date("2026-08-25T18:00:00.000Z");
    vi.mocked(removeRepoReviewSetting).mockResolvedValue({
      removed: false,
      conflict: true,
    });
    vi.mocked(getRepoReviewSetting).mockResolvedValue({
      id: "rrs_1",
      organizationId: ORG,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
      reviewDraftPrs: true,
      trustedAuthorThreshold: null,
      egressPolicy: null,
      egressAllowlist: null,
      supersedePolicy: null,
      recheckOnComplete: false,
      updatedByUserId: USER,
      createdAt: current,
      updatedAt: current,
    });
    const res = await DELETE(
      new NextRequest(
        "http://localhost/api/review-settings/acme/widgets?expectedUpdatedAt=2026-08-25T17:00:00.000Z",
        { method: "DELETE" },
      ),
      { params },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "conflict",
      currentUpdatedAt: current.toISOString(),
    });
  });

  it("DELETE is 401 when unauthenticated", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    const res = await DELETE(putReq({ blockTolerance: "error" }), { params });
    expect(res.status).toBe(401);
    expect(removeRepoReviewSetting).not.toHaveBeenCalled();
  });
});
