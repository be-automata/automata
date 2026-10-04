import { describe, it, vi, beforeEach, expect } from "vitest";
import { GET } from "./route";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { parseSelfHealPatch } from "./review-settings-route-shared";
import { listRepoReviewSettings } from "@terragon/shared/model/repo-review-settings";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
}));
vi.mock(
  "@terragon/shared/model/repo-review-settings",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    listRepoReviewSettings: vi.fn(),
  }),
);
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
        supersedePolicy: null,
        recheckOnComplete: false,
        reviewMode: null,
        reviewBatteries: null,
        reviewRunTests: null,
        reviewCommandTimeoutS: null,
        reviewMaxTurns: null,
        taskBatteries: null,
        selfHealMode: null,
        selfHealKillSwitch: null,
        selfHealMaxOpenIssues: null,
        selfHealMaxAttempts: null,
        selfHealCooldownMin: null,
        selfHealMinSeverity: null,
        selfHealAbsentAudits: null,
        selfHealAutoLabel: null,
        selfHealMaxDiffLines: null,
        selfHealPrExpiryDays: null,
        selfHealRunWindow: null,
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

  it("phase 4: lists a repo row that carries only review-agent overrides, with the five fields", async () => {
    vi.mocked(listRepoReviewSettings).mockResolvedValue([
      {
        id: "s2",
        organizationId: ORG,
        repoFullName: "acme/agents",
        blockTolerance: "warning",
        reviewDraftPrs: null,
        trustedAuthorThreshold: null,
        egressPolicy: null,
        egressAllowlist: null,
        supersedePolicy: null,
        recheckOnComplete: false,
        reviewMode: "orchestrated",
        reviewBatteries: ["somnio-review"],
        reviewRunTests: true,
        reviewCommandTimeoutS: 120,
        reviewMaxTurns: 30,
        taskBatteries: null,
        selfHealMode: null,
        selfHealKillSwitch: null,
        selfHealMaxOpenIssues: null,
        selfHealMaxAttempts: null,
        selfHealCooldownMin: null,
        selfHealMinSeverity: null,
        selfHealAbsentAudits: null,
        selfHealAutoLabel: null,
        selfHealMaxDiffLines: null,
        selfHealPrExpiryDays: null,
        selfHealRunWindow: null,
        updatedByUserId: USER,
        createdAt: new Date(),
        updatedAt: new Date("2026-10-03T00:00:00Z"),
      },
    ]);
    const res = await GET();
    const json = (await res.json()) as {
      settings: Array<Record<string, unknown>>;
    };
    expect(json.settings).toHaveLength(1);
    expect(json.settings[0]).toMatchObject({
      repoFullName: "acme/agents",
      reviewMode: "orchestrated",
      reviewBatteries: ["somnio-review"],
      reviewRunTests: true,
      reviewCommandTimeoutS: 120,
      reviewMaxTurns: 30,
    });
  });

  it("phase 7: lists a repo row that carries only task packs, with taskBatteries", async () => {
    vi.mocked(listRepoReviewSettings).mockResolvedValue([
      {
        id: "s3",
        organizationId: ORG,
        repoFullName: "acme/tasks",
        blockTolerance: "warning",
        reviewDraftPrs: null,
        trustedAuthorThreshold: null,
        egressPolicy: null,
        egressAllowlist: null,
        supersedePolicy: null,
        recheckOnComplete: false,
        reviewMode: null,
        reviewBatteries: null,
        reviewRunTests: null,
        reviewCommandTimeoutS: null,
        reviewMaxTurns: null,
        taskBatteries: ["somnio-skills"],
        selfHealMode: null,
        selfHealKillSwitch: null,
        selfHealMaxOpenIssues: null,
        selfHealMaxAttempts: null,
        selfHealCooldownMin: null,
        selfHealMinSeverity: null,
        selfHealAbsentAudits: null,
        selfHealAutoLabel: null,
        selfHealMaxDiffLines: null,
        selfHealPrExpiryDays: null,
        selfHealRunWindow: null,
        updatedByUserId: USER,
        createdAt: new Date(),
        updatedAt: new Date("2026-10-04T00:00:00Z"),
      },
    ]);
    const res = await GET();
    const json = (await res.json()) as {
      settings: Array<Record<string, unknown>>;
    };
    expect(json.settings[0]).toMatchObject({
      repoFullName: "acme/tasks",
      taskBatteries: ["somnio-skills"],
    });
  });
});

