import { describe, expect, it } from "vitest";

import {
  AUTHORIZED_MOVES,
  buildSnapshot,
  buildWebhookBody,
  commitTransition,
  DAY_MS,
  decideTransition,
  dedupeStatesFromSnapshot,
  evaluateRamSwap,
  evaluateRunSignals,
  GROWTH_REFIRE_MS,
  GROWTH_TRIGGER_IDS,
  growthWindow,
  INITIAL_DEDUPE_STATE,
  nearestRankPercentile,
  parseMemTotalAvailable,
  parsePswpin,
  parseRunRow,
  pruneMemSamples,
  type GrowthTriggerId,
  type MemSample,
  type RunRow,
  type RunSignalsResult,
  type TriggerDedupeState,
  type TriggerEvaluation,
} from "./growth-triggers";

// 2026-10-19T12:00Z: the window is 2026-10-12T00:00Z .. 2026-10-19T00:00Z (exclusive).
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const DAY0 = Date.UTC(2026, 9, 12);
const MIN = 60_000;

interface RowSpec {
  day: number;
  /** Offset into the day, ms. */
  at?: number;
  waitS?: number | null;
  runS?: number | null;
  org?: string | null;
  repo?: string | null;
  pr?: number | null;
  status?: string;
  id?: string | null;
}

let rowSeq = 0;

function row(spec: RowSpec): RunRow {
  const createdAtMs = DAY0 + spec.day * DAY_MS + (spec.at ?? 3_600_000);
  const waitS = spec.waitS === undefined ? 10 : spec.waitS;
  const startedAtMs = waitS === null ? null : createdAtMs + waitS * 1000;
  const runS = spec.runS === undefined ? 60 : spec.runS;
  const finishedAtMs =
    startedAtMs === null || runS === null ? null : startedAtMs + runS * 1000;
  rowSeq += 1;
  return {
    id: spec.id === undefined ? `run-${rowSeq}` : spec.id,
    status: spec.status ?? "COMPLETED",
    createdAtMs,
    startedAtMs,
    finishedAtMs,
    orgId: spec.org === undefined ? "org-a" : spec.org,
    repoFullName: spec.repo ?? null,
    prNumber: spec.pr ?? null,
  };
}

function evalRows(rows: RunRow[], questionnaire = false): RunSignalsResult {
  return evaluateRunSignals({
    runs: { kind: "rows", rows },
    nowMs: NOW,
    questionnaire,
  });
}

const sevenDays = (spec: Omit<RowSpec, "day">): RunRow[] =>
  Array.from({ length: 7 }, (_, day) => row({ ...spec, day }));

describe("parseRunRow", () => {
  const base = {
    actionId: "agent-run-newest:run",
    status: "COMPLETED",
    createdAt: "2026-10-15T10:00:00Z",
    startedAt: "2026-10-15T10:05:00Z",
    finishedAt: "2026-10-15T10:15:00Z",
    metadata: { id: "run-uuid-1" },
    taskExternalId: "task-uuid-1",
    additionalMetadata: {
      orgId: "org-1",
      lane: "pr",
      repoFullName: "acme/app",
      prNumber: "42",
    },
  };

  it("parses a full row; metadata values are strings", () => {
    expect(parseRunRow(base)).toEqual({
      id: "run-uuid-1",
      status: "COMPLETED",
      createdAtMs: Date.parse("2026-10-15T10:00:00Z"),
      startedAtMs: Date.parse("2026-10-15T10:05:00Z"),
      finishedAtMs: Date.parse("2026-10-15T10:15:00Z"),
      orgId: "org-1",
      repoFullName: "acme/app",
      prNumber: 42,
    });
  });

  it("takes the id from metadata.id, falling back to taskExternalId, else null", () => {
    expect(parseRunRow({ ...base, metadata: {} })?.id).toBe("task-uuid-1");
    expect(parseRunRow({ ...base, metadata: "nope" })?.id).toBe("task-uuid-1");
    expect(parseRunRow({ ...base, metadata: { id: 7 } })?.id).toBe(
      "task-uuid-1",
    );
    expect(
      parseRunRow({ ...base, metadata: undefined, taskExternalId: undefined })
        ?.id,
    ).toBeNull();
  });

  it("ignores non-run action ids and non-objects", () => {
    expect(
      parseRunRow({ ...base, actionId: "agent-run:on-failure-task" }),
    ).toBeNull();
    expect(parseRunRow({ ...base, actionId: undefined })).toBeNull();
    expect(parseRunRow(null)).toBeNull();
    expect(parseRunRow("row")).toBeNull();
  });

  it("drops a row with no parseable createdAt", () => {
    expect(parseRunRow({ ...base, createdAt: "garbage" })).toBeNull();
    expect(parseRunRow({ ...base, createdAt: undefined })).toBeNull();
  });

  it("tolerates missing or invalid optional fields", () => {
    const r = parseRunRow({
      actionId: "agent-run:run",
      createdAt: "2026-10-15T10:00:00Z",
      startedAt: "0001-01-01T00:00:00Z",
      finishedAt: 12,
      additionalMetadata: { orgId: "  ", prNumber: "4x2", repoFullName: 7 },
    });
    expect(r).toMatchObject({
      status: "",
      startedAtMs: null,
      finishedAtMs: null,
      orgId: null,
      repoFullName: null,
      prNumber: null,
    });
    expect(
      parseRunRow({ ...base, additionalMetadata: "nope" })?.orgId,
    ).toBeNull();
    expect(
      parseRunRow({ ...base, additionalMetadata: { prNumber: "0" } })?.prNumber,
    ).toBeNull();
  });
});

