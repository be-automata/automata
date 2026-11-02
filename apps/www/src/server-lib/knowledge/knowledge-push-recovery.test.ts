import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { handleKnowledgePush } from "@/app/api/webhooks/github/knowledge-push";
import {
  knowledgeCursor,
  knowledgeIntent,
  organizationReviewSettings,
} from "@terragon/shared/db/schema";
import { rowsOf } from "@terragon/shared/db";
import { bindGithubInstallationToOrg } from "@terragon/shared/model/github-installation";
import {
  listKnowledgeHeadCheckCandidates,
  recoverKnowledgeHeadIntent,
  requeueExpiredKnowledgeIntents,
  claimDueKnowledgeIntents,
  failKnowledgeIntent,
} from "@terragon/shared/model/knowledge-intent";
import { createOrganization } from "@terragon/shared/model/organizations";

import {
  runKnowledgeReconcileSweep,
  type KnowledgeReconcileSweepDeps,
} from "./reconcile-sweep";

vi.mock("@terragon/shared/github-app", () => ({
  getRepoInstallationId: vi.fn(async () => null),
  getReadOnlyInstallationToken: vi.fn(async () => ({
    token: "mock-github-token",
    expiresAt: "2099-01-01T00:00:00Z",
  })),
}));

// The push handler reaches the write through forKnowledge(...).store. Make the
// accessor's recordPushUnlessOffboarded throw once, the way a DB failure would.
const control = vi.hoisted(() => ({ failNextPushWrite: false }));
vi.mock("@terragon/shared/model/knowledge-access", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@terragon/shared/model/knowledge-access")
    >();
  return {
    ...actual,
    forKnowledge: (args: Parameters<typeof actual.forKnowledge>[0]) => {
      const real = actual.forKnowledge(args);
      return {
        ...real,
        store: {
          ...real.store,
          recordPushUnlessOffboarded: async (
            a: Parameters<typeof real.store.recordPushUnlessOffboarded>[0],
          ) => {
            if (control.failNextPushWrite) {
              control.failNextPushWrite = false;
              throw new Error("simulated database failure");
            }
            return real.store.recordPushUnlessOffboarded(a);
          },
        },
      };
    },
  };
});

const SHA_A = "a".repeat(40);
const SHA_H = "b".repeat(40);

let orgId: string;
let installationId: number;
let repo: string;

beforeEach(async () => {
  vi.clearAllMocks();
  control.failNextPushWrite = false;
  const slug = `kpr-${nanoid(8).toLowerCase()}`;
  orgId = (await createOrganization({ db, name: slug, slug })).id;
  installationId = Math.floor(Math.random() * 1_000_000_000) + 1000;
  repo = `fixture-owner/repo-${nanoid(6).toLowerCase()}`;
  await bindGithubInstallationToOrg({
    db,
    installationId,
    organizationId: orgId,
    mode: "active",
  });
  await db
    .insert(organizationReviewSettings)
    .values({ organizationId: orgId, knowledgeEngine: true });
  await db.insert(knowledgeCursor).values({
    organizationId: orgId,
    repoFullName: repo,
    defaultBranch: "main",
    lastSha: SHA_A,
    observedHeadSha: SHA_A,
  });
});

const intents = () =>
  db
    .select()
    .from(knowledgeIntent)
    .where(eq(knowledgeIntent.organizationId, orgId));

const cursorRow = async () =>
  (
    await db
      .select()
      .from(knowledgeCursor)
      .where(
        and(
          eq(knowledgeCursor.organizationId, orgId),
          eq(knowledgeCursor.repoFullName, repo),
        ),
      )
  )[0];

function pushPayload() {
  return {
    ref: "refs/heads/main",
    before: SHA_A,
    after: SHA_H,
    deleted: false,
    forced: false,
    installation: { id: installationId },
    repository: {
      full_name: repo,
      name: repo.split("/")[1],
      default_branch: "main",
      owner: { login: repo.split("/")[0] },
    },
  } as never;
}

