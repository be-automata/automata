import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Octokit } from "octokit";

import { db } from "@/lib/db";
import { auditFindings, auditFixAttempts } from "@terragon/shared/db/schema";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  claimAttemptLease,
  claimFixAttempt,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { createOrganization } from "@terragon/shared/model/organizations";

import {
  evaluateFixCi,
  FIX_CI_STUCK_MS,
  FIX_CI_SWEEP_LIMIT,
  runStuckDraftSweep,
} from "./evaluate-fix-ci";
import { defaultOpenFixPrDeps, type OpenFixPrDeps } from "./open-fix-pr";
import { commentMarker, FINDING_LABELS } from "./render-issue";
import {
  resolveSelfHealFromRows,
  type SelfHealContext,
} from "./resolve-self-heal";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = "acme/widgets";
const BOT = "automata-app[bot]";
const SHA = "b".repeat(40);
const ISSUE = 42;
const PR = 501;
const FP = "0123456789abcdef";
const MIN = 60_000;

interface RunState {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
}

interface FakeState {
  pr: {
    state: string;
    draft: boolean;
    merged_at: string | null;
    headSha: string;
  };
  branch: () => Promise<unknown>;
  checkRuns: RunState[];
  statuses: Array<{ context: string; state: string; updated_at: string }>;
  files: unknown[];
  comments: Array<{
    id: number;
    number: number;
    body: string;
    user: { login: string };
  }>;
  labels: Map<number, string[]>;
}

function ok<T>(data: T) {
  return { data, status: 200, headers: {} };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), {
    status,
    response: { headers: {} },
  });
}

function protectedBranch(names: string[]) {
  return async () =>
    ok({
      protected: true,
      protection: {
        required_status_checks: { contexts: names, checks: [] },
      },
    });
}

function fakeOctokit(state: FakeState) {
  const labelsOf = (n: number) => state.labels.get(n) ?? [];
  const rest = {
    pulls: {
      get: vi.fn(async () =>
        ok({
          number: PR,
          node_id: "PR_node_501",
          state: state.pr.state,
          draft: state.pr.draft,
          merged_at: state.pr.merged_at,
          head: { sha: state.pr.headSha, ref: "automata/fix" },
          base: { ref: "main" },
        }),
      ),
      update: vi.fn(async ({ state: s }: { state?: string }) => {
        if (s) state.pr.state = s;
        return ok({});
      }),
      merge: vi.fn(),
      updateBranch: vi.fn(),
    },
    repos: {
      getBranch: vi.fn(async () => state.branch()),
      getBranchRules: vi.fn(async () => ok([])),
      getCombinedStatusForRef: vi.fn(async () =>
        ok({ state: "success", statuses: state.statuses }),
      ),
      compareCommitsWithBasehead: vi.fn(async () =>
        ok({ ahead_by: 1, files: state.files }),
      ),
      merge: vi.fn(),
    },
    checks: {
      listForRef: vi.fn(async () =>
        ok({
          total_count: state.checkRuns.length,
          check_runs: state.checkRuns,
        }),
      ),
    },
    git: {
      deleteRef: vi.fn(async (_args: unknown) => ok(undefined)),
    },
    issues: {
      listComments: vi.fn(async ({ issue_number }: { issue_number: number }) =>
        ok(state.comments.filter((c) => c.number === issue_number)),
      ),
      createComment: vi.fn(
        async ({
          issue_number,
          body,
        }: {
          issue_number: number;
          body: string;
        }) => {
          const id = state.comments.length + 1;
          state.comments.push({
            id,
            number: issue_number,
            body,
            user: { login: BOT },
          });
          return ok({ id });
        },
      ),
      updateComment: vi.fn(async () => ok({})),
      get: vi.fn(async ({ issue_number }: { issue_number: number }) =>
        ok({
          number: issue_number,
          state: "open",
          labels: labelsOf(issue_number).map((name) => ({ name })),
          created_at: "",
        }),
      ),
      addLabels: vi.fn(
        async ({
          issue_number,
          labels,
        }: {
          issue_number: number;
          labels: string[];
        }) => {
          state.labels.set(issue_number, [
            ...labelsOf(issue_number),
            ...labels,
          ]);
          return ok([]);
        },
      ),
      removeLabel: vi.fn(
        async ({
          issue_number,
          name,
        }: {
          issue_number: number;
          name: string;
        }) => {
          state.labels.set(
            issue_number,
            labelsOf(issue_number).filter((l) => l !== name),
          );
          return ok([]);
        },
      ),
    },
  };
  const graphql = vi.fn(async () => ({
    markPullRequestReadyForReview: {
      pullRequest: { id: "PR_node_501", isDraft: false },
    },
  }));
  return { rest, graphql };
}