describe("growthWindow / nearestRankPercentile", () => {
  it("covers the last 7 complete UTC days and excludes today", () => {
    const w = growthWindow(NOW);
    expect(w.startMs).toBe(DAY0);
    expect(w.endMs).toBe(Date.UTC(2026, 9, 19));
    expect(w.dayStartsMs).toHaveLength(7);
    expect(w.dayStartsMs[6]).toBe(Date.UTC(2026, 9, 18));
  });

  it("is nearest-rank", () => {
    expect(nearestRankPercentile([], 0.9)).toBeNull();
    expect(nearestRankPercentile([5], 0.9)).toBe(5);
    expect(nearestRankPercentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0.9)).toBe(9);
    expect(
      nearestRankPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9),
    ).toBe(10);
  });
});

describe("queue-wait p90", () => {
  it("fires when every one of the 7 days has p90 > 600 s", () => {
    const r = evalRows(sevenDays({ waitS: 700 })).queueWait;
    expect(r.verdict).toBe("over");
    expect(r.value).toBe(700);
    expect(r.threshold).toBe(600);
  });

  it("reports the weakest day and stays under when one day is at threshold", () => {
    const rows = sevenDays({ waitS: 900 });
    rows[3] = row({ day: 3, waitS: 600 });
    const r = evalRows(rows).queueWait;
    expect(r.verdict).toBe("under");
    expect(r.value).toBe(600);
  });

  it("uses the p90, not the max, per day", () => {
    // Day 0: nine fast runs and one slow one — p90 is the 9th value (fast).
    const rows = sevenDays({ waitS: 900 });
    for (let i = 0; i < 9; i++) rows.push(row({ day: 0, waitS: 30 }));
    rows.push(row({ day: 0, waitS: 5000 }));
    rows.splice(0, 1); // drop the original 900 s day-0 row
    const r = evalRows(rows);
    expect(r.stats?.queueWaitDailyP90S[0]).toBe(30);
    expect(r.queueWait.verdict).toBe("under");
  });

  it("an empty day breaks the 7-day streak", () => {
    const rows = sevenDays({ waitS: 900 }).filter(
      (r) =>
        r.createdAtMs < DAY0 + 4 * DAY_MS || r.createdAtMs >= DAY0 + 5 * DAY_MS,
    );
    const r = evalRows(rows);
    expect(r.stats?.queueWaitDailyP90S[4]).toBeNull();
    expect(r.queueWait.verdict).toBe("under");
    expect(r.queueWait.value).toBe(0);
  });

  it("a day whose only runs are still QUEUED counts as empty", () => {
    const rows = sevenDays({ waitS: 900 });
    rows[2] = row({ day: 2, waitS: null });
    expect(evalRows(rows).queueWait.verdict).toBe("under");
  });

  it("a run cancelled before it started counts its whole life as queue wait", () => {
    const rows = sevenDays({ waitS: 900 });
    const queued = row({ day: 2, waitS: null });
    rows[2] = {
      ...queued,
      status: "CANCELLED",
      finishedAtMs: queued.createdAtMs + 1200 * 1000,
    };
    const r = evalRows(rows);
    expect(r.stats?.queueWaitDailyP90S[2]).toBe(1200);
    expect(r.queueWait.verdict).toBe("over");
    expect(r.queueWait.summary).toContain(
      "engine queue only, in-worker admission and box-slot waits not counted",
    );
  });

  it("a run that ended without starting under a non-CANCELLED status still counts as wait", () => {
    const rows = sevenDays({ waitS: 900 });
    const queued = row({ day: 4, waitS: null });
    rows[4] = {
      ...queued,
      status: "FAILED",
      finishedAtMs: queued.createdAtMs + 1500 * 1000,
    };
    expect(evalRows(rows).stats?.queueWaitDailyP90S[4]).toBe(1500);
  });

  it("excludes today's partial day and rows older than the window", () => {
    const rows = sevenDays({ waitS: 900 });
    rows.push(row({ day: 7, waitS: 10 })); // today
    rows.push(row({ day: -1, waitS: 10 })); // 8 days ago
    const r = evalRows(rows);
    expect(r.queueWait.verdict).toBe("over");
    expect(r.queueWait.value).toBe(900);
  });
});

