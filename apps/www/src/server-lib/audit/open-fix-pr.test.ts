import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Octokit } from "octokit";

import { db } from "@/lib/db";
import {
  auditFindings,
  auditFixAttempts,
  githubPR,
  selfHealBreakerEvent,
  thread,
} from "@terragon/shared/db/schema";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  bindFixAttemptThread,
  claimAttemptLease,
  claimFixAttempt,
  listPendingPrOpens,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  defaultOpenFixPrDeps,
  openDraftFixPr,
  runFixPrOpenSweep,
  type OpenFixPrDeps,
} from "./open-fix-pr";
import { commentMarker, FINDING_LABELS } from "./render-issue";
import {
  resolveSelfHealFromRows,
  type SelfHealContext,
} from "./resolve-self-heal";
import { withSelfHealCall } from "./with-self-heal-call";
import { attemptSignalOf, evaluateLoopFix } from "./loop-breaker";

vi.mock("./with-self-heal-call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./with-self-heal-call")>();
  return { ...actual, withSelfHealCall: vi.fn(actual.withSelfHealCall) };
});

vi.mock("@terragon/shared/model/audit-fix-attempts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/audit-fix-attempts")
    >();
  return { ...actual, listPendingPrOpens: vi.fn(actual.listPendingPrOpens) };
});

const REPO = "acme/widgets";
const BOT = "automata-app[bot]";
const SHA = "b".repeat(40);
const ISSUE = 42;
const MIN = 60_000;

interface RawPull {
  number: number;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  user?: { login?: string } | null;
}

interface FakeState {
  headSha: string | null;
  aheadBy: number;
  files: unknown[];
  pulls: RawPull[];
  comments: Array<{ id: number; body: string; user: { login: string } }>;
  labels: string[];
  create: () => Promise<RawPull>;
}

function ok<T>(data: T) {
  return { data, status: 200, headers: {} };
}

function httpError(status: number, message: string, data?: unknown) {
  return Object.assign(new Error(message), {
    status,
    response: { headers: {}, data },
  });
}

function fakeOctokit(state: FakeState) {
  const rest = {
    git: {
      getRef: vi.fn(async (_args: unknown) => {
        if (state.headSha === null) throw httpError(404, "Not Found");
        return ok({ object: { sha: state.headSha } });
      }),
      deleteRef: vi.fn(async (_args: unknown) => ok(undefined)),
    },
    repos: {
      get: vi.fn(async () => ok({ default_branch: "main", private: true })),
      compareCommitsWithBasehead: vi.fn(async (_args: unknown) =>
        ok({ ahead_by: state.aheadBy, files: state.files }),
      ),
      merge: vi.fn(),
    },
    pulls: {
      list: vi.fn(async (_args: unknown) => ok(state.pulls)),
      create: vi.fn(async (_args: unknown) => ok(await state.create())),
      merge: vi.fn(),
      updateBranch: vi.fn(),
    },
    issues: {
      listComments: vi.fn(async () => ok(state.comments)),
      createComment: vi.fn(async ({ body }: { body: string }) => {
        const id = state.comments.length + 1;
        state.comments.push({ id, body, user: { login: BOT } });
        return ok({ id });
      }),
      updateComment: vi.fn(async () => ok({})),
      get: vi.fn(async () =>
        ok({
          number: ISSUE,
          state: "open",
          labels: state.labels.map((name) => ({ name })),
          created_at: "",
        }),
      ),
      addLabels: vi.fn(async ({ labels }: { labels: string[] }) => {
        state.labels.push(...labels);
        return ok([]);
      }),
      removeLabel: vi.fn(async ({ name }: { name: string }) => {
        state.labels = state.labels.filter((l) => l !== name);
        return ok([]);
      }),
    },
  };
  const graphql = vi.fn();
  return { rest, graphql };
}

type Fake = ReturnType<typeof fakeOctokit>;

function totalCalls(fake: Fake): number {
  let n = fake.graphql.mock.calls.length;
  for (const group of Object.values(fake.rest)) {
    for (const fn of Object.values(group)) {
      n += (fn as ReturnType<typeof vi.fn>).mock.calls.length;
    }
  }
  return n;
}

