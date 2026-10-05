import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  auditFixAttempts,
  auditRuns,
  selfHealBreaker,
} from "@terragon/shared/db/schema";
import { insertFinding } from "@terragon/shared/model/audit-findings";
import {
  getBreakerState,
  recordBreakerEvent,
  tripBreaker,
} from "@terragon/shared/model/self-heal-breaker";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import {
  attemptSignalOf,
  auditRunSignalOf,
  evaluateLoopAudit,
  evaluateLoopFix,
  evaluatePlaneBreakers,
  LOOP_BREAKER_LIMIT,
  LOOP_COOLDOWNS_MS,
  runLoopBreakerEvaluation,
  type LoopAuditFindingSignal,
  type LoopAuditRunSignal,
  type LoopBreakerEvent,
  type LoopFixAttemptSignal,
  type PlaneEvent,
} from "./loop-breaker";

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = new Date(Date.UTC(2026, 9, 4, 12));
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let seq = 0;
function attempt(
  result: LoopFixAttemptSignal["result"],
  outcome: string | null = result === "failure" ? "ci_failed" : null,
  extra: Partial<LoopFixAttemptSignal> = {},
): LoopFixAttemptSignal {
  seq += 1;
  return {
    id: `a${seq}`,
    findingId: `f${seq}`,
    createdAt: ago(seq * MIN),
    result,
    outcome,
    ...extra,
  };
}

function event(
  signal: string,
  msAgo: number,
  outcome: LoopBreakerEvent["outcome"] = "failure",
): LoopBreakerEvent {
  return { signal, outcome, createdAt: ago(msAgo) };
}

describe("LOOP_COOLDOWNS_MS", () => {
  it("is 24 h then 72 h", () => {
    expect(LOOP_COOLDOWNS_MS).toEqual([86_400_000, 259_200_000]);
  });
});

describe("LOOP_BREAKER_LIMIT", () => {
  it("evaluates at most 20 repos per tick", () => {
    expect(LOOP_BREAKER_LIMIT).toBe(20);
  });
});

describe("attemptSignalOf (counted vs refunded)", () => {
  const base = {
    id: "x",
    findingId: "f",
    createdAt: NOW,
    phase: "closed" as const,
    infraRefunded: false,
    outcome: "ci_failed",
    terminalCause: "ci_failed",
    prNumber: null,
    guardStatus: null,
    checkStatus: null,
  };

  it("counted closes are failures; refunds are refunded", () => {
    expect(attemptSignalOf(base).result).toBe("failure");
    expect(
      attemptSignalOf({ ...base, infraRefunded: true, outcome: "ci_infra" })
        .result,
    ).toBe("refunded");
    expect(
      attemptSignalOf({ ...base, infraRefunded: true, outcome: "stuck" })
        .result,
    ).toBe("refunded");
  });

  it("a counted close for an exhausted login never counts toward a breaker", () => {
    expect(
      attemptSignalOf({
        ...base,
        outcome: "run_failed",
        terminalCause: "credential",
      }).result,
    ).toBe("excluded");
  });

  it("a draft opened with check + guard passed is a success; in flight is pending", () => {
    expect(
      attemptSignalOf({
        ...base,
        phase: "ci_pending",
        outcome: null,
        terminalCause: null,
        prNumber: 7,
        guardStatus: "passed",
        checkStatus: "passed",
      }).result,
    ).toBe("success");
    expect(
      attemptSignalOf({
        ...base,
        phase: "dispatched",
        outcome: null,
        terminalCause: null,
      }).result,
    ).toBe("pending");
  });
});