describe("client share", () => {
  it("one org at 100% never fires (≥ 2 orgs guard)", () => {
    const r = evalRows(sevenDays({ org: "org-a", runS: 600 })).clientShare;
    expect(r.value).toBe(1);
    expect(r.verdict).toBe("under");
  });

  it("fires when a client holds > 40% of attributed time with ≥ 2 orgs", () => {
    const rows = [
      row({ day: 0, org: "org-a", runS: 500 }),
      row({ day: 1, org: "org-b", runS: 300 }),
      row({ day: 2, org: "org-c", runS: 200 }),
    ];
    const r = evalRows(rows);
    expect(r.clientShare.verdict).toBe("over");
    expect(r.clientShare.value).toBe(0.5);
    expect(r.stats?.topClient).toEqual({ orgId: "org-a", share: 0.5 });
  });

  it("compares the unrounded share: 0.4004 fires though it reports 0.4", () => {
    const near = evalRows([
      row({ day: 0, org: "org-a", runS: 4004 }),
      row({ day: 1, org: "org-b", runS: 3000 }),
      row({ day: 2, org: "org-c", runS: 2996 }),
    ]).clientShare;
    expect(near.value).toBe(0.4);
    expect(near.verdict).toBe("over");
  });

  it("at exactly 40% it stays under", () => {
    const rows = [
      row({ day: 0, org: "org-a", runS: 400 }),
      row({ day: 1, org: "org-b", runS: 300 }),
      row({ day: 2, org: "org-c", runS: 300 }),
    ];
    expect(evalRows(rows).clientShare.verdict).toBe("under");
  });

  it("excludes unattributed time from the share and reports it", () => {
    const rows = [
      row({ day: 0, org: "org-a", runS: 300 }),
      row({ day: 1, org: "org-b", runS: 700 }),
      row({ day: 2, org: null, runS: 9000 }),
    ];
    const r = evalRows(rows);
    expect(r.clientShare.value).toBe(0.7);
    expect(r.stats?.unattributed).toEqual({ seconds: 9000, fraction: 0.9 });
  });

  it("counts u:<userId> personal scopes as distinct clients", () => {
    const rows = [
      row({ day: 0, org: "u:user-1", runS: 900 }),
      row({ day: 1, org: "u:user-2", runS: 100 }),
    ];
    const r = evalRows(rows);
    expect(r.stats?.clients).toBe(2);
    expect(r.clientShare.verdict).toBe("over");
  });

  it("excludes rows lacking startedAt or finishedAt from time sums (V4)", () => {
    const rows = [
      row({ day: 0, org: "org-a", runS: 100 }),
      row({ day: 1, org: "org-b", runS: null }),
      row({ day: 2, org: "org-b", waitS: null }),
    ];
    const r = evalRows(rows);
    expect(r.stats?.clients).toBe(2);
    expect(r.clientShare.value).toBe(1);
    // org-b holds no run time, so the box is single-tenant in time: no split signal (Q-1).
    expect(r.clientShare.verdict).toBe("under");
  });
});

describe("scale composite", () => {
  const clients = (n: number): RunRow[] =>
    Array.from({ length: n }, (_, i) => row({ day: 0, org: `org-${i}` }));
  /** `perDay` distinct PRs on each of the 7 days. */
  const prs = (perDay: number): RunRow[] =>
    Array.from({ length: 7 * perDay }, (_, i) =>
      row({
        day: i % 7,
        org: "org-0",
        repo: "acme/app",
        pr: i,
      }),
    );

  it("a single arm never fires", () => {
    expect(evalRows(clients(6)).scaleComposite.verdict).toBe("under");
    expect(evalRows(prs(101)).scaleComposite.verdict).toBe("under");
    expect(evalRows([], true).scaleComposite.verdict).toBe("under");
    expect(evalRows([], true).scaleComposite.value).toBe(1);
  });

  it("each pair fires", () => {
    expect(evalRows([...clients(6), ...prs(101)]).scaleComposite).toMatchObject(
      { verdict: "over", value: 2 },
    );
    expect(evalRows(clients(6), true).scaleComposite.verdict).toBe("over");
    expect(evalRows(prs(101), true).scaleComposite.verdict).toBe("over");
    expect(
      evalRows([...clients(6), ...prs(101)], true).scaleComposite.value,
    ).toBe(3);
  });

  it("clients at exactly 5 do not hold the arm", () => {
    expect(evalRows(clients(5), true).scaleComposite.verdict).toBe("under");
  });

  it("PRs/day is the 7-day average; the busiest day is reported but never fires", () => {
    // One burst day of 700 distinct PRs: avg exactly 100 → arm not held.
    const burst = Array.from({ length: 700 }, (_, i) =>
      row({ day: 5, org: "org-0", repo: "acme/app", pr: i + 1 }),
    );
    const r = evalRows(burst, true);
    expect(r.stats?.prsPerDay).toBe(100);
    expect(r.stats?.busiestDay).toEqual({ date: "2026-10-17", prs: 700 });
    expect(r.scaleComposite.verdict).toBe("under");
  });

  it("counts distinct (repo, pr) per day; re-runs of one PR count once", () => {
    const rows = [
      row({ day: 0, repo: "acme/app", pr: 1 }),
      row({ day: 0, repo: "acme/app", pr: 1 }),
      row({ day: 0, repo: "ACME/app", pr: 1 }),
      row({ day: 0, repo: "acme/other", pr: 1 }),
      row({ day: 1, repo: "acme/app", pr: 1 }),
      row({ day: 1, repo: null, pr: 2 }),
    ];
    const r = evalRows(rows);
    expect(r.stats?.prsPerDay).toBe(Math.round((3 / 7) * 1000) / 1000);
    expect(r.stats?.busiestDay).toEqual({ date: "2026-10-12", prs: 2 });
  });

  it("no PRs → busiestDay null", () => {
    expect(evalRows(clients(2)).stats?.busiestDay).toBeNull();
  });
});