describe("parseSelfHealPatch (phase 8)", () => {
  async function errorOf(
    result: ReturnType<typeof parseSelfHealPatch>,
  ): Promise<string> {
    if (!("errorResponse" in result)) throw new Error("expected a 400");
    expect(result.errorResponse.status).toBe(400);
    return ((await result.errorResponse.json()) as { error: string }).error;
  }

  it("copies exactly the present self-heal keys", () => {
    const result = parseSelfHealPatch(
      { selfHealMode: "dry-run", selfHealMaxAttempts: 2, blockTolerance: "x" },
      { isOrgDefaultRow: false },
    );
    expect(result).toEqual({
      patch: { selfHealMode: "dry-run", selfHealMaxAttempts: 2 },
    });
  });

  it("accepts null (clear) and a wrap-around run window", () => {
    expect(
      parseSelfHealPatch(
        { selfHealMode: null, selfHealRunWindow: "22:00-04:00" },
        { isOrgDefaultRow: false },
      ),
    ).toEqual({
      patch: { selfHealMode: null, selfHealRunWindow: "22:00-04:00" },
    });
  });

  it("400 naming the field for an invalid value", async () => {
    const error = await errorOf(
      parseSelfHealPatch({ selfHealMode: "auto" }, { isOrgDefaultRow: false }),
    );
    expect(error).toContain("selfHealMode");
  });

  it("400 for the kill switch on a per-repo row, ok on the org default", async () => {
    const error = await errorOf(
      parseSelfHealPatch(
        { selfHealKillSwitch: true },
        { isOrgDefaultRow: false },
      ),
    );
    expect(error).toContain("selfHealKillSwitch");
    expect(
      parseSelfHealPatch(
        { selfHealKillSwitch: true },
        { isOrgDefaultRow: true },
      ),
    ).toEqual({ patch: { selfHealKillSwitch: true } });
  });

  it("rejects any gate-commands key as unknown", async () => {
    const error = await errorOf(
      parseSelfHealPatch(
        { selfHealGateCommands: [] },
        { isOrgDefaultRow: true },
      ),
    );
    expect(error).toMatch(/unknown field/);
  });
});

describe("GET /api/review-settings self-heal fields (phase 8)", () => {
  it("returns the self-heal fields on each row DTO", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId: USER,
      organizationId: ORG,
    });
    vi.mocked(listRepoReviewSettings).mockResolvedValue([
      {
        id: "s4",
        organizationId: ORG,
        repoFullName: "acme/heal",
        blockTolerance: "warning",
        reviewDraftPrs: null,
        trustedAuthorThreshold: null,
        egressPolicy: null,
        egressAllowlist: null,
        supersedePolicy: null,
        recheckOnComplete: false,
        reviewMode: null,
        reviewBatteries: null,
        reviewRunTests: null,
        reviewCommandTimeoutS: null,
        reviewMaxTurns: null,
        taskBatteries: null,
        selfHealMode: "dry-run",
        selfHealKillSwitch: null,
        selfHealMaxOpenIssues: null,
        selfHealMaxAttempts: 2,
        selfHealCooldownMin: null,
        selfHealMinSeverity: null,
        selfHealAbsentAudits: null,
        selfHealAutoLabel: null,
        selfHealMaxDiffLines: null,
        selfHealPrExpiryDays: null,
        selfHealRunWindow: "22:00-04:00",
        updatedByUserId: USER,
        createdAt: new Date(),
        updatedAt: new Date("2026-10-04T00:00:00Z"),
      },
    ]);
    const res = await GET();
    const json = (await res.json()) as {
      settings: Array<Record<string, unknown>>;
    };
    expect(json.settings[0]).toMatchObject({
      selfHealMode: "dry-run",
      selfHealMaxAttempts: 2,
      selfHealRunWindow: "22:00-04:00",
      selfHealKillSwitch: null,
    });
  });
});