describe("recovery of a swallowed push write (D-03 / PD-19)", () => {
  it("writes the missing intent on a head check and dispatches it, with no further push", async () => {
    // 1. The push arrives but its write fails: the handler swallows it.
    control.failNextPushWrite = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      handleKnowledgePush(pushPayload(), "delivery-1"),
    ).resolves.toBeUndefined();
    consoleError.mockRestore();
    expect(await intents()).toEqual([]);
    expect((await cursorRow())?.lastPushAt).toBeNull();
    expect((await cursorRow())?.observedHeadSha).toBe(SHA_A);

    // 2. Pick a tick minute whose slot is this repo's, in the near future so
    //    the recovered intent is due by tick 2 (its next_attempt_at is the DB
    //    insert time).
    const slot = rowsOf<{ s: number }>(
      await db.execute(
        sql`SELECT (abs(hashtext(${orgId} || ':' || ${repo})::bigint) % 15)::int AS s`,
      ),
    )[0]!.s;
    const currentMinute = Math.floor(Date.now() / 60_000);
    let tickMinute = currentMinute + 1;
    while (tickMinute % 15 !== slot) tickMinute += 1;
    const tick1 = new Date(tickMinute * 60_000);
    const tick2 = new Date((tickMinute + 1) * 60_000);

    const triggered: unknown[] = [];
    const readHead = vi.fn(async (row: { organizationId: string }) =>
      row.organizationId === orgId
        ? { kind: "ok" as const, sha: SHA_H, defaultBranch: "main" }
        : { kind: "no_access" as const },
    );
    const deps: KnowledgeReconcileSweepDeps = {
      secret: () => "s3cret",
      requeueExpired: (now) => requeueExpiredKnowledgeIntents({ db, now }),
      claimDue: (now, limit) => claimDueKnowledgeIntents({ db, now, limit }),
      fail: (intentId, code, now) =>
        failKnowledgeIntent({ db, intentId, code, now }),
      trigger: async (row) => {
        if (row.organizationId === orgId) triggered.push(row);
      },
      alert: async () => undefined,
      // A wide window so rows left by other tests cannot crowd this repo out.
      listHeadCandidates: (now, s) =>
        listKnowledgeHeadCheckCandidates({ db, now, slot: s, limit: 1000 }),
      readHead,
      recoverHead: (row, sha, defaultBranch, now) =>
        recoverKnowledgeHeadIntent({
          db,
          organizationId: row.organizationId,
          repoFullName: row.repoFullName,
          defaultBranch,
          headSha: sha,
          now,
        }),
      log: { log: vi.fn(), error: vi.fn() },
    };

    // Tick 1: the head check finds GitHub ahead of last_sha and no intent.
    const first = await runKnowledgeReconcileSweep(deps, tick1);
    expect(first.headRecovered).toBeGreaterThanOrEqual(1);
    const rows = await intents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `intent:${orgId}:${repo}@${SHA_H}`,
      state: "pending",
      targetSha: SHA_H,
    });
    const afterRecovery = await cursorRow();
    expect(afterRecovery).toMatchObject({
      observedHeadSha: SHA_H,
      lastSha: SHA_A,
      lastPushAt: null,
    });
    expect(triggered).toEqual([]);

    // Tick 2: the sweep claims it and dispatches exactly one reconcile for H.
    const second = await runKnowledgeReconcileSweep(deps, tick2);
    expect(second.dispatched).toBeGreaterThanOrEqual(1);
    expect(triggered).toEqual([
      {
        id: `intent:${orgId}:${repo}@${SHA_H}`,
        organizationId: orgId,
        repoFullName: repo,
        targetSha: SHA_H,
      },
    ]);
    // No second push was delivered: still only the one recovered row.
    expect(await intents()).toHaveLength(1);
    expect((await intents())[0]?.state).toBe("processing");
  });
});
