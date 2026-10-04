import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  selfHealBreaker,
  thread as threadTable,
} from "@terragon/shared/db/schema";
import type { ThreadSourceMetadata } from "@terragon/shared";
import {
  claimAuditRun,
  createAuditRunAtDispatch,
  finishAuditRun,
  getAuditRunByThread,
} from "@terragon/shared/model/audit-findings";
import { enqueueEffects } from "@terragon/shared/model/self-heal-outbox";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  runAuditSweep,
  runOutboxDrain,
  type AuditSweepDeps,
  type OutboxDrainDeps,
} from "./audit-sweep";
import type { SelfHealContext } from "./resolve-self-heal";

vi.mock("@terragon/env/apps-www", () => ({
  env: {
    GITHUB_SIDE_EFFECTS_ENABLED: true,
    GITHUB_BOT_LOGIN: "automata-ai-bot[bot]",
    NEXT_PUBLIC_GITHUB_APP_NAME: "automata-ai-bot",
  },
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

const REPO = "acme/widgets";
const MIN = 60_000;
const AUDIT_STAMP: ThreadSourceMetadata = {
  type: "automation-skill",
  skillName: "audit-findings",
  contentSha: "sha",
  source: "db",
};

let userId: string;
let orgId: string;

async function makeThread({
  ageMs = 30 * MIN,
  status = "complete",
  stamp = AUDIT_STAMP as ThreadSourceMetadata | null,
  terminalCause = null as string | null,
}: {
  ageMs?: number;
  status?: "complete" | "stopped" | "working";
  stamp?: ThreadSourceMetadata | null;
  terminalCause?: string | null;
} = {}): Promise<string> {
  const { threadId } = await createTestThread({
    db,
    userId,
    overrides: { githubRepoFullName: REPO },
  });
  await db
    .update(threadTable)
    .set({
      status,
      sourceMetadata: stamp,
      terminalCause,
      updatedAt: new Date(Date.now() - ageMs),
    })
    .where(eq(threadTable.id, threadId));
  return threadId;
}

function sweepHarness() {
  const handleFinish = vi.fn(
    async (_args: {
      userId: string;
      threadId: string;
      threadChatId: string;
      deadlineAt?: Date;
    }) => undefined,
  );
  const deps: AuditSweepDeps = {
    handleFinish: handleFinish as unknown as AuditSweepDeps["handleFinish"],
    now: () => new Date(),
  };
  const calledThreads = () =>
    handleFinish.mock.calls.map(
      (call) => (call as unknown as [{ threadId: string }])[0].threadId,
    );
  return { handleFinish, deps, calledThreads };
}

beforeEach(async () => {
  userId = (await createTestUser({ db })).user.id;
  orgId = await createTestOrg({ db });
});

describe("runAuditSweep candidates", () => {
  it("processes a stamped terminal thread with no run, and one with a dispatched run", async () => {
    const noRun = await makeThread();
    const dispatched = await makeThread();
    await createAuditRunAtDispatch({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId: dispatched,
      audit: "security-audit",
    });
    const { deps, calledThreads, handleFinish } = sweepHarness();

    const result = await runAuditSweep({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps,
    });

    expect(calledThreads()).toEqual(
      expect.arrayContaining([noRun, dispatched]),
    );
    expect(result.processed).toBe(handleFinish.mock.calls.length);
    expect(handleFinish.mock.calls[0]?.[0]).toMatchObject({
      userId,
      threadChatId: expect.any(String),
    });
  });

  it("skips done/failed runs, non-audit skills, fresh, archived and abandoned threads", async () => {
    const done = await makeThread();
    await createAuditRunAtDispatch({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId: done,
      audit: "security-audit",
    });
    const claimed = await claimAuditRun({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId: done,
      audit: "security-audit",
    });
    await finishAuditRun({
      db,
      organizationId: orgId,
      id: claimed?.id ?? "",
      status: "done",
    });
    const review = await makeThread({
      stamp: { ...AUDIT_STAMP, skillName: "pr-review" } as ThreadSourceMetadata,
    });
    const unstamped = await makeThread({ stamp: null });
    const fresh = await makeThread({ ageMs: 2 * MIN });
    const stale = await makeThread({ ageMs: 7 * 60 * MIN });
    const working = await makeThread({ status: "working" });
    const superseded = await makeThread({ terminalCause: "superseded" });
    const archived = await makeThread();
    await db
      .update(threadTable)
      .set({ archived: true })
      .where(eq(threadTable.id, archived));
    const { deps, calledThreads } = sweepHarness();

    await runAuditSweep({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps,
    });

    const called = calledThreads();
    for (const id of [
      done,
      review,
      unstamped,
      fresh,
      stale,
      working,
      superseded,
      archived,
    ]) {
      expect(called).not.toContain(id);
    }
  });

  it("caps a sweep at the limit", async () => {
    for (let i = 0; i < 4; i++) await makeThread();
    const { deps, handleFinish } = sweepHarness();

    const result = await runAuditSweep({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      limit: 2,
      deps,
    });

    expect(handleFinish.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.processed).toBeLessThanOrEqual(2);
  });

  it("reclaims a claimed run with an expired lease, not a live one", async () => {
    const expired = await makeThread({ stamp: null });
    const live = await makeThread({ stamp: null });
    for (const [threadId, now] of [
      [expired, new Date(Date.now() - 30 * MIN)],
      [live, new Date()],
    ] as const) {
      await claimAuditRun({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        threadId,
        audit: "security-audit",
        now,
      });
    }
    const { deps, calledThreads } = sweepHarness();

    await runAuditSweep({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps,
    });

    expect(calledThreads()).toContain(expired);
    expect(calledThreads()).not.toContain(live);
  });

  it("gives each candidate at most the per-item deadline and keeps going after a slow one", async () => {
    const a = await makeThread();
    const b = await makeThread();
    const started = Date.now();
    const handleFinish = vi.fn(async () => {
      // Simulates a hook that used its whole deadline.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const deps: AuditSweepDeps = {
      handleFinish: handleFinish as unknown as AuditSweepDeps["handleFinish"],
      now: () => new Date(),
    };

    await runAuditSweep({
      db,
      now: new Date(),
      deadlineAt: new Date(started + 120_000),
      perItemMs: 20_000,
      deps,
    });

    const calls = handleFinish.mock.calls as unknown as Array<
      [{ threadId: string; deadlineAt: Date }]
    >;
    const ids = calls.map((call) => call[0].threadId);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    for (const [arg] of calls) {
      expect(arg.deadlineAt.getTime()).toBeLessThanOrEqual(
        started + 20_000 + 2_000,
      );
    }
  });

  it("stops when the total deadline is near", async () => {
    await makeThread();
    const { deps, handleFinish } = sweepHarness();

    const result = await runAuditSweep({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 500),
      deps,
    });

    expect(handleFinish).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it("closes the run of a v1 thread instead of re-queueing it", async () => {
    const v1 = await makeThread({ stamp: null });
    await db
      .update(threadTable)
      .set({ version: 1 })
      .where(eq(threadTable.id, v1));
    await claimAuditRun({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      threadId: v1,
      audit: "security-audit",
      now: new Date(Date.now() - 30 * MIN),
    });
    const { deps, calledThreads } = sweepHarness();

    await runAuditSweep({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps,
    });

    expect(calledThreads()).not.toContain(v1);
    const run = await getAuditRunByThread({
      db,
      organizationId: orgId,
      threadId: v1,
    });
    expect(run?.status).toBe("failed");
  });
});

function drainHarness({
  enabled = true,
  mode = "on",
  mintFails = false,
}: { enabled?: boolean; mode?: "on" | "off"; mintFails?: boolean } = {}) {
  const mint = vi.fn(async (_args: { owner: string; repo: string }) => {
    if (mintFails) throw new Error("mint failed");
    return { octokit: {} as never, installationId: 7 };
  });
  const applyEffects = vi.fn(async (args: { effects: unknown[] }) => ({
    applied: args.effects.length,
    pending: 0,
    failed: 0,
  }));
  const claimedOrgs = new Set<string>();
  const loadContext = vi.fn(async (args: { organizationId: string }) => {
    if (!claimedOrgs.has(args.organizationId)) {
      throw new Error("not a test org");
    }
    const ctx: SelfHealContext = {
      flagEnabled: true,
      sideEffectsEnabled: true,
      shadow: false,
      resolved: {
        killed: false,
        settings: { mode } as SelfHealContext["resolved"]["settings"],
      },
      breakers: {
        permissionLatched: false,
        loopAuditOpen: false,
        loopFixOpen: false,
      },
    };
    return ctx;
  });
  const claimDue = vi.fn();
  const deps = {
    isLoopEnabled: async () => enabled,
    claimDue: (async (args: Parameters<OutboxDrainDeps["claimDue"]>[0]) => {
      claimDue(args);
      return (
        await import("@terragon/shared/model/self-heal-outbox")
      ).claimDueEffects(args);
    }) as OutboxDrainDeps["claimDue"],
    loadContext: loadContext as unknown as OutboxDrainDeps["loadContext"],
    mint: mint as unknown as OutboxDrainDeps["mint"],
    createWriter: (() => ({})) as unknown as OutboxDrainDeps["createWriter"],
    applyEffects: applyEffects as unknown as OutboxDrainDeps["applyEffects"],
    now: () => new Date(),
  } satisfies OutboxDrainDeps;
  return { deps, mint, applyEffects, claimDue, claimedOrgs, loadContext };
}

async function seedEffect(
  organizationId: string,
  repoFullName: string,
  fingerprint: string,
): Promise<void> {
  const threadId = (
    await createTestThread({
      db,
      userId,
      overrides: { githubRepoFullName: repoFullName },
    })
  ).threadId;
  await createAuditRunAtDispatch({
    db,
    organizationId,
    repoFullName,
    threadId,
    audit: "security-audit",
  });
  const run = await getAuditRunByThread({ db, organizationId, threadId });
  await enqueueEffects({
    db,
    organizationId,
    repoFullName,
    runId: run?.id ?? "",
    effects: [
      {
        fingerprint,
        action: "create_issue",
        payload: { title: fingerprint, body: "b", labels: [] },
      },
    ],
    now: new Date(Date.now() - MIN),
  });
}

describe("runOutboxDrain", () => {
  it("mints once and applies once per repo", async () => {
    const h = drainHarness();
    h.claimedOrgs.add(orgId);
    await seedEffect(orgId, "acme/one", "fp-a");
    await seedEffect(orgId, "acme/one", "fp-b");
    await seedEffect(orgId, "acme/two", "fp-c");

    const result = await runOutboxDrain({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps: h.deps,
    });

    const minted = h.mint.mock.calls.map((call) => call[0].repo).sort();
    expect(minted).toEqual(["one", "two"]);
    expect(h.applyEffects).toHaveBeenCalledTimes(2);
    expect(result.applied).toBe(3);
  });

  it("claims nothing and mints nothing when the flag is off", async () => {
    const h = drainHarness({ enabled: false });
    h.claimedOrgs.add(orgId);
    await seedEffect(orgId, "acme/one", "fp-a");

    const result = await runOutboxDrain({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps: h.deps,
    });

    expect(h.claimDue).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
  });

  it("does not claim the rows of a rate-limited org", async () => {
    const limitedOrg = await createTestOrg({ db });
    const h = drainHarness();
    h.claimedOrgs.add(limitedOrg);
    await seedEffect(limitedOrg, "acme/limited", "fp-l");
    await db.insert(selfHealBreaker).values({
      organizationId: limitedOrg,
      scopeKind: "github_write",
      scopeKey: "7",
      rateLimitedUntil: new Date(Date.now() + 30 * MIN),
    });

    await runOutboxDrain({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps: h.deps,
    });

    const repos = h.mint.mock.calls.map((call) => call[0].repo);
    expect(repos).not.toContain("limited");
  });

  it("defers (does not apply) a repo whose switches are off", async () => {
    const h = drainHarness({ mode: "off" });
    h.claimedOrgs.add(orgId);
    await seedEffect(orgId, "acme/one", "fp-a");

    const result = await runOutboxDrain({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps: h.deps,
    });

    expect(h.mint).not.toHaveBeenCalled();
    expect(h.applyEffects).not.toHaveBeenCalled();
    expect(result.pending).toBeGreaterThanOrEqual(1);
  });

  it("releases the group when the token mint fails", async () => {
    const h = drainHarness({ mintFails: true });
    h.claimedOrgs.add(orgId);
    await seedEffect(orgId, "acme/one", "fp-a");

    await runOutboxDrain({
      db,
      now: new Date(),
      deadlineAt: new Date(Date.now() + 120_000),
      deps: h.deps,
    });

    expect(h.applyEffects).not.toHaveBeenCalled();
  });
});
