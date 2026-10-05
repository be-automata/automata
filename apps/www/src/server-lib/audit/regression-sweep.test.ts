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
  listRegressionCandidates,
  recordFixPrMerged,
  regressionRecordOf,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { createOrganization } from "@terragon/shared/model/organizations";

import {
  FIX_REGRESSION_GET_COMMIT_CAP,
  FIX_REGRESSION_LIMIT,
  runFixRegressionSweep,
  type FixRegressionDeps,
} from "./regression-sweep";
import {
  resolveSelfHealFromRows,
  type SelfHealContext,
} from "./resolve-self-heal";

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

const REPO = "Acme/Widgets";
const BOT = "automata-app[bot]";
const MERGE_SHA = "f".repeat(40);
const DAY = 86_400_000;
const HOUR = 3_600_000;

function ok<T>(data: T) {
  return { data, status: 200, headers: {} };
}

interface RawCommit {
  sha: string;
  commit: { message: string };
  author: { login: string; type?: string } | null;
}

interface FakeState {
  commits: RawCommit[];
  files: Map<string, Array<{ filename: string; patch?: string }>>;
}

function fakeOctokit(state: FakeState) {
  const write = () => vi.fn(async () => ok({}));
  const rest = {
    repos: {
      listCommits: vi.fn(async (_args: unknown) => ok(state.commits)),
      getCommit: vi.fn(async ({ ref }: { ref: string }) =>
        ok({ sha: ref, files: state.files.get(ref) ?? [] }),
      ),
      merge: write(),
    },
    pulls: {
      update: write(),
      create: write(),
      merge: write(),
    },
    issues: {
      create: write(),
      update: write(),
      createComment: write(),
      addLabels: write(),
    },
    git: { deleteRef: write(), createRef: write() },
  };
  const graphql = vi.fn();
  return { rest, graphql };
}

type Fake = ReturnType<typeof fakeOctokit>;

function human(sha: string, message = "fix: tweak"): RawCommit {
  return { sha, commit: { message }, author: { login: "octocat" } };
}

