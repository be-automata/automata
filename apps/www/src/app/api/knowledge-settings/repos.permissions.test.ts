import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { GET } from "./route";
import { POST as RETRY } from "./retry/route";
import { POST as DIAGNOSE } from "./diagnose/route";
import { db } from "@/lib/db";
import { getTenantContextOrNull, isPlatformAdmin } from "@/lib/auth-server";
import {
  createTestUser,
  createTestOrganization,
} from "@terragon/shared/model/test-helpers";
import { recordKnowledgePush } from "@terragon/shared/model/knowledge-repo-status";
import { listKnowledgeAdminActions } from "@terragon/shared/model/knowledge-admin-log";
import { addOrganizationMember } from "@terragon/shared/model/organizations";
import * as schema from "@terragon/shared/db/schema";
import {
  GithubDeliveriesError,
  listRepoWebhookDeliveries,
} from "@/server-lib/knowledge/github-deliveries";

vi.mock("@/lib/auth-server", () => ({
  getTenantContextOrNull: vi.fn(),
  isPlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));
vi.mock("@/server-lib/knowledge/github-deliveries", async () => {
  const actual = await vi.importActual<
    typeof import("@/server-lib/knowledge/github-deliveries")
  >("@/server-lib/knowledge/github-deliveries");
  return { ...actual, listRepoWebhookDeliveries: vi.fn() };
});

const SHA = "a".repeat(40);

function post(handler: typeof RETRY, body: unknown) {
  return handler(
    new NextRequest("http://localhost/api/knowledge-settings/x", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("knowledge-settings repos, retry and diagnose (real DB)", () => {
  let userId: string;
  let orgId: string;

  async function actor(role: "owner" | "admin" | "member") {
    userId = (await createTestUser({ db })).user.id;
    orgId = (await createTestOrganization({ db, userId, role })).organization
      .id;
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId: orgId,
    });
  }

  /** A new user with `role` in an existing org, made the session actor. */
  async function joinAs(organizationId: string, role: "admin" | "member") {
    userId = (await createTestUser({ db })).user.id;
    await addOrganizationMember({ db, organizationId, userId, role });
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId,
    });
  }

  async function seedFailedIntent(
    organizationId: string,
    repoFullName = "acme/repo",
  ) {
    const { intentId } = await recordKnowledgePush({
      db,
      organizationId,
      repoFullName,
      defaultBranch: "main",
      targetSha: SHA,
    });
    await db
      .update(schema.knowledgeIntent)
      .set({ state: "failed", attempts: 8, lastErrorCode: "fetch_failed" })
      .where(eq(schema.knowledgeIntent.id, intentId));
    return intentId;
  }

  const intentState = async (id: string) =>
    (
      await db
        .select()
        .from(schema.knowledgeIntent)
        .where(eq(schema.knowledgeIntent.id, id))
    )[0];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPlatformAdmin).mockResolvedValue(false);
  });

  it("GET gives a member the repo rows of their own org only, with no GitHub call", async () => {
    await actor("owner");
    const mine = orgId;
    const failedId = await seedFailedIntent(mine);
    await actor("owner");
    await seedFailedIntent(orgId, "other/repo");
    await joinAs(mine, "member");
    const body = await (await GET()).json();
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]).toMatchObject({
      repoFullName: "acme/repo",
      pending: true,
      latestIntent: {
        id: failedId,
        state: "failed",
        attempts: 8,
        lastErrorCode: "fetch_failed",
      },
    });
    expect(typeof body.repos[0].lastPushAt).toBe("string");
    expect(listRepoWebhookDeliveries).not.toHaveBeenCalled();
  });

  describe("retry", () => {
    it("401 without a session, 400 without an org", async () => {
      vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
      expect((await post(RETRY, { intentId: "x" })).status).toBe(401);
      vi.mocked(getTenantContextOrNull).mockResolvedValue({
        userId: "u",
        organizationId: null,
      });
      expect((await post(RETRY, { intentId: "x" })).status).toBe(400);
    });

    it("a member gets 403 and the intent stays failed", async () => {
      await actor("owner");
      const id = await seedFailedIntent(orgId);
      await joinAs(orgId, "member");
      expect((await post(RETRY, { intentId: id })).status).toBe(403);
      expect((await intentState(id))?.state).toBe("failed");
    });

    it("an org admin retries: pending, attempts 0, one intent_retry log row", async () => {
      await actor("admin");
      const id = await seedFailedIntent(orgId);
      const res = await post(RETRY, { intentId: id });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: "retried" });
      const row = await intentState(id);
      expect(row?.state).toBe("pending");
      expect(row?.attempts).toBe(0);
      const log = (
        await listKnowledgeAdminActions({ db, organizationId: orgId })
      ).filter((a) => a.action === "intent_retry");
      expect(log).toHaveLength(1);
      expect(log[0]?.target).toEqual({ targetSha: SHA, attemptsWas: 8 });
    });

    it("a platform admin who is not a member may retry", async () => {
      await actor("owner");
      const id = await seedFailedIntent(orgId);
      const org = orgId;
      userId = (await createTestUser({ db })).user.id;
      vi.mocked(getTenantContextOrNull).mockResolvedValue({
        userId,
        organizationId: org,
      });
      vi.mocked(isPlatformAdmin).mockResolvedValue(true);
      expect((await post(RETRY, { intentId: id })).status).toBe(200);
    });

    it("foreign, unknown and non-failed ids give the same 404", async () => {
      await actor("owner");
      const foreignId = await seedFailedIntent(orgId);
      await actor("owner");
      const processedId = await seedFailedIntent(orgId, "acme/ok");
      await db
        .update(schema.knowledgeIntent)
        .set({ state: "processed" })
        .where(eq(schema.knowledgeIntent.id, processedId));
      const bodies = [];
      for (const intentId of [foreignId, "nope", processedId]) {
        const res = await post(RETRY, { intentId });
        expect(res.status).toBe(404);
        bodies.push(await res.json());
      }
      expect(bodies).toEqual([
        { error: "Not found" },
        { error: "Not found" },
        { error: "Not found" },
      ]);
      expect((await intentState(foreignId))?.state).toBe("failed");
    });
  });

  describe("diagnose", () => {
    it("a member gets 403 and GitHub is not called", async () => {
      await actor("owner");
      await seedFailedIntent(orgId);
      await joinAs(orgId, "member");
      expect((await post(DIAGNOSE, { repoFullName: "acme/repo" })).status).toBe(
        403,
      );
      expect(listRepoWebhookDeliveries).not.toHaveBeenCalled();
    });

    it("an admin gets 404 for a repo that is not onboarded", async () => {
      await actor("admin");
      expect((await post(DIAGNOSE, { repoFullName: "globex/y" })).status).toBe(
        404,
      );
      expect(listRepoWebhookDeliveries).not.toHaveBeenCalled();
    });

    it("an admin gets delivery metadata for an onboarded repo", async () => {
      await actor("admin");
      await seedFailedIntent(orgId);
      const deliveries = [
        {
          guid: "g",
          event: "push",
          action: null,
          statusCode: 200,
          deliveredAt: "2026-10-01T00:00:00Z",
          redelivery: false,
        },
      ];
      vi.mocked(listRepoWebhookDeliveries).mockResolvedValue(deliveries);
      const res = await post(DIAGNOSE, { repoFullName: "Acme/Repo" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deliveries });
      expect(listRepoWebhookDeliveries).toHaveBeenCalledWith({
        repoFullName: "acme/repo",
      });
    });

    it("502 github_unavailable when the App call fails", async () => {
      await actor("admin");
      await seedFailedIntent(orgId);
      vi.mocked(listRepoWebhookDeliveries).mockRejectedValue(
        new GithubDeliveriesError("github_unavailable"),
      );
      const res = await post(DIAGNOSE, { repoFullName: "acme/repo" });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "github_unavailable" });
    });
  });
});
