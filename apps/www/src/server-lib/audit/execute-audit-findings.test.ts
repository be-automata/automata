import { describe, expect, it, vi } from "vitest";

import type {
  AuditEffectRow,
  AuditFindingRow,
} from "@terragon/shared/model/audit-findings";

import type { AuditLedger, LedgerBatch } from "./audit-ledger";
import {
  actionsToEffects,
  executeAuditFindings,
  type ExecuteAuditDeps,
  type ExecuteAuditInput,
} from "./execute-audit-findings";
import type { ParsedFinding } from "./parse-audit-findings";
import type { ResolvedSelfHeal } from "./resolve-self-heal";
import {
  createFakeBreakerStore,
  createFakeIssueWriter,
  createInMemoryAuditLedger,
  createInMemoryOutbox,
  FAKE_DB,
  FAKE_ORG,
} from "./__fixtures__/in-memory-self-heal";

const REPO = "acme/widgets";
const RUN = "run-1";
const AUDIT = "security-audit";
const SCRIPT_RULE = "supply.lockfile-missing";
const RUBRIC_RULE = "automation.review-process";

const SETTINGS: ResolvedSelfHeal = {
  mode: "on",
  killSwitch: false,
  maxOpenIssues: 50,
  maxAttempts: 3,
  cooldownMin: 60,
  minSeverity: "low",
  autoLabel: true,
  absentAudits: 3,
  maxDiffLines: 200,
  prExpiryDays: 7,
  runWindow: "always",
};