describe("attribution gate", () => {
  /** org-a dominates three orgs: 800 / 1000 s of attributed time. */
  const dominant = (): RunRow[] => [
    row({ day: 0, org: "org-a", runS: 800 }),
    row({ day: 1, org: "org-b", runS: 100 }),
    row({ day: 2, org: "org-c", runS: 100 }),
  ];
  const clients = (n: number): RunRow[] =>
    Array.from({ length: n }, (_, i) =>
      row({ day: 0, org: `org-${i}`, runS: 100 }),
    );
  const prs = (perDay: number): RunRow[] =>
    Array.from({ length: 7 * perDay }, (_, i) =>
      row({ day: i % 7, org: "org-0", repo: "acme/app", pr: i, runS: 1 }),
    );
  /** One unattributed row of `runS` seconds. */
  const unattributed = (runS: number): RunRow =>
    row({ day: 3, org: null, runS });

  it("high unattributed time makes client_share unknown even with a dominant org", () => {
    // 100 s unattributed of 1100 s total: 9.09%.
    const r = evalRows([...dominant(), unattributed(100)]);
    expect(r.clientShare).toMatchObject({
      verdict: "unknown",
      value: 0.8,
      reason: "attribution incomplete (9.09% of run time unattributed)",
    });
    expect(r.clientShare.summary).toContain("9.09% of run time unattributed");
    // The gate states the figure once, in its reason.
    expect(
      r.clientShare.summary.match(/% of run time unattributed/g),
    ).toHaveLength(1);
    expect(r.stats?.topClient).toEqual({ orgId: "org-a", share: 0.8 });
    expect(r.stats?.unattributed).toEqual({ seconds: 100, fraction: 0.091 });
  });

  it("at or below 5% unattributed the share decides as before", () => {
    // 50 s of 1050 s: 4.76%.
    const r = evalRows([...dominant(), unattributed(50)]);
    expect(r.clientShare.verdict).toBe("over");
    expect(r.clientShare.reason).toBeUndefined();
    expect(r.clientShare.summary).toContain("4.76% of run time unattributed");
    expect(evalRows(dominant()).clientShare.summary).toContain(
      "0% of run time unattributed",
    );
  });

  it("client_share: a zero-length run does not make its org a holder of box time", () => {
    const solo = Array.from({ length: 10 }, () =>
      row({ day: 2, org: "org-a", runS: 100 }),
    );
    const r = evalRows([...solo, row({ day: 2, org: "org-b", runS: 0 })]);
    expect(r.clientShare.verdict).toBe("under");
    expect(r.clientShare.summary).toContain("across 1 org(s) with run time");
  });

  it("client_share: an org with no run time does not satisfy the two-org guard", () => {
    const solo = Array.from({ length: 10 }, () =>
      row({ day: 2, org: "org-a", runS: 100 }),
    );
    const neverRan = {
      ...row({ day: 2, org: "org-b", waitS: null }),
      status: "CANCELLED",
    };
    const r = evalRows([...solo, neverRan]);
    expect(r.clientShare.verdict).toBe("under");
    expect(r.clientShare.summary).toContain("across 1 org(s) with run time");
    expect(r.stats?.clients).toBe(2);
  });

  it("composite: more than 5 tagged orgs hold the clients arm even while attribution is incomplete", () => {
    // 6 tagged orgs + > 100 PRs/day + 10% unattributed run time: two arms are certainly held.
    const tagged = Array.from({ length: 6 }, (_, i) =>
      row({ day: 1, org: `org-${i}`, runS: 100 }),
    );
    const many = Array.from({ length: 7 * 101 }, (_, i) =>
      row({ day: i % 7, org: "org-0", repo: "acme/app", pr: i, runS: 0 }),
    );
    const untagged = row({ day: 1, org: null, runS: 67 });
    const r = evalRows([...tagged, ...many, untagged]);
    expect(r.clientShare.verdict).toBe("unknown");
    expect(r.scaleComposite).toMatchObject({ verdict: "over", value: 2 });
  });

  it("composite: clients unknown + one other arm held → unknown, naming the arm", () => {
    // 4 tagged orgs (≤ 5) do not hold the arm; the unattributed time could hide more.
    const r = evalRows([...clients(4), unattributed(600)], true);
    expect(r.scaleComposite).toMatchObject({ verdict: "unknown", value: 1 });
    expect(r.scaleComposite.reason).toMatch(/clients/);
    expect(r.scaleComposite.reason).toMatch(/attribution incomplete/);
  });

  it("composite: clients unknown + two other arms held → over", () => {
    const rows = [...prs(101), unattributed(600)];
    expect(evalRows(rows, true).scaleComposite).toMatchObject({
      verdict: "over",
      value: 2,
    });
  });

  it("composite: clients unknown and no other arm held → under", () => {
    expect(
      evalRows([...clients(6), unattributed(600)]).scaleComposite.verdict,
    ).toBe("under");
  });

  it("composite with low unattributed time counts the clients arm as before", () => {
    // 10 s unattributed of 610 s: 1.6%.
    const r = evalRows([...clients(6), unattributed(10)], true);
    expect(r.scaleComposite).toMatchObject({ verdict: "over", value: 2 });
    expect(r.scaleComposite.reason).toBeUndefined();
  });
});

