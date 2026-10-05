import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  auditFindings,
  auditFixAttempts,
  selfHealSlot,
  thread,
} from "@terragon/shared/db/schema";
import {
  insertFinding,
  updateFinding,
  type AuditFindingRow,
} from "@terragon/shared/model/audit-findings";
import {
  claimFixAttempt,
  listFixReadyFindings,
} from "@terragon/shared/model/audit-fix-attempts";
import {
  getIssueAutomationsForRepo,
  getPullRequestAutomationsForRepo,
} from "@terragon/shared/model/automations";
import {
  acquireHalfOpenProbe,
  getBreakerState,
  moveExpiredToHalfOpen,
  probeAttemptIdOf,
  recordProbeAttempt,
  tripBreaker,
} from "@terragon/shared/model/self-heal-breaker";
import {
  SELF_HEAL_DEFAULTS,
  type SelfHealMode,
} from "@terragon/shared/model/self-heal-settings";
import {
  getSelfHealSlot,
  releaseSelfHealSlot,
} from "@terragon/shared/model/self-heal-slot";
import {
  createTestAutomation,
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { runLoopBreakerEvaluation } from "./loop-breaker";
import { loadSelfHealContext, type SelfHealContext } from "./resolve-self-heal";
import { defaultRunAuditFixDeps, runAuditFixAutomation } from "./run-audit-fix";
import { admitSelfHealRun } from "./self-heal-admission";
import {
  createRepoGithubProbe,
  runSelfHealDispatcher,
  type RepoGithubProbe,
  type SelfHealDispatcherDeps,
} from "./self-heal-dispatcher";

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BOT = "automata-app[bot]";
/**
 * Far-future instants (03:00 UTC, inside the default 02:00-06:00 window), one
 * day apart per test: the review-in-flight check is platform-wide, so rows
 * other test files create at wall-clock time stay outside its window.
 */
const BASE = Date.parse("2097-06-01T03:00:00.000Z");
let day = 0;

function contextFor(mode: SelfHealMode): SelfHealContext {
  return {
    flagEnabled: true,
    sideEffectsEnabled: true,
    shadow: false,
    resolved: {
      settings: { ...SELF_HEAL_DEFAULTS, mode },
      killed: false,
    },
    breakers: {
      permissionLatched: false,
      loopAuditOpen: false,
      loopFixOpen: false,
    },
  };
}

describe("runSelfHealDispatcher (BULK-01)", () => {
  let now: Date;
  let userId: string;
  let orgA: string;
  let orgB: string;
  let orgs: Set<string>;
  let modes: Map<string, SelfHealMode>;
  let lines: string[];
  let errors: string[];
  let runAutomationCalls: Record<string, unknown>[];

  function repoName(): string {
    return `acme-${nanoid(6).toLowerCase()}/widgets`;
  }

  async function seedFinding({
    organizationId,
    repoFullName,
    readyAgoMin,
  }: {
    organizationId: string;
    repoFullName: string;
    readyAgoMin: number;
  }): Promise<AuditFindingRow> {
    const row = await insertFinding({
      db,
      organizationId,
      finding: {
        repoFullName,
        fingerprint: randomBytes(8).toString("hex"),
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: "Lockfile missing",
        planMd: "Add the lockfile.",
        acceptanceMd: "The lockfile exists.",
        planFiles: ["package.json", "pnpm-lock.yaml"],
      },
    });
    const updated = await updateFinding({
      db,
      organizationId,
      id: row.id,
      patch: {
        issueNumber: Math.floor(Math.random() * 100_000) + 1,
        status: "open",
        autoFixLabeled: true,
        fixReadyAt: new Date(now.getTime() - readyAgoMin * MIN),
      },
    });
    if (!updated) throw new Error("seed finding vanished");
    return updated;
  }

  async function seedFixAutomation(organizationId: string, repo: string) {
    return createTestAutomation({
      db,
      userId,
      values: {
        organizationId,
        repoFullName: repo,
        triggerType: "issue",
        // any: createTestAutomation merges a schedule-shaped default config.
        triggerConfig: {
          on: { labeled: true },
          filter: { labels: ["automata:auto-fix"] },
        } as any,
        action: {
          type: "skill_message",
          config: { skillName: "audit-fix", version: "latest" },
        },
      },
    });
  }

  async function seedReviewAutomation(
    organizationId: string,
    repo: string,
    filter: Record<string, unknown> = { includeAllAuthors: true },
  ) {
    return createTestAutomation({
      db,
      userId,
      values: {
        organizationId,
        repoFullName: repo,
        triggerType: "pull_request",
        // any: createTestAutomation merges a schedule-shaped default config.
        triggerConfig: { on: { open: true }, filter } as any,
      },
    });
  }

  async function seedReviewInFlight(organizationId: string) {
    const repo = repoName();
    const automation = await seedReviewAutomation(organizationId, repo);
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId,
        automationId: automation.id,
        githubRepoFullName: repo,
        githubPRNumber: 7,
      },
    });
    await db
      .update(thread)
      .set({ status: "queued", createdAt: new Date(now.getTime() - MIN) })
      .where(eq(thread.id, threadId));
  }

  function probe(overrides: Partial<RepoGithubProbe> = {}): RepoGithubProbe {
    return {
      installationKey: "1001",
      capabilitiesOk: true,
      readDefaultBranch: async () => "main",
      ...overrides,
    };
  }

  function harness(overrides: Partial<SelfHealDispatcherDeps> = {}) {
    const claim = vi.fn(claimFixAttempt);
    const admit = vi.fn(admitSelfHealRun);
    const releaseSlot = vi.fn(releaseSelfHealSlot);
    const probeRepo = vi.fn(async () => probe());
    const deps: SelfHealDispatcherDeps = {
      isLoopEnabled: async () => true,
      // The real selector is platform-wide; keep this test's orgs only.
      listFixReady: async ({ db: d, limit = 20 }) =>
        (await listFixReadyFindings({ db: d, limit: 1000 }))
          .filter((f) => orgs.has(f.organizationId))
          .slice(0, limit),
      admit,
      loadContext: async ({ repoFullName }) =>
        contextFor(modes.get(repoFullName) ?? "on"),
      probeRepo,
      getBreakerState,
      listIssueAutomations: getIssueAutomationsForRepo,
      listPullRequestAutomations: getPullRequestAutomationsForRepo,
      claim,
      acquireProbe: acquireHalfOpenProbe,
      recordProbe: recordProbeAttempt,
      runFix: (args) =>
        runAuditFixAutomation({
          ...args,
          deps: {
            ...defaultRunAuditFixDeps("test"),
            validateCanRun: async () => ({ canRun: true }),
            runAutomation: async (call) => {
              runAutomationCalls.push(call as Record<string, unknown>);
              const created = await createTestThread({
                db,
                userId,
                overrides: {
                  organizationId: args.attempt.organizationId,
                  githubRepoFullName: args.finding.repoFullName,
                },
              });
              return created;
            },
            log: (line) => lines.push(line),
            error: (message) => errors.push(message),
            capture: () => undefined,
            now: () => now,
          },
        }),
      releaseSlot,
      updateFinding,
      botLogin: () => BOT,
      log: (line) => lines.push(line),
      error: (message) => errors.push(message),
      capture: () => undefined,
      now: () => now,
      ...overrides,
    };
    return { deps, claim, admit, releaseSlot, probeRepo };
  }

  function dispatch(deps: SelfHealDispatcherDeps) {
    return runSelfHealDispatcher({
      db,
      now,
      deadlineAt: new Date(now.getTime() + 120_000),
      deps,
    });
  }

  async function findingRow(id: string) {
    const [row] = await db
      .select()
      .from(auditFindings)
      .where(eq(auditFindings.id, id));
    return row;
  }

  async function attemptsFor(findingId: string) {
    return db
      .select()
      .from(auditFixAttempts)
      .where(eq(auditFixAttempts.findingId, findingId));
  }

  /** One fully configured, dispatchable repo in `organizationId`. */
  async function dispatchableRepo(organizationId: string, readyAgoMin = 30) {
    const repo = repoName();
    await seedFixAutomation(organizationId, repo);
    await seedReviewAutomation(organizationId, repo);
    const finding = await seedFinding({
      organizationId,
      repoFullName: repo,
      readyAgoMin,
    });
    return { repo, finding };
  }

  beforeEach(async () => {
    day += 1;
    now = new Date(BASE + day * DAY);
    lines = [];
    errors = [];
    runAutomationCalls = [];
    modes = new Map();
    await db.delete(selfHealSlot);
    userId = (await createTestUser({ db })).user.id;
    orgA = await createTestOrg({ db });
    orgB = await createTestOrg({ db });
    orgs = new Set([orgA, orgB]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flag off: returns before admission and before any DB claim", async () => {
    await dispatchableRepo(orgA);
    const listFixReady = vi.fn(async () => []);
    const h = harness({ isLoopEnabled: async () => false, listFixReady });
    const result = await dispatch(h.deps);

    expect(result).toEqual({ dispatched: null, considered: 0 });
    expect(listFixReady).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(await getSelfHealSlot({ db })).toBeNull();
  });

  it("RES-11: a review in flight defers; no claim, no attempt consumed, no slot", async () => {
    const { finding } = await dispatchableRepo(orgA);
    await seedReviewInFlight(orgB);
    const h = harness();
    const result = await dispatch(h.deps);

    expect(result).toEqual({
      dispatched: null,
      considered: 0,
      deferred: "review_in_flight",
    });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.probeRepo).not.toHaveBeenCalled();
    const row = await findingRow(finding.id);
    expect(row?.attempts).toBe(0);
    expect(row?.activeAttemptId).toBeNull();
    expect(await attemptsFor(finding.id)).toHaveLength(0);
    expect(lines.join("\n")).toContain(
      "reason=admission_deferred:review_in_flight",
    );
    const slot = await getSelfHealSlot({ db });
    expect(slot?.leaseUntil ?? null).toBeNull();
  });

  it("dry-run → would_dispatch, missing fix automation → refused, the third is claimed and dispatched", async () => {
    // A: org A, dry-run (fully configured otherwise).
    const a = await dispatchableRepo(orgA, 90);
    modes.set(a.repo, "dry-run");
    // B: org B, no audit-fix automation.
    const bRepo = repoName();
    await seedReviewAutomation(orgB, bRepo);
    const b = await seedFinding({
      organizationId: orgB,
      repoFullName: bRepo,
      readyAgoMin: 60,
    });
    // C: org B, dispatchable.
    const c = await dispatchableRepo(orgB, 30);

    const h = harness();
    const result = await dispatch(h.deps);

    expect(result.considered).toBe(3);
    expect(result.dispatched).toEqual(expect.any(String));

    const rowA = await findingRow(a.finding.id);
    expect(rowA).toMatchObject({
      lastDecision: "would_dispatch",
      lastDecisionReason: "dry_run",
      attempts: 0,
      activeAttemptId: null,
    });
    expect(await attemptsFor(a.finding.id)).toHaveLength(0);

    const rowB = await findingRow(b.id);
    expect(rowB).toMatchObject({
      lastDecision: "dispatch",
      lastDecisionReason: "no_fix_automation",
      attempts: 0,
      activeAttemptId: null,
    });
    expect(await attemptsFor(b.id)).toHaveLength(0);

    const rowC = await findingRow(c.finding.id);
    expect(rowC?.attempts).toBe(1);
    expect(rowC?.activeThreadId).toBe(result.dispatched);
    const [attempt] = await attemptsFor(c.finding.id);
    expect(attempt).toMatchObject({
      phase: "dispatched",
      threadId: result.dispatched,
      attemptNo: 1,
    });
    expect(h.claim).toHaveBeenCalledTimes(1);

    // The thread carries the attempt in its stamp; base = default branch.
    expect(runAutomationCalls).toHaveLength(1);
    expect(runAutomationCalls[0]).toMatchObject({
      source: "automated",
      options: {
        branchName: "main",
        stampExtra: { selfHealAttemptId: attempt?.id },
      },
    });

    const slot = await getSelfHealSlot({ db });
    expect(slot).toMatchObject({
      holderKind: "fix",
      holderThreadId: result.dispatched,
    });

    const joined = lines.join("\n");
    expect(joined).toMatch(
      /decision=would_dispatch reason=dry_run mode=dry-run/,
    );
    expect(joined).toMatch(/decision=dispatch reason=no_fix_automation/);
    expect(joined).toMatch(/decision=dispatch reason=started mode=on/);
  });

  it("REV-01: a review automation that does not match bot authors refuses", async () => {
    const repo = repoName();
    await seedFixAutomation(orgA, repo);
    await seedReviewAutomation(orgA, repo, {
      includeOtherAuthors: true,
      otherAuthors: "someone-else",
    });
    const finding = await seedFinding({
      organizationId: orgA,
      repoFullName: repo,
      readyAgoMin: 10,
    });
    const h = harness();
    const result = await dispatch(h.deps);

    expect(result.dispatched).toBeNull();
    expect(await findingRow(finding.id)).toMatchObject({
      lastDecisionReason: "no_review_automation",
      attempts: 0,
    });
  });

  it("REV-01: the bot login in otherAuthors counts as a matching review automation", async () => {
    const repo = repoName();
    await seedFixAutomation(orgA, repo);
    await seedReviewAutomation(orgA, repo, {
      includeOtherAuthors: true,
      otherAuthors: `someone, ${BOT.toUpperCase()}`,
    });
    await seedFinding({
      organizationId: orgA,
      repoFullName: repo,
      readyAgoMin: 10,
    });
    const result = await dispatch(harness().deps);
    expect(result.dispatched).toEqual(expect.any(String));
  });

  it("all candidates refused → the slot is released", async () => {
    const a = await dispatchableRepo(orgA, 20);
    modes.set(a.repo, "off");
    const bRepo = repoName();
    await seedFinding({
      organizationId: orgB,
      repoFullName: bRepo,
      readyAgoMin: 10,
    });
    const h = harness();
    const result = await dispatch(h.deps);

    expect(result).toEqual({ dispatched: null, considered: 2 });
    expect(h.releaseSlot).toHaveBeenCalledWith({ db });
    const slot = await getSelfHealSlot({ db });
    expect(slot?.leaseUntil ?? null).toBeNull();
    expect(await findingRow(a.finding.id)).toMatchObject({
      lastDecisionReason: "mode_off",
    });
  });

  it("an open exec_plane breaker refuses before any claim", async () => {
    const a = await dispatchableRepo(orgA, 20);
    const h = harness({
      getBreakerState: async (args) => {
        const row = await getBreakerState(args);
        return args.scopeKind === "exec_plane"
          ? { ...row, state: "open" }
          : row;
      },
    });
    const result = await dispatch(h.deps);
    expect(result.dispatched).toBeNull();
    expect(h.claim).not.toHaveBeenCalled();
    expect(await findingRow(a.finding.id)).toMatchObject({
      lastDecisionReason: "exec_plane_open",
    });
  });

  it("missing fixLoop capabilities refuse; GitHub unavailable is a skip, not a claim", async () => {
    const a = await dispatchableRepo(orgA, 20);
    const b = await dispatchableRepo(orgB, 10);
    const h = harness({
      probeRepo: async ({ organizationId }) =>
        organizationId === orgA ? probe({ capabilitiesOk: false }) : null,
    });
    const result = await dispatch(h.deps);
    expect(result.dispatched).toBeNull();
    expect(h.claim).not.toHaveBeenCalled();
    expect(await findingRow(a.finding.id)).toMatchObject({
      lastDecisionReason: "missing_permission",
    });
    expect(await findingRow(b.finding.id)).toMatchObject({
      lastDecisionReason: "github_unavailable",
    });
  });

  it("a lost claim CAS records claim_refused and moves on", async () => {
    const a = await dispatchableRepo(orgA, 20);
    const h = harness({ claim: vi.fn(async () => null) });
    const result = await dispatch(h.deps);
    expect(result.dispatched).toBeNull();
    expect(await findingRow(a.finding.id)).toMatchObject({
      lastDecisionReason: "claim_refused",
    });
    expect((await getSelfHealSlot({ db }))?.leaseUntil ?? null).toBeNull();
  });

  it("free plan: an unprotected (or unreadable) default branch is NOT a refusal; protection is never read", async () => {
    const a = await dispatchableRepo(orgA, 20);
    const getBranchProtection = vi.fn(async () => {
      throw Object.assign(new Error("Upgrade to GitHub Pro"), { status: 403 });
    });
    const reposGet = vi.fn(async () => ({
      data: { default_branch: "trunk" },
      status: 200,
      headers: {},
    }));
    const fakeOctokit = {
      rest: { repos: { get: reposGet, getBranchProtection } },
      request: vi.fn(async () => {
        throw new Error("no raw requests expected");
      }),
    };
    const probeRepo = createRepoGithubProbe({
      // any: a structural Octokit stand-in with only the routes under test.
      mint: async () => ({ octokit: fakeOctokit as any, installationId: 4242 }),
      preflight: async () => ({ ok: true, installationId: 4242 }),
    });
    const h = harness({ probeRepo });
    const result = await dispatch(h.deps);

    expect(result.dispatched).toEqual(expect.any(String));
    expect(getBranchProtection).not.toHaveBeenCalled();
    expect(fakeOctokit.request).not.toHaveBeenCalled();
    expect(reposGet).toHaveBeenCalledTimes(1);
    expect(runAutomationCalls[0]).toMatchObject({
      options: { branchName: "trunk" },
    });
    expect(await findingRow(a.finding.id)).toMatchObject({ attempts: 1 });
  });

  it("concurrent ticks dispatch exactly one fix run", async () => {
    await dispatchableRepo(orgA, 30);
    await dispatchableRepo(orgB, 20);
    const [first, second] = await Promise.all([
      dispatch(harness().deps),
      dispatch(harness().deps),
    ]);
    const dispatched = [first.dispatched, second.dispatched].filter(
      (id) => id !== null,
    );
    expect(dispatched).toHaveLength(1);
    expect([first.deferred, second.deferred]).toContain("slot_held");
    const claimed = await db
      .select()
      .from(auditFixAttempts)
      .where(eq(auditFixAttempts.threadId, dispatched[0] as string));
    expect(claimed).toHaveLength(1);
  });

  it("a held slot (another self-heal run) defers the whole tick", async () => {
    const { finding } = await dispatchableRepo(orgA, 30);
    const first = await dispatch(harness().deps);
    expect(first.dispatched).toEqual(expect.any(String));
    const other = await dispatchableRepo(orgB, 20);
    const second = await dispatch(harness().deps);
    expect(second).toEqual({
      dispatched: null,
      considered: 0,
      deferred: "slot_held",
    });
    expect(await findingRow(other.finding.id)).toMatchObject({ attempts: 0 });
    expect(await findingRow(finding.id)).toMatchObject({ attempts: 1 });
  });

  /** A real breaker row moved to half_open (one probe) at `now`. */
  async function halfOpenBreaker(
    organizationId: string,
    scopeKind: "loop_fix" | "exec_plane" | "hatchet_dispatch",
    scopeKey: string,
  ) {
    await tripBreaker({
      db,
      organizationId,
      scopeKind,
      scopeKey,
      reason: "consecutive_failures",
      evidence: {},
      now: new Date(now.getTime() - 4 * DAY),
    });
    const moved = await moveExpiredToHalfOpen({
      db,
      organizationId,
      scopeKind,
      scopeKey,
      now,
    });
    if (moved?.to !== "half_open") throw new Error("breaker not half-open");
  }

  const loopFixRow = (organizationId: string, repo: string) =>
    getBreakerState({
      db,
      organizationId,
      scopeKind: "loop_fix",
      scopeKey: repo,
    });

  it("RES-15: a half-open loop_fix probe is taken in the claim transaction and stamped with the attempt id", async () => {
    const { repo, finding } = await dispatchableRepo(orgA, 30);
    await halfOpenBreaker(orgA, "loop_fix", repo);
    const result = await dispatch(harness().deps);

    expect(result.dispatched).toEqual(expect.any(String));
    const [attempt] = await attemptsFor(finding.id);
    const row = await loopFixRow(orgA, repo);
    expect(row.state).toBe("half_open");
    expect(row.halfOpenProbesLeft).toBe(0);
    expect(row.probeInFlightUntil?.getTime()).toBeGreaterThan(now.getTime());
    expect(probeAttemptIdOf(row)).toBe(attempt?.id);
  });

  it("RES-15: two concurrent claims on a half-open repo → exactly one claim; the other records breaker_half_open_probe_taken", async () => {
    const repo = repoName();
    await seedFixAutomation(orgA, repo);
    await seedReviewAutomation(orgA, repo);
    const f1 = await seedFinding({
      organizationId: orgA,
      repoFullName: repo,
      readyAgoMin: 30,
    });
    const f2 = await seedFinding({
      organizationId: orgA,
      repoFullName: repo,
      readyAgoMin: 20,
    });
    await halfOpenBreaker(orgA, "loop_fix", repo);
    // Bypass the box slot so both ticks reach the claim at once.
    const ticks = () =>
      harness({
        admit: vi.fn(async () => ({ admitted: true as const })),
        runFix: vi.fn(async () => ({ threadId: `t-${nanoid(6)}` })),
      }).deps;
    const results = await Promise.all([dispatch(ticks()), dispatch(ticks())]);

    expect(results.filter((r) => r.dispatched !== null)).toHaveLength(1);
    const attempts = [
      ...(await attemptsFor(f1.id)),
      ...(await attemptsFor(f2.id)),
    ];
    expect(attempts).toHaveLength(1);
    const reasons = [
      (await findingRow(f1.id))?.lastDecisionReason,
      (await findingRow(f2.id))?.lastDecisionReason,
    ];
    expect(reasons).toContain("breaker_half_open_probe_taken");
    expect(lines.join("\n")).toContain("reason=breaker_half_open_probe_taken");
  });

  it("RES-15: a failing claim CAS rolls the probe back; the probe is still available", async () => {
    const { repo, finding } = await dispatchableRepo(orgA, 30);
    await halfOpenBreaker(orgA, "loop_fix", repo);
    const h = harness({ claim: vi.fn(async () => null) });
    const result = await dispatch(h.deps);

    expect(result.dispatched).toBeNull();
    expect(await findingRow(finding.id)).toMatchObject({
      lastDecisionReason: "claim_refused",
    });
    const row = await loopFixRow(orgA, repo);
    expect(row.halfOpenProbesLeft).toBe(1);
    expect(probeAttemptIdOf(row)).toBeNull();
    expect(
      await acquireHalfOpenProbe({
        db,
        organizationId: orgA,
        scopeKind: "loop_fix",
        scopeKey: repo,
        now,
      }),
    ).toBe(true);
  });

  it("an open or paused loop_fix breaker refuses with loop_fix_open (real breaker read)", async () => {
    const a = await dispatchableRepo(orgA, 30);
    await tripBreaker({
      db,
      organizationId: orgA,
      scopeKind: "loop_fix",
      scopeKey: a.repo,
      reason: "consecutive_failures",
      evidence: {},
      now,
    });
    const b = await dispatchableRepo(orgB, 20);
    await tripBreaker({
      db,
      organizationId: orgB,
      scopeKind: "loop_fix",
      scopeKey: b.repo,
      reason: "draft_unsupported",
      evidence: {},
      cooldownMs: "paused_manual",
      now,
    });
    const h = harness();
    const result = await dispatch(h.deps);

    expect(result.dispatched).toBeNull();
    expect(h.claim).not.toHaveBeenCalled();
    for (const id of [a.finding.id, b.finding.id]) {
      expect(await findingRow(id)).toMatchObject({
        lastDecisionReason: "loop_fix_open",
        attempts: 0,
      });
    }
  });

  it("a half-open exec_plane breaker lets exactly one claim through as its probe", async () => {
    const { finding } = await dispatchableRepo(orgA, 30);
    await halfOpenBreaker(orgA, "exec_plane", "*");
    const result = await dispatch(harness().deps);

    expect(result.dispatched).toEqual(expect.any(String));
    const [attempt] = await attemptsFor(finding.id);
    const row = await getBreakerState({
      db,
      organizationId: orgA,
      scopeKind: "exec_plane",
      scopeKey: "*",
    });
    expect(row.halfOpenProbesLeft).toBe(0);
    expect(probeAttemptIdOf(row)).toBe(attempt?.id);
  });

  it("the probe's draft opening (check + guard passed) closes loop_fix on the next tick evaluation", async () => {
    const { repo, finding } = await dispatchableRepo(orgA, 30);
    await halfOpenBreaker(orgA, "loop_fix", repo);
    await dispatch(harness().deps);
    const [attempt] = await attemptsFor(finding.id);
    if (!attempt) throw new Error("no probe attempt");
    await db
      .update(auditFixAttempts)
      .set({
        phase: "ci_pending",
        prNumber: 41,
        prState: "draft",
        guardStatus: "passed",
        checkStatus: "passed",
      })
      .where(eq(auditFixAttempts.id, attempt.id));
    await runLoopBreakerEvaluation({
      db,
      now: new Date(now.getTime() + 10 * MIN),
      deadlineAt: new Date(Date.now() + 60_000),
      limit: 1_000,
      deps: {
        log: () => undefined,
        error: () => undefined,
        capture: () => undefined,
      },
    });
    const row = await loopFixRow(orgA, repo);
    expect(row.state).toBe("closed");
    expect(row.tripCount).toBe(1);
  });

  it("RES-15: downstream gates pass only the probe attempt through a half-open loop_fix", async () => {
    const { repo, finding } = await dispatchableRepo(orgA, 30);
    await halfOpenBreaker(orgA, "loop_fix", repo);
    await dispatch(harness().deps);
    const [attempt] = await attemptsFor(finding.id);
    if (!attempt) throw new Error("no probe attempt");
    const gate = (probeAttemptId?: string) =>
      loadSelfHealContext({
        db,
        organizationId: orgA,
        repoFullName: repo,
        installationKey: "1001",
        ...(probeAttemptId ? { probeAttemptId } : {}),
      });
    expect((await gate(attempt.id)).breakers.loopFixOpen).toBe(false);
    expect((await gate()).breakers.loopFixOpen).toBe(true);
    expect((await gate("another-attempt")).breakers.loopFixOpen).toBe(true);
  });
});
