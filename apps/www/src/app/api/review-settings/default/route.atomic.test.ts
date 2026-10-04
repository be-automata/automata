import { describe, it, vi, expect } from "vitest";
import { NextRequest } from "next/server";
import { PUT } from "./route";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import {
  createTestUser,
  createTestOrganization,
} from "@terragon/shared/model/test-helpers";
import {
  getRepoReviewSetting,
  ORG_DEFAULT_REPO_SENTINEL,
} from "@terragon/shared/model/repo-review-settings";

vi.mock("@/lib/auth-server", () => ({ getTenantContextOrNull: vi.fn() }));
// The actor-log insert fails; the settings write in the same transaction must
// roll back with it (real Postgres, no mock of the settings model).
vi.mock("@terragon/shared/model/self-heal-admin-log", async (importActual) => ({
  ...(await importActual<
    typeof import("@terragon/shared/model/self-heal-admin-log")
  >()),
  recordSelfHealAdminAction: vi.fn(async () => {
    throw new Error("admin-log insert failed");
  }),
}));

describe("/api/review-settings/default — settings write and actor log are atomic", () => {
  it("a failed actor-log insert leaves the kill switch unapplied", async () => {
    const userId = (await createTestUser({ db })).user.id;
    const org = await createTestOrganization({ db, userId, role: "admin" });
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId: org.organization.id,
    });

    await expect(
      PUT(
        new NextRequest("http://localhost/api/review-settings/default", {
          method: "PUT",
          body: JSON.stringify({ selfHealKillSwitch: true }),
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("admin-log insert failed");

    const row = await getRepoReviewSetting({
      db,
      organizationId: org.organization.id,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    expect(row?.selfHealKillSwitch ?? null).toBeNull();
  });
});