describe("supersede waste", () => {
  it("fires when CANCELLED run time > 20% of all run time", () => {
    const rows = [
      row({ day: 0, runS: 700 }),
      row({ day: 1, runS: 300, status: "CANCELLED", org: null }),
    ];
    const r = evalRows(rows).supersedeWaste;
    expect(r.value).toBe(0.3);
    expect(r.verdict).toBe("over");
  });

  it("compares the unrounded ratio: 0.2004 fires though it reports 0.2", () => {
    const r = evalRows([
      row({ day: 0, runS: 7996 }),
      row({ day: 1, runS: 2004, status: "CANCELLED" }),
    ]).supersedeWaste;
    expect(r.value).toBe(0.2);
    expect(r.verdict).toBe("over");
  });

  it("at exactly 20% or with no run time it stays under", () => {
    expect(
      evalRows([
        row({ day: 0, runS: 800 }),
        row({ day: 1, runS: 200, status: "CANCELLED" }),
      ]).supersedeWaste.verdict,
    ).toBe("under");
    expect(evalRows([]).supersedeWaste).toMatchObject({
      verdict: "under",
      value: 0,
    });
  });
});

describe("engine unreadable", () => {
  it("marks every run trigger unknown with the reason", () => {
    const r = evaluateRunSignals({
      runs: { kind: "unreadable", reason: "page cap" },
      nowMs: NOW,
      questionnaire: true,
    });
    for (const e of [
      r.queueWait,
      r.clientShare,
      r.scaleComposite,
      r.supersedeWaste,
    ]) {
      expect(e).toMatchObject({
        verdict: "unknown",
        value: null,
        reason: "page cap",
      });
    }
    expect(r.stats).toBeNull();
  });
});

