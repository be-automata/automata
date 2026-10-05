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
  listOpenReadyFixPrs,
  updateFixAttempt,
} from "@terragon/shared/model/audit-fix-attempts";
import { createOrganization } from "@terragon/shared/model/organizations";

import {
  FIX_PR_EXPIRY_LIMIT,
  runFixPrExpirySweep,
  type FixPrExpiryDeps,
} from "./fix-pr-expiry";
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
  reviews: Array<{ user: { login: string; type?: string } | null }>;
  comments: Array<{
    id: number;
    number: number;
    body: string;
    user: { login: string };
  }>;
  labels: Map<number, string[]>;
}

function fakeOctokit(state: FakeState) {
  const labelsOf = (n: number) => state.labels.get(n) ?? [];
  const rest = {
    pulls: {
      get: vi.fn(async () => ok(state.pull)),
      listReviews: vi.fn(async (_args: unknown) => ok(state.reviews)),
      update: vi.fn(async (_args: unknown) => ok({})),
      merge: vi.fn(),
      updateBranch: vi.fn(),
    },
    git: { deleteRef: vi.fn(async (_args: unknown) => ok(undefined)) },
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

describe("expiry of unreviewed ready fix PRs (R5, BRK-01)", () => {
  let orgId: string;
  let findingId: string;
  let attemptId: string;
  let branch: string;
  let prNumber: number;
  let state: FakeState;
  let fake: Fake;
  let ctx: SelfHealContext;
  let deps: Partial<FixPrExpiryDeps>;
  let mint: ReturnType<typeof vi.fn>;
  let lines: string[];
  let log: ReturnType<typeof vi.fn>;

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

  const loopFixEvents = () =>
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

  const noWrites = () => {
    expect(fake.rest.pulls.update).not.toHaveBeenCalled();
    expect(fake.rest.git.deleteRef).not.toHaveBeenCalled();
    expect(fake.rest.issues.createComment).not.toHaveBeenCalled();
    expect(fake.rest.issues.addLabels).not.toHaveBeenCalled();
  };

  const neverMerges = () => {
    expect(fake.rest.pulls.merge).not.toHaveBeenCalled();
    expect(fake.rest.pulls.updateBranch).not.toHaveBeenCalled();
    expect(fake.graphql).not.toHaveBeenCalled();
  };

  const sweep = (limit?: number) =>
    runFixPrExpirySweep({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 60_000),
      ...(limit !== undefined ? { limit } : {}),
      deps,
    });

  const setReadyAt = (at: Date, id = attemptId) =>
    updateFixAttempt({
      db,
      organizationId: orgId,
      id,
      patch: { readyAt: at },
    });

  async function readyAttempt(
    fp: string,
    issueNumber = ISSUE,
  ): Promise<{
    findingId: string;
    attemptId: string;
    branch: string;
    prNumber: number;
  }> {
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
        fixReadyAt: new Date(Date.now() - MIN),
      },
    });
    const claimed = await claimFixAttempt({
      db,
      organizationId: orgId,
      findingId: row.id,
      maxAttempts: 3,
      cooldownMin: 30,
      branchFor: (n) => `automata/fix-42-${fp.slice(0, 8)}-a${n}`,
    });
    if (!claimed) throw new Error("claim failed");
    const pr = Math.floor(Math.random() * 1_000_000_000) + 1;
    await updateFixAttempt({
      db,
      organizationId: orgId,
      id: claimed.attempt.id,
      patch: {
        phase: "ready",
        checkStatus: "passed",
        guardStatus: "passed",
        gatedHeadSha: "a".repeat(40),
        prNumber: pr,
        prState: "ready",
        prOpenedAt: new Date(Date.now() - 9 * DAY),
        readyAt: new Date(Date.now() - 8 * DAY),
      },
    });
    return {
      findingId: row.id,
      attemptId: claimed.attempt.id,
      branch: claimed.attempt.branch ?? "",
      prNumber: pr,
    };
  }

  beforeEach(async () => {
    orgId = (
      await createOrganization({
        db,
        name: "Org",
        slug: `org-${nanoid(8).toLowerCase()}`,
      })
    ).id;
    const made = await readyAttempt(FP);
    findingId = made.findingId;
    attemptId = made.attemptId;
    branch = made.branch;
    prNumber = made.prNumber;

    state = {
      pull: {
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        merged_by: null,
      },
      reviews: [{ user: { login: "ci-helper[bot]", type: "Bot" } }],
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
          prExpiryDays: 7,
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
    lines = [];
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
      line: (line) => lines.push(line),
      capture: vi.fn(),
      schedule: () => {},
      // Only this test's org: other suites share the database.
      list: async (args) =>
        (await listOpenReadyFixPrs({ ...args, limit: 1000 }))
          .filter((r) => r.organizationId === orgId)
          .slice(0, args.limit),
    };
  });

  it("an old ready PR with only bot reviews → closed, one marker comment, branch deleted, expired, one pr_expired event", async () => {
    const result = await sweep();
    expect(result).toMatchObject({ checked: 1, expired: 1 });

    expect(fake.rest.pulls.listReviews.mock.calls[0]?.[0]).toMatchObject({
      pull_number: prNumber,
      per_page: 100,
    });
    expect(fake.rest.pulls.update).toHaveBeenCalledTimes(1);
    expect(fake.rest.pulls.update.mock.calls[0]?.[0]).toMatchObject({
      pull_number: prNumber,
      state: "closed",
    });
    expect(fake.rest.git.deleteRef).toHaveBeenCalledTimes(1);
    expect(fake.rest.git.deleteRef.mock.calls[0]?.[0]).toMatchObject({
      ref: `heads/${branch}`,
    });
    const onPr = state.comments.filter((c) => c.number === prNumber);
    expect(onPr).toHaveLength(1);
    const [marker = "", text = ""] = onPr[0]?.body.split("\n") ?? [];
    expect(marker).toBe(
      commentMarker({ fp: FP, kind: "fix_pr_expired", runId: attemptId }),
    );
    expect(text).toContain("within 7 days");
    expect(onPr[0]?.body).not.toContain("@");

    const row = await attempt();
    expect(row).toMatchObject({
      prState: "expired",
      phase: "closed",
      outcome: "pr_expired",
      terminalCause: "pr_expired",
      infraRefunded: false,
    });
    const f = await finding();
    expect(f.status).toBe("open");
    expect(f.attempts).toBe(1);
    expect(f.activeAttemptId).toBeNull();
    expect((await loopFixEvents()).map((e) => e.signal)).toEqual([
      "pr_expired",
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("decision=pr_open reason=expired mode=on");
    neverMerges();

    // A second run finds nothing: the PR is no longer ready.
    expect(await sweep()).toMatchObject({ checked: 0, expired: 0 });
    expect(fake.rest.pulls.update).toHaveBeenCalledTimes(1);
  });

  it("one human review (any state) exempts the PR", async () => {
    state.reviews = [
      { user: { login: BOT } },
      { user: { login: "octocat", type: "User" } },
    ];
    expect(await sweep()).toMatchObject({ checked: 1, expired: 0 });
    noWrites();
    expect((await attempt()).prState).toBe("ready");
    expect(await loopFixEvents()).toHaveLength(0);
  });

  it("a PR younger than the repo's window is untouched and not read", async () => {
    await setReadyAt(new Date(Date.now() - 3 * DAY));
    expect(await sweep()).toMatchObject({ checked: 1, expired: 0 });
    expect(fake.rest.pulls.get).not.toHaveBeenCalled();
    noWrites();
    expect((await attempt()).prState).toBe("ready");
  });

  it("a PR ready for less than a day is never selected", async () => {
    await setReadyAt(new Date(Date.now() - 60 * MIN));
    expect(await sweep()).toMatchObject({ checked: 0, expired: 0 });
    expect(mint).not.toHaveBeenCalled();
  });

  it("already merged on GitHub → settled as a merge by the lifecycle recorder, no close call", async () => {
    state.pull = {
      state: "closed",
      draft: false,
      merged: true,
      merged_at: "2026-10-05T12:00:00Z",
      merge_commit_sha: "f".repeat(40),
      merged_by: { login: "octocat" },
    };
    expect(await sweep()).toMatchObject({ checked: 1, expired: 0 });
    noWrites();
    const row = await attempt();
    expect(row.outcome).toBe("merged");
    expect(row.prState).toBe("merged");
    expect((await loopFixEvents()).map((e) => e.signal)).toEqual(["pr_merged"]);
  });

  it("already closed on GitHub → settled as a human close, no close call", async () => {
    state.pull = { ...state.pull, state: "closed" };
    expect(await sweep()).toMatchObject({ checked: 1, expired: 0 });
    expect(fake.rest.pulls.update).not.toHaveBeenCalled();
    const row = await attempt();
    expect(row.outcome).toBe("pr_closed");
    expect(row.prState).toBe("closed");
  });

  it("a PR a person turned back into a draft is left to the stuck-draft sweep", async () => {
    state.pull = { ...state.pull, draft: true };
    expect(await sweep()).toMatchObject({ checked: 1, expired: 0 });
    noWrites();
    expect((await attempt()).prState).toBe("ready");
  });

  it.each([
    [
      "dry-run mode",
      (c: SelfHealContext) => (c.resolved.settings.mode = "dry-run"),
    ],
    ["the kill switch", (c: SelfHealContext) => (c.resolved.killed = true)],
    [
      "side effects disabled",
      (c: SelfHealContext) => (c.sideEffectsEnabled = false),
    ],
    ["the flag off", (c: SelfHealContext) => (c.flagEnabled = false)],
  ])("%s → no GitHub call, no write, logged skip", async (_name, apply) => {
    apply(ctx);
    expect(await sweep()).toMatchObject({ checked: 1, expired: 0 });
    expect(mint).not.toHaveBeenCalled();
    noWrites();
    expect((await attempt()).prState).toBe("ready");
    expect(await loopFixEvents()).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      "[self-heal] fix PR expiry skipped",
      expect.objectContaining({ attemptId }),
    );
  });

  it("at the attempts cap the expired finding goes needs-human-approve", async () => {
    ctx.resolved.settings.maxAttempts = 1;
    await sweep();
    const f = await finding();
    expect(f.status).toBe("needs_human");
    expect(state.labels.get(ISSUE)).toContain(FINDING_LABELS.needsHumanApprove);
  });

  it("a failed close is logged; the attempt stays expired (the webhook is then a no-op)", async () => {
    fake.rest.pulls.update.mockRejectedValue(
      Object.assign(new Error("nope"), {
        status: 422,
        response: { headers: {} },
      }),
    );
    expect(await sweep()).toMatchObject({ checked: 1, expired: 1 });
    expect((await attempt()).prState).toBe("expired");
    expect(log).toHaveBeenCalledWith(
      "[self-heal] fix PR expiry close failed",
      expect.objectContaining({ attemptId }),
    );
  });

  it("an unreadable review list leaves the PR alone", async () => {
    fake.rest.pulls.listReviews.mockRejectedValue(
      Object.assign(new Error("gone"), {
        status: 404,
        response: { headers: {} },
      }),
    );
    expect(await sweep()).toMatchObject({ checked: 1, expired: 0 });
    noWrites();
  });

  it("processes at most `limit` PRs per run (default 20)", async () => {
    expect(FIX_PR_EXPIRY_LIMIT).toBe(20);
    await readyAttempt("fedcba9876543210", ISSUE + 1);
    expect(await sweep(1)).toMatchObject({ checked: 1, expired: 1 });
  });

  it("never throws: a list failure is logged", async () => {
    deps.list = async () => {
      throw new Error("db down");
    };
    await expect(sweep()).resolves.toMatchObject({ checked: 0, expired: 0 });
    expect(log).toHaveBeenCalledWith(
      "[self-heal] fix PR expiry list failed",
      expect.anything(),
    );
  });
});
