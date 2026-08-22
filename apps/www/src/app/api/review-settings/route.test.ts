import { describe, it, vi, beforeEach, expect } from "vitest";
import { GET } from "./route";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { listRepoReviewSettings } from "@terragon/shared/model/repo-review-settings";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
}));
vi.mock("@terragon/shared/model/repo-review-settings", () => ({
  listRepoReviewSettings: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));

const ORG = "org_1";
const USER = "user_1";

describe("GET /api/review-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: ORG,
    });
  });

  it("401 when unauthenticated", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns an empty set (not an error) when there is no active org", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: null,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { settings: unknown[] };
    expect(json.settings).toEqual([]);
    expect(listRepoReviewSettings).not.toHaveBeenCalled();
  });

  it("lists ONLY the active org's overrides, projected to the wire shape", async () => {
    vi.mocked(listRepoReviewSettings).mockResolvedValue([
      {
        id: "s1",
        organizationId: ORG,
        repoFullName: "acme/widgets",
        blockTolerance: "info",
        reviewDraftPrs: false,
        trustedAuthorThreshold: null,
        egressPolicy: null,
        egressAllowlist: null,
        updatedByUserId: USER,
        createdAt: new Date(),
        updatedAt: new Date("2026-07-20T00:00:00Z"),
      },
    ]);
    const res = await GET();
    expect(listRepoReviewSettings).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
    );
    const json = (await res.json()) as {
      settings: Array<{
        repoFullName: string;
        blockTolerance: string;
        reviewDraftPrs: boolean;
      }>;
    };
    expect(json.settings).toHaveLength(1);
    expect(json.settings[0]!.repoFullName).toBe("acme/widgets");
    expect(json.settings[0]!.blockTolerance).toBe("info");
    expect(json.settings[0]!.reviewDraftPrs).toBe(false);
  });
});