type Fake = ReturnType<typeof fakeOctokit>;

function writeCalls(fake: Fake): number {
  return (
    fake.graphql.mock.calls.length +
    fake.rest.pulls.update.mock.calls.length +
    fake.rest.git.deleteRef.mock.calls.length +
    fake.rest.issues.createComment.mock.calls.length +
    fake.rest.issues.updateComment.mock.calls.length +
    fake.rest.issues.addLabels.mock.calls.length +
    fake.rest.issues.removeLabel.mock.calls.length
  );
}

function totalCalls(fake: Fake): number {
  let n = fake.graphql.mock.calls.length;
  for (const group of Object.values(fake.rest)) {
    for (const fn of Object.values(group)) {
      n += (fn as ReturnType<typeof vi.fn>).mock.calls.length;
    }
  }
  return n;
}

const run = (over: Partial<RunState> = {}): RunState => ({
  name: "test",
  status: "completed",
  conclusion: "success",
  completed_at: new Date(Date.now() - 5 * MIN).toISOString(),
  ...over,
});

describe("evaluateFixCi (GATE-01 steps 4-5, SC4, R4, KILL-01)", () => {
  let orgId: string;
  let findingId: string;
  let attemptId: string;
  let branch: string;
  let state: FakeState;
  let fake: Fake;
  let ctx: SelfHealContext;
  let deps: OpenFixPrDeps;
  let mint: ReturnType<typeof vi.fn>;

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

  const evaluate = () =>
    evaluateFixCi({ db, organizationId: orgId, attemptId, deps });

  const firstLines = (number: number) =>
    state.comments
      .filter((c) => c.number === number)
      .map((c) => c.body.split("\n")[0]);

  const neverMerges = () => {
    expect(fake.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fake.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(fake.rest.repos.merge).not.toHaveBeenCalled();
    for (const call of fake.graphql.mock.calls as unknown[][]) {
      expect(String(call[0])).not.toMatch(
        /enablePullRequestAutoMerge|mergePullRequest/,
      );
    }
  };

  const draft = (over: Parameters<typeof updateFixAttempt>[0]["patch"] = {}) =>
    updateFixAttempt({
      db,
      organizationId: orgId,
      id: attemptId,
      patch: {
        phase: "ci_pending",
        checkReportedAt: new Date(Date.now() - 6 * MIN),
        checkStatus: "passed",
        checkResults: { status: "passed" },
        gatedHeadSha: SHA,
        guardStatus: "passed",
        diffLines: 2,
        prNumber: PR,
        prState: "draft",
        prOpenedAt: new Date(Date.now() - 5 * MIN),
        ...over,
      },
    });

  beforeEach(async () => {
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
        fingerprint: FP,
        audit: "security-audit",
        ruleId: "dep.vulnerable",
        severity: "high",
        checkKind: "script",
        title: "Vulnerable dependency",
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
    await draft();

    state = {
      pr: { state: "open", draft: true, merged_at: null, headSha: SHA },
      branch: protectedBranch(["check", "test"]),
      checkRuns: [run({ name: "check" }), run({ name: "test" })],
      statuses: [],
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-const v = 1;\n+const v = 2;",
        },
      ],
      comments: [],
      labels: new Map([[ISSUE, [FINDING_LABELS.finding]]]),
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

  it("required checks green + head == gated + guard ok → ready via App GraphQL, once", async () => {
    expect(await evaluate()).toBe("ready");

    expect(fake.graphql).toHaveBeenCalledTimes(1);
    const [query, vars] = fake.graphql.mock.calls[0] as unknown as [
      string,
      { pullRequestId: string },
    ];
    expect(query).toContain("markPullRequestReadyForReview");
    expect(vars.pullRequestId).toBe("PR_node_501");

    const row = await attempt();
    expect(row.prState).toBe("ready");
    expect(row.phase).toBe("ready");
    expect(row.readyAt).not.toBeNull();
    expect(row.ciStatus).toBe("passed");
    expect(row.ciResults).toMatchObject({ gateSource: "protection" });
    expect(row.leaseUntil).toBeNull();
    // RES-15: the attempt is named, so a half-open probe attempt is not
    // refused by its own loop_fix breaker.
    expect(deps.loadContext).toHaveBeenCalledWith(
      expect.objectContaining({ probeAttemptId: row.id }),
    );
    expect(fake.rest.pulls.update).not.toHaveBeenCalled();
    expect(fake.rest.git.deleteRef).not.toHaveBeenCalled();
    neverMerges();
  });

  it("a required check still queued → pending, no GitHub write", async () => {
    state.checkRuns = [
      run({ name: "check" }),
      run({ name: "test", status: "queued", conclusion: null }),
    ];
    expect(await evaluate()).toBe("pending");
    expect(writeCalls(fake)).toBe(0);
    const row = await attempt();
    expect(row.prState).toBe("draft");
    expect(row.phase).toBe("ci_pending");
    expect(row.ciStatus).toBe("pending");
    expect(row.ciResults).toMatchObject({ gateSource: "protection" });
    neverMerges();
  });

  it("a required check failed → draft withdrawn, branch deleted, issue comment, counted", async () => {
    state.checkRuns = [
      run({ name: "check" }),
      run({ name: "test", conclusion: "failure" }),
    ];
    expect(await evaluate()).toBe("ci_failed");

    expect(fake.rest.pulls.update).toHaveBeenCalledTimes(1);
    expect(fake.rest.pulls.update.mock.calls[0]?.[0]).toMatchObject({
      pull_number: PR,
      state: "closed",
    });
    expect(fake.rest.git.deleteRef.mock.calls[0]?.[0]).toMatchObject({
      ref: `heads/${branch}`,
    });
    expect(firstLines(PR)).toEqual([
      commentMarker({ fp: FP, kind: "fix_draft_withdrawn", runId: attemptId }),
    ]);
    expect(firstLines(ISSUE)).toEqual([
      commentMarker({ fp: FP, kind: "fix_attempt_rejected", runId: attemptId }),
    ]);
    const row = await attempt();
    expect(row.phase).toBe("closed");
    expect(row.outcome).toBe("ci_failed");
    expect(row.infraRefunded).toBe(false);
    expect(row.prState).toBe("closed");
    expect(row.ciStatus).toBe("failed");
    expect(row.ciResults).toMatchObject({
      gateSource: "protection",
      failing: ["test"],
    });
    expect((await finding()).attempts).toBe(1);
    expect(fake.graphql).not.toHaveBeenCalled();
    neverMerges();
  });

  it("a counted failure at the attempts cap → needs-human-approve", async () => {
    ctx.resolved.settings.maxAttempts = 1;
    state.checkRuns = [run({ name: "check", conclusion: "timed_out" })];
    expect(await evaluate()).toBe("ci_failed");
    const f = await finding();
    expect(f.status).toBe("needs_human");
    expect(f.lastDecisionReason).toBe("attempts_cap");
    expect(state.labels.get(ISSUE)).toContain(FINDING_LABELS.needsHumanApprove);
  });

  it("a cancelled required check → withdrawn, branch deleted, refunded", async () => {
    state.checkRuns = [
      run({ name: "check" }),
      run({ name: "test", conclusion: "cancelled" }),
    ];
    expect(await evaluate()).toBe("ci_infra");
    expect(fake.rest.pulls.update).toHaveBeenCalledTimes(1);
    expect(fake.rest.git.deleteRef).toHaveBeenCalledTimes(1);
    const row = await attempt();
    expect(row.phase).toBe("closed");
    expect(row.infraRefunded).toBe(true);
    expect(row.outcome).toBe("ci_infra");
    expect((await finding()).attempts).toBe(0);
    neverMerges();
  });

  it("the head moved after the check → sha_mismatch (counted)", async () => {
    state.pr.headSha = "d".repeat(40);
    expect(await evaluate()).toBe("sha_mismatch");
    const row = await attempt();
    expect(row.outcome).toBe("sha_mismatch");
    expect(row.infraRefunded).toBe(false);
    expect(fake.rest.pulls.update).toHaveBeenCalledTimes(1);
    expect(fake.graphql).not.toHaveBeenCalled();
    neverMerges();
  });

  it("the guard now rejects the compare diff → guard_rejected (counted)", async () => {
    state.files = [
      {
        filename: "src/a.test.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-expect(a).toBe(1);\n+expect(a).toBe(2);",
      },
    ];
    expect(await evaluate()).toBe("guard_rejected");
    const row = await attempt();
    expect(row.outcome).toBe("guard_rejected");
    expect(row.guardStatus).toBe("rejected");
    expect(row.infraRefunded).toBe(false);
    expect(fake.graphql).not.toHaveBeenCalled();
    neverMerges();
  });

  it("protection removed mid-flight → re-selects all-checks and keeps evaluating", async () => {
    state.checkRuns = [
      run({ name: "check" }),
      run({ name: "test", status: "in_progress", conclusion: null }),
    ];
    expect(await evaluate()).toBe("pending");
    expect((await attempt()).ciResults).toMatchObject({
      gateSource: "protection",
    });

    state.branch = async () => {
      throw httpError(404, "Branch not protected");
    };
    expect(await evaluate()).toBe("pending");
    let row = await attempt();
    expect(row.phase).toBe("ci_pending");
    expect(row.infraRefunded).toBe(false);
    expect(row.ciResults).toMatchObject({ gateSource: "all-checks" });

    state.checkRuns = [run({ name: "check" }), run({ name: "test" })];
    expect(await evaluate()).toBe("ready");
    row = await attempt();
    expect(row.ciResults).toMatchObject({ gateSource: "all-checks" });
    expect(fake.rest.pulls.update).not.toHaveBeenCalled();
    neverMerges();
  });

  it("free plan (403) and no CI within 10 min → finding-check-only: ready + needs-human-approve + note", async () => {
    await draft({ prOpenedAt: new Date(Date.now() - 11 * MIN) });
    state.branch = async () => {
      throw httpError(
        403,
        "Upgrade to GitHub Pro or make this repository public to enable this feature.",
      );
    };
    state.checkRuns = [];
    expect(await evaluate()).toBe("ready");

    expect(fake.graphql).toHaveBeenCalledTimes(1);
    expect(state.labels.get(PR)).toContain(FINDING_LABELS.needsHumanApprove);
    expect(firstLines(PR)).toEqual([
      commentMarker({ fp: FP, kind: "fix_draft_no_repo_ci", runId: attemptId }),
    ]);
    const row = await attempt();
    expect(row.prState).toBe("ready");
    expect(row.ciResults).toMatchObject({ gateSource: "finding-check-only" });
    neverMerges();
  });

  it("no protection and no CI yet at 5 min → pending, never a refusal", async () => {
    state.branch = async () => ok({ protected: false });
    state.checkRuns = [];
    expect(await evaluate()).toBe("pending");
    expect(writeCalls(fake)).toBe(0);
    expect((await attempt()).phase).toBe("ci_pending");
  });

  it("the kill switch → killed: refunded, no GitHub call", async () => {
    ctx.resolved = { ...ctx.resolved, killed: true };
    expect(await evaluate()).toBe("killed");
    const row = await attempt();
    expect(row.phase).toBe("closed");
    expect(row.outcome).toBe("killed");
    expect(row.infraRefunded).toBe(true);
    expect(mint).not.toHaveBeenCalled();
    expect(totalCalls(fake)).toBe(0);
  });

  it("a lease held by the opener → lease_held, no calls", async () => {
    expect(
      await claimAttemptLease({ db, organizationId: orgId, attemptId }),
    ).toBe(true);
    expect(await evaluate()).toBe("lease_held");
    expect(mint).not.toHaveBeenCalled();
    expect((await attempt()).phase).toBe("ci_pending");
  });

  it("an attempt that is not a draft awaiting CI is not touched", async () => {
    await draft({ prState: "ready", phase: "ready" });
    expect(await evaluate()).toBe("not_draft");
    expect(mint).not.toHaveBeenCalled();
  });

  it("never imports the user-token mark-pr-ready action", () => {
    const source = readFileSync(join(HERE, "evaluate-fix-ci.ts"), "utf8");
    expect(source).not.toContain("mark-pr-ready");
    expect(source).not.toMatch(/from\s+["']@\/lib\/github/);
  });

  describe("runStuckDraftSweep", () => {
    // The sweep is cross-org: park every other draft left by earlier tests.
    beforeEach(async () => {
      await db
        .update(auditFixAttempts)
        .set({ phase: "closed" })
        .where(
          and(
            eq(auditFixAttempts.phase, "ci_pending"),
            ne(auditFixAttempts.id, attemptId),
          ),
        );
    });

    it("a draft pending for 61 min → evaluated once, still pending → stuck: withdrawn and refunded", async () => {
      await draft({ prOpenedAt: new Date(Date.now() - 61 * MIN) });
      state.checkRuns = [
        run({ name: "check" }),
        run({ name: "test", status: "queued", conclusion: null }),
      ];
      const result = await runStuckDraftSweep({
        db,
        now: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        deps,
      });
      expect(result.outcomes.stuck).toBeGreaterThanOrEqual(1);
      expect(fake.rest.pulls.get).toHaveBeenCalledTimes(1);
      const row = await attempt();
      expect(row.phase).toBe("closed");
      expect(row.ciStatus).toBe("stuck");
      expect(row.infraRefunded).toBe(true);
      expect(row.outcome).toBe("stuck");
      expect(fake.rest.pulls.update).toHaveBeenCalledTimes(1);
      expect(fake.rest.git.deleteRef).toHaveBeenCalledTimes(1);
      neverMerges();
    });

    it("a younger pending draft is evaluated (missed webhook, settle window) and kept", async () => {
      state.checkRuns = [
        run({ name: "check" }),
        run({ name: "test", status: "queued", conclusion: null }),
      ];
      await runStuckDraftSweep({
        db,
        now: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        deps,
      });
      expect(fake.rest.pulls.get).toHaveBeenCalled();
      const row = await attempt();
      expect(row.phase).toBe("ci_pending");
      expect(row.ciStatus).toBe("pending");
    });

    it("processes at most `limit` drafts (20 per tick) and stops at the deadline", async () => {
      expect(FIX_CI_SWEEP_LIMIT).toBe(20);
      expect(FIX_CI_STUCK_MS).toBe(60 * MIN);
      const limited = await runStuckDraftSweep({
        db,
        now: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        limit: 1,
        deps,
      });
      expect(limited.processed).toBe(1);
      const late = await runStuckDraftSweep({
        db,
        now: new Date(),
        deadlineAt: new Date(Date.now() + 1_000),
        deps,
      });
      expect(late.processed).toBe(0);
    });
  });
});