describe("RAM / swap", () => {
  const GiB = 1024 ** 3;
  const SUSTAIN = 15 * MIN;
  const sample = (
    minutesAgo: number,
    util: number,
    pswpin: number | null = 0,
  ): MemSample => ({
    atMs: NOW - minutesAgo * MIN,
    memTotal: 16 * GiB,
    memAvailable: 16 * GiB * (1 - util),
    pswpin,
  });
  const evalRam = (samples: MemSample[], unreadableReason?: string) =>
    evaluateRamSwap({
      samples,
      nowMs: NOW,
      ramFraction: 0.7,
      sustainMs: SUSTAIN,
      unreadableReason,
    });

  it("fires on utilisation above the fraction sustained ≥ sustain", () => {
    const r = evalRam([
      sample(15, 0.8),
      sample(10, 0.8),
      sample(5, 0.9),
      sample(0, 0.75),
    ]);
    expect(r.verdict).toBe("over");
    expect(r.value).toBe(0.75);
    expect(r.threshold).toBe(0.7);
  });

  it("does not fire when the streak is younger than sustain", () => {
    expect(
      evalRam([
        sample(20, 0.5),
        sample(14, 0.8),
        sample(10, 0.8),
        sample(0, 0.8),
      ]).verdict,
    ).toBe("under");
  });

  it("is unknown (warming up) until the samples span the sustain window", () => {
    expect(
      evalRam([sample(14, 0.8), sample(10, 0.8), sample(0, 0.8)]),
    ).toMatchObject({ verdict: "unknown", value: null, reason: "warming up" });
    expect(evalRam([sample(0, 0.1)]).reason).toBe("warming up");
    expect(evalRam([sample(15, 0.1), sample(0, 0.1)]).verdict).toBe("under");
  });

  it("a restored firing ram_swap is not cleared before a full window, then clears once", () => {
    const seeded = dedupeStatesFromSnapshot({
      triggers: {
        ram_swap: { firing: true, lastFiredAt: new Date(NOW).toISOString() },
      },
    }).ram_swap;
    expect(seeded.firing).toBe(true);
    // The restarted worker samples every 5 min, all well under the fraction.
    const bootMs = NOW + MIN;
    let state = seeded;
    let clears = 0;
    const samples: MemSample[] = [];
    for (let tick = 0; tick <= 6; tick++) {
      const nowMs = bootMs + tick * 5 * MIN;
      samples.push({ ...sample(0, 0.1), atMs: nowMs });
      const e = evaluateRamSwap({
        samples,
        nowMs,
        ramFraction: 0.7,
        sustainMs: SUSTAIN,
      });
      if (tick < 3) expect(e.verdict).toBe("unknown");
      const t = decideTransition(state, e.verdict, nowMs);
      if (t.action === "clear") clears += 1;
      if (tick === 0) expect(t.action).toBe("none");
      state = commitTransition(state, t, true);
    }
    expect(clears).toBe(1);
    expect(state.firing).toBe(false);
  });

  it("a dip below the fraction restarts the streak", () => {
    expect(
      evalRam([
        sample(20, 0.8),
        sample(10, 0.6),
        sample(5, 0.8),
        sample(0, 0.8),
      ]).verdict,
    ).toBe("under");
  });

  it("exactly at the fraction is not over", () => {
    expect(evalRam([sample(20, 0.7), sample(0, 0.7)]).verdict).toBe("under");
  });

  it("fires on pswpin strictly increasing over ≥ sustain even with low RAM", () => {
    expect(
      evalRam([
        sample(15, 0.2, 100),
        sample(10, 0.2, 110),
        sample(5, 0.2, 111),
        sample(0, 0.2, 200),
      ]).verdict,
    ).toBe("over");
  });

  it("a flat pswpin step, a too-short streak, or a null counter breaks the swap arm", () => {
    expect(
      evalRam([sample(15, 0.2, 100), sample(10, 0.2, 100), sample(0, 0.2, 200)])
        .verdict,
    ).toBe("under");
    expect(
      evalRam([
        sample(15, 0.2, 100),
        sample(10, 0.2, 100),
        sample(5, 0.2, 110),
        sample(0, 0.2, 120),
      ]).verdict,
    ).toBe("under");
    expect(
      evalRam([
        sample(15, 0.2, 100),
        sample(10, 0.2, null),
        sample(0, 0.2, 200),
      ]).verdict,
    ).toBe("under");
  });

  it("is unknown when this tick's read failed or there are no samples", () => {
    expect(evalRam([sample(20, 0.9), sample(0, 0.9)], "ENOENT")).toMatchObject({
      verdict: "unknown",
      value: null,
      reason: "ENOENT",
    });
    expect(evalRam([]).verdict).toBe("unknown");
  });

  it("pruning keeps the boundary sample and everything newer, without changing the verdict", () => {
    const all = [
      sample(60, 0.9),
      sample(30, 0.9),
      sample(20, 0.9),
      sample(10, 0.9),
      sample(0, 0.9),
    ];
    const kept = pruneMemSamples(all, NOW, SUSTAIN);
    expect(kept.map((s) => (NOW - s.atMs) / MIN)).toEqual([20, 10, 0]);
    expect(evalRam(kept).verdict).toBe(evalRam(all).verdict);
    expect(pruneMemSamples([sample(5, 0.1)], NOW, SUSTAIN)).toHaveLength(1);
    expect(pruneMemSamples([], NOW, SUSTAIN)).toEqual([]);
  });
});

describe("/proc parsers", () => {
  it("parses MemTotal / MemAvailable in bytes", () => {
    const text =
      "MemTotal:       16000000 kB\nMemFree:  1 kB\nMemAvailable:    4000000 kB\n";
    expect(parseMemTotalAvailable(text)).toEqual({
      memTotal: 16000000 * 1024,
      memAvailable: 4000000 * 1024,
    });
  });

  it("returns null on missing or malformed fields", () => {
    expect(parseMemTotalAvailable("MemTotal: 16000000 kB\n")).toBeNull();
    expect(parseMemTotalAvailable("MemAvailable: 1 kB\n")).toBeNull();
    expect(
      parseMemTotalAvailable("MemTotal: 0 kB\nMemAvailable: 0 kB\n"),
    ).toBeNull();
    expect(
      parseMemTotalAvailable("MemTotal: abc kB\nMemAvailable: 1 kB\n"),
    ).toBeNull();
    expect(parseMemTotalAvailable("")).toBeNull();
  });

  it("parses pswpin and returns null when missing", () => {
    expect(parsePswpin("pgpgin 5\npswpin 1234\npswpout 9\n")).toBe(1234);
    expect(parsePswpin("pswpout 9\n")).toBeNull();
    expect(parsePswpin("pswpin x\n")).toBeNull();
    expect(parsePswpin("")).toBeNull();
  });
});

