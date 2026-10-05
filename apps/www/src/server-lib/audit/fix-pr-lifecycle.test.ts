import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Octokit } from "octokit";

import { db } from "@/lib/db";
import {
  auditFindings,
  auditFixAttempts,
  selfHealBreakerEvent,
} from "@terragon/shared/db/schema";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  claimFixAttempt,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { createOrganization } from "@terragon/shared/model/organizations";

import {
  changedRangesOf,
  countHumanCommits,
  FIX_PR_RANGES_MAX_FILES,
  handleSelfHealPrClosed,
  runFixPrSettleSweep,
  type FixPrLifecycleDeps,
} from "./fix-pr-lifecycle";
import { commentMarker, FINDING_LABELS } from "./render-issue";
import {
  resolveSelfHealFromRows,
  type SelfHealContext,
} from "./resolve-self-heal";

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

const REPO = "Acme/Widgets";
const BOT = "automata-app[bot]";
const GATED = "a".repeat(40);
const MERGE_SHA = "f".repeat(40);
const FP = "0123456789abcdef";
const ISSUE = 42;
const DAY = 86_400_000;
const MIN = 60_000;

function ok<T>(data: T) {
  return { data, status: 200, headers: {} };
}

interface FakeState {
  pull: {
    state: string;
    draft: boolean;
    merged: boolean;
    merged_at: string | null;
    merge_commit_sha: string | null;
    merged_by: { login: string } | null;
  };
  commits: Array<{ sha: string; author: { login: string; type?: string } }>;
  files: Array<{ filename: string; status: string; patch?: string }>;
  comments: Array<{
    id: number;
    number: number;
    body: string;
    user: { login: string };
  }>;
  labels: Map<number, string[]>;
  failFiles?: boolean;
}

function fakeOctokit(state: FakeState) {
  const labelsOf = (n: number) => state.labels.get(n) ?? [];
  const rest = {
    pulls: {
      get: vi.fn(async () => ok(state.pull)),
      listCommits: vi.fn(async (_args: unknown) => ok(state.commits)),
      listFiles: vi.fn(
        async ({ page, per_page }: { page: number; per_page: number }) => {
          if (state.failFiles) {
            throw Object.assign(new Error("boom"), {
              status: 502,
              response: { headers: {} },
            });
          }
          return ok(state.files.slice((page - 1) * per_page, page * per_page));
        },
      ),
      update: vi.fn(),
      merge: vi.fn(),
      updateBranch: vi.fn(),
    },
    repos: { merge: vi.fn() },
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
  const graphql = vi.fn();
  return { rest, graphql };
}

type Fake = ReturnType<typeof fakeOctokit>;

describe("countHumanCommits / changedRangesOf", () => {
  it("counts non-bot commits after the gated head", () => {
    const commits = [
      { sha: "1", author: { login: BOT } },
      { sha: GATED, author: { login: BOT } },
      { sha: "3", author: { login: "octocat" } },
      { sha: "4", author: { login: "dependabot[bot]" } },
      { sha: "5", author: { login: "x", type: "Bot" } },
      { sha: "6", author: { login: "hubot" } },
    ];
    expect(countHumanCommits(commits, GATED, BOT)).toBe(2);
  });

  it("counts every non-bot commit when the gated head is gone", () => {
    const commits = [
      { sha: "1", author: { login: "octocat" } },
      { sha: "2", author: { login: BOT.toUpperCase() } },
    ];
    expect(countHumanCommits(commits, GATED, BOT)).toBe(1);
  });

  it("new-side ranges per file, skipping removed and patchless files, capped at 50", () => {
    expect(
      changedRangesOf([
        { filename: "a.ts", status: "modified", patch: "@@ -1,2 +1,3 @@" },
        { filename: "gone.ts", status: "removed", patch: "@@ -1,2 +0,0 @@" },
        { filename: "bin.png", status: "modified" },
      ]),
    ).toEqual([{ file: "a.ts", ranges: [[1, 3]] }]);
    const many = Array.from({ length: 60 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@",
    }));
    expect(changedRangesOf(many)).toHaveLength(FIX_PR_RANGES_MAX_FILES);
  });
});

