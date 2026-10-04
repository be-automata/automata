import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { auditRuns } from "@terragon/shared/db/schema";
import {
  createAuditRunAtDispatch,
  insertFinding,
} from "@terragon/shared/model/audit-findings";
import { recordSelfHealAdminAction } from "@terragon/shared/model/self-heal-admin-log";
import {
  createTestOrganization,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { GET } from "./route";

vi.mock("@/lib/auth-server", () => ({ getTenantContextOrNull: vi.fn() }));

const REPO = "acme/widgets";
const params = Promise.resolve({ owner: "acme", repo: "widgets" });

function get(query = ""): Promise<Response> {
  return GET(
    new NextRequest(`http://localhost/api/self-heal/acme/widgets${query}`),
    { params },
  );
}

describe("GET /api/self-heal/[owner]/[repo]", () => {
  let userId: string;
  let orgId: string;

  async function actor(role: "owner" | "admin" | "member") {
    userId = (await createTestUser({ db })).user.id;
    const org = await createTestOrganization({
      db,
      userId,
      name: `Org ${nanoid(6)}`,
      role,
    });
    orgId = org.organization.id;
    vi.mocked(getTenantContextOrNull).mockResolvedValue({
      userId,
      organizationId: orgId,
    });
  }

  async function seedRun(
    organizationId: string,
    createdAt: Date,
    fingerprints: string[],
    complete = true,
  ): Promise<string> {
    const { threadId } = await createTestThread({ db, userId });
    await createAuditRunAtDispatch({
      db,
      organizationId,
      repoFullName: REPO,
      threadId,
      audit: "security",
      checkTokenHash: "check-secret-hash",
    });
    const [row] = await db
      .update(auditRuns)
      .set({
        createdAt,
        complete,
        status: "done",
        decisions: fingerprints.map((fingerprint) => ({
          fingerprint,
          action: "sighting",
          reason: "seen",
        })),
      })
      .where(eq(auditRuns.threadId, threadId))
      .returning({ id: auditRuns.id });
    return row!.id;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401 when unauthenticated, 403 for a member", async () => {
    vi.mocked(getTenantContextOrNull).mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    await actor("member");
    expect((await get()).status).toBe(403);
  });

  it("admin gets the activity view: runs newest first (max 20), ledger, outbox, breakers, log, churn", async () => {
    await actor("admin");
    const r1 = await seedRun(orgId, new Date("2026-01-01T00:00:00Z"), [
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
      "cccccccccccccccc",
    ]);
    const r2 = await seedRun(orgId, new Date("2026-01-02T00:00:00Z"), [
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
      "dddddddddddddddd",
    ]);
    await insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: "aaaaaaaaaaaaaaaa",
        audit: "security",
        ruleId: "R1",
        severity: "high",
        checkKind: "script",
        title: "finding a",
      },
    });
    await recordSelfHealAdminAction({
      db,
      organizationId: orgId,
      actorUserId: userId,
      action: "settings_change",
      target: { repoFullName: REPO },
    });

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      effective: { mode: string; reason: string };
      runs: Array<{ id: string }>;
      findings: unknown[];
      outbox: {
        pending: number;
        failed: number;
        oldestPendingAt: string | null;
      };
      breakers: {
        repo: { loopAudit: { state: string }; loopFix: { state: string } };
        installation: unknown[];
      };
      adminLog: unknown[];
      churn: Array<{ fromRunId: string; toRunId: string; churn: number }>;
    };
    expect(typeof body.effective.mode).toBe("string");
    expect(typeof body.effective.reason).toBe("string");
    expect(body.runs.map((r) => r.id)).toEqual([r2, r1]);
    expect(body.findings).toHaveLength(1);
    expect(body.outbox).toEqual({
      pending: 0,
      failed: 0,
      oldestPendingAt: null,
    });
    expect(body.breakers.repo.loopAudit.state).toBe("closed");
    expect(body.breakers.repo.loopFix.state).toBe("closed");
    expect(body.adminLog).toHaveLength(1);
    expect(body.churn).toEqual([{ fromRunId: r1, toRunId: r2, churn: 0.5 }]);
    expect(JSON.stringify(body)).not.toContain("check-secret-hash");
  });

  it("caps runs at 20 and never returns another org's rows", async () => {
    await actor("owner");
    for (let i = 0; i < 22; i++) {
      await seedRun(orgId, new Date(Date.UTC(2026, 0, 1, 0, i)), ["x"]);
    }
    const other = await createTestOrganization({
      db,
      userId: (await createTestUser({ db })).user.id,
      name: `Other ${nanoid(6)}`,
    });
    const foreign = await seedRun(
      other.organization.id,
      new Date("2026-06-01T00:00:00Z"),
      ["y"],
    );
    const body = (await (await get()).json()) as {
      runs: Array<{ id: string }>;
    };
    expect(body.runs).toHaveLength(20);
    expect(body.runs.map((r) => r.id)).not.toContain(foreign);
  });

  it("?format=export carries plan_md and never a token hash; unknown format is 400", async () => {
    await actor("admin");
    await seedRun(orgId, new Date("2026-01-01T00:00:00Z"), [
      "aaaaaaaaaaaaaaaa",
    ]);
    await insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: "aaaaaaaaaaaaaaaa",
        audit: "security",
        ruleId: "R1",
        severity: "high",
        checkKind: "script",
        title: "finding a",
        planMd: "1. do the thing",
        acceptanceMd: "tests pass",
      },
    });
    const res = await get("?format=export");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("planMd");
    expect(text).toContain("1. do the thing");
    expect(text).not.toContain("check_token_hash");
    expect(text).not.toContain("gate_token_hash");
    expect(text).not.toContain("check-secret-hash");
    expect(text).not.toMatch(/token_?hash/i);
    const parsed = JSON.parse(text) as {
      repoFullName: string;
      runs: unknown[];
      effects: unknown[];
      attempts: unknown[];
    };
    expect(parsed.repoFullName).toBe(REPO);
    expect(parsed.runs).toHaveLength(1);

    expect((await get("?format=csv")).status).toBe(400);
  });
});