describe("evaluateLoopFix (RES-15)", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("3 consecutive counted failures trip", () => {
    const d = evaluateLoopFix({
      attempts: [
        attempt("failure", "guard_rejected"),
        attempt("failure", "sha_mismatch"),
        attempt("failure", "run_failed"),
      ],
      events: [],
      now: NOW,
    });
    expect(d.trip).toBe(true);
    if (d.trip) {
      expect(d.reason).toBe("consecutive_failures");
      expect(d.evidence.attemptIds).toEqual(["a1", "a2", "a3"]);
    }
  });

  it("2 counted failures do not trip", () => {
    expect(
      evaluateLoopFix({
        attempts: [attempt("failure", "run_failed"), attempt("failure", "x")],
        events: [],
        now: NOW,
      }).trip,
    ).toBe(false);
  });

  it("refunded (infra) and excluded attempts interleaved never count and never break the run", () => {
    const attempts = [
      attempt("failure", "run_failed"),
      attempt("refunded", "ci_infra"),
      attempt("failure", "no_changes"),
      attempt("refunded", "stuck"),
      attempt("excluded", "run_failed"),
    ];
    expect(evaluateLoopFix({ attempts, events: [], now: NOW }).trip).toBe(
      false,
    );
    const refundsOnly = [1, 2, 3, 4, 5].map(() =>
      attempt("refunded", "ci_infra"),
    );
    expect(
      evaluateLoopFix({ attempts: refundsOnly, events: [], now: NOW }).trip,
    ).toBe(false);
    const withThird = [...attempts, attempt("failure", "run_failed")];
    const d = evaluateLoopFix({ attempts: withThird, events: [], now: NOW });
    expect(d.trip && d.reason).toBe("consecutive_failures");
  });

  it("2 guard rejections in the last 10 attempts trip", () => {
    const d = evaluateLoopFix({
      attempts: [
        attempt("failure", "guard_rejected"),
        attempt("success"),
        attempt("success"),
        attempt("failure", "guard_rejected"),
      ],
      events: [],
      now: NOW,
    });
    expect(d.trip && d.reason).toBe("guard_rejections");
  });

  it("a guard rejection older than the last 10 decided attempts does not count", () => {
    const attempts = [
      attempt("failure", "guard_rejected"),
      ...Array.from({ length: 9 }, () => attempt("success")),
      attempt("failure", "guard_rejected"),
    ];
    expect(evaluateLoopFix({ attempts, events: [], now: NOW }).trip).toBe(
      false,
    );
  });

  it("3 consecutive CI failures across 3 different findings trip as ci_failures", () => {
    const d = evaluateLoopFix({
      attempts: [
        attempt("failure", "ci_failed"),
        attempt("failure", "ci_failed"),
        attempt("failure", "ci_failed"),
      ],
      events: [],
      now: NOW,
    });
    expect(d.trip && d.reason).toBe("ci_failures");
  });

  it("the same finding failing CI thrice is not the ci_failures rule", () => {
    const d = evaluateLoopFix({
      attempts: [
        attempt("failure", "ci_failed", { findingId: "same" }),
        attempt("failure", "ci_failed", { findingId: "same" }),
        attempt("failure", "ci_failed", { findingId: "same" }),
      ],
      events: [],
      now: NOW,
    });
    expect(d.trip && d.reason).toBe("consecutive_failures");
  });

  it("≥ 50% of the last 6 attempts in 14 days (min 4) trip", () => {
    const four = [
      attempt("failure", "run_failed"),
      attempt("success"),
      attempt("failure", "run_failed"),
      attempt("success"),
    ];
    expect(evaluateLoopFix({ attempts: four, events: [], now: NOW })).toEqual(
      expect.objectContaining({ trip: true, reason: "failure_rate" }),
    );
    // Below the minimum volume: 2 of 3.
    expect(
      evaluateLoopFix({ attempts: four.slice(0, 3), events: [], now: NOW })
        .trip,
    ).toBe(false);
    // 2 of 6 is below 50%.
    const six = [
      attempt("failure", "run_failed"),
      attempt("success"),
      attempt("success"),
      attempt("failure", "run_failed"),
      attempt("success"),
      attempt("success"),
    ];
    expect(evaluateLoopFix({ attempts: six, events: [], now: NOW }).trip).toBe(
      false,
    );
    // Older than 14 days does not count.
    const old = four.map((a) => ({ ...a, createdAt: ago(15 * DAY) }));
    expect(evaluateLoopFix({ attempts: old, events: [], now: NOW }).trip).toBe(
      false,
    );
  });

  it("2 reopen/regressed events in 30 days trip; one does not; older ones do not count", () => {
    expect(
      evaluateLoopFix({
        attempts: [],
        events: [event("reopened", DAY), event("regressed", 20 * DAY)],
        now: NOW,
      }),
    ).toEqual(expect.objectContaining({ trip: true, reason: "regressions" }));
    expect(
      evaluateLoopFix({
        attempts: [],
        events: [event("reopened", DAY), event("regressed", 31 * DAY)],
        now: NOW,
      }).trip,
    ).toBe(false);
  });

  it("2 consecutive pr_expired trip; a merge in between resets", () => {
    expect(
      evaluateLoopFix({
        attempts: [],
        events: [event("pr_expired", H), event("pr_expired", 2 * H)],
        now: NOW,
      }),
    ).toEqual(expect.objectContaining({ trip: true, reason: "pr_expired" }));
    expect(
      evaluateLoopFix({
        attempts: [],
        events: [
          event("pr_expired", H),
          event("pr_merged", 2 * H, "success"),
          event("pr_expired", 3 * H),
        ],
        now: NOW,
      }).trip,
    ).toBe(false);
  });

  it("3 gh_403/gh_422 on repo writes in 1 h trip; spread over more than 1 h does not", () => {
    expect(
      evaluateLoopFix({
        attempts: [],
        events: [
          event("gh_403", MIN, "ignored"),
          event("gh_422", 10 * MIN, "ignored"),
          event("gh_403", 50 * MIN, "ignored"),
        ],
        now: NOW,
      }),
    ).toEqual(expect.objectContaining({ trip: true, reason: "gh_errors" }));
    expect(
      evaluateLoopFix({
        attempts: [],
        events: [
          event("gh_403", MIN, "ignored"),
          event("gh_422", 10 * MIN, "ignored"),
          event("gh_403", 70 * MIN, "ignored"),
        ],
        now: NOW,
      }).trip,
    ).toBe(false);
  });

  it("draft_unsupported pauses the repo immediately (paused_manual)", () => {
    const d = evaluateLoopFix({
      attempts: [],
      events: [event("draft_unsupported", MIN)],
      now: NOW,
    });
    expect(d).toEqual(
      expect.objectContaining({
        trip: true,
        reason: "draft_unsupported",
        cooldownMs: "paused_manual",
      }),
    );
  });
});

