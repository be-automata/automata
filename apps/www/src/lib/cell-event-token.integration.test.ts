import { and, eq, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as cellPlan } from "@/app/api/daemon/cell-plan/route";
import { POST as cellTeardown } from "@/app/api/daemon/cell-teardown/route";
import { POST as daemonEvent } from "@/app/api/daemon-event/route";
import { db } from "@/lib/db";
import { verifyDaemonApiKey } from "@/lib/daemon-api-key";
import {
  cellEventTokenName,
  daemonRunKey,
  hasActiveDaemonToken,
  mintCellEventToken,
  mintDaemonToken,
  revokeCellEventTokens,
  revokeDaemonTokenById,
  revokeDaemonTokensForThread,
  supersedeCellEventTokens,
} from "@/lib/daemon-token";
import { DAEMON_EVENT_SCOPE } from "@/lib/daemon-token-context";
import {
  daemonRouteMatrix,
  jsonRequest,
  outcomeOf,
  refusedFor,
  type DaemonRouteCase,
} from "@/test-helpers/daemon-route-matrix";
import { mockLoggedOutUser, mockWaitUntil } from "@/test-helpers/mock-next";
import { apikey as apikeyTable } from "@terragon/shared/db/schema";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { CELL_RUN_TTL_MS, cellStepKey } from "@terragon/types/cell";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Real auth, real database (#693), as retired-daemon-token.integration.test.ts:
// nothing between a route and verifyDaemonApiKey is mocked, only what leaves
// the process.
vi.mock("@terragon/env/apps-www", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@terragon/env/apps-www");
  const overrides: Record<string, string> = {
    GOOGLE_AI_STUDIO_API_KEY: "fake-google-upstream-key",
    OPENROUTER_API_KEY: "fake-openrouter-upstream-key",
  };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop, receiver) =>
        typeof prop === "string" && prop in overrides
          ? overrides[prop]
          : Reflect.get(target, prop, receiver),
    }),
  };
});
vi.mock("@/server-lib/checkpoint-thread", () => ({
  checkpointThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@terragon/sandbox", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, extendSandboxLife: vi.fn().mockResolvedValue(undefined) };
});

describe("a cell's event-scoped daemon token (#693)", () => {
  let userId: string;
  let threadId: string;
  let threadChatId: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  /** Run A's cell step: `cellStepKey` of its worker token's id. */
  const STEP_A = "cell-runaworkertokenid000000000000";
  const STEP_B = "cell-runbworkertokenid000000000000";
  const run = (stepKey: string = STEP_A) => ({
    userId,
    threadId,
    threadChatId,
    stepKey,
  });
  const refusedAsEventScoped = (): boolean =>
    refusedFor(logSpy, "event-scoped token");

  async function mintRunToken(): Promise<string> {
    return mintDaemonToken({
      ...run(),
      name: daemonRunKey({ threadId, threadChatId }),
    });
  }

  async function cellRows() {
    return db
      .select({
        id: apikeyTable.id,
        name: apikeyTable.name,
        expiresAt: apikeyTable.expiresAt,
        metadata: apikeyTable.metadata,
      })
      .from(apikeyTable)
      .where(
        and(
          eq(apikeyTable.referenceId, userId),
          like(apikeyTable.name, `%:cell-event:%`),
        ),
      );
  }

  async function keyCount(): Promise<number> {
    return (
      await db
        .select({ id: apikeyTable.id })
        .from(apikeyTable)
        .where(eq(apikeyTable.referenceId, userId))
    ).length;
  }

  beforeEach(async () => {
    await mockWaitUntil();
    await mockLoggedOutUser();
    userId = (await createTestUser({ db })).user.id;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    const t = await createTestThread({
      db,
      userId,
      overrides: { organizationId: org.id },
      chatOverrides: { status: "working" },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    logSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const teardownCase: DaemonRouteCase = {
    name: "cell-teardown",
    // A live run token passes auth and fails the attempt schema (400).
    liveIsNot401: true,
    call: async (token) =>
      outcomeOf(
        await cellTeardown(
          jsonRequest("http://localhost/api/daemon/cell-teardown", token, {
            threadId,
            threadChatId,
            action: "revoke",
            attempt: 0,
          }),
        ),
      ),
  };
  const matrix = daemonRouteMatrix(() => ({ userId, threadId }));
  const refusing = [
    ...matrix.filter((c) => !c.name.startsWith("daemon-event")),
    teardownCase,
  ];
  const daemonEventCase = matrix.find((c) => c.name.startsWith("daemon-event"));

  it("the matrix covers every route but daemon-event", () => {
    expect(daemonEventCase).toBeDefined();
    expect(refusing.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "next-message",
        "agent-credentials",
        "thread-status",
        "cell-plan",
        "cell-teardown",
        "anthropic proxy",
        "openai proxy",
        "cli-router",
      ]),
    );
  });

  it.each(refusing)(
    "$name: the cell token gets the unknown token's 401; the run token does not",
    async ({ call, liveIsNot401 }) => {
      const unknown = await call(`unknown-${nanoid(32)}`);
      expect(unknown.status).toBe(401);

      const { token } = await mintCellEventToken({ ...run(), attempt: 1 });
      logSpy.mockClear();
      expect(await call(token)).toEqual(unknown);
      expect(refusedAsEventScoped()).toBe(true);

      logSpy.mockClear();
      const live = await call(await mintRunToken());
      expect(refusedAsEventScoped()).toBe(false);
      if (liveIsNot401) expect(live.status).not.toBe(401);
    },
  );

  it("daemon-event accepts it, with the run token's answer and the F2 binding", async () => {
    const { token } = await mintCellEventToken({ ...run(), attempt: 1 });
    logSpy.mockClear();
    // A foreign threadChat: past auth, refused by F2 exactly like the run token.
    const cell = await daemonEventCase!.call(token);
    expect(refusedAsEventScoped()).toBe(false);
    expect(cell.status).toBe(403);
    expect(cell).toEqual(await daemonEventCase!.call(await mintRunToken()));

    // Its own thread: an empty batch is ingested.
    const own = await daemonEvent(
      jsonRequest("http://localhost/api/daemon-event", token, {
        threadId,
        threadChatId,
        messages: [],
      }),
    );
    expect(own.status).toBe(200);
  });

  it("cell-plan refuses it with 401 before anything: no step, no bearer, no new key", async () => {
    const { token, apiKeyId } = await mintCellEventToken({
      ...run(),
      attempt: 1,
    });
    const before = await keyCount();
    const res = await cellPlan(
      jsonRequest("http://localhost/api/daemon/cell-plan", token, {
        threadId,
        threadChatId,
        worker: "w1",
        epoch: "1",
        requestId: "request-aaaaaaaaaaaaaaaa",
      }),
    );
    expect(res.status).toBe(401);
    expect(await keyCount()).toBe(before);
    const steps = await db.query.cellStep.findMany({
      where: (s, { eq: eqOp }) => eqOp(s.threadId, threadId),
    });
    expect(steps).toEqual([]);
    // A bearer needs a step (foreign key); check the would-be key's anyway.
    const bearers = await db.query.cellBearer.findMany({
      where: (b, { eq: eqOp }) => eqOp(b.stepKey, cellStepKey(apiKeyId)),
    });
    expect(bearers).toEqual([]);
  });

  describe("lifecycle", () => {
    const liveIds = async () => (await cellRows()).map((r) => r.id).sort();
    const verifies = async (token: string) =>
      (await verifyDaemonApiKey(token, { allowEventScoped: true })) !== null;

    it("mints with the F1/F2 metadata, the scope, the step's name and a capped expiry", async () => {
      const t0 = Date.now();
      const { token, apiKeyId } = await mintCellEventToken({
        ...run(),
        attempt: 3,
      });
      const [row] = await cellRows();
      expect(row?.id).toBe(apiKeyId);
      expect(row?.name).toBe(
        `${daemonRunKey({ threadId, threadChatId })}:cell-event:${STEP_A}:3`,
      );
      expect(row?.name).toBe(cellEventTokenName({ ...run(), attempt: 3 }));
      const expires = row?.expiresAt?.getTime() ?? Infinity;
      expect(expires).toBeLessThanOrEqual(Date.now() + CELL_RUN_TTL_MS + 5_000);
      expect(expires).toBeGreaterThan(t0 + CELL_RUN_TTL_MS - 60_000);

      expect(await verifyDaemonApiKey(token)).toBe(null);
      const key = await verifyDaemonApiKey(token, { allowEventScoped: true });
      expect(key?.metadata).toMatchObject({
        tokenType: "daemon",
        threadId,
        threadChatId,
        scope: DAEMON_EVENT_SCOPE,
      });
      expect(
        (key?.metadata as Record<string, unknown>).organizationId,
      ).toBeTruthy();
    });

    it("a winning plan supersedes the step's older tokens, and only older ones", async () => {
      const first = await mintCellEventToken({ ...run(), attempt: 1 });
      await sleep(5);
      const second = await mintCellEventToken({ ...run(), attempt: 2 });
      await sleep(5);
      const newer = await mintCellEventToken({ ...run(), attempt: 2 });
      // `second` wins late (a racing replay): `newer` is not older, it stays.
      expect(
        await supersedeCellEventTokens({
          ...run(),
          keepApiKeyId: second.apiKeyId,
        }),
      ).toBe(1);
      expect(await verifies(first.token)).toBe(false);
      expect(await verifies(second.token)).toBe(true);
      expect(await verifies(newer.token)).toBe(true);
      // `newer` wins too: the racing pair converges on the newest.
      await supersedeCellEventTokens({
        ...run(),
        keepApiKeyId: newer.apiKeyId,
      });
      expect(await liveIds()).toEqual([newer.apiKeyId]);
    });

    it("a replay that never wins leaves the earlier response's token", async () => {
      const kept = await mintCellEventToken({ ...run(), attempt: 1 });
      // The replay mints, then fails in build: cell-plan deletes only its own.
      const failed = await mintCellEventToken({ ...run(), attempt: 1 });
      expect(
        await revokeDaemonTokenById({ userId, apiKeyId: failed.apiKeyId }),
      ).toBe(1);
      expect(await liveIds()).toEqual([kept.apiKeyId]);
    });

    it("another run's step is never touched, though its attempt numbers repeat", async () => {
      const a = await mintCellEventToken({ ...run(STEP_A), attempt: 1 });
      const b = await mintCellEventToken({ ...run(STEP_B), attempt: 1 });
      // Run A's teardown (attempt 1) and terminal read leave run B's token.
      expect(await revokeCellEventTokens({ ...run(STEP_A), attempt: 1 })).toBe(
        1,
      );
      expect(await revokeCellEventTokens(run(STEP_A))).toBe(0);
      expect(
        await supersedeCellEventTokens({
          ...run(STEP_A),
          keepApiKeyId: a.apiKeyId,
        }),
      ).toBe(0);
      expect(await liveIds()).toEqual([b.apiKeyId]);
    });

    it("revokes one attempt's token, or the whole step's, and never the run token", async () => {
      const runToken = await mintRunToken();
      const runKey = daemonRunKey({ threadId, threadChatId });
      await mintCellEventToken({ ...run(), attempt: 2 });
      expect(await revokeCellEventTokens({ ...run(), attempt: 1 })).toBe(0);
      expect(await revokeCellEventTokens({ ...run(), attempt: 2 })).toBe(1);
      await mintCellEventToken({ ...run(), attempt: 3 });
      await mintCellEventToken({ ...run(), attempt: 4 });
      expect(await revokeCellEventTokens(run())).toBe(2);
      expect(await cellRows()).toEqual([]);

      // The worker's own token and the double-dispatch guard are untouched.
      expect(await verifyDaemonApiKey(runToken)).not.toBe(null);
      expect(await hasActiveDaemonToken({ userId, name: runKey })).toBe(true);
    });

    it("the per-thread sweep deletes it", async () => {
      await mintCellEventToken({ ...run(), attempt: 1 });
      expect(await revokeDaemonTokensForThread({ userId, threadId })).toBe(1);
      expect(await cellRows()).toEqual([]);
    });

    it("another user's cell tokens are never touched (owner fence)", async () => {
      const mine = await mintCellEventToken({ ...run(), attempt: 1 });
      const stranger = (await createTestUser({ db })).user.id;
      expect(await revokeCellEventTokens({ ...run(), userId: stranger })).toBe(
        0,
      );
      expect(
        await supersedeCellEventTokens({
          ...run(),
          userId: stranger,
          keepApiKeyId: "no-such-key",
        }),
      ).toBe(0);
      expect(await liveIds()).toEqual([mine.apiKeyId]);
    });
  });
});