describe("dedupe state machine", () => {
  const T0 = NOW;

  it("fires from idle, then suppresses re-fire within 24 h", () => {
    const t1 = decideTransition(INITIAL_DEDUPE_STATE, "over", T0);
    expect(t1).toEqual({
      action: "fire",
      next: { firing: true, lastFiredAtMs: T0 },
    });
    const s1 = commitTransition(INITIAL_DEDUPE_STATE, t1, true);
    const t2 = decideTransition(s1, "over", T0 + GROWTH_REFIRE_MS - 1);
    expect(t2.action).toBe("none");
    expect(commitTransition(s1, t2, false)).toEqual(s1);
  });

  it("re-fires once 24 h have passed while still over", () => {
    const s: TriggerDedupeState = { firing: true, lastFiredAtMs: T0 };
    expect(decideTransition(s, "over", T0 + GROWTH_REFIRE_MS)).toEqual({
      action: "fire",
      next: { firing: true, lastFiredAtMs: T0 + GROWTH_REFIRE_MS },
    });
  });

  it("clears once when it drops under while firing", () => {
    const s: TriggerDedupeState = { firing: true, lastFiredAtMs: T0 };
    const t = decideTransition(s, "under", T0 + MIN);
    expect(t).toEqual({
      action: "clear",
      next: { firing: false, lastFiredAtMs: T0 },
    });
    const s2 = commitTransition(s, t, true);
    expect(decideTransition(s2, "under", T0 + 2 * MIN).action).toBe("none");
  });

  it("fire → clear → over again within 24 h does not re-fire (AC 4); the clear is unaffected", () => {
    const fire = decideTransition(INITIAL_DEDUPE_STATE, "over", T0);
    expect(fire.action).toBe("fire");
    const s1 = commitTransition(INITIAL_DEDUPE_STATE, fire, true);
    const clear = decideTransition(s1, "under", T0 + MIN);
    expect(clear.action).toBe("clear");
    const s2 = commitTransition(s1, clear, true);
    expect(s2).toEqual({ firing: false, lastFiredAtMs: T0 });
    const again = decideTransition(s2, "over", T0 + 2 * MIN);
    expect(again).toEqual({ action: "none", next: s2 });
    expect(decideTransition(s2, "over", T0 + GROWTH_REFIRE_MS - 1).action).toBe(
      "none",
    );
    expect(decideTransition(s2, "over", T0 + GROWTH_REFIRE_MS)).toEqual({
      action: "fire",
      next: { firing: true, lastFiredAtMs: T0 + GROWTH_REFIRE_MS },
    });
  });

  it("unknown never fires nor clears", () => {
    for (const s of [
      INITIAL_DEDUPE_STATE,
      { firing: true, lastFiredAtMs: T0 - 2 * GROWTH_REFIRE_MS },
    ]) {
      expect(decideTransition(s, "unknown", T0)).toEqual({
        action: "none",
        next: s,
      });
    }
  });

  it("a failed POST is not committed, so the next tick retries (V2)", () => {
    const fire = decideTransition(INITIAL_DEDUPE_STATE, "over", T0);
    const afterFail = commitTransition(INITIAL_DEDUPE_STATE, fire, false);
    expect(afterFail).toEqual(INITIAL_DEDUPE_STATE);
    expect(decideTransition(afterFail, "over", T0 + MIN).action).toBe("fire");

    const firing: TriggerDedupeState = { firing: true, lastFiredAtMs: T0 };
    const clear = decideTransition(firing, "under", T0 + MIN);
    expect(commitTransition(firing, clear, false)).toEqual(firing);
    expect(
      decideTransition(
        commitTransition(firing, clear, false),
        "under",
        T0 + 2 * MIN,
      ).action,
    ).toBe("clear");
  });

  it("honours a custom refire window", () => {
    const s: TriggerDedupeState = { firing: true, lastFiredAtMs: T0 };
    expect(decideTransition(s, "over", T0 + 1000, 1000).action).toBe("fire");
  });
});

describe("webhook body", () => {
  const evaluation: TriggerEvaluation = {
    trigger: "ram_swap",
    verdict: "over",
    value: 0.82,
    threshold: 0.7,
    summary: "box RAM 82% used\n(line two)",
  };

  it("has exactly the V3 shape for a fire", () => {
    const body = buildWebhookBody({
      evaluation,
      boxId: "box-1",
      nowMs: NOW,
      state: "fired",
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "authorizedMove",
        "boxId",
        "firedAt",
        "state",
        "text",
        "threshold",
        "trigger",
        "value",
      ].sort(),
    );
    expect(body).toMatchObject({
      trigger: "ram_swap",
      value: 0.82,
      threshold: 0.7,
      authorizedMove: "Add a second shared box on the same tenant",
      boxId: "box-1",
      firedAt: "2026-10-19T12:00:00.000Z",
      state: "fired",
    });
    expect(body.text).not.toMatch(/\n/);
    expect(body.text).toContain("ram_swap");
    expect(body.text).toContain("box-1");
    expect(body.text).toContain(AUTHORIZED_MOVES.ram_swap);
  });

  it("carries state cleared for a clear", () => {
    const body = buildWebhookBody({
      evaluation: { ...evaluation, verdict: "under", value: 0.4 },
      boxId: "box-1",
      nowMs: NOW,
      state: "cleared",
    });
    expect(body.state).toBe("cleared");
    expect(body.text).toContain("cleared");
  });

  it("authorized moves are verbatim from the issue table", () => {
    expect(AUTHORIZED_MOVES).toEqual({
      queue_wait_p90: "Raise the cap, then resize CX43 (cap 6) / CX53 (cap 8)",
      ram_swap: "Add a second shared box on the same tenant",
      client_share:
        "Split that client to its own box (tickets 6/7); also fires manually on isolation / write-lane requests",
      scale_composite: "Start the per-run sandbox path",
      supersede_waste: "Revisit the default policy",
    });
  });
});