describe("evaluateLoopAudit", () => {
  const run = (
    result: LoopAuditRunSignal["result"],
    msAgo: number,
  ): LoopAuditRunSignal => ({ id: `r${msAgo}`, createdAt: ago(msAgo), result });

  it("auditRunSignalOf: unparseable or incomplete is bad, complete is good, unfinished or infra is skipped", () => {
    const r = { status: "done", outcome: "applied", complete: true };
    expect(auditRunSignalOf(r)).toBe("good");
    expect(auditRunSignalOf({ ...r, complete: false })).toBe("bad");
    expect(
      auditRunSignalOf({
        status: "failed",
        outcome: "unparseable",
        complete: null,
      }),
    ).toBe("bad");
    expect(
      auditRunSignalOf({ status: "failed", outcome: "error", complete: null }),
    ).toBe("skip");
    expect(
      auditRunSignalOf({ status: "claimed", outcome: null, complete: null }),
    ).toBe("skip");
  });

  it("3 consecutive bad runs trip; a complete parseable run in between resets", () => {
    expect(
      evaluateLoopAudit({
        runs: [run("bad", 1), run("skip", 2), run("bad", 3), run("bad", 4)],
        findings: [],
        now: NOW,
      }),
    ).toEqual(
      expect.objectContaining({ trip: true, reason: "consecutive_bad_audits" }),
    );
    expect(
      evaluateLoopAudit({
        runs: [run("bad", 1), run("good", 2), run("bad", 3), run("bad", 4)],
        findings: [],
        now: NOW,
      }).trip,
    ).toBe(false);
  });

  it("churn: ≥ 50% of the issues created in 14 days closed as absent within 2 audits", () => {
    const runs = [
      run("good", 1 * DAY),
      run("good", 2 * DAY),
      run("good", 3 * DAY),
    ];
    const finding = (
      createdAgo: number,
      closedAgo: number | null,
    ): LoopAuditFindingSignal => ({
      createdAt: ago(createdAgo),
      closedAsAbsentAt: closedAgo === null ? null : ago(closedAgo),
    });
    // Created 3.5 d ago, closed 1.5 d ago: 2 audits in between → churn.
    const churned = finding(3.5 * DAY, 1.5 * DAY);
    const kept = finding(3.5 * DAY, null);
    expect(
      evaluateLoopAudit({ runs, findings: [churned, kept], now: NOW }),
    ).toEqual(expect.objectContaining({ trip: true, reason: "churn" }));
    // Closed after 3 audits is not churn.
    const late = finding(3.5 * DAY, 0.5 * DAY);
    expect(
      evaluateLoopAudit({ runs, findings: [late, kept], now: NOW }).trip,
    ).toBe(false);
    // 1 of 3 is below the threshold.
    expect(
      evaluateLoopAudit({ runs, findings: [churned, kept, kept], now: NOW })
        .trip,
    ).toBe(false);
    // A single issue is below the minimum volume.
    expect(
      evaluateLoopAudit({ runs, findings: [churned], now: NOW }).trip,
    ).toBe(false);
  });
});

