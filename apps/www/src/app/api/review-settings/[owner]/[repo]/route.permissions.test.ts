import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { PUT, DELETE } from "./route";
import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { checkRepoAdmin } from "@/lib/repo-admin";
import {
  createTestUser,
  createTestOrganization,
} from "@terragon/shared/model/test-helpers";
import {
  getRepoReviewSetting,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";

vi.mock("@/lib/auth-server", () => ({ getTenantContextOrNull: vi.fn() }));
vi.mock("@/lib/repo-admin", () => ({ checkRepoAdmin: vi.fn() }));

const REPO = "acme/widgets";
const params = Promise.resolve({ owner: "acme", repo: "widgets" });

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/review-settings/acme/widgets", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params },
  );
}

/**
 * #125 C6 two-level permission + optimistic concurrency on the per-repo
 * write path (all three settings of the family) — real DB, real role rows.
 */
describe("PUT/DELETE /api/review-settings/[owner]/[repo] — permissions + conflict", () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRepoAdmin).mockResolvedValue("not-admin");
  });

  it("a plain member is 403'd with human copy; a repo admin CAN override their repo (AC1)", async () => {
    await actor("member");
    let res = await put({ supersedePolicy: "complete-run-queue" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /organization admins or admins of this repository/i,
    );
    // GitHub says they administer the repo → allowed.
    vi.mocked(checkRepoAdmin).mockResolvedValue("admin");
    res = await put({ supersedePolicy: "complete-run-queue" });
    expect(res.status).toBe(200);
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
    });
    expect(row?.supersedePolicy).toBe("complete-run-queue");
  });

  it("an org admin writes without any GitHub lookup", async () => {
    await actor("admin");
    const res = await put({ blockTolerance: "error" });
    expect(res.status).toBe(200);
    expect(checkRepoAdmin).not.toHaveBeenCalled();
  });

  it("a failed GitHub lookup is fail-closed 403 with 'try again' copy", async () => {
    await actor("member");
    vi.mocked(checkRepoAdmin).mockResolvedValue("lookup-failed");
    const res = await put({ reviewDraftPrs: false });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /couldn't verify your permission on GitHub/i,
    );
  });

  it("DELETE is gated the same way", async () => {
    await actor("member");
    const res = await DELETE(
      new NextRequest("http://localhost/api/review-settings/acme/widgets", {
        method: "DELETE",
      }),
      { params },
    );
    expect(res.status).toBe(403);
  });

  it("optimistic concurrency: a stale expectedUpdatedAt gets 409 with currentUpdatedAt, never last-write-wins (AC3)", async () => {
    await actor("owner");
    const first = await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { supersedePolicy: "newest-wins" },
    });
    // Second writer read BEFORE first's save.
    const stale = new Date(first.updatedAt.getTime() - 60_000).toISOString();
    const res = await put({
      supersedePolicy: "app-side",
      expectedUpdatedAt: stale,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      currentUpdatedAt: string;
    };
    expect(body.error).toBe("conflict");
    expect(body.currentUpdatedAt).toBe(first.updatedAt.toISOString());
    // The stored value was NOT overwritten.
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
    });
    expect(row?.supersedePolicy).toBe("newest-wins");
    // A fresh expectedUpdatedAt succeeds.
    const ok = await put({
      supersedePolicy: "app-side",
      expectedUpdatedAt: first.updatedAt.toISOString(),
    });
    expect(ok.status).toBe(200);
  });

  it("two CONCURRENT writers holding the same version: exactly one wins, the other gets 409 (DB-level CAS, not read-then-write)", async () => {
    await actor("owner");
    const first = await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { supersedePolicy: "newest-wins" },
    });
    const v = first.updatedAt.toISOString();
    const [a, b] = await Promise.all([
      put({ supersedePolicy: "app-side", expectedUpdatedAt: v }),
      put({ supersedePolicy: "complete-run-queue", expectedUpdatedAt: v }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
    });
    const winner = a.status === 200 ? "app-side" : "complete-run-queue";
    expect(row?.supersedePolicy).toBe(winner);
  });

  it("DELETE (tolerance Reset) never wipes the repo's supersede override — the row is kept with tolerance at defaults", async () => {
    await actor("owner");
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { blockTolerance: "error", supersedePolicy: "app-side" },
    });
    const res = await DELETE(
      new NextRequest("http://localhost/api/review-settings/acme/widgets", {
        method: "DELETE",
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
    });
    expect(row?.supersedePolicy).toBe("app-side");
    expect(row?.blockTolerance).toBe("warning");
  });
});
