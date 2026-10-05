import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db } from "@/lib/db";
import { hatchetRun, selfHealSlot, thread } from "@terragon/shared/db/schema";
import { getSelfHealSlot } from "@terragon/shared/model/self-heal-slot";
import {
  createTestAutomation,
  createTestOrg,
  createTestRemoteRun,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { admitSelfHealRun, hasReviewInFlight } from "./self-heal-admission";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/**
 * Each test reads at its own far-future instant, so rows written by other
 * test files (created at wall-clock time) and by earlier tests here are
 * outside the 60 min window — the check is platform-wide by design.
 */
const BASE = Date.parse("2099-01-01T00:00:00.000Z");
let day = 0;

describe("self-heal admission (RES-11)", () => {
  let orgId: string;
  let userId: string;
  let now: Date;
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
  };

  async function reviewRun({
    ageMin,
    status = "working",
    enableThreadChatCreation = false,
  }: {
    ageMin: number;
    status?: "working" | "complete";
    enableThreadChatCreation?: boolean;
  }): Promise<string> {
    const run = await createTestRemoteRun({
      db,
      userId,
      organizationId: orgId,
      prNumber: Math.floor(Math.random() * 100_000) + 1,
      externalId: nanoid(),
      status,
      enableThreadChatCreation,
    });
    await db
      .update(hatchetRun)
      .set({ createdAt: new Date(now.getTime() - ageMin * MIN) })
      .where(eq(hatchetRun.id, run.runId));
    return run.threadId;
  }

  async function automationThread({
    triggerType,
    status,
    ageMin,
  }: {
    triggerType: "pull_request" | "schedule";
    status: "queued" | "booting" | "complete";
    ageMin: number;
  }): Promise<string> {
    const automation = await createTestAutomation({
      db,
      userId,
      values: {
        organizationId: orgId,
        repoFullName: "acme/widgets",
        triggerType,
        ...(triggerType === "pull_request"
          ? {
              // any: createTestAutomation merges a schedule-shaped default.
              triggerConfig: {
                on: { open: true },
                filter: { includeAllAuthors: true },
              } as any,
            }
          : {}),
      },
    });
    const { threadId } = await createTestThread({
      db,
      userId,
      overrides: {
        organizationId: orgId,
        automationId: automation.id,
        githubRepoFullName: "acme/widgets",
        githubPRNumber: triggerType === "pull_request" ? 7 : undefined,
      },
    });
    await db
      .update(thread)
      .set({ status, createdAt: new Date(now.getTime() - ageMin * MIN) })
      .where(eq(thread.id, threadId));
    return threadId;
  }

  beforeEach(async () => {
    day += 1;
    now = new Date(BASE + day * DAY);
    lines = [];
    await db.delete(selfHealSlot);
    orgId = await createTestOrg({ db });
    userId = (await createTestUser({ db })).user.id;
  });

  it("admits and takes the slot when no review is live", async () => {
    expect(await hasReviewInFlight({ db, now })).toBe(false);
    const r = await admitSelfHealRun({
      db,
      organizationId: orgId,
      holderKind: "fix",
      now,
      log,
    });
    expect(r).toEqual({ admitted: true });
    const slot = await getSelfHealSlot({ db });
    expect(slot?.holderKind).toBe("fix");
    expect(slot?.organizationId).toBe(orgId);
    expect(lines).toEqual([]);
  });

  it("defers while a dispatched review is in flight — no slot taken, one log line", async () => {
    await reviewRun({ ageMin: 10 });
    expect(await hasReviewInFlight({ db, now })).toBe(true);
    const r = await admitSelfHealRun({
      db,
      organizationId: orgId,
      holderKind: "fix",
      now,
      context: { repoFullName: "acme/widgets", mode: "on" },
      log,
    });
    expect(r).toEqual({ admitted: false, reason: "review_in_flight" });
    expect(await getSelfHealSlot({ db })).toBeNull();
    expect(lines).toEqual([
      `[self-heal] v=1 org=${orgId} repo=acme/widgets run=- fp=- decision=dispatch reason=admission_deferred:review_in_flight mode=on`,
    ]);
  });

  it("defers for a queued PR-review thread that has no hatchet_run row yet", async () => {
    await automationThread({
      triggerType: "pull_request",
      status: "queued",
      ageMin: 5,
    });
    const r = await admitSelfHealRun({
      db,
      organizationId: orgId,
      holderKind: "audit",
      now,
      log,
    });
    expect(r).toEqual({ admitted: false, reason: "review_in_flight" });
    expect(await getSelfHealSlot({ db })).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("ignores a stale in_flight row (> 60 min) whose thread is terminal", async () => {
    await reviewRun({ ageMin: 61, status: "complete" });
    const r = await admitSelfHealRun({
      db,
      organizationId: orgId,
      holderKind: "fix",
      now,
      log,
    });
    expect(r).toEqual({ admitted: true });
  });

  it("ignores a fresh in_flight row whose chat-mode thread is complete", async () => {
    await reviewRun({
      ageMin: 5,
      status: "complete",
      enableThreadChatCreation: true,
    });
    expect(await hasReviewInFlight({ db, now })).toBe(false);
  });

  it("ignores old PR-review threads and non-review queued threads", async () => {
    await automationThread({
      triggerType: "pull_request",
      status: "queued",
      ageMin: 61,
    });
    await automationThread({
      triggerType: "schedule",
      status: "booting",
      ageMin: 5,
    });
    await automationThread({
      triggerType: "pull_request",
      status: "complete",
      ageMin: 5,
    });
    expect(await hasReviewInFlight({ db, now })).toBe(false);
  });

  it("two concurrent admissions with no review: one admitted, one slot_held", async () => {
    const otherOrg = await createTestOrg({ db });
    const results = await Promise.all([
      admitSelfHealRun({
        db,
        organizationId: orgId,
        holderKind: "fix",
        now,
        log,
      }),
      admitSelfHealRun({
        db,
        organizationId: otherOrg,
        holderKind: "audit",
        now,
        log,
      }),
    ]);
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(results.filter((r) => !r.admitted)).toEqual([
      { admitted: false, reason: "slot_held" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "decision=dispatch reason=admission_deferred:slot_held",
    );
  });
});