describe("fix PR lifecycle (R5, SC4, HUMAN-MERGE-GATE)", () => {
  let orgId: string;
  let findingId: string;
  let attemptId: string;
  let branch: string;
  let prNumber: number;
  let state: FakeState;
  let fake: Fake;
  let ctx: SelfHealContext;
  let deps: Partial<FixPrLifecycleDeps>;
  let mint: ReturnType<typeof vi.fn>;
  let scheduled: Promise<unknown>[];
  let lines: string[];

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

  const lifecycleEvents = () =>
    db
      .select({ signal: selfHealBreakerEvent.signal })
      .from(selfHealBreakerEvent)
      .where(
        and(
          eq(selfHealBreakerEvent.organizationId, orgId),
          eq(selfHealBreakerEvent.scopeKind, "loop_fix"),
          eq(selfHealBreakerEvent.scopeKey, REPO.toLowerCase()),
        ),
      );

  const neverMerges = () => {
    expect(fake.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fake.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(fake.rest.repos.merge).not.toHaveBeenCalled();
    expect(fake.graphql).not.toHaveBeenCalled();
  };

  const payload = (over: Record<string, unknown> = {}) => ({
    action: "closed",
    pull_request: {
      number: prNumber,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      merged_by: null,
      head: { ref: branch },
      ...over,
    },
    repository: { full_name: REPO.toLowerCase() },
  });

  const mergedPayload = () =>
    payload({
      merged: true,
      merged_at: "2026-10-05T12:00:00Z",
      merge_commit_sha: MERGE_SHA,
      merged_by: { login: "octocat" },
    });

  const settleScheduled = async () => {
    await Promise.all(scheduled);
  };

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
        planFiles: ["src/a.ts"],
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
    prNumber = Math.floor(Math.random() * 1_000_000_000) + 1;
    await updateFixAttempt({
      db,
      organizationId: orgId,
      id: attemptId,
      patch: {
        phase: "ready",
        checkStatus: "passed",
        guardStatus: "passed",
        gatedHeadSha: GATED,
        prNumber,
        prState: "ready",
        prOpenedAt: new Date(Date.now() - 60 * MIN),
        readyAt: new Date(Date.now() - 30 * MIN),
      },
    });

    state = {
      pull: {
        state: "closed",
        draft: false,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        merged_by: null,
      },
      commits: [
        { sha: GATED, author: { login: BOT } },
        { sha: "e".repeat(40), author: { login: "octocat" } },
      ],
      files: [
        {
          filename: "src/a.ts",
          status: "modified",
          patch: "@@ -10,3 +12,5 @@\n-a\n+b",
        },
        { filename: "src/b.ts", status: "added", patch: "@@ -0,0 +1,2 @@" },
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
        settings: { ...resolved.settings, mode: "on", maxAttempts: 3 },
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
    scheduled = [];
    lines = [];
    deps = {
      db,
      loadContext: vi.fn(async () => ctx),
      mint,
      callDeps: {
        now: () => new Date(),
        log: () => {},
        sleep: async () => {},
        rand: () => 0,
      },
      botLogin: () => BOT,
      now: () => new Date(),
      log: () => {},
      line: (line) => lines.push(line),
      capture: vi.fn(),
      schedule: (p) => {
        scheduled.push(p);
      },
    };
  });

  it("merged → merge recorded at once, GitHub reads in waitUntil, regression window +30 days, one decision line", async () => {
    await handleSelfHealPrClosed(mergedPayload(), deps);
    // The DB half is synchronous; the GitHub reads were only scheduled.
    let row = await attempt();
    expect(row).toMatchObject({
      mergeSha: MERGE_SHA,
      mergedBy: "octocat",
      outcome: "merged",
      prState: "merged",
      phase: "closed",
      humanCommitCount: null,
      changedRanges: null,
    });
    expect(row.mergedAt?.toISOString()).toBe("2026-10-05T12:00:00.000Z");
    expect(row.regressionWindowEndsAt?.getTime()).toBe(
      Date.parse("2026-10-05T12:00:00Z") + 30 * DAY,
    );
    expect(scheduled).toHaveLength(1);

    await settleScheduled();
    row = await attempt();
    expect(row.humanCommitCount).toBe(1);
    expect(row.changedRanges).toEqual([
      { file: "src/a.ts", ranges: [[12, 16]] },
      { file: "src/b.ts", ranges: [[1, 2]] },
    ]);
    expect(fake.rest.pulls.listCommits.mock.calls[0]?.[0]).toMatchObject({
      pull_number: prNumber,
      per_page: 100,
    });
    expect(fake.rest.pulls.listFiles).toHaveBeenCalledTimes(1);

    const f = await finding();
    expect(f.activeAttemptId).toBeNull();
    expect(f.fixReadyAt).toBeNull();
    expect(f.attempts).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("decision=pr_open reason=merged mode=on");
    expect(lines[0]).toContain(`run=${attemptId}`);
    expect((await lifecycleEvents()).map((e) => e.signal)).toEqual([
      "pr_merged",
    ]);
    neverMerges();
  });

  it("a repeat merged delivery is a no-op", async () => {
    await handleSelfHealPrClosed(mergedPayload(), deps);
    await settleScheduled();
    await handleSelfHealPrClosed(mergedPayload(), deps);
    expect(scheduled).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(await lifecycleEvents()).toHaveLength(1);
  });

  it("listFiles pages stop at 3; a failed file read leaves the ranges null", async () => {
    state.files = Array.from({ length: 400 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: "modified",
      patch: "@@ -1 +1 @@",
    }));
    await handleSelfHealPrClosed(mergedPayload(), deps);
    await settleScheduled();
    expect(fake.rest.pulls.listFiles).toHaveBeenCalledTimes(3);
    expect((await attempt()).changedRanges).toHaveLength(50);
  });

  it("a failed GitHub read keeps the merge record; the detail stays null", async () => {
    state.failFiles = true;
    await handleSelfHealPrClosed(mergedPayload(), deps);
    await settleScheduled();
    const row = await attempt();
    expect(row.outcome).toBe("merged");
    expect(row.changedRanges).toBeNull();
    expect(row.humanCommitCount).toBe(1);
  });

  it("closed unmerged → attempt counted, finding free after the cooldown, pr_closed event, no GitHub call under the cap", async () => {
    await handleSelfHealPrClosed(payload(), deps);
    const row = await attempt();
    expect(row).toMatchObject({
      phase: "closed",
      prState: "closed",
      outcome: "pr_closed",
      terminalCause: "closed_unmerged",
      infraRefunded: false,
      mergedAt: null,
    });
    const f = await finding();
    expect(f.attempts).toBe(1);
    expect(f.activeAttemptId).toBeNull();
    expect(f.status).toBe("open");
    expect(f.fixReadyAt).not.toBeNull();
    expect(f.lastAttemptAt).not.toBeNull();
    expect(mint).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
    expect(lines[0]).toContain("decision=pr_open reason=closed_unmerged");
    expect((await lifecycleEvents()).map((e) => e.signal)).toEqual([
      "pr_closed",
    ]);
  });

  it("closed unmerged at the attempts cap → needs-human-approve via the IssueWriter", async () => {
    ctx.resolved.settings.maxAttempts = 1;
    await handleSelfHealPrClosed(payload(), deps);
    const f = await finding();
    expect(f.status).toBe("needs_human");
    expect(f.lastDecisionReason).toBe("attempts_cap");
    expect(state.labels.get(ISSUE)).toContain(FINDING_LABELS.needsHumanApprove);
    expect(state.comments.map((c) => c.body.split("\n")[0])).toEqual([
      commentMarker({
        fp: FP,
        kind: "needs_human_attempts_cap",
        runId: attemptId,
      }),
    ]);
    neverMerges();
  });

  it("at the cap with mode off, the DB moves but GitHub is not touched (KILL-01)", async () => {
    ctx.resolved.settings.maxAttempts = 1;
    ctx.flagEnabled = false;
    await handleSelfHealPrClosed(payload(), deps);
    expect((await finding()).status).toBe("needs_human");
    expect(mint).not.toHaveBeenCalled();
  });

  it("a PR the platform already withdrew (attempt closed) is a no-op", async () => {
    await updateFixAttempt({
      db,
      organizationId: orgId,
      id: attemptId,
      patch: { phase: "closed", outcome: "ci_failed", prState: "closed" },
    });
    await handleSelfHealPrClosed(payload(), deps);
    const row = await attempt();
    expect(row.outcome).toBe("ci_failed");
    expect(lines).toHaveLength(0);
    expect(await lifecycleEvents()).toHaveLength(0);
  });

  it("an unknown PR → no Octokit, no write, nothing scheduled", async () => {
    await handleSelfHealPrClosed(
      { ...mergedPayload(), pull_request: { number: prNumber + 1 } },
      deps,
    );
    await handleSelfHealPrClosed(
      { ...payload(), repository: { full_name: "other/repo" } },
      deps,
    );
    expect(mint).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
    expect(deps.loadContext).not.toHaveBeenCalled();
    expect((await attempt()).phase).toBe("ready");
  });

  it("a PR whose head branch is not the attempt's is ignored (T-09-14-1)", async () => {
    await handleSelfHealPrClosed(
      payload({ head: { ref: "feature/other" } }),
      deps,
    );
    expect((await attempt()).phase).toBe("ready");
    expect(mint).not.toHaveBeenCalled();
  });

  it("not a closed action, or a malformed payload → ignored", async () => {
    await handleSelfHealPrClosed({ ...payload(), action: "opened" }, deps);
    await handleSelfHealPrClosed(null, deps);
    await handleSelfHealPrClosed({ action: "closed" }, deps);
    expect((await attempt()).phase).toBe("ready");
  });

  it("an Octokit error in the waitUntil is logged, never thrown", async () => {
    const log = vi.fn();
    mint.mockRejectedValueOnce(new Error("mint down"));
    await expect(
      handleSelfHealPrClosed(mergedPayload(), { ...deps, log }),
    ).resolves.toBeUndefined();
    await expect(settleScheduled()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "[self-heal] fix PR lifecycle token mint failed",
      expect.objectContaining({ attemptId }),
    );
    expect((await attempt()).outcome).toBe("merged");
  });

  it("a DB failure is logged, never thrown", async () => {
    const failing = {
      select: () => {
        throw new Error("db down");
      },
    } as unknown as typeof db;
    const log = vi.fn();
    await expect(
      handleSelfHealPrClosed(payload(), { ...deps, db: failing, log }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "[self-heal] fix PR lifecycle failed",
      expect.anything(),
    );
  });

  describe("settle sweep (09-11 / 09-12: PR already merged or closed while ci_pending)", () => {
    const sweep = () =>
      runFixPrSettleSweep({
        db,
        now: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        limit: 1000,
        deps,
      });

    beforeEach(async () => {
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: { phase: "ci_pending", prState: "draft", readyAt: null },
      });
    });

    it("a draft a person merged is settled from pulls.get, detail read inline", async () => {
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: { prState: "merged" },
      });
      state.pull = {
        state: "closed",
        draft: true,
        merged: true,
        merged_at: "2026-10-05T12:00:00Z",
        merge_commit_sha: MERGE_SHA,
        merged_by: { login: "octocat" },
      };
      const result = await sweep();
      expect(result.outcomes.merged).toBeGreaterThanOrEqual(1);
      const row = await attempt();
      expect(row).toMatchObject({
        outcome: "merged",
        phase: "closed",
        mergeSha: MERGE_SHA,
        mergedBy: "octocat",
        humanCommitCount: 1,
        leaseUntil: null,
      });
      expect(row.changedRanges).not.toBeNull();
      expect(scheduled).toHaveLength(0);
      expect((await finding()).activeAttemptId).toBeNull();
      neverMerges();
    });

    it("an adopted PR that was already closed is counted", async () => {
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: { prState: "closed" },
      });
      await sweep();
      const row = await attempt();
      expect(row.outcome).toBe("pr_closed");
      expect(row.phase).toBe("closed");
      expect((await finding()).attempts).toBe(1);
    });

    it("a PR open again puts the PR state back; nothing is closed", async () => {
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: { prState: "closed" },
      });
      state.pull = { ...state.pull, state: "open", draft: true };
      await sweep();
      const row = await attempt();
      expect(row.prState).toBe("draft");
      expect(row.phase).toBe("ci_pending");
    });

    it("an unreadable PR is skipped and retried later", async () => {
      await updateFixAttempt({
        db,
        organizationId: orgId,
        id: attemptId,
        patch: { prState: "merged" },
      });
      mint.mockRejectedValueOnce(new Error("mint down"));
      await sweep();
      const row = await attempt();
      expect(row.phase).toBe("ci_pending");
      expect(row.leaseUntil).toBeNull();
    });
  });
});