function fp(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function parsed(n: number, rule = RUBRIC_RULE): ParsedFinding {
  return {
    rule,
    subject: `path/${n}`,
    severity: "high",
    section: "security-automation",
    title: `Finding ${n}`,
    files: [`path/${n}`],
    plan: `Plan ${n}`,
    acceptance: `Accept ${n}`,
    effort: "S",
    fingerprint: fp(n),
  };
}

function harness(opts: { startMs?: number } = {}) {
  let t = opts.startMs ?? Date.UTC(2026, 9, 4, 12, 0, 0);
  const clock = () => new Date(t);
  const events: string[] = [];
  const lines: string[] = [];
  const captured: Array<[string, Record<string, string>]> = [];
  const writer = createFakeIssueWriter({ now: clock });
  const outbox = createInMemoryOutbox(clock);
  const mem = createInMemoryAuditLedger();
  const breakers = createFakeBreakerStore(clock);
  const control: {
    failMarkOnce: boolean;
    persistCalls: number;
    createMs: number;
    failOnCreate?: number;
  } = { failMarkOnce: false, persistCalls: 0, createMs: 0 };
  let creates = 0;
  const createStarts: number[] = [];

  const origCreate = writer.createIssue.bind(writer);
  writer.createIssue = async (i) => {
    events.push("create");
    createStarts.push(t);
    creates += 1;
    if (creates === control.failOnCreate) {
      writer.failNext("createIssue", "permission");
    }
    t += control.createMs;
    return origCreate(i);
  };

  const rows = (): AuditFindingRow[] => [...mem.rows.values()];

  const ledger: AuditLedger = {
    async list() {
      return rows();
    },
    async pendingCreateFingerprints() {
      return new Set(
        [...outbox.rows.values()]
          .filter((e) => e.action === "create_issue" && e.status === "pending")
          .map((e) => e.fingerprint),
      );
    },
    async countOpenIssues() {
      return rows().filter(
        (r) =>
          (r.status === "open" || r.status === "needs_human") &&
          r.issueNumber !== null,
      ).length;
    },
    async persist(batch: LedgerBatch) {
      events.push("persist");
      control.persistCalls += 1;
      const idByFp = new Map<string, string>();
      for (const finding of batch.inserts) {
        const row = await mem.insertFinding({
          organizationId: FAKE_ORG,
          finding,
        });
        idByFp.set(row.fingerprint, row.id);
      }
      for (const { findingId, patch } of batch.patches) {
        await mem.updateFinding({
          organizationId: FAKE_ORG,
          id: findingId,
          patch,
        });
      }
      const effectsEnqueued = await outbox.enqueueEffects({
        organizationId: FAKE_ORG,
        repoFullName: REPO,
        runId: RUN,
        effects: batch.effects.map((e) => ({
          ...e,
          findingId: e.findingId ?? idByFp.get(e.fingerprint) ?? null,
        })),
        now: clock(),
      });
      lastBatch = batch;
      return { effectsEnqueued };
    },
    async markIssueCreated(effect: AuditEffectRow, issueNumber, now) {
      if (control.failMarkOnce) {
        control.failMarkOnce = false;
        throw new Error("ledger down");
      }
      const row = rows().find((r) => r.fingerprint === effect.fingerprint);
      if (!row) throw new Error("no row");
      const payload = effect.payload as Record<string, unknown>;
      const autoFix = payload.autoFix === true;
      await mem.updateFinding({
        organizationId: FAKE_ORG,
        id: row.id,
        patch: {
          issueNumber,
          status: payload.status === "needs_human" ? "needs_human" : "open",
          autoFixLabeled: autoFix,
          fixReadyAt: autoFix ? now : null,
          planHash: payload.planHash as string,
        },
      });
    },
    async issueNumberFor(effect) {
      return (
        rows().find((r) => r.fingerprint === effect.fingerprint)?.issueNumber ??
        null
      );
    },
  };
  let lastBatch: LedgerBatch | null = null;

  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  const deps: ExecuteAuditDeps = {
    db: FAKE_DB,
    installationKey: "42",
    ledger,
    writer,
    outbox,
    breakers,
    log: (message) => {
      lines.push(message);
    },
    capture: (event, props) => {
      captured.push([event, props]);
    },
    now: clock,
    sleep,
    rand: () => 0,
  };

  async function seedCandidate(
    n: number,
    extra: Partial<AuditFindingRow> = {},
    rule = RUBRIC_RULE,
  ) {
    return mem.insertFinding({
      organizationId: FAKE_ORG,
      finding: {
        repoFullName: REPO,
        fingerprint: fp(n),
        audit: AUDIT,
        ruleId: rule,
        severity: "high",
        checkKind: rule === SCRIPT_RULE ? "script" : "rubric",
        title: `Finding ${n}`,
        status: "candidate",
        recentSightings: [true],
        ...extra,
      },
    });
  }

  async function run(
    overrides: Partial<ExecuteAuditInput> & { findings?: ParsedFinding[] } = {},
  ) {
    const { findings = [], ...rest } = overrides;
    const issues =
      "issues" in rest
        ? (rest.issues ?? null)
        : await writer.readIssueStates(
            rows()
              .map((r) => r.issueNumber)
              .filter((n): n is number => n !== null),
          );
    const input: ExecuteAuditInput = {
      organizationId: FAKE_ORG,
      repoFullName: REPO,
      runId: RUN,
      audit: AUDIT,
      mode: "on",
      block: {
        audit: AUDIT,
        complete: true,
        report: {},
        sections: [],
        findings,
      },
      complete: true,
      checkResults: null,
      settings: SETTINGS,
      isPublicRepo: false,
      deadlineAt: new Date(t + 60_000),
      ...rest,
      issues,
    };
    return executeAuditFindings({ deps, input });
  }

  return {
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
    events,
    lines,
    captured,
    writer,
    outbox,
    mem,
    rows,
    control,
    createStarts,
    deps,
    seedCandidate,
    run,
    lastBatch: () => lastBatch,
  };
}

describe("executeAuditFindings", () => {
  it("persists in one transaction before any GitHub call, then drains exactly once", async () => {
    const h = harness();
    await h.seedCandidate(1, {}, SCRIPT_RULE);
    await h.seedCandidate(2);
    const checkResults = new Map([[fp(1), "fail" as const]]);
    const summary = await h.run({
      findings: [parsed(1, SCRIPT_RULE), parsed(2)],
      checkResults,
    });

    expect(summary.outcome).toBe("applied");
    expect(summary.created).toBe(2);
    expect(h.control.persistCalls).toBe(1);
    expect(h.events.indexOf("persist")).toBeLessThan(
      h.events.indexOf("create"),
    );
    expect(
      h.lastBatch()?.effects.filter((e) => e.action === "create_issue"),
    ).toHaveLength(2);
    expect(h.writer.createCount()).toBe(2);

    for (const issue of h.writer.issues.values()) {
      expect(issue.body.split("\n")[0]).toMatch(
        /^<!-- automata-finding:v1 fp=[0-9a-f]{16} -->$/,
      );
      expect(issue.labels.has("automata:finding")).toBe(true);
    }
    const script = h.rows().find((r) => r.fingerprint === fp(1));
    expect(script).toMatchObject({
      status: "open",
      autoFixLabeled: true,
    });
    expect(script?.issueNumber).not.toBeNull();
    expect(script?.fixReadyAt).toBeInstanceOf(Date);
    const rubric = h.rows().find((r) => r.fingerprint === fp(2));
    expect(rubric).toMatchObject({ status: "needs_human" });
    expect(rubric?.autoFixLabeled).toBe(false);
    expect(rubric?.fixReadyAt).toBeNull();
  });

  it("replaying the same input enqueues nothing and creates nothing", async () => {
    const h = harness();
    await h.seedCandidate(1, {}, SCRIPT_RULE);
    await h.seedCandidate(2);
    const input = {
      findings: [parsed(1, SCRIPT_RULE), parsed(2)],
      checkResults: new Map([[fp(1), "fail" as const]]),
    };
    await h.run(input);
    const effectRows = h.outbox.rows.size;
    h.advance(10_000);
    const again = await h.run(input);
    expect(h.outbox.rows.size).toBe(effectRows);
    expect(h.writer.createCount()).toBe(2);
    expect(again.created).toBe(0);
    expect(again.outcome).toBe("applied");
  });

  it("adopts by marker after a crash between the create and the ledger update", async () => {
    const h = harness();
    await h.seedCandidate(2);
    h.control.failMarkOnce = true;
    const input = { findings: [parsed(2)] };
    const first = await h.run(input);
    expect(h.writer.createCount()).toBe(1);
    expect(first.created).toBe(0);
    expect(first.pending).toBe(1);
    expect(first.outcome).toBe("applied_partial");

    h.advance(3 * 60_000);
    const second = await h.run(input);
    expect(h.writer.createCount()).toBe(1);
    expect(second.created).toBe(1);
    expect(h.rows()[0]?.issueNumber).toBe(1);
    expect(second.outcome).toBe("applied");
  });

  it("dry-run keeps bookkeeping, enqueues nothing and only reads", async () => {
    const h = harness();
    await h.seedCandidate(2);
    const summary = await h.run({ mode: "dry-run", findings: [parsed(2)] });
    expect(summary.outcome).toBe("dry_run");
    expect(h.outbox.rows.size).toBe(0);
    expect(h.writer.calls.map((c) => c.op)).toEqual(["readIssueStates"]);
    expect(summary.decisions.map((d) => d.action)).toContain("would_create");
    expect(h.rows()[0]?.recentSightings).toEqual([true, true]);
    expect(h.rows()[0]?.status).toBe("candidate");
    expect(h.lines.some((l) => l.endsWith("mode=dry-run"))).toBe(true);
  });

  it("returns applied_partial under a deadline with the rest pending (RES-04)", async () => {
    const h = harness();
    h.control.createMs = 3_000;
    for (let n = 1; n <= 25; n++) await h.seedCandidate(n);
    const deadlineAt = new Date(h.now() + 20_000);
    const summary = await h.run({
      findings: Array.from({ length: 25 }, (_, i) => parsed(i + 1)),
      deadlineAt,
    });
    expect(summary.outcome).toBe("applied_partial");
    expect(h.writer.createCount()).toBeGreaterThan(0);
    expect(h.writer.createCount()).toBeLessThan(25);
    expect(summary.pending).toBe(25 - h.writer.createCount());
    for (const start of h.createStarts) {
      expect(start).toBeLessThanOrEqual(deadlineAt.getTime() - 1_000);
    }
    const pending = [...h.outbox.rows.values()].filter(
      (e) => e.status === "pending",
    );
    expect(pending).toHaveLength(summary.pending);
  });

  it("reports issues_unknown and writes no close or reopen effects", async () => {
    const h = harness();
    await h.seedCandidate(
      1,
      { status: "open", issueNumber: 5, consecutiveCheckPasses: 1 },
      SCRIPT_RULE,
    );
    const summary = await h.run({
      findings: [parsed(1, SCRIPT_RULE)],
      checkResults: new Map([[fp(1), "pass" as const]]),
      issues: null,
    });
    expect(summary.outcome).toBe("issues_unknown");
    expect(
      [...h.outbox.rows.values()].filter((e) => e.action === "set_issue_state"),
    ).toHaveLength(0);
    expect(h.rows()[0]?.status).toBe("open");
  });

  it("stops with missing-permission and leaves the rest pending", async () => {
    const h = harness();
    for (let n = 1; n <= 3; n++) await h.seedCandidate(n);
    h.control.failOnCreate = 2;
    const summary = await h.run({
      findings: [parsed(1), parsed(2), parsed(3)],
    });
    expect(summary.outcome).toBe("missing-permission");
    expect(h.writer.createCount()).toBe(1);
    const statuses = [...h.outbox.rows.values()].map((e) => e.status).sort();
    expect(statuses).toEqual(["applied", "failed", "pending"]);
    expect(summary.pending).toBe(1);
  });

  it("moves a tracked rubric finding to needs-human and clears the auto-fix flags", async () => {
    const h = harness();
    h.writer.seedIssue({
      number: 7,
      fingerprint: fp(9),
      labels: new Set(["automata:finding", "automata:auto-fix"]),
    });
    const seeded = await h.seedCandidate(9, {
      status: "open",
      issueNumber: 7,
      absentCount: 2,
      autoFixLabeled: true,
      fixReadyAt: new Date(h.now()),
    });
    const summary = await h.run({ findings: [] });
    expect(summary.outcome).toBe("applied");
    expect(summary.needsHuman).toBe(1);
    const labels = h.writer.issues.get(7)?.labels;
    expect(labels?.has("needs-human-review")).toBe(true);
    expect(labels?.has("automata:auto-fix")).toBe(false);
    expect(h.writer.comments).toHaveLength(1);
    const row = h.rows().find((r) => r.id === seeded.id);
    expect(row).toMatchObject({
      status: "needs_human",
      autoFixLabeled: false,
      fixReadyAt: null,
    });
  });

  it("reports the persisted decisions before the drain makes any GitHub write", async () => {
    const h = harness();
    await h.seedCandidate(1, {}, SCRIPT_RULE);
    const reported: { decisions: unknown[]; events: string[] }[] = [];
    h.deps.onPersisted = (decisions) => {
      reported.push({ decisions, events: [...h.events] });
    };
    const summary = await h.run({
      findings: [parsed(1, SCRIPT_RULE)],
      checkResults: new Map([[fp(1), "fail" as const]]),
    });

    expect(reported).toHaveLength(1);
    expect(reported[0]!.decisions).toEqual(summary.decisions);
    expect(reported[0]!.events).toContain("persist");
    expect(reported[0]!.events).not.toContain("create");
    expect(h.writer.createCount()).toBe(1);
  });

  it("does not report decisions when persisting them fails", async () => {
    const h = harness();
    const reported: unknown[] = [];
    h.deps.onPersisted = (decisions) => {
      reported.push(decisions);
    };
    h.deps.ledger.persist = async () => {
      throw new Error("db down");
    };
    const summary = await h.run({ findings: [parsed(1)] });

    expect(summary.outcome).toBe("error");
    expect(reported).toHaveLength(0);
  });

  it("logs one pinned line and one event per decision and caps the summary", async () => {
    const h = harness();
    const findings = Array.from({ length: 150 }, (_, i) => parsed(i + 1));
    const summary = await h.run({ findings });
    expect(summary.decisions).toHaveLength(100);
    const decisionLines = h.lines.filter((l) => l.startsWith("[self-heal] "));
    // 150 candidates, 150 consensus_pending skips
    expect(decisionLines).toHaveLength(300);
    expect(h.captured).toHaveLength(300);
    for (const line of decisionLines) {
      expect(line).toMatch(
        /^\[self-heal\] v=1 org=\S+ repo=\S+ run=\S+ fp=\S{1,8} decision=[a-z_]+ reason=[a-z0-9_:-]+ mode=(off|dry-run|on)$/,
      );
    }
    expect(decisionLines.join("\n")).not.toContain("Finding 1");
  });
});

describe("actionsToEffects", () => {
  it("maps every effect-bearing action and ignores bookkeeping actions", () => {
    const rows = [
      {
        id: "f1",
        fingerprint: fp(1),
        attempts: 2,
      },
    ] as AuditFindingRow[];
    const effects = actionsToEffects(
      [
        { kind: "record_sighting", findingId: "f1", sightings: [true] },
        {
          kind: "close_issue",
          findingId: "f1",
          issueNumber: 4,
          alreadyClosed: false,
          commentMarkerId: "m1",
        },
        {
          kind: "close_issue",
          findingId: "f1",
          issueNumber: 4,
          alreadyClosed: true,
          commentMarkerId: "m1",
        },
        {
          kind: "reopen_issue",
          findingId: "f1",
          issueNumber: 4,
          commentMarkerId: "m2",
        },
      ],
      {
        audit: AUDIT,
        runId: RUN,
        maxAttempts: 3,
        rows,
        ruleFor: () => undefined,
      },
    );
    expect(effects.map((e) => e.action)).toEqual([
      "upsert_comment",
      "set_issue_state",
      "set_issue_state",
      "upsert_comment",
    ]);
  });
});
