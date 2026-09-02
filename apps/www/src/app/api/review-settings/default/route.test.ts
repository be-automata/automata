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

  it("first-write fence: two admins racing to CREATE the org default (expectedUpdatedAt:null) — exactly one 200, the other 409", async () => {
    await actor("admin");
    const [a, b] = await Promise.all([
      put({ supersedePolicy: "newest-wins", expectedUpdatedAt: null }),
      put({ supersedePolicy: "complete-run-discard", expectedUpdatedAt: null }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const stored = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    // The winner's choice stands — nothing was silently overwritten.
    expect(["newest-wins", "complete-run-discard"]).toContain(
      stored?.supersedePolicy,
    );
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
      supersedePolicy: "complete-run-discard",
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

  it("#165: the retired 'app-side' value → 400, never stored", async () => {
    await actor("admin");
    expect((await put({ supersedePolicy: "app-side" })).status).toBe(400);
  });

  it("unknown policy → 400, never stored", async () => {
    await actor("admin");
    expect((await put({ supersedePolicy: "yolo" })).status).toBe(400);
  });

  it("two CONCURRENT admins holding the same version: exactly one wins, the other gets 409", async () => {
    await actor("admin");
    await put({ supersedePolicy: "newest-wins" });
    const v = (await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    }))!.updatedAt.toISOString();
    const [a, b] = await Promise.all([
      put({ supersedePolicy: "complete-run-discard", expectedUpdatedAt: v }),
      put({ supersedePolicy: "complete-run-queue", expectedUpdatedAt: v }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe("/api/review-settings/default — reviewDraftPrs (org draft toggle)", () => {
  let userId: string;
  let orgId: string;

  // Same actor() as the describe above — re-declared because it writes THESE
  // describe-scoped ids; hoisting would share mutable state across suites.
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

  it("a draft-only PUT is accepted, round-trips on GET, and 403s for a member", async () => {
    await actor("admin");
    const res = await put({ reviewDraftPrs: false, expectedUpdatedAt: null });
    expect(res.status).toBe(200);
    const getRes = await GET();
    const json = (await getRes.json()) as {
      setting: { reviewDraftPrs: boolean } | null;
    };
    expect(json.setting?.reviewDraftPrs).toBe(false);

    await actor("member");
    expect((await put({ reviewDraftPrs: true })).status).toBe(403);
  });

  it("PUT reviewDraftPrs:null clears the org choice back to inherit (tri-state)", async () => {
    await actor("admin");
    const first = await put({ reviewDraftPrs: true, expectedUpdatedAt: null });
    expect(first.status).toBe(200);
    const v1 = ((await first.json()) as { setting: { updatedAt: string } })
      .setting.updatedAt;

    const cleared = await put({ reviewDraftPrs: null, expectedUpdatedAt: v1 });
    expect(cleared.status).toBe(200);
    expect(
      (
        (await cleared.json()) as {
          setting: { reviewDraftPrs: boolean | null };
        }
      ).setting.reviewDraftPrs,
    ).toBeNull();

    const getRes = await GET();
    const json = (await getRes.json()) as {
      setting: { reviewDraftPrs: boolean | null } | null;
    };
    expect(json.setting?.reviewDraftPrs).toBeNull();
  });

  it("non-boolean → 400, never stored", async () => {
    await actor("admin");
    expect((await put({ reviewDraftPrs: "nope" })).status).toBe(400);
    expect(
      await getRepoReviewSetting({
        db,
        organizationId: orgId,
        repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      }),
    ).toBeUndefined();
  });

  it("THE FENCE THE FAMILY CHECK MISSED: two draft-only first writes (expectedUpdatedAt:null ×2) — exactly one 200", async () => {
    // Draft-only writes leave supersede_policy NULL, so the old per-family
    // fence would have admitted both. The row-level fence must not.
    await actor("admin");
    const [a, b] = await Promise.all([
      put({ reviewDraftPrs: false, expectedUpdatedAt: null }),
      put({ reviewDraftPrs: true, expectedUpdatedAt: null }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("a draft write does not clobber a stored supersedePolicy, and vice versa", async () => {
    await actor("admin");
    const first = await put({
      supersedePolicy: "complete-run-queue",
      expectedUpdatedAt: null,
    });
    expect(first.status).toBe(200);
    const v1 = ((await first.json()) as { setting: { updatedAt: string } })
      .setting.updatedAt;

    const second = await put({
      reviewDraftPrs: false,
      expectedUpdatedAt: v1,
    });
    expect(second.status).toBe(200);
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    expect(row?.supersedePolicy).toBe("complete-run-queue");
    expect(row?.reviewDraftPrs).toBe(false);
  });

  it("stale expectedUpdatedAt on a draft write → 409, value untouched", async () => {
    await actor("admin");
    const first = await put({ reviewDraftPrs: false, expectedUpdatedAt: null });
    expect(first.status).toBe(200);
    const res = await put({
      reviewDraftPrs: true,
      expectedUpdatedAt: new Date(0).toISOString(),
    });
    expect(res.status).toBe(409);
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    expect(row?.reviewDraftPrs).toBe(false);
  });
});
