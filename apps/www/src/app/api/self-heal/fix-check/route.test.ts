import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { waitUntil } from "@/lib/wait-until";
import { openDraftFixPr } from "@/server-lib/audit/open-fix-pr";
import {
  hashSelfHealToken,
  mintSelfHealToken,
} from "@/server-lib/audit/plan-self-heal-run";
import { auditFixAttempts } from "@terragon/shared/db/schema";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  bindFixAttemptThread,
  claimFixAttempt,
  refundFixAttempt,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { POST } from "./route";

vi.mock("@/server-lib/audit/open-fix-pr", () => ({
  openDraftFixPr: vi.fn(async () => "draft_opened"),
}));

const REPO = "acme/widgets";
const SHA = "a".repeat(40);

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/self-heal/fix-check", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/self-heal/fix-check", () => {
  let orgId: string;
  let attemptId: string;
  let token: string;

  const report = (over: Record<string, unknown> = {}) => ({
    attemptId,
    workerStatus: "completed",
    headSha: SHA,
    checkOutcome: "pass",
    deniedPaths: [],
    ...over,
  });

  const post = (body: unknown, tokenValue: string | null = token) =>
    POST(
      req(
        body,
        tokenValue === null ? {} : { "x-self-heal-gate-token": tokenValue },
      ),
    );

  const stored = async () => {
    const [row] = await db
      .select()
      .from(auditFixAttempts)
      .where(eq(auditFixAttempts.id, attemptId));
    if (!row) throw new Error("attempt vanished");
    return row;
  };

  const setToken = (expiresAt: Date) =>
    updateFixAttempt({
      db,
      organizationId: orgId,
      id: attemptId,
      patch: {
        gateTokenHash: hashSelfHealToken(token),
        gateTokenExpiresAt: expiresAt,
      },
    });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(waitUntil).mockClear();
    vi.mocked(openDraftFixPr).mockClear();
    const user = (await createTestUser({ db })).user;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    const finding = await insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: "0123456789abcdef",
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: "Lockfile missing",
        subject: "pnpm-lock.yaml",
        status: "open",
        issueNumber: 42,
        autoFixLabeled: true,
        fixReadyAt: new Date(Date.now() - 60_000),
      },
    });
    const claimed = await claimFixAttempt({
      db,
      organizationId: orgId,
      findingId: finding.id,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor: (n) => `automata/fix-42-01234567-a${n}`,
    });
    if (!claimed) throw new Error("claim failed");
    attemptId = claimed.attempt.id;
    const threadId = (await createTestThread({ db, userId: user.id })).threadId;
    await bindFixAttemptThread({
      db,
      organizationId: orgId,
      attemptId,
      threadId,
    });
    token = mintSelfHealToken();
    await setToken(new Date(Date.now() + 60 * 60 * 1000));
  });

  describe("authentication", () => {
    it("a missing, wrong or expired token gets the same 401 body and records nothing", async () => {
      const missing = await post(report(), null);
      const wrong = await post(report(), mintSelfHealToken());
      const short = await post(report(), "x");
      await setToken(new Date(Date.now() - 1000));
      const expired = await post(report());
      const bodies = await Promise.all(
        [missing, wrong, short, expired].map(async (res) => {
          expect(res.status).toBe(401);
          return res.text();
        }),
      );
      expect(new Set(bodies).size).toBe(1);
      expect((await stored()).checkReportedAt).toBeNull();
    });

    it("R6: an unknown attempt gets the same 401 as a wrong token (no existence oracle)", async () => {
      const unknown = await post(report({ attemptId: randomUUID() }));
      const wrong = await post(report(), mintSelfHealToken());
      expect(unknown.status).toBe(401);
      expect(await unknown.text()).toBe(await wrong.text());
    });

    it("R6: attempt A's token presented for attempt B → 401, nothing recorded on either", async () => {
      const finding = await insertFinding({
        db,
        organizationId: orgId,
        finding: {
          repoFullName: REPO,
          fingerprint: "fedcba9876543210",
          audit: "security-audit",
          ruleId: "supply.lockfile-missing",
          severity: "high",
          checkKind: "script",
          title: "Lockfile missing",
          subject: "pnpm-lock.yaml",
          status: "open",
          issueNumber: 43,
          autoFixLabeled: true,
          fixReadyAt: new Date(Date.now() - 60_000),
        },
      });
      const claimed = await claimFixAttempt({
        db,
        organizationId: orgId,
        findingId: finding.id,
        maxAttempts: 3,
        cooldownMin: 30,
        branchFor: (n) => `automata/fix-43-fedcba98-a${n}`,
      });
      if (!claimed) throw new Error("claim failed");
      const tokenB = mintSelfHealToken();
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: claimed.attempt.id,
        patch: {
          gateTokenHash: hashSelfHealToken(tokenB),
          gateTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const res = await post(report({ attemptId: claimed.attempt.id }), token);
      expect(res.status).toBe(401);
      const [b] = await db
        .select()
        .from(auditFixAttempts)
        .where(eq(auditFixAttempts.id, claimed.attempt.id));
      expect(b?.checkReportedAt).toBeNull();
      expect((await stored()).checkReportedAt).toBeNull();
      expect(vi.mocked(openDraftFixPr)).not.toHaveBeenCalled();
    });

    it("R6: after the gate token is rotated, the old token gets 401 and the new one records", async () => {
      const old = token;
      token = mintSelfHealToken();
      await setToken(new Date(Date.now() + 60 * 60 * 1000));
      expect((await post(report(), old)).status).toBe(401);
      expect((await stored()).checkReportedAt).toBeNull();
      expect((await post(report())).status).toBe(200);
      expect((await stored()).checkReportedAt).not.toBeNull();
    });

    it("an attempt without a stored token rejects every token", async () => {
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: { gateTokenHash: null, gateTokenExpiresAt: null },
      });
      expect((await post(report())).status).toBe(401);
    });
  });

  describe("validation", () => {
    it.each([
      ["a short headSha", { headSha: "abc" }],
      ["an uppercase headSha", { headSha: "A".repeat(40) }],
      ["51 denied paths", { deniedPaths: Array(51).fill("a") }],
      ["a 301-char denied path", { deniedPaths: ["a".repeat(301)] }],
      ["an unknown workerStatus", { workerStatus: "done" }],
      ["an unknown checkOutcome", { checkOutcome: "maybe" }],
      ["a non-uuid attemptId", { attemptId: "nope" }],
      ["completed without a headSha", { headSha: null }],
    ])("%s → 400", async (_label, over) => {
      expect((await post(report(over))).status).toBe(400);
      expect((await stored()).checkReportedAt).toBeNull();
    });

    it("a non-JSON body → 400", async () => {
      expect((await post("{not json")).status).toBe(400);
    });
  });

  describe("verdicts", () => {
    it("completed + pass + no denied path → passed, bound to the pushed sha", async () => {
      const log = vi.spyOn(console, "log");
      const res = await post(report());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true, status: "passed" });
      const row = await stored();
      expect(row.checkStatus).toBe("passed");
      expect(row.gatedHeadSha).toBe(SHA);
      expect(row.deniedPaths).toEqual([]);
      expect(row.checkReportedAt).toBeInstanceOf(Date);
      expect(row.phase).toBe("checking");
      expect(row.checkResults).toEqual({
        status: "passed",
        workerStatus: "completed",
        checkOutcome: "pass",
      });
      const lines = JSON.stringify(log.mock.calls);
      expect(lines).toContain(attemptId);
      expect(lines).toContain("passed");
      expect(lines).not.toContain(token);
    });

    it("completed + pass + a denied path → failed", async () => {
      const res = await post(report({ deniedPaths: ["AGENTS.md"] }));
      expect(await res.json()).toEqual({ recorded: true, status: "failed" });
      const row = await stored();
      expect(row.checkStatus).toBe("failed");
      expect(row.deniedPaths).toEqual(["AGENTS.md"]);
    });

    it("completed + fail → failed", async () => {
      const res = await post(report({ checkOutcome: "fail" }));
      expect(await res.json()).toEqual({ recorded: true, status: "failed" });
    });

    it("a check error → error (never a pass)", async () => {
      const res = await post(report({ checkOutcome: "error" }));
      expect(await res.json()).toEqual({ recorded: true, status: "error" });
      expect((await stored()).checkStatus).toBe("error");
    });

    it("no_branch → no_branch, stored as a counted failure", async () => {
      const res = await post(
        report({
          workerStatus: "no_branch",
          headSha: null,
          checkOutcome: null,
        }),
      );
      expect(await res.json()).toEqual({ recorded: true, status: "no_branch" });
      const row = await stored();
      expect(row.checkStatus).toBe("failed");
      expect(row.gatedHeadSha).toBeNull();
      expect(row.checkResults).toMatchObject({ status: "no_branch" });
    });

    it("aborted → aborted, stored as an error (refunded later)", async () => {
      const res = await post(
        report({ workerStatus: "aborted", headSha: null, checkOutcome: null }),
      );
      expect(await res.json()).toEqual({ recorded: true, status: "aborted" });
      const row = await stored();
      expect(row.checkStatus).toBe("error");
      expect(row.checkResults).toMatchObject({ status: "aborted" });
    });
  });

  describe("single use", () => {
    it("a second report is not recorded and does not overwrite the first", async () => {
      expect(await (await post(report())).json()).toEqual({
        recorded: true,
        status: "passed",
      });
      const second = await post(report({ checkOutcome: "fail" }));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({
        recorded: false,
        status: "failed",
      });
      expect((await stored()).checkStatus).toBe("passed");
    });

    it("a report for an attempt the reconcile already closed is not recorded", async () => {
      await refundFixAttempt({
        db,
        organizationId: orgId,
        attemptId,
        cause: "check_missing",
      });
      const res = await post(report());
      expect(await res.json()).toEqual({ recorded: false, status: "passed" });
      const row = await stored();
      expect(row.checkReportedAt).toBeNull();
      expect(row.phase).toBe("closed");
    });
  });

  describe("draft opener attachment (GATE-01)", () => {
    it("a recorded report schedules the opener exactly once, fenced by the attempt's org", async () => {
      await post(report());
      expect(vi.mocked(waitUntil)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openDraftFixPr)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openDraftFixPr).mock.calls[0]?.[0]).toMatchObject({
        organizationId: orgId,
        attemptId,
      });
    });

    it("a non-passing recorded report is handed to the opener too (it records the outcome)", async () => {
      await post(report({ checkOutcome: "fail" }));
      expect(vi.mocked(openDraftFixPr)).toHaveBeenCalledTimes(1);
    });

    it("a duplicate report does not schedule it again", async () => {
      await post(report());
      await post(report());
      expect(vi.mocked(waitUntil)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(openDraftFixPr)).toHaveBeenCalledTimes(1);
    });

    it("a rejected or unrecorded report schedules nothing", async () => {
      await post(report(), mintSelfHealToken());
      await post(report({ headSha: "abc" }));
      await refundFixAttempt({
        db,
        organizationId: orgId,
        attemptId,
        cause: "check_missing",
      });
      await post(report());
      expect(vi.mocked(waitUntil)).not.toHaveBeenCalled();
      expect(vi.mocked(openDraftFixPr)).not.toHaveBeenCalled();
    });
  });
});
