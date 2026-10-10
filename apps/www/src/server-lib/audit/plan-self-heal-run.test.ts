import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  auditFindings,
  auditFixAttempts,
  auditRuns,
} from "@terragon/shared/db/schema";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  bindFixAttemptThread,
  claimFixAttempt,
  refundFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { upsertFeatureFlag } from "@terragon/shared/model/feature-flags";
import type { DB } from "@terragon/shared/db";
import { upsertRepoReviewSetting } from "@terragon/shared/model/repo-review-settings";

import { fixBranchName } from "./fix-run-prompt";
import {
  deriveFixCheckStatus,
  hashSelfHealToken,
  mintSelfHealToken,
  planSelfHealAuditRun,
  planSelfHealFixRun,
  planSelfHealRun,
} from "./plan-self-heal-run";

const REPO = "acme/widgets";
const STAMP = {
  type: "automation-skill" as const,
  skillName: "audit-findings",
  contentSha: "sha",
  source: "db",
};

describe("planSelfHealAuditRun", () => {
  let orgId: string;
  let threadId: string;

  const plan = (sourceMetadata: unknown = STAMP) =>
    planSelfHealAuditRun({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId,
      sourceMetadata: sourceMetadata as never,
    });

  const finding = (fingerprint: string, over: Record<string, unknown> = {}) =>
    insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint,
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: `finding ${fingerprint}`,
        subject: "pnpm-lock.yaml",
        status: "open",
        ...over,
      },
    });

  const runRows = () =>
    db.select().from(auditRuns).where(eq(auditRuns.threadId, threadId));

  beforeEach(async () => {
    vi.restoreAllMocks();
    await upsertFeatureFlag({
      db,
      name: "selfHealLoop",
      updates: { defaultValue: false, globalOverride: true },
    });
    const user = (await createTestUser({ db })).user;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { selfHealMode: "dry-run" },
    });
    threadId = (await createTestThread({ db, userId: user.id })).threadId;
  });

  it("returns {} for an unstamped thread", async () => {
    expect(await plan(null)).toEqual({});
    expect(await plan({ ...STAMP, skillName: "other" })).toEqual({});
    expect(await runRows()).toHaveLength(0);
  });

  it("returns {} and creates no run when the effective mode is off", async () => {
    await upsertFeatureFlag({
      db,
      name: "selfHealLoop",
      updates: { defaultValue: false, globalOverride: false },
    });
    expect(await plan()).toEqual({});
    expect(await runRows()).toHaveLength(0);
  });

  it("lists script findings with their rule check kind and stores only the token hash", async () => {
    await finding("aaaaaaaaaaaaaaa1");
    await finding("aaaaaaaaaaaaaaa2", {
      ruleId: "files.gitignore-missing-pattern",
      subject: ".gitignore",
      findingKey: ".env",
    });
    await finding("aaaaaaaaaaaaaaa3", { checkKind: "rubric" });
    await finding("aaaaaaaaaaaaaaa4", { status: "suppressed" });
    await finding("aaaaaaaaaaaaaaa5", { status: "candidate" });

    const { selfHeal } = await plan();
    expect(selfHeal?.kind).toBe("audit");
    expect(selfHeal?.checkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(selfHeal?.checks.map((c) => c.fingerprint).sort()).toEqual([
      "aaaaaaaaaaaaaaa1",
      "aaaaaaaaaaaaaaa2",
      "aaaaaaaaaaaaaaa5",
    ]);
    expect(
      selfHeal?.checks.find((c) => c.fingerprint === "aaaaaaaaaaaaaaa2"),
    ).toEqual({
      fingerprint: "aaaaaaaaaaaaaaa2",
      check: "gitignore-has-pattern",
      subject: ".gitignore",
      key: ".env",
    });

    const rows = await runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("dispatched");
    expect(rows[0]?.requestedChecks).toEqual(selfHeal?.checks);
    expect(rows[0]?.checkTokenHash).toBe(
      hashSelfHealToken(selfHeal?.checkToken ?? ""),
    );
    expect(JSON.stringify(rows[0])).not.toContain(selfHeal?.checkToken ?? "?");
    const ttl = (rows[0]?.checkTokenExpiresAt?.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(44 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(45 * 60 * 1000);
  });

  it("caps the checks at 50, highest severity first", async () => {
    for (let i = 0; i < 60; i++) {
      await finding(i.toString(16).padStart(16, "0"), {
        severity: i < 5 ? "low" : "high",
      });
    }
    const { selfHeal } = await plan();
    expect(selfHeal?.checks).toHaveLength(50);
    const lowFps = new Set(
      Array.from({ length: 5 }, (_, i) => i.toString(16).padStart(16, "0")),
    );
    expect(selfHeal?.checks.some((c) => lowFps.has(c.fingerprint))).toBe(false);
  });

  it("never throws: a database failure yields {} and one warn line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await planSelfHealAuditRun({
      db: {} as DB,
      organizationId: orgId,
      repoFullName: REPO,
      threadId,
      sourceMetadata: STAMP,
    });
    expect(result).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "[hatchet] self-heal: audit planning failed",
    );
    expect(await runRows()).toHaveLength(0);
  });

  it("mints distinct 43-char tokens whose hash is sha256 hex", () => {
    const a = mintSelfHealToken();
    expect(a).toHaveLength(43);
    expect(a).not.toBe(mintSelfHealToken());
    expect(hashSelfHealToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("planSelfHealFixRun", () => {
  let orgId: string;
  let userId: string;
  let threadId: string;
  let findingId: string;
  let issueNumber: number;
  const FP = "0123456789abcdef";

  const fixStamp = (attemptId?: string) => ({
    type: "automation-skill" as const,
    skillName: "audit-fix",
    contentSha: "sha",
    source: "db",
    ...(attemptId !== undefined ? { selfHealAttemptId: attemptId } : {}),
  });

  const plan = (sourceMetadata: unknown, over: { db?: DB } = {}) =>
    planSelfHealFixRun({
      db: over.db ?? db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId,
      sourceMetadata: sourceMetadata as never,
      baseBranch: "main",
    });

  const claim = async () => {
    const claimed = await claimFixAttempt({
      db,
      organizationId: orgId,
      findingId,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor: (attemptNo) =>
        fixBranchName({ issueNumber, fingerprint: FP, attemptNo }),
    });
    if (!claimed) throw new Error("claim failed");
    return claimed.attempt;
  };

  const readAttempt = async (id: string) => {
    const [row] = await db
      .select()
      .from(auditFixAttempts)
      .where(eq(auditFixAttempts.id, id));
    if (!row) throw new Error("attempt vanished");
    return row;
  };

  const setMode = (patch: Record<string, unknown>, repo = REPO) =>
    upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: repo,
      patch: patch as never,
    });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await upsertFeatureFlag({
      db,
      name: "selfHealLoop",
      updates: { defaultValue: false, globalOverride: true },
    });
    userId = (await createTestUser({ db })).user.id;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    await setMode({ selfHealMode: "on" });
    threadId = (await createTestThread({ db, userId })).threadId;
    issueNumber = Math.floor(Math.random() * 100_000) + 1;
    const row = await insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: FP,
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: "Lockfile missing",
        subject: "pnpm-lock.yaml",
        status: "open",
        planFiles: ["package.json", "pnpm-lock.yaml"],
        issueNumber,
        autoFixLabeled: true,
        fixReadyAt: new Date(Date.now() - 60_000),
      },
    });
    findingId = row.id;
  });

  it("returns {} for a thread without the audit-fix stamp", async () => {
    expect(await plan(null)).toEqual({});
    expect(await plan(STAMP)).toEqual({});
  });

  it("plans the fix input from the stamped attempt, binds the thread and stores only the token hash", async () => {
    const warn = vi.spyOn(console, "warn");
    const log = vi.spyOn(console, "log");
    const attempt = await claim();
    const result = await plan(fixStamp(attempt.id));
    if (!("selfHeal" in result) || result.selfHeal === undefined) {
      throw new Error(`expected a plan, got ${JSON.stringify(result)}`);
    }
    const fix = result.selfHeal;
    if (fix.kind !== "fix") throw new Error("expected a fix plan");
    expect(fix.attemptId).toBe(attempt.id);
    expect(fix.branch).toBe(
      fixBranchName({ issueNumber, fingerprint: FP, attemptNo: 1 }),
    );
    expect(fix.branch).toBe(attempt.branch);
    expect(fix.baseBranch).toBe("main");
    expect(fix.checks).toEqual([
      { fingerprint: FP, check: "file-exists", subject: "pnpm-lock.yaml" },
    ]);
    expect(fix.denyExceptions).toEqual([]);
    expect(fix.gateToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await readAttempt(attempt.id);
    expect(row.threadId).toBe(threadId);
    expect(row.phase).toBe("dispatched");
    expect(row.gateTokenHash).toBe(hashSelfHealToken(fix.gateToken));
    expect(JSON.stringify(row)).not.toContain(fix.gateToken);
    const ttl = (row.gateTokenExpiresAt?.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(119 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(120 * 60 * 1000);
    for (const spy of [warn, log]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(fix.gateToken);
      }
    }
  });

  it("RACE-01: an attempt the dispatcher already bound to this thread is still planned", async () => {
    const attempt = await claim();
    expect(
      await bindFixAttemptThread({
        db,
        organizationId: orgId,
        attemptId: attempt.id,
        threadId,
      }),
    ).toBe(true);
    const result = await plan(fixStamp(attempt.id));
    expect("selfHeal" in result && result.selfHeal?.kind).toBe("fix");
  });

  it("an attempt bound to a different thread is refused and left alone", async () => {
    const attempt = await claim();
    const other = (await createTestThread({ db, userId })).threadId;
    await bindFixAttemptThread({
      db,
      organizationId: orgId,
      attemptId: attempt.id,
      threadId: other,
    });
    expect(await plan(fixStamp(attempt.id))).toEqual({ abort: "no_attempt" });
    const row = await readAttempt(attempt.id);
    expect(row.phase).toBe("dispatched");
    expect(row.threadId).toBe(other);
    expect(row.gateTokenHash).toBeNull();
  });

  it("a stamp without an attempt id, or an unknown attempt, aborts with no_attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await plan(fixStamp())).toEqual({ abort: "no_attempt" });
    expect(await plan(fixStamp(randomUUID()))).toEqual({
      abort: "no_attempt",
    });
  });

  it("an attempt of another org is not found (no_attempt)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = await claim();
    const other = await createOrganization({
      db,
      name: "Other",
      slug: `other-${nanoid(8).toLowerCase()}`,
    });
    const result = await planSelfHealFixRun({
      db,
      organizationId: other.id,
      repoFullName: REPO,
      threadId,
      sourceMetadata: fixStamp(attempt.id),
      baseBranch: "main",
    });
    expect(result).toEqual({ abort: "no_attempt" });
    expect((await readAttempt(attempt.id)).phase).toBe("claimed");
  });

  it("an attempt that was refunded before dispatch aborts with no_attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = await claim();
    await refundFixAttempt({
      db,
      organizationId: orgId,
      attemptId: attempt.id,
      cause: "test",
    });
    expect(await plan(fixStamp(attempt.id))).toEqual({ abort: "no_attempt" });
  });

  it.each([
    ["the kill switch", async () => setMode({ selfHealKillSwitch: true }, "*")],
    [
      "the global flag off",
      async () =>
        upsertFeatureFlag({
          db,
          name: "selfHealLoop",
          updates: { defaultValue: false, globalOverride: false },
        }),
    ],
    ["dry-run mode", async () => setMode({ selfHealMode: "dry-run" })],
  ])(
    "%s → abort killed and the attempt is refunded with outcome killed",
    async (_label, arrange) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const attempt = await claim();
      await arrange();
      expect(await plan(fixStamp(attempt.id))).toEqual({ abort: "killed" });
      const row = await readAttempt(attempt.id);
      expect(row.phase).toBe("closed");
      expect(row.outcome).toBe("killed");
      expect(row.infraRefunded).toBe(true);
      expect(row.threadId).toBeNull();
      expect(row.gateTokenHash).toBeNull();
    },
  );

  it("a planner error aborts with planning_failed and refunds the attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = await claim();
    await db
      .update(auditFindings)
      .set({ ruleId: "no.such-rule" })
      .where(eq(auditFindings.id, findingId));
    expect(await plan(fixStamp(attempt.id))).toEqual({
      abort: "planning_failed",
    });
    const row = await readAttempt(attempt.id);
    expect(row.phase).toBe("closed");
    expect(row.outcome).toBe("planning_failed");
    expect(row.infraRefunded).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("never throws: a database failure yields planning_failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await plan(fixStamp(randomUUID()), { db: {} as DB })).toEqual({
      abort: "planning_failed",
    });
  });

  describe("#277 regression checks", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const resolved = (
      fingerprint: string,
      over: Record<string, unknown> = {},
    ) =>
      insertFinding({
        db,
        organizationId: orgId,
        finding: {
          repoFullName: REPO,
          fingerprint,
          audit: "security-audit",
          ruleId: "dep.vulnerable",
          severity: "high",
          checkKind: "script",
          title: `resolved ${fingerprint}`,
          subject: "undici",
          findingKey: "GHSA-0000-0000-0000",
          status: "resolved",
          updatedAt: new Date(Date.now() - DAY_MS),
          ...over,
        },
      });

    const planFix = async () => {
      const attempt = await claim();
      const result = await plan(fixStamp(attempt.id));
      const fix = "selfHeal" in result ? result.selfHeal : undefined;
      if (fix?.kind !== "fix") {
        throw new Error(`expected a fix plan, got ${JSON.stringify(result)}`);
      }
      return fix;
    };

    it("#277: sends the checks of the repo's findings resolved in the last 30 days, newest first", async () => {
      await resolved("bbbbbbbbbbbbbbb1", {
        updatedAt: new Date(Date.now() - 3 * DAY_MS),
      });
      await resolved("bbbbbbbbbbbbbbb2", {
        ruleId: "files.gitignore-missing-pattern",
        subject: ".gitignore",
        findingKey: ".env",
      });
      const fix = await planFix();
      expect(fix.regressionChecks).toEqual([
        {
          fingerprint: "bbbbbbbbbbbbbbb2",
          check: "gitignore-has-pattern",
          subject: ".gitignore",
          key: ".env",
        },
        {
          fingerprint: "bbbbbbbbbbbbbbb1",
          check: "npm-audit-clean",
          subject: "undici",
          key: "GHSA-0000-0000-0000",
        },
      ]);
    });

    it("#277: leaves out stale, unresolved, rubric, subjectless, unknown-rule and other-repo findings", async () => {
      await resolved("ccccccccccccccc1", {
        updatedAt: new Date(Date.now() - 31 * DAY_MS),
      });
      await resolved("ccccccccccccccc2", { status: "open" });
      await resolved("ccccccccccccccc3", { status: "suppressed" });
      await resolved("ccccccccccccccc4", { checkKind: "rubric" });
      await resolved("ccccccccccccccc5", { subject: null });
      await resolved("ccccccccccccccc6", { ruleId: "no.such-rule" });
      await resolved("ccccccccccccccc7", { repoFullName: "acme/other" });
      await resolved("ccccccccccccccc8");
      const fix = await planFix();
      expect(fix.regressionChecks?.map((c) => c.fingerprint)).toEqual([
        "ccccccccccccccc8",
      ]);
    });

    it("#277: caps the regression checks at 50", async () => {
      for (let i = 0; i < 52; i++) {
        await resolved(`dddddddddddd${i.toString(16).padStart(4, "0")}`, {
          updatedAt: new Date(Date.now() - DAY_MS - i * 60_000),
        });
      }
      const fix = await planFix();
      expect(fix.regressionChecks).toHaveLength(50);
      expect(fix.regressionChecks?.[0]?.fingerprint).toBe("dddddddddddd0000");
    });

    it("#277: omits the field when no finding was recently resolved", async () => {
      const fix = await planFix();
      expect(fix).not.toHaveProperty("regressionChecks");
    });
  });

  it("a ci.* rule ships its plan's workflow files as deny exceptions", async () => {
    await db
      .update(auditFindings)
      .set({
        ruleId: "ci.action-unpinned",
        subject: ".github/workflows/ci.yml",
        planFiles: [".github/workflows/ci.yml", "src/a.ts"],
      })
      .where(eq(auditFindings.id, findingId));
    const attempt = await claim();
    const result = await plan(fixStamp(attempt.id));
    const fix = "selfHeal" in result ? result.selfHeal : undefined;
    if (fix?.kind !== "fix") throw new Error("expected a fix plan");
    expect(fix.denyExceptions).toEqual([".github/workflows/ci.yml"]);
    expect(fix.checks[0]?.subject).toBe(".github/workflows/ci.yml");
  });
});