/** The five evaluations keyed by trigger, as the driver hands them to buildSnapshot. */
function evaluationsOf(
  run: RunSignalsResult,
  ram: TriggerEvaluation,
): Record<GrowthTriggerId, TriggerEvaluation> {
  return {
    queue_wait_p90: run.queueWait,
    ram_swap: ram,
    client_share: run.clientShare,
    scale_composite: run.scaleComposite,
    supersede_waste: run.supersedeWaste,
  };
}

const UNREADABLE_RUNS = evaluateRunSignals({
  runs: { kind: "unreadable", reason: "engine read: http 503" },
  nowMs: NOW,
  questionnaire: false,
});
const UNREADABLE_RAM = evaluateRamSwap({
  samples: [],
  nowMs: NOW,
  ramFraction: 0.7,
  sustainMs: 900_000,
  unreadableReason: "ENOENT /proc/meminfo",
});

describe("snapshot", () => {
  it("lists every trigger with value, threshold, verdict, firing and lastFiredAt", () => {
    const run = evalRows([
      row({ day: 0, org: "org-a", runS: 100, repo: "a/b", pr: 1 }),
      row({ day: 1, org: null, runS: 100 }),
    ]);
    const ram = evaluateRamSwap({
      samples: [],
      nowMs: NOW,
      ramFraction: 0.7,
      sustainMs: 900_000,
      unreadableReason: "ENOENT /proc/meminfo",
    });
    const snap = buildSnapshot({
      nowMs: NOW,
      boxId: "box-1",
      evaluations: evaluationsOf(run, ram),
      states: {
        ...dedupeStatesFromSnapshot(null),
        client_share: { firing: true, lastFiredAtMs: NOW - MIN },
      },
      stats: run.stats,
    });
    expect(Object.keys(snap.triggers)).toEqual([...GROWTH_TRIGGER_IDS]);
    expect(snap.triggers.ram_swap).toEqual({
      value: null,
      threshold: 0.7,
      verdict: "unknown",
      reason: "ENOENT /proc/meminfo",
      firing: false,
      lastFiredAt: null,
    });
    // Half the run time is unattributed: the attribution gate holds client_share unknown
    // while still reporting the share it observed.
    expect(snap.triggers.client_share).toMatchObject({
      value: 1,
      verdict: "unknown",
      reason: "attribution incomplete (50% of run time unattributed)",
      firing: true,
      lastFiredAt: new Date(NOW - MIN).toISOString(),
    });
    expect(snap.triggers.queue_wait_p90).not.toHaveProperty("reason");
    expect(snap).toMatchObject({
      evaluatedAt: "2026-10-19T12:00:00.000Z",
      boxId: "box-1",
      windowDays: 7,
      unattributed: { seconds: 100, fraction: 0.5 },
      busiestDay: { date: "2026-10-12", prs: 1 },
      clients: 1,
    });
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("with the engine unreadable, run stats are null and run triggers read unknown", () => {
    const snap = buildSnapshot({
      nowMs: NOW,
      boxId: "box-1",
      evaluations: evaluationsOf(UNREADABLE_RUNS, UNREADABLE_RAM),
      states: dedupeStatesFromSnapshot(null),
      stats: UNREADABLE_RUNS.stats,
    });
    expect(snap).toMatchObject({
      unattributed: null,
      busiestDay: null,
      clients: null,
      windowDays: 7,
    });
    expect(snap.triggers.supersede_waste).toEqual({
      value: null,
      threshold: 0.2,
      verdict: "unknown",
      reason: "engine read: http 503",
      firing: false,
      lastFiredAt: null,
    });
  });

  it("round-trips dedupe state through the snapshot; junk seeds the initial state", () => {
    const snap = buildSnapshot({
      nowMs: NOW,
      boxId: "b",
      evaluations: evaluationsOf(UNREADABLE_RUNS, UNREADABLE_RAM),
      states: {
        ...dedupeStatesFromSnapshot(null),
        ram_swap: { firing: true, lastFiredAtMs: NOW - MIN },
      },
      stats: null,
    });
    const seeded = dedupeStatesFromSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(seeded.ram_swap).toEqual({ firing: true, lastFiredAtMs: NOW - MIN });
    expect(seeded.queue_wait_p90).toEqual(INITIAL_DEDUPE_STATE);
    expect(dedupeStatesFromSnapshot(null).ram_swap).toEqual(
      INITIAL_DEDUPE_STATE,
    );
    expect(
      dedupeStatesFromSnapshot({
        triggers: { ram_swap: { firing: true, lastFiredAt: "garbage" } },
      }).ram_swap,
    ).toEqual(INITIAL_DEDUPE_STATE);
  });
});