describe("openDraftFixPr (GATE-01, SC4, RES-18)", () => {
  let orgId: string;
  let userId: string;
  let threadId: string;
  let findingId: string;
  let attemptId: string;
  let branch: string;
  let state: FakeState;
  let fake: Fake;
  let ctx: SelfHealContext;
  let deps: OpenFixPrDeps;
  let mint: ReturnType<typeof vi.fn>;

  const pr = (over: Partial<RawPull> = {}): RawPull => ({
    number: 501,
    state: "open",
    draft: true,
    merged_at: null,
    user: { login: BOT },
    ...over,
  });

  const report = (
    status: "passed" | "failed" | "error" | "no_branch" | "aborted",
    over: Record<string, unknown> = {},
  ) =>
    updateFixAttempt({
      db,
      organizationId: orgId,
      id: attemptId,
      patch: {
        phase: "checking",
        checkReportedAt: new Date(),
        checkStatus:
          status === "passed"
            ? "passed"
            : status === "failed" || status === "no_branch"
              ? "failed"
              : "error",
        checkResults: { status },
        gatedHeadSha:
          status === "no_branch" || status === "aborted" ? null : SHA,
        ...over,
      },
    });

  const attempt = async () => {
    const [row] = await db
      .select()
      .from(auditFixAttempts)
      .where(eq(auditFixAttempts.id, attemptId));
    if (!row) throw new Error("attempt vanished");
    return row;
  };

  const finding = async () => {
    const [row] = await db
      .select()
      .from(auditFindings)
      .where(eq(auditFindings.id, findingId));
    if (!row) throw new Error("finding vanished");
    return row;
  };

  const open = () =>
    openDraftFixPr({ db, organizationId: orgId, attemptId, deps });

  const neverMerges = () => {
    expect(fake.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fake.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(fake.rest.repos.merge).not.toHaveBeenCalled();
    expect(fake.graphql).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    vi.mocked(withSelfHealCall).mockClear();
    userId = (await createTestUser({ db })).user.id;
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    const row = await insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: "0123456789abcdef",
        audit: "security-audit",
        ruleId: "dep.vulnerable",
        severity: "high",
        checkKind: "script",
        title: "Vulnerable dependency @someone fixes #7",
        subject: "lodash",
        planFiles: ["src/a.ts", "package.json"],
        status: "open",
        issueNumber: ISSUE,
        autoFixLabeled: true,
        fixReadyAt: new Date(Date.now() - MIN),
      },
    });
    findingId = row.id;
    const claimed = await claimFixAttempt({
      db,
      organizationId: orgId,
      findingId,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor: (n) => `automata/fix-42-01234567-a${n}`,
    });
    if (!claimed) throw new Error("claim failed");
    attemptId = claimed.attempt.id;
    branch = claimed.attempt.branch ?? "";
    threadId = (
      await createTestThread({
        db,
        userId,
        overrides: { organizationId: orgId, githubRepoFullName: REPO },
      })
    ).threadId;
    await bindFixAttemptThread({
      db,
      organizationId: orgId,
      attemptId,
      threadId,
    });

    state = {
      headSha: SHA,
      aheadBy: 2,
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-const v = 1;\n+const v = 2;",
        },
      ],
      pulls: [],
      comments: [],
      labels: [FINDING_LABELS.finding, FINDING_LABELS.autoFix],
      create: async () => pr(),
    };
    fake = fakeOctokit(state);
    const resolved = resolveSelfHealFromRows({
      organizationId: orgId,
      repo: undefined,
      orgDefault: undefined,
    });
    ctx = {
      flagEnabled: true,
      sideEffectsEnabled: true,
      shadow: false,
      resolved: {
        ...resolved,
        settings: {
          ...resolved.settings,
          mode: "on",
          maxAttempts: 3,
          maxDiffLines: 300,
        },
      },
      breakers: {
        permissionLatched: false,
        loopAuditOpen: false,
        loopFixOpen: false,
      },
    };
    mint = vi.fn(async () => ({
      octokit: fake as unknown as Octokit,
      installationId: 77,
    }));
    deps = {
      ...defaultOpenFixPrDeps(),
      loadContext: vi.fn(async () => ctx),
      mint,
      preflight: vi.fn(async () => ({ ok: true as const, installationId: 77 })),
      callDeps: {
        now: () => new Date(),
        log: () => {},
        sleep: async () => {},
        rand: () => 0,
      },
      botLogin: () => BOT,
      log: () => {},
    };
  });

  it("passed + gated head + ahead + guard ok → one bot draft PR, linked everywhere", async () => {
    await report("passed");
    expect(await open()).toBe("draft_opened");

    expect(fake.rest.pulls.create).toHaveBeenCalledTimes(1);
    const args = fake.rest.pulls.create.mock.calls[0]?.[0] as unknown as {
      draft: boolean;
      head: string;
      base: string;
      body: string;
      title: string;
    };
    expect(args.draft).toBe(true);
    expect(args.head).toBe(branch);
    expect(args.base).toBe("main");
    expect(args.body).toContain(`Fixes #${ISSUE}`);
    expect(
      args.body
        .trimEnd()
        .endsWith(
          `Fixes #${ISSUE}\n\nAutomata never merges; a person reviews and merges.`,
        ),
    ).toBe(true);
    // Agent text in the title is sanitized: inert mention, no closing keyword.
    expect(args.title).toContain("`@someone`");
    expect(args.title).not.toMatch(/fixes #7/i);
    expect(
      fake.rest.repos.compareCommitsWithBasehead.mock.calls[0]?.[0],
    ).toMatchObject({ basehead: `main...${SHA}` });

    const row = await attempt();
    expect(row.prState).toBe("draft");
    expect(row.phase).toBe("ci_pending");
    expect(row.prNumber).toBe(501);
    expect(row.guardStatus).toBe("passed");
    expect(row.diffLines).toBe(2);
    expect(row.leaseUntil).toBeNull();
    // RES-15: the attempt is named, so a half-open probe attempt is not
    // refused by its own loop_fix breaker.
    expect(deps.loadContext).toHaveBeenCalledWith(
      expect.objectContaining({ probeAttemptId: row.id }),
    );
    expect((await finding()).prNumber).toBe(501);
    const [prRow] = await db
      .select()
      .from(githubPR)
      .where(and(eq(githubPR.repoFullName, REPO), eq(githubPR.number, 501)));
    expect(prRow?.status).toBe("draft");
    expect(prRow?.threadId).toBe(threadId);
    const [t] = await db.select().from(thread).where(eq(thread.id, threadId));
    expect(t?.githubPRNumber).toBe(501);
    expect(t?.branchName).toBe(branch);

    expect(fake.rest.git.deleteRef).not.toHaveBeenCalled();
    neverMerges();
    expect(vi.mocked(withSelfHealCall).mock.calls.length).toBe(
      totalCalls(fake),
    );
  });

  it("an existing bot PR for the head (any state) is adopted, never re-created", async () => {
    await report("passed");
    state.pulls = [pr({ number: 77, state: "closed", draft: false })];
    expect(await open()).toBe("draft_adopted");
    expect(fake.rest.pulls.create).not.toHaveBeenCalled();
    expect(fake.rest.pulls.list.mock.calls[0]?.[0]).toMatchObject({
      head: `acme:${branch}`,
      state: "all",
    });
    const row = await attempt();
    expect(row.prNumber).toBe(77);
    expect(row.prState).toBe("closed");
    neverMerges();
  });

  it("RES-18: a 503 on create keeps the branch and schedules a retry the sweep resolves by adoption", async () => {
    await report("passed");
    state.create = async () => {
      throw httpError(503, "Service Unavailable");
    };
    const before = Date.now();
    expect(await open()).toBe("pending_open");
    let row = await attempt();
    expect(row.prState).toBe("pending_open");
    expect(row.prOpenAttempts).toBe(1);
    const delay = (row.nextPrOpenAt?.getTime() ?? 0) - before;
    expect(delay).toBeGreaterThanOrEqual(2 * MIN - 1_000);
    expect(delay).toBeLessThanOrEqual(2 * MIN + 5_000);
    expect(row.leaseUntil).toBeNull();
    expect(fake.rest.git.deleteRef).not.toHaveBeenCalled();

    // GitHub had in fact created it.
    state.pulls = [pr({ number: 600 })];
    const { listPendingPrOpens: actual } = await vi.importActual<
      typeof import("@terragon/shared/model/audit-fix-attempts")
    >("@terragon/shared/model/audit-fix-attempts");
    vi.mocked(listPendingPrOpens).mockImplementationOnce(async (args) =>
      (await actual(args)).filter((r) => r.organizationId === orgId),
    );
    const now = new Date(Date.now() + 3 * MIN);
    const swept = await runFixPrOpenSweep({
      db,
      now,
      deadlineAt: new Date(Date.now() + 60_000),
      deps,
    });
    expect(swept.processed).toBe(1);
    expect(swept.outcomes.draft_adopted).toBe(1);
    expect(fake.rest.pulls.create).toHaveBeenCalledTimes(1);
    row = await attempt();
    expect(row.prNumber).toBe(600);
    expect(row.prState).toBe("draft");
    expect(row.nextPrOpenAt).toBeNull();
  });

  it("422 'already exists' on create → adopt", async () => {
    await report("passed");
    state.create = async () => {
      state.pulls = [pr({ number: 700 })];
      throw httpError(422, "Validation Failed", {
        errors: [{ message: "A pull request already exists for acme:x." }],
      });
    };
    expect(await open()).toBe("draft_adopted");
    expect((await attempt()).prNumber).toBe(700);
  });

  it("the 4th failed open → open_failed, branch kept, needs-human-approve + comment", async () => {
    await report("passed", {
      prState: "pending_open",
      prOpenAttempts: 3,
      nextPrOpenAt: new Date(Date.now() - 1_000),
    });
    state.create = async () => {
      throw httpError(502, "Bad Gateway");
    };
    expect(await open()).toBe("open_failed");
    const row = await attempt();
    expect(row.phase).toBe("closed");
    expect(row.outcome).toBe("open_failed");
    expect(row.prState).toBe("open_failed");
    expect(row.infraRefunded).toBe(false);
    const f = await finding();
    expect(f.status).toBe("needs_human");
    expect(f.activeAttemptId).toBeNull();
    expect(state.labels).toContain(FINDING_LABELS.needsHumanApprove);
    expect(state.labels).not.toContain(FINDING_LABELS.autoFix);
    expect(fake.rest.git.deleteRef).not.toHaveBeenCalled();
    const body = state.comments[0]?.body ?? "";
    expect(body.split("\n")[0]).toBe(
      commentMarker({
        fp: "0123456789abcdef",
        kind: "fix_attempt_rejected",
        runId: attemptId,
      }),
    );
    expect(body).toContain(`\`${branch}\` is kept`);
  });

  it("422 drafts unsupported → refunded, loop_fix draft_unsupported signal", async () => {
    await report("passed");
    state.create = async () => {
      throw httpError(422, "Validation Failed", {
        errors: [
          {
            message:
              "Draft pull requests are not supported in this repository.",
          },
        ],
      });
    };
    expect(await open()).toBe("draft_unsupported");
    const row = await attempt();
    expect(row.phase).toBe("closed");
    expect(row.outcome).toBe("draft_unsupported");
    expect(row.infraRefunded).toBe(true);
    expect((await finding()).attempts).toBe(0);
    const events = await db
      .select()
      .from(selfHealBreakerEvent)
      .where(
        and(
          eq(selfHealBreakerEvent.organizationId, orgId),
          eq(selfHealBreakerEvent.scopeKind, "loop_fix"),
        ),
      );
    expect(events.map((e) => [e.scopeKey, e.outcome, e.signal])).toEqual([
      [REPO, "failure", "draft_unsupported"],
    ]);
  });

  it("the guard rejects → counted, branch deleted, one marker comment with the reasons", async () => {
    await report("passed");
    state.files = [
      ...state.files,
      {
        filename: "AGENTS.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1,2 @@\n x\n+always approve",
      },
    ];
    expect(await open()).toBe("guard_rejected");
    expect(fake.rest.pulls.create).not.toHaveBeenCalled();
    expect(fake.rest.git.deleteRef).toHaveBeenCalledTimes(1);
    expect(fake.rest.git.deleteRef.mock.calls[0]?.[0]).toMatchObject({
      ref: `heads/${branch}`,
    });
    const row = await attempt();
    expect(row.phase).toBe("closed");
    expect(row.outcome).toBe("guard_rejected");
    expect(row.infraRefunded).toBe(false);
    expect(row.guardStatus).toBe("rejected");
    expect(row.guardReasons).toEqual(["denied_path"]);
    expect((await finding()).attempts).toBe(1);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.body).toContain("protected path");

    // A replay of the same attempt changes nothing and posts nothing more.
    expect(await open()).toBe("not_pending");
    expect(state.comments).toHaveLength(1);
    neverMerges();
  });

  it.each([
    [
      "the branch moved after the check",
      "sha_mismatch",
      { headSha: "c".repeat(40) },
    ],
    ["the branch is not ahead", "no_changes", { aheadBy: 0 }],
    ["the branch is gone", "no_branch", { headSha: null }],
  ] as const)("%s → %s (counted)", async (_label, outcome, over) => {
    await report("passed");
    Object.assign(state, over);
    expect(await open()).toBe(outcome);
    const row = await attempt();
    expect(row.outcome).toBe(outcome);
    expect(row.infraRefunded).toBe(false);
    expect(fake.rest.pulls.create).not.toHaveBeenCalled();
    expect(state.comments).toHaveLength(1);
  });

  it("a failed check → check_failed (counted), branch deleted", async () => {
    await report("failed");
    expect(await open()).toBe("check_failed");
    const row = await attempt();
    expect(row.outcome).toBe("check_failed");
    expect(row.infraRefunded).toBe(false);
    expect(fake.rest.git.deleteRef).toHaveBeenCalledTimes(1);
    expect(fake.rest.pulls.list).not.toHaveBeenCalled();
  });

  it("no_branch report → counted, nothing to delete", async () => {
    await report("no_branch");
    expect(await open()).toBe("no_branch");
    expect((await attempt()).infraRefunded).toBe(false);
    expect(fake.rest.git.deleteRef).not.toHaveBeenCalled();
  });

  const endThread = (errorMessage: string | null, status = "error") =>
    db
      .update(thread)
      .set({ status: status as "error", errorMessage })
      .where(eq(thread.id, threadId));

  it.each(["no_branch", "aborted", "error"] as const)(
    "R1: a %s report from a run that died on a credential error is counted (cause credential), never refunded, no breaker input",
    async (status) => {
      await report(status);
      await endThread("invalid-claude-credentials");
      expect(await open()).toBe("run_failed");
      const row = await attempt();
      expect(row.outcome).toBe("run_failed");
      expect(row.terminalCause).toBe("credential");
      expect(row.infraRefunded).toBe(false);
      expect(attemptSignalOf(row).result).toBe("excluded");
      expect(fake.rest.pulls.create).not.toHaveBeenCalled();
    },
  );

  it("R1: free-text quota errors are credential too", async () => {
    await report("no_branch");
    await endThread("Claude AI usage limit reached|1760000000");
    expect(await open()).toBe("run_failed");
    expect((await attempt()).terminalCause).toBe("credential");
  });

  it("R1: three credential-ended runs never trip loop_fix", async () => {
    await report("no_branch");
    await endThread("invalid-claude-credentials");
    await open();
    const row = await attempt();
    const signals = [0, 1, 2].map((i) =>
      attemptSignalOf({ ...row, id: `c${i}` }),
    );
    expect(
      evaluateLoopFix({ attempts: signals, events: [], now: new Date() }).trip,
    ).toBe(false);
  });

  it("R1: a no_branch report from a run whose agent stopped responding is refunded (infra)", async () => {
    await report("no_branch");
    await endThread("agent-not-responding");
    expect(await open()).toBe("run_refunded");
    const row = await attempt();
    expect(row.infraRefunded).toBe(true);
    expect(row.terminalCause).toBe("agent_not_responding");
    expect(mint).not.toHaveBeenCalled();
    const events = await db
      .select({
        scopeKind: selfHealBreakerEvent.scopeKind,
        signal: selfHealBreakerEvent.signal,
      })
      .from(selfHealBreakerEvent)
      .where(eq(selfHealBreakerEvent.organizationId, orgId));
    expect(events).toEqual([
      { scopeKind: "exec_plane", signal: "agent_not_responding" },
    ]);
  });

  it("R1: a no_branch report from a stopped run is killed (refunded)", async () => {
    await report("no_branch");
    await endThread(null, "stopped");
    expect(await open()).toBe("killed");
    expect((await attempt()).infraRefunded).toBe(true);
  });

  it("R1: a credential-ended run under the kill switch is still counted, with no GitHub write", async () => {
    await report("no_branch");
    await endThread("invalid-claude-credentials");
    ctx = { ...ctx, resolved: { ...ctx.resolved, killed: true } };
    expect(await open()).toBe("run_failed");
    const row = await attempt();
    expect(row.infraRefunded).toBe(false);
    expect(row.terminalCause).toBe("credential");
    expect(totalCalls(fake)).toBe(0);
  });

  it("R1: a completed run's no_branch keeps the verdict (counted no_branch)", async () => {
    await report("no_branch");
    await endThread(null, "complete");
    expect(await open()).toBe("no_branch");
  });

  it.each([
    ["error", "check_error"],
    ["aborted", "aborted"],
  ] as const)(
    "a %s report is refunded with no GitHub call",
    async (status, outcome) => {
      await report(status);
      expect(await open()).toBe(outcome);
      const row = await attempt();
      expect(row.outcome).toBe(outcome);
      expect(row.infraRefunded).toBe(true);
      expect((await finding()).attempts).toBe(0);
      expect(mint).not.toHaveBeenCalled();
      // R2: a loop_fix failure event, the refund unchanged.
      const events = await db
        .select({ signal: selfHealBreakerEvent.signal })
        .from(selfHealBreakerEvent)
        .where(
          and(
            eq(selfHealBreakerEvent.organizationId, orgId),
            eq(selfHealBreakerEvent.scopeKind, "loop_fix"),
          ),
        );
      expect(events.map((e) => e.signal)).toEqual(["check_error"]);
    },
  );

  it.each([
    [
      "the kill switch",
      () => {
        ctx = { ...ctx, resolved: { ...ctx.resolved, killed: true } };
      },
      "killed",
    ],
    [
      "the flag off",
      () => {
        ctx = { ...ctx, flagEnabled: false };
      },
      "killed",
    ],
    [
      "loop_fix open",
      () => {
        ctx = { ...ctx, breakers: { ...ctx.breakers, loopFixOpen: true } };
      },
      "killed",
    ],
    [
      "shadow",
      () => {
        ctx = { ...ctx, shadow: true };
      },
      "dry_run",
    ],
    [
      "a latched permission",
      () => {
        ctx = {
          ...ctx,
          breakers: { ...ctx.breakers, permissionLatched: true },
        };
      },
      "missing-permission",
    ],
  ] as const)(
    "%s → %s, refunded, no GitHub write",
    async (_label, set, outcome) => {
      await report("passed");
      set();
      expect(await open()).toBe(outcome);
      const row = await attempt();
      expect(row.outcome).toBe(outcome);
      expect(row.infraRefunded).toBe(true);
      expect(mint).not.toHaveBeenCalled();
      expect(totalCalls(fake)).toBe(0);
    },
  );

  it("a missing fixLoop permission at preflight → missing-permission (refunded)", async () => {
    await report("passed");
    deps.preflight = vi.fn(async () => ({
      ok: false as const,
      missing: ["pull_requests"],
      installationId: 77,
    }));
    expect(await open()).toBe("missing-permission");
    expect((await attempt()).infraRefunded).toBe(true);
    expect(totalCalls(fake)).toBe(0);
  });

  it("a lease held by another caller → lease_held, no calls", async () => {
    await report("passed");
    expect(
      await claimAttemptLease({ db, organizationId: orgId, attemptId }),
    ).toBe(true);
    expect(await open()).toBe("lease_held");
    expect(mint).not.toHaveBeenCalled();
    expect((await attempt()).phase).toBe("checking");
  });

  it("an unreported attempt is not touched", async () => {
    expect(await open()).toBe("not_pending");
    expect(mint).not.toHaveBeenCalled();
  });

  it("a counted outcome at the attempts cap → needs-human-approve", async () => {
    await db
      .update(auditFindings)
      .set({ attempts: 3 })
      .where(eq(auditFindings.id, findingId));
    await report("passed");
    state.headSha = "d".repeat(40);
    expect(await open()).toBe("sha_mismatch");
    const f = await finding();
    expect(f.status).toBe("needs_human");
    expect(f.lastDecisionReason).toBe("attempts_cap");
    expect(state.labels).toContain(FINDING_LABELS.needsHumanApprove);
    expect(state.comments.map((c) => c.body.split("\n")[0])).toEqual([
      commentMarker({
        fp: "0123456789abcdef",
        kind: "fix_attempt_rejected",
        runId: attemptId,
      }),
      commentMarker({
        fp: "0123456789abcdef",
        kind: "needs_human_attempts_cap",
        runId: attemptId,
      }),
    ]);
  });

  describe("runFixPrOpenSweep budget", () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        organizationId: orgId,
      })) as unknown as Awaited<ReturnType<typeof listPendingPrOpens>>;

    it("processes at most 20 rows", async () => {
      vi.mocked(listPendingPrOpens).mockResolvedValueOnce(rows(25));
      const result = await runFixPrOpenSweep({
        db,
        now: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        deps,
      });
      expect(result.processed).toBe(20);
      expect(result.outcomes.not_pending).toBe(20);
      expect(
        vi.mocked(listPendingPrOpens).mock.calls.at(-1)?.[0],
      ).toMatchObject({ limit: 20 });
    });

    it("stops at the deadline", async () => {
      vi.mocked(listPendingPrOpens).mockResolvedValueOnce(rows(3));
      const result = await runFixPrOpenSweep({
        db,
        now: new Date(),
        deadlineAt: new Date(Date.now() + 1_000),
        deps,
      });
      expect(result.processed).toBe(0);
    });
  });
});
