import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { getTenantContextOrNull } from "@/lib/auth-server";
import { auditFixAttempts, auditRuns } from "@terragon/shared/db/schema";
import {
  createAuditRunAtDispatch,
  insertFinding,
} from "@terragon/shared/model/audit-findings";
import { recordSelfHealAdminAction } from "@terragon/shared/model/self-heal-admin-log";
import { recordAdmissionDeferral } from "@terragon/shared/model/self-heal-slot";
import {
  createTestOrganization,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { GET } from "./route";

vi.mock("@/lib/auth-server", () => ({ getTenantContextOrNull: vi.fn() }));
vi.mock("@/server-lib/audit/fix-trigger-logins", () => ({
  resolveFixTriggerLogins: vi.fn(async () => [
    "automata-app[bot]",
    "repo-owner",
  ]),
}));

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

  it("activity and export carry the same metrics and a timeline of the 20 newest attempts", async () => {
    await actor("admin");
    const finding = await insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: "eeeeeeeeeeeeeeee",
        audit: "security",
        ruleId: "R2",
        severity: "high",
        checkKind: "script",
        title: "finding e",
      },
    });
    const base = Date.UTC(2026, 8, 1);
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    const mergedBy = ["automata-app[bot]", "Repo-Owner", "a-reviewer"];
    // 3 merged (bot, owner, a reviewer), 1 expired, then 18 counted closes.
    for (let i = 0; i < 22; i++) {
      const isMerged = i < 3;
      await db.insert(auditFixAttempts).values({
        organizationId: orgId,
        repoFullName: REPO,
        findingId: finding.id,
        attemptNo: i + 1,
        phase: "closed",
        prNumber: 100 + i,
        prState: isMerged ? "merged" : i === 3 ? "expired" : "closed",
        claimedAt: at(i * 10),
        checkReportedAt: at(i * 10 + 1),
        prOpenedAt: at(i * 10 + 2),
        ciStatus: "passed",
        ciEvaluatedAt: at(i * 10 + 3),
        ciResults: {
          gateSource: i === 21 ? "all-checks" : "protection",
        },
        readyAt: at(i * 10 + 4),
        mergedAt: isMerged ? at(i * 10 + 5) : null,
        mergedBy: isMerged ? mergedBy[i] : null,
        humanCommitCount: isMerged ? (i === 2 ? 1 : 0) : null,
        infraRefunded: i === 20,
        gateTokenHash: "gate-secret-hash",
        createdAt: at(i * 10),
      });
    }
    await recordAdmissionDeferral({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      reason: "review_in_flight",
    });

    interface Metrics {
      prsOpened: number;
      merged: number;
      mergedByNonTrigger: number;
      mergeRate: number | null;
      humanEditRatio: number | null;
      expiredRate: number | null;
      refunded: number;
      counted: number;
      admissionDeferrals: number;
      mergeRateBasis: string;
      reopenRate: number | null;
    }
    interface TimelineEntry {
      attemptNo: number;
      prUrl: string | null;
      gateSource: string | null;
      steps: Record<string, string | null>;
    }
    const activity = (await (await get()).json()) as {
      metrics: Metrics;
      attemptTimeline: TimelineEntry[];
    };
    const exportText = await (await get("?format=export")).text();
    expect(exportText).not.toMatch(/token_?hash/i);
    expect(exportText).not.toContain("gate-secret-hash");
    const exported = JSON.parse(exportText) as {
      metrics: Metrics;
      attempts: unknown[];
    };

    expect(activity.metrics).toEqual(exported.metrics);
    expect(exported.attempts).toHaveLength(22);
    expect(activity.metrics).toMatchObject({
      prsOpened: 22,
      merged: 3,
      mergedByNonTrigger: 1,
      mergeRate: 1 / 22,
      humanEditRatio: 1 / 3,
      expiredRate: 1 / 22,
      refunded: 1,
      counted: 21,
      admissionDeferrals: 1,
      mergeRateBasis: "bot-and-owner",
      reopenRate: null,
    });

    expect(activity.attemptTimeline).toHaveLength(20);
    const newest = activity.attemptTimeline[0]!;
    expect(newest.attemptNo).toBe(22);
    expect(newest.prUrl).toBe(`https://github.com/${REPO}/pull/121`);
    expect(newest.gateSource).toBe("all-checks");
    expect(newest.steps).toMatchObject({
      claim: at(210).toISOString(),
      check: at(211).toISOString(),
      draft: at(212).toISOString(),
      ci: at(213).toISOString(),
      ready: at(214).toISOString(),
      merged: null,
    });
    expect(newest.steps.closed).not.toBeNull();
    expect(activity.attemptTimeline.map((e) => e.attemptNo)).not.toContain(1);
  });
});