describe("evaluatePlaneBreakers", () => {
  const pe = (
    outcome: PlaneEvent["outcome"],
    signal: string,
    msAgo: number,
  ): PlaneEvent => ({ outcome, signal, createdAt: ago(msAgo) });

  it("3 consecutive dispatch timeouts/connection failures trip hatchet_dispatch", () => {
    const d = evaluatePlaneBreakers({
      hatchet: [
        pe("timeout", "dispatch_timeout", 1),
        pe("failure", "dispatch_lost", 2),
        pe("failure", "dispatch_lost", 3),
        pe("success", "dispatch_visible", 4),
      ],
      exec: [],
      now: NOW,
    });
    expect(d.hatchet_dispatch).toEqual(
      expect.objectContaining({ trip: true, reason: "consecutive_failures" }),
    );
    expect(d.exec_plane.trip).toBe(false);
  });

  it("≥ 50% of the last 10 dispatches in 10 min (min 5) trip hatchet_dispatch", () => {
    const events = [
      pe("failure", "dispatch_lost", 1 * MIN),
      pe("success", "dispatch_visible", 2 * MIN),
      pe("failure", "dispatch_lost", 3 * MIN),
      pe("success", "dispatch_visible", 4 * MIN),
      pe("failure", "dispatch_lost", 5 * MIN),
    ];
    expect(
      evaluatePlaneBreakers({ hatchet: events, exec: [], now: NOW })
        .hatchet_dispatch,
    ).toEqual(expect.objectContaining({ trip: true, reason: "error_rate" }));
    // Outside the 10 minute window, the volume is too small.
    const stale = events.map((e) => ({
      ...e,
      createdAt: new Date(e.createdAt.getTime() - 20 * MIN),
    }));
    expect(
      evaluatePlaneBreakers({ hatchet: stale, exec: [], now: NOW })
        .hatchet_dispatch.trip,
    ).toBe(false);
  });

  it("3 consecutive infra terminal causes trip exec_plane", () => {
    const d = evaluatePlaneBreakers({
      hatchet: [],
      exec: [
        pe("failure", "timeout", 1),
        pe("failure", "daemon_failed", 2),
        pe("failure", "plane_offline", 3),
      ],
      now: NOW,
    });
    expect(d.exec_plane).toEqual(
      expect.objectContaining({ trip: true, reason: "consecutive_infra" }),
    );
  });

  it("≥ 50% of the last 6 runs trip exec_plane", () => {
    const d = evaluatePlaneBreakers({
      hatchet: [],
      exec: [
        pe("failure", "timeout", 1),
        pe("success", "check_reported", 2),
        pe("failure", "sandbox_lost", 3),
        pe("success", "check_reported", 4),
        pe("failure", "check_missing", 5),
        pe("success", "check_reported", 6),
      ],
      now: NOW,
    });
    expect(d.exec_plane).toEqual(
      expect.objectContaining({ trip: true, reason: "infra_rate" }),
    );
  });

  it("login-exhaustion outcomes never contribute", () => {
    const d = evaluatePlaneBreakers({
      hatchet: [],
      exec: [
        pe("failure", "credential", 1),
        pe("failure", "credential", 2),
        pe("failure", "credential", 3),
        pe("failure", "timeout", 4),
      ],
      now: NOW,
    });
    expect(d.exec_plane.trip).toBe(false);
  });
});

/**
 * DB: ancient instants, one window per test (the selectors are cross-org,
 * so rows other files create at wall-clock time stay outside every window).
 */
const BASE = Date.UTC(1991, 0, 1);
let windowNo = 0;