describe("deriveFixCheckStatus", () => {
  it.each([
    ["completed", "pass", [], "passed"],
    ["completed", "pass", ["AGENTS.md"], "failed"],
    ["completed", "fail", [], "failed"],
    ["completed", "error", [], "error"],
    ["completed", null, [], "error"],
    ["completed", "error", [".github/workflows/x.yml"], "failed"],
    ["no_branch", null, [], "no_branch"],
    ["aborted", null, [], "aborted"],
    ["aborted", "pass", [], "aborted"],
    ["error", "pass", [], "error"],
  ] as const)(
    "%s + %s + %j → %s",
    (workerStatus, checkOutcome, deniedPaths, expected) => {
      expect(
        deriveFixCheckStatus({
          workerStatus,
          checkOutcome,
          deniedPaths: [...deniedPaths],
        }),
      ).toBe(expected);
    },
  );
});

describe("planSelfHealRun", () => {
  const base = {
    db,
    repoFullName: REPO,
    threadId: "t-1",
    baseBranch: "main",
  };

  it("refuses an audit-fix stamp on a thread that is not an org task thread", async () => {
    expect(
      await planSelfHealRun({
        ...base,
        organizationId: null,
        sourceMetadata: { ...STAMP, skillName: "audit-fix" },
      }),
    ).toEqual({ abort: "not_org_task_thread" });
  });

  it("plans nothing for a non-org thread without a fix stamp", async () => {
    expect(
      await planSelfHealRun({
        ...base,
        organizationId: null,
        sourceMetadata: STAMP,
      }),
    ).toEqual({});
  });
});
