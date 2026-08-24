import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
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

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/review-settings/default", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("/api/review-settings/default (#125 C6 org default)", () => {
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

  beforeEach(() => vi.clearAllMocks());

  it("PUT from a non-admin member → 403 with human copy (AC1)", async () => {
    await actor("member");
    const res = await put({ supersedePolicy: "complete-run-discard" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /organization admins/i,
    );
  });

  it("no active org → 400 with human copy", async () => {
    userId = (await createTestUser({ db })).user.id;
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId: null,
    });
    const res = await put({ supersedePolicy: "newest-wins" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /organization/i,
    );
  });

  it("an org admin writes the sentinel row; GET round-trips it; the resolver default stays untouched for other orgs", async () => {
    await actor("admin");
    const res = await put({
      supersedePolicy: "complete-run-discard",
      recheckOnComplete: true,
    });
    expect(res.status).toBe(200);
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    expect(row?.supersedePolicy).toBe("complete-run-discard");
    expect(row?.recheckOnComplete).toBe(true);
    const got = await GET();
    expect(
      ((await got.json()) as { setting: { supersedePolicy: string } }).setting
        .supersedePolicy,
    ).toBe("complete-run-discard");
  });

  it("conflict: a stale expectedUpdatedAt → 409 and no overwrite (AC3)", async () => {
    await actor("owner");
    await put({ supersedePolicy: "newest-wins" });
    const current = (await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    }))!.updatedAt;
    const res = await put({
      supersedePolicy: "app-side",
      expectedUpdatedAt: new Date(current.getTime() - 60_000).toISOString(),
    });
    expect(res.status).toBe(409);
    expect(
      (
        await getRepoReviewSetting({
          db,
          organizationId: orgId,
          repoFullName: ORG_DEFAULT_REPO_SENTINEL,
        })
      )?.supersedePolicy,
    ).toBe("newest-wins");
  });

  it("unknown policy → 400, never stored", async () => {
    await actor("admin");
    expect((await put({ supersedePolicy: "yolo" })).status).toBe(400);
  });
});