describe("30-day regression tracking of merged fixes (R5, BRK-01, SC5)", () => {
  let orgId: string;
  let findingId: string;
  let attemptId: string;
  let mergedAt: Date;
  let state: FakeState;
  let fake: Fake;
  let ctx: SelfHealContext;
  let deps: Partial<FixRegressionDeps>;
  let mint: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;

  const attempt = async (id = attemptId) => {
    const [row] = await db
      .select()
      .from(auditFixAttempts)
      .where(eq(auditFixAttempts.id, id));
    if (!row) throw new Error("attempt vanished");
    return row;
  };

  const record = async (id = attemptId) =>
    regressionRecordOf((await attempt(id)).regression);

  const loopFixSignals = async () =>
    (
      await db
        .select({ signal: selfHealBreakerEvent.signal })
        .from(selfHealBreakerEvent)
        .where(
          and(
            eq(selfHealBreakerEvent.organizationId, orgId),
            eq(selfHealBreakerEvent.scopeKind, "loop_fix"),
            eq(selfHealBreakerEvent.scopeKey, REPO.toLowerCase()),
          ),
        )
    ).map((e) => e.signal);

  const sweep = (now = new Date(), limit?: number) =>
    runFixRegressionSweep({
      db,
      now,
      deadlineAt: new Date(Date.now() + 60_000),
      ...(limit !== undefined ? { limit } : {}),
      deps,
    });

  const noWrites = () => {
    for (const spy of [
      fake.rest.repos.merge,
      fake.rest.pulls.update,
      fake.rest.pulls.create,
      fake.rest.pulls.merge,
      fake.rest.issues.create,
      fake.rest.issues.update,
      fake.rest.issues.createComment,
      fake.rest.issues.addLabels,
      fake.rest.git.deleteRef,
      fake.rest.git.createRef,
      fake.graphql,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  };

  async function mergedAttempt(
    fp: string,
    issueNumber: number,
    changedRanges: Array<{
      file: string;
      ranges: Array<[number, number]>;
    }> | null,
  ): Promise<{ findingId: string; attemptId: string }> {
    const row = await insertFinding({
      db,
      organizationId: orgId,
      finding: {
        repoFullName: REPO,
        fingerprint: fp,
        audit: "security-audit",
        ruleId: "dep.vulnerable",
        severity: "high",
        checkKind: "script",
        title: "Vulnerable dependency",
        subject: "lodash",
        planFiles: ["src/a.ts"],
        status: "open",
        issueNumber,
        autoFixLabeled: true,
        fixReadyAt: new Date(Date.now() - DAY),
      },
    });
    const claimed = await claimFixAttempt({
      db,
      organizationId: orgId,
      findingId: row.id,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor: (n) => `automata/fix-${issueNumber}-a${n}`,
    });
    if (!claimed) throw new Error("claim failed");
    await updateFixAttempt({
      db,
      organizationId: orgId,
      id: claimed.attempt.id,
      patch: {
        phase: "ready",
        prNumber: Math.floor(Math.random() * 1_000_000_000) + 1,
        prState: "ready",
        gatedHeadSha: "a".repeat(40),
      },
    });
    await recordFixPrMerged({
      db,
      organizationId: orgId,
      attemptId: claimed.attempt.id,
      mergedAt,
      mergeSha: MERGE_SHA,
      mergedBy: "octocat",
      humanCommitCount: 0,
      changedRanges,
    });
    return { findingId: row.id, attemptId: claimed.attempt.id };
  }

  beforeEach(async () => {
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    mergedAt = new Date(Date.now() - 3 * DAY);
    const made = await mergedAttempt("0123456789abcdef", 42, [
      { file: "src/a.ts", ranges: [[12, 16]] },
    ]);
    findingId = made.findingId;
    attemptId = made.attemptId;

    state = { commits: [], files: new Map() };
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
        settings: { ...resolved.settings, mode: "on" },
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
    log = vi.fn();
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
      log,
      line: () => {},
      capture: vi.fn(),
      schedule: () => {},
      // Only this test's org: other suites share the database.
      list: async (args) =>
        (await listRegressionCandidates({ ...args, limit: 1000 }))
          .filter((r) => r.organizationId === orgId)
          .slice(0, args.limit),
    };
  });

  it("a clean merge: one read since the merge, a record with nothing found, no event, no write", async () => {
    state.commits = [
      { sha: "b1", commit: { message: "chore" }, author: { login: BOT } },
    ];
    const now = new Date();
    expect(await sweep(now)).toMatchObject({
      checked: 1,
      regressed: 0,
      reopened: 0,
    });
    expect(fake.rest.repos.listCommits).toHaveBeenCalledTimes(1);
    expect(fake.rest.repos.listCommits.mock.calls[0]?.[0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      since: mergedAt.toISOString(),
      per_page: 100,
    });
    // A bot commit is never fetched.
    expect(fake.rest.repos.getCommit).not.toHaveBeenCalled();
    expect(await record()).toEqual({
      reverted: false,
      followupShas: [],
      reopened: false,
      checkedAt: now.toISOString(),
      windowComplete: false,
    });
    expect((await attempt()).regressionCheckedAt).toEqual(now);
    expect(await loopFixSignals()).toEqual([]);
    noWrites();
  });

  it("a revert of the merge → reverted with the sha and exactly one regressed event; re-checking emits nothing new", async () => {
    state.commits = [
      human(
        "r1",
        `Revert "Merge pull request #9"\n\nThis reverts commit ${MERGE_SHA}.`,
      ),
    ];
    expect(await sweep()).toMatchObject({ checked: 1, regressed: 1 });
    expect(await record()).toMatchObject({ reverted: true, revertSha: "r1" });
    expect(await loopFixSignals()).toEqual(["regressed"]);

    // 25 h later the same state is seen again.
    expect(await sweep(new Date(Date.now() + 25 * HOUR))).toMatchObject({
      checked: 1,
      regressed: 0,
    });
    expect(await loopFixSignals()).toEqual(["regressed"]);
    noWrites();
  });

  it("a human follow-up on the merged lines → listed, one regressed event; a later re-check reuses it without refetching", async () => {
    state.commits = [
      human("h1"),
      human("h2"),
      {
        sha: "b1",
        commit: { message: "x" },
        author: { login: "renovate[bot]" },
      },
    ];
    state.files.set("h1", [
      { filename: "src/a.ts", patch: "@@ -12,3 +12,4 @@\n-x\n+y" },
    ]);
    state.files.set("h2", [{ filename: "src/other.ts", patch: "@@ -1 +1 @@" }]);
    expect(await sweep()).toMatchObject({ checked: 1, regressed: 1 });
    expect(fake.rest.repos.getCommit).toHaveBeenCalledTimes(2);
    expect((await record())?.followupShas).toEqual(["h1"]);
    expect(await loopFixSignals()).toEqual(["regressed"]);

    fake.rest.repos.getCommit.mockClear();
    await sweep(new Date(Date.now() + 25 * HOUR));
    // h1 is known; only h2 is fetched again.
    expect(fake.rest.repos.getCommit).toHaveBeenCalledTimes(1);
    expect((await record())?.followupShas).toEqual(["h1"]);
    expect(await loopFixSignals()).toEqual(["regressed"]);
  });

  it("the finding reopened after the merge → reopened true and one reopened event, once", async () => {
    await db
      .update(auditFindings)
      .set({ lastReopenedAt: new Date(mergedAt.getTime() + DAY) })
      .where(eq(auditFindings.id, findingId));
    expect(await sweep()).toMatchObject({ checked: 1, reopened: 1 });
    expect((await record())?.reopened).toBe(true);
    expect(await loopFixSignals()).toEqual(["reopened"]);
    await sweep(new Date(Date.now() + 25 * HOUR));
    expect(await loopFixSignals()).toEqual(["reopened"]);
  });

  it("a reopen before the merge is not a regression", async () => {
    await db
      .update(auditFindings)
      .set({ lastReopenedAt: new Date(mergedAt.getTime() - DAY) })
      .where(eq(auditFindings.id, findingId));
    await sweep();
    expect((await record())?.reopened).toBe(false);
    expect(await loopFixSignals()).toEqual([]);
  });

  it("the window ends → windowComplete, never selected again", async () => {
    const after = new Date(mergedAt.getTime() + 30 * DAY + HOUR);
    expect(await sweep(after)).toMatchObject({ checked: 1 });
    expect((await record())?.windowComplete).toBe(true);
    expect(await sweep(new Date(after.getTime() + 2 * DAY))).toMatchObject({
      checked: 0,
    });
  });

  it("an attempt checked less than 24 h ago is not selected", async () => {
    const now = new Date();
    await sweep(now);
    expect(await sweep(new Date(now.getTime() + 23 * HOUR))).toMatchObject({
      checked: 0,
    });
    expect(fake.rest.repos.listCommits).toHaveBeenCalledTimes(1);
  });

  it("caps: one page of 100 commits and at most 20 getCommit calls per attempt", async () => {
    state.commits = Array.from({ length: 30 }, (_, i) => human(`c${i}`));
    await sweep();
    expect(fake.rest.repos.getCommit).toHaveBeenCalledTimes(
      FIX_REGRESSION_GET_COMMIT_CAP,
    );
    expect(FIX_REGRESSION_GET_COMMIT_CAP).toBe(20);
  });

  it("at most 10 attempts per run", async () => {
    expect(FIX_REGRESSION_LIMIT).toBe(10);
    const list = vi.fn(deps.list as FixRegressionDeps["list"]);
    deps.list = list;
    await sweep(new Date(), 20);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ limit: 10 });
  });

  it("unknown merged ranges (null) → no commit detail read, no follow-ups", async () => {
    await db
      .update(auditFixAttempts)
      .set({ changedRanges: null })
      .where(eq(auditFixAttempts.id, attemptId));
    state.commits = [human("h1")];
    await sweep();
    expect(fake.rest.repos.getCommit).not.toHaveBeenCalled();
    expect((await record())?.followupShas).toEqual([]);
  });

  it("an Octokit error is logged and the sweep continues with the next attempt", async () => {
    mergedAt = new Date(Date.now() - 2 * DAY);
    const second = await mergedAttempt("fedcba9876543210", 43, [
      { file: "src/a.ts", ranges: [[12, 16]] },
    ]);
    fake.rest.repos.listCommits.mockRejectedValueOnce(
      Object.assign(new Error("gone"), {
        status: 404,
        response: { headers: {} },
      }),
    );
    state.commits = [
      human("r9", `Revert "x"\n\nThis reverts commit ${MERGE_SHA}.`),
    ];
    expect(await sweep()).toMatchObject({ checked: 2, regressed: 1 });
    expect(log).toHaveBeenCalledWith(
      "[self-heal] fix regression read failed",
      expect.objectContaining({ attemptId }),
    );
    expect((await record())?.reverted).toBe(false);
    expect((await record(second.attemptId))?.reverted).toBe(true);
  });

  it("mode off → no GitHub call; the reopen is still recorded from the ledger", async () => {
    ctx.flagEnabled = false;
    await db
      .update(auditFindings)
      .set({ lastReopenedAt: new Date(mergedAt.getTime() + DAY) })
      .where(eq(auditFindings.id, findingId));
    expect(await sweep()).toMatchObject({ checked: 1, reopened: 1 });
    expect(mint).not.toHaveBeenCalled();
    expect((await record())?.reopened).toBe(true);
  });

  it("never throws: a list failure is logged", async () => {
    deps.list = async () => {
      throw new Error("db down");
    };
    await expect(sweep()).resolves.toMatchObject({ checked: 0 });
    expect(log).toHaveBeenCalledWith(
      "[self-heal] fix regression list failed",
      expect.anything(),
    );
  });
});