describe("runLoopBreakerEvaluation (DB)", () => {
  let organizationId: string;
  let userId: string;
  let now: Date;
  const REPO = "acme/widgets";
  let logs: Array<[string, Record<string, unknown>]>;
  let captured: Array<[string, Record<string, string>]>;

  beforeEach(async () => {
    windowNo += 1;
    now = new Date(BASE + windowNo * 90 * DAY);
    organizationId = await createTestOrg({ db });
    const { user } = await createTestUser({ db });
    userId = user.id;
    logs = [];
    captured = [];
  });

  const evaluate = (at: Date = now) =>
    runLoopBreakerEvaluation({
      db,
      now: at,
      deadlineAt: new Date(Date.now() + 60_000),
      // Other suites in the same database leave moving breakers behind; the
      // production LIMIT is pinned by the LOOP_BREAKER_LIMIT test.
      limit: 1_000,
      deps: {
        log: (m, f) => logs.push([m, f]),
        error: (m, f) => logs.push([m, f]),
        capture: (e, p) => captured.push([e, p]),
      },
    });

  const state = (
    scopeKind: "loop_fix" | "loop_audit" | "exec_plane" | "hatchet_dispatch",
    scopeKey = REPO,
  ) => getBreakerState({ db, organizationId, scopeKind, scopeKey });

  async function seedAttempt(
    values: Partial<typeof auditFixAttempts.$inferInsert>,
    createdAgoMs: number,
  ) {
    const finding = await insertFinding({
      db,
      organizationId,
      finding: {
        repoFullName: REPO,
        fingerprint: randomBytes(8).toString("hex"),
        audit: "security-audit",
        ruleId: "supply.lockfile-missing",
        severity: "high",
        checkKind: "script",
        title: "Lockfile missing",
        status: "open",
      },
    });
    const [row] = await db
      .insert(auditFixAttempts)
      .values({
        organizationId,
        repoFullName: REPO,
        findingId: finding.id,
        attemptNo: 1,
        createdAt: new Date(now.getTime() - createdAgoMs),
        ...values,
      })
      .returning();
    return row!;
  }

  it("3 consecutive counted failures trip loop_fix with one transition, one LOOP_OPEN and PostHog events", async () => {
    for (const [i, outcome] of [
      "ci_failed",
      "guard_rejected",
      "run_failed",
    ].entries()) {
      await seedAttempt(
        {
          phase: "closed",
          outcome,
          terminalCause: outcome,
          infraRefunded: false,
        },
        (i + 1) * H,
      );
    }
    await seedAttempt(
      {
        phase: "closed",
        outcome: "ci_infra",
        terminalCause: "ci_infra",
        infraRefunded: true,
      },
      30 * MIN,
    );
    // Other suites' breakers share the database: count only this org's lines.
    const mine = () =>
      logs.filter(([, f]) => f.org === organizationId).map(([m]) => m);
    await evaluate();
    const row = await state("loop_fix");
    expect(row.state).toBe("open");
    expect(row.lastTripReason).toBe("consecutive_failures");
    expect(row.openUntil?.getTime()).toBe(now.getTime() + DAY);
    expect(mine()).toEqual([
      "[self-heal:breaker] transition",
      "[self-heal:breaker] LOOP_OPEN",
    ]);
    expect(
      captured.filter(([, p]) => p.org === organizationId).map(([e]) => e),
    ).toEqual(["self_heal_breaker_transition", "self_heal_loop_paused"]);
    // A second evaluation changes nothing.
    await evaluate();
    expect(mine()).toHaveLength(2);
    expect((await state("loop_fix")).version).toBe(row.version);
  });

  it("refunded attempts never trip", async () => {
    for (let i = 0; i < 5; i++) {
      await seedAttempt(
        {
          phase: "closed",
          outcome: "refunded",
          terminalCause: "timeout",
          infraRefunded: true,
        },
        (i + 1) * H,
      );
    }
    await evaluate();
    expect((await state("loop_fix")).state).toBe("closed");
  });

  it("a draft_unsupported event pauses the repo", async () => {
    await recordBreakerEvent({
      db,
      organizationId,
      scopeKind: "loop_fix",
      scopeKey: REPO,
      outcome: "failure",
      signal: "draft_unsupported",
      now: new Date(now.getTime() - MIN),
    });
    await evaluate();
    expect((await state("loop_fix")).state).toBe("paused_manual");
  });

  it("moves an expired open to half_open, and old failures do not re-trip after the probe closes it", async () => {
    for (let i = 0; i < 3; i++) {
      await seedAttempt(
        {
          phase: "closed",
          outcome: "run_failed",
          terminalCause: "agent_error",
          infraRefunded: false,
        },
        (i + 1) * H,
      );
    }
    await evaluate();
    expect((await state("loop_fix")).state).toBe("open");
    const later = new Date(now.getTime() + DAY + MIN);
    await evaluate(later);
    expect((await state("loop_fix")).state).toBe("half_open");
    // The probe attempt (dispatcher-stamped) opened its draft.
    const probe = await seedAttempt(
      {
        phase: "ci_pending",
        prNumber: 12,
        guardStatus: "passed",
        checkStatus: "passed",
      },
      now.getTime() - later.getTime() - MIN,
    );
    await db
      .update(selfHealBreaker)
      .set({
        halfOpenProbesLeft: 0,
        lastTripEvidence: { probeAttemptId: probe.id },
      })
      .where(
        and(
          eq(selfHealBreaker.organizationId, organizationId),
          eq(selfHealBreaker.scopeKind, "loop_fix"),
        ),
      );
    await evaluate(new Date(later.getTime() + 10 * MIN));
    const closed = await state("loop_fix");
    expect(closed.state).toBe("closed");
    expect(closed.tripCount).toBe(1);
    await evaluate(new Date(later.getTime() + 20 * MIN));
    expect((await state("loop_fix")).state).toBe("closed");
  });

  it("a counted probe failure re-opens with the next cooldown; a refunded probe is released", async () => {
    await tripBreaker({
      db,
      organizationId,
      scopeKind: "loop_fix",
      scopeKey: REPO,
      reason: "consecutive_failures",
      evidence: {},
      now: new Date(now.getTime() - 2 * DAY),
    });
    await evaluate(); // cooldown over → half_open
    expect((await state("loop_fix")).state).toBe("half_open");
    const refunded = await seedAttempt(
      {
        phase: "closed",
        outcome: "refunded",
        terminalCause: "timeout",
        infraRefunded: true,
      },
      -MIN,
    );
    const stamp = (attemptId: string) =>
      db
        .update(selfHealBreaker)
        .set({
          halfOpenProbesLeft: 0,
          lastTripEvidence: { probeAttemptId: attemptId },
        })
        .where(
          and(
            eq(selfHealBreaker.organizationId, organizationId),
            eq(selfHealBreaker.scopeKind, "loop_fix"),
          ),
        );
    await stamp(refunded.id);
    await evaluate(new Date(now.getTime() + 10 * MIN));
    const released = await state("loop_fix");
    expect(released.state).toBe("half_open");
    expect(released.halfOpenProbesLeft).toBe(1);

    const failed = await seedAttempt(
      {
        phase: "closed",
        outcome: "ci_failed",
        terminalCause: "ci_failed",
        infraRefunded: false,
      },
      -20 * MIN,
    );
    await stamp(failed.id);
    const at = new Date(now.getTime() + 30 * MIN);
    await evaluate(at);
    const reopened = await state("loop_fix");
    expect(reopened.state).toBe("open");
    expect(reopened.tripCount).toBe(2);
    expect(reopened.openUntil?.getTime()).toBe(at.getTime() + 3 * DAY);
  });

  it("3 consecutive unparseable audits trip loop_audit", async () => {
    for (let i = 0; i < 3; i++) {
      const { threadId } = await createTestThread({ db, userId });
      await db.insert(auditRuns).values({
        organizationId,
        repoFullName: REPO,
        threadId,
        audit: "security-audit",
        status: "failed",
        outcome: "unparseable",
        createdAt: new Date(now.getTime() - (i + 1) * DAY),
      });
    }
    await evaluate();
    const row = await state("loop_audit");
    expect(row.state).toBe("open");
    expect(row.lastTripReason).toBe("consecutive_bad_audits");
  });

  it("3 consecutive exec_plane infra failures trip exec_plane; the closed hatchet breaker stays closed", async () => {
    for (const [i, signal] of [
      "timeout",
      "daemon_failed",
      "plane_offline",
    ].entries()) {
      await recordBreakerEvent({
        db,
        organizationId,
        scopeKind: "exec_plane",
        scopeKey: "*",
        outcome: "failure",
        signal,
        now: new Date(now.getTime() - (i + 1) * H),
      });
    }
    await recordBreakerEvent({
      db,
      organizationId,
      scopeKind: "hatchet_dispatch",
      scopeKey: "*",
      outcome: "success",
      signal: "dispatch_visible",
      now: new Date(now.getTime() - H),
    });
    await evaluate();
    const exec = await state("exec_plane", "*");
    expect(exec.state).toBe("open");
    expect(exec.openUntil?.getTime()).toBe(now.getTime() + H);
    expect((await state("hatchet_dispatch", "*")).state).toBe("closed");
  });
});
