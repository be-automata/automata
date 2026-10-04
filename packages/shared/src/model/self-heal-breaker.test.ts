import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { createDb } from "../db";
import {
  selfHealAdminLog,
  selfHealBreaker,
  selfHealBreakerEvent,
} from "../db/schema";
import { createOrganization } from "./organizations";
import {
  acquireHalfOpenProbe,
  breakerCooldownMs,
  clearPermissionLatch,
  countRecentEvents,
  evaluateApiBreaker,
  extendRateLimitedUntil,
  getBreakerState,
  recordBreakerEvent,
  resetBreaker,
  setPermissionLatch,
  type BreakerEventOutcome,
} from "./self-heal-breaker";

const db = createDb(env.DATABASE_URL!);
// A second client against the same DB: a second "isolate".
const db2 = createDb(env.DATABASE_URL!);
const KEY = "inst-1";
const DAY = 86_400_000;

async function makeOrg(): Promise<string> {
  const org = await createOrganization({
    db,
    name: "acme",
    slug: `acme-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("self-heal breaker", () => {
  let org: string;
  let t0: Date;
  const at = (ms: number) => new Date(t0.getTime() + ms);

  async function events(
    outcomes: BreakerEventOutcome[],
    scopeKind: "github_write" | "github_read" = "github_write",
    start = 0,
  ) {
    for (const [i, outcome] of outcomes.entries()) {
      await recordBreakerEvent({
        db,
        organizationId: org,
        scopeKind,
        scopeKey: KEY,
        outcome,
        signal: "x",
        now: at(start + i),
      });
    }
  }

  function evalW(
    nowMs: number,
    logs: unknown[][] = [],
    scopeKind: "github_write" | "github_read" = "github_write",
  ) {
    return evaluateApiBreaker({
      db,
      organizationId: org,
      scopeKind,
      scopeKey: KEY,
      now: at(nowMs),
      logger: (m, f) => logs.push([m, f]),
    });
  }

  const state = (scopeKind: "github_write" | "github_read" = "github_write") =>
    getBreakerState({ db, organizationId: org, scopeKind, scopeKey: KEY });

  beforeEach(async () => {
    org = await makeOrg();
    t0 = new Date();
  });

  it("stays closed below min volume, opens at 5/10 failures with a 60 s cooldown", async () => {
    await events(Array(9).fill("failure"));
    expect(await evalW(1_000)).toBeNull();
    expect((await state()).state).toBe("closed");

    const org2 = org;
    await events(["success"], "github_write", 9);
    // 9 failures + 1 success = 10 events, 90% failures -> trips
    const logs: unknown[][] = [];
    const tr = await evalW(1_000, logs);
    expect(org).toBe(org2);
    expect(tr?.to).toBe("open");
    const row = await state();
    expect(row.tripCount).toBe(1);
    expect(row.openUntil?.getTime()).toBe(at(1_000).getTime() + 60_000);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0]).toBe("[self-heal:breaker] transition");
    expect(Object.keys(logs[0]![1] as object).sort()).toEqual(
      [
        "from",
        "openUntil",
        "org",
        "reason",
        "scopeKey",
        "scopeKind",
        "to",
        "tripCount",
      ].sort(),
    );
    const trips = await db
      .select()
      .from(selfHealBreakerEvent)
      .where(
        and(
          eq(selfHealBreakerEvent.organizationId, org),
          eq(selfHealBreakerEvent.outcome, "trip"),
        ),
      );
    expect(trips).toHaveLength(1);
  });

  it("exactly 5 failures out of 10 trips", async () => {
    await events([
      "failure",
      "success",
      "failure",
      "success",
      "failure",
      "success",
      "failure",
      "success",
      "failure",
      "success",
    ]);
    expect((await evalW(1_000))?.to).toBe("open");
  });

  it("4 failures out of 10 does not trip", async () => {
    await events([
      "failure",
      "success",
      "failure",
      "success",
      "failure",
      "success",
      "failure",
      "success",
      "success",
      "success",
    ]);
    expect(await evalW(1_000)).toBeNull();
  });

  it("3 consecutive timeouts trip even below min volume", async () => {
    await events(["success", "timeout", "timeout", "timeout"]);
    const tr = await evalW(1_000);
    expect(tr?.to).toBe("open");
    expect(tr?.reason).toBe("consecutive_timeouts");
  });

  it("ignored events never count", async () => {
    await events(Array(12).fill("ignored"));
    expect(await evalW(1_000)).toBeNull();
  });

  it("open -> half_open after cooldown; one concurrent probe; success closes", async () => {
    await events(["timeout", "timeout", "timeout"]);
    await evalW(1_000);
    expect(await evalW(30_000)).toBeNull(); // still cooling
    const tr = await evalW(62_000);
    expect(tr?.to).toBe("half_open");
    const probes = await Promise.all([
      acquireHalfOpenProbe({
        db,
        organizationId: org,
        scopeKind: "github_write",
        scopeKey: KEY,
        now: at(62_100),
      }),
      acquireHalfOpenProbe({
        db: db2,
        organizationId: org,
        scopeKind: "github_write",
        scopeKey: KEY,
        now: at(62_100),
      }),
    ]);
    expect(probes.filter(Boolean)).toHaveLength(1);
    expect(await evalW(62_200)).toBeNull(); // no verdict yet
    await events(["success"], "github_write", 62_300);
    const closed = await evalW(62_400);
    expect(closed?.to).toBe("closed");
    expect((await state()).tripCount).toBe(1);
  });

  it("a failed probe re-opens with a 120 s cooldown (trip_count 2)", async () => {
    await events(["timeout", "timeout", "timeout"]);
    await evalW(1_000);
    await evalW(62_000);
    await acquireHalfOpenProbe({
      db,
      organizationId: org,
      scopeKind: "github_write",
      scopeKey: KEY,
      now: at(62_100),
    });
    await events(["failure"], "github_write", 62_300);
    const tr = await evalW(62_400);
    expect(tr?.to).toBe("open");
    const row = await state();
    expect(row.tripCount).toBe(2);
    expect(row.openUntil?.getTime()).toBe(at(62_400).getTime() + 120_000);
  });

  it("an expired probe lease can be taken again", async () => {
    await events(["timeout", "timeout", "timeout"]);
    await evalW(1_000);
    await evalW(62_000);
    const args = {
      db,
      organizationId: org,
      scopeKind: "github_write" as const,
      scopeKey: KEY,
    };
    expect(await acquireHalfOpenProbe({ ...args, now: at(62_100) })).toBe(true);
    expect(await acquireHalfOpenProbe({ ...args, now: at(70_000) })).toBe(
      false,
    );
    expect(await acquireHalfOpenProbe({ ...args, now: at(100_000) })).toBe(
      true,
    );
  });

  it("cooldowns are capped: write 15 min, read 5 min", () => {
    expect(breakerCooldownMs("github_write", 1)).toBe(60_000);
    expect(breakerCooldownMs("github_write", 2)).toBe(120_000);
    expect(breakerCooldownMs("github_write", 30)).toBe(15 * 60_000);
    expect(breakerCooldownMs("github_read", 1)).toBe(30_000);
    expect(breakerCooldownMs("github_read", 30)).toBe(5 * 60_000);
  });

  it("github_read opens with its own 30 s cooldown", async () => {
    await events(["timeout", "timeout", "timeout"], "github_read");
    await evalW(1_000, [], "github_read");
    const row = await state("github_read");
    expect(row.openUntil?.getTime()).toBe(at(1_000).getTime() + 30_000);
  });

  it("concurrent evaluations of one trip produce exactly one transition", async () => {
    await events(["timeout", "timeout", "timeout"]);
    const logs: unknown[][] = [];
    const results = await Promise.all([evalW(1_000, logs), evalW(1_000, logs)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect((await state()).tripCount).toBe(1);
  });

  it("rate_limited_until only moves forward", async () => {
    const base = Date.now();
    const call = (ms: number) =>
      extendRateLimitedUntil({
        db,
        organizationId: org,
        installationKey: KEY,
        until: new Date(base + ms),
      });
    await call(120_000);
    await call(30_000);
    expect((await state()).rateLimitedUntil?.getTime()).toBe(base + 120_000);
    await call(300_000);
    expect((await state()).rateLimitedUntil?.getTime()).toBe(base + 300_000);
  });

  it("the hourly create budget is a Postgres count shared by two clients", async () => {
    const since = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 20; i++) {
      await recordBreakerEvent({
        db: i % 2 === 0 ? db : db2,
        organizationId: org,
        scopeKind: "github_write",
        scopeKey: KEY,
        outcome: "ignored",
        signal: "gh_create",
      });
    }
    await recordBreakerEvent({
      db,
      organizationId: org,
      scopeKind: "github_write",
      scopeKey: KEY,
      outcome: "ignored",
      signal: "gh_create",
      now: new Date(Date.now() - 2 * 3_600_000),
    });
    const args = {
      organizationId: org,
      scopeKind: "github_write" as const,
      scopeKey: KEY,
      signal: "gh_create",
      since,
    };
    expect(await countRecentEvents({ db, ...args })).toBe(20);
    expect(await countRecentEvents({ db: db2, ...args })).toBe(20);
  });

  it("permission latch opens on set and closes only on clear", async () => {
    const args = {
      db,
      organizationId: org,
      installationId: "9",
      permission: "issues" as const,
    };
    await setPermissionLatch({ ...args, reason: "403" });
    const key = "9:issues";
    const read = () =>
      getBreakerState({
        db,
        organizationId: org,
        scopeKind: "permission",
        scopeKey: key,
      });
    expect((await read()).state).toBe("open");
    await setPermissionLatch({ ...args, reason: "403 again" });
    expect((await read()).state).toBe("open");
    await clearPermissionLatch({ ...args, reason: "preflight write" });
    expect((await read()).state).toBe("closed");
  });

  it("resetBreaker closes, keeps trip_count and logs the actor", async () => {
    await events(["timeout", "timeout", "timeout"]);
    await evalW(1_000);
    await resetBreaker({
      db,
      organizationId: org,
      scopeKind: "github_write",
      scopeKey: KEY,
      actorUserId: "admin-1",
    });
    const row = await state();
    expect(row.state).toBe("closed");
    expect(row.tripCount).toBe(1);
    const log = await db
      .select()
      .from(selfHealAdminLog)
      .where(eq(selfHealAdminLog.organizationId, org));
    expect(log).toHaveLength(1);
    expect(log[0]?.action).toBe("breaker_reset");
    expect(log[0]?.actorUserId).toBe("admin-1");
  });

  it("trip_count decays by 1 per 14 closed days, never below 0", async () => {
    await db.insert(selfHealBreaker).values({
      organizationId: org,
      scopeKind: "github_write",
      scopeKey: KEY,
      tripCount: 3,
      updatedAt: at(-28 * DAY),
    });
    expect(await evalW(0)).toBeNull();
    expect((await state()).tripCount).toBe(1);
    await db
      .update(selfHealBreaker)
      .set({ updatedAt: at(-60 * DAY) })
      .where(eq(selfHealBreaker.organizationId, org));
    await evalW(0);
    expect((await state()).tripCount).toBe(0);
  });

  it("the synthetic state for an unknown scope is closed with version -1", async () => {
    const s = await getBreakerState({
      db,
      organizationId: org,
      scopeKind: "exec_plane",
      scopeKey: "*",
    });
    expect(s.state).toBe("closed");
    expect(s.version).toBe(-1);
  });
});
