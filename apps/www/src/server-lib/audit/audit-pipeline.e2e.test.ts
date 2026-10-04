import { describe, expect, it, vi } from "vitest";

import type { DBMessage } from "@terragon/shared/db/db-message";
import type {
  AuditEffectRow,
  AuditFindingRow,
} from "@terragon/shared/model/audit-findings";
import { AUDIT_SECTIONS } from "@terragon/shared/self-heal/audit-rules";

import { runOutboxDrain, type OutboxDrainDeps } from "./audit-sweep";
import type { CheckOutcome } from "./decide-audit-actions";
import type { AuditLedger, LedgerBatch } from "./audit-ledger";
import {
  executeAuditFindings,
  type ExecuteAuditDeps,
} from "./execute-audit-findings";
import {
  parseAuditFindings,
  selectAuditTerminalText,
} from "./parse-audit-findings";
import { applyOutboxEffects } from "./apply-outbox";
import type { ResolvedSelfHeal } from "./resolve-self-heal";
import {
  ECHO_FINDING,
  fence,
  makeBlock,
  makeFinding,
  type FixtureFinding,
} from "./__fixtures__/audit-terminal-messages";
import {
  createFakeBreakerStore,
  createFakeIssueWriter,
  createInMemoryAuditLedger,
  createInMemoryOutbox,
  FAKE_DB,
  FAKE_ORG,
} from "./__fixtures__/in-memory-self-heal";

/**
 * The whole audit writer, end to end, with no LLM and no network: terminal
 * messages -> tagged-block selection -> parse -> decide -> persist -> drain,
 * against in-memory stand-ins for Postgres and GitHub that keep the real
 * uniqueness rules. The cron's drainer is exercised on the same stand-ins.
 */

const REPO = "acme/widgets";
const AUDIT = "security-audit";
const SECTIONS = AUDIT_SECTIONS[AUDIT].map((id) => ({
  id,
  name: id,
  score: 80,
}));

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

const SCRIPT_FINDING = makeFinding();
const SECOND_FINDING = makeFinding({
  rule: "files.sensitive-committed",
  subject: "config/staging.pem",
  title: "Second private key committed",
  files: ["config/staging.pem"],
});

const leadMessage = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: null,
  parts: [{ type: "text", text }],
});
const subAgentMessage = (text: string): DBMessage => ({
  type: "agent",
  parent_tool_use_id: "toolu_x",
  parts: [{ type: "text", text }],
});

/** A lead's tagged block followed by a sub-agent echo of ANOTHER block. */
function transcript(
  findings: FixtureFinding[],
  overrides: Record<string, unknown> = {},
): DBMessage[] {
  return [
    { type: "user", model: null, parts: [{ type: "text", text: "audit" }] },
    leadMessage(
      "Audit complete.\n" +
        fence(makeBlock(findings, { sections: SECTIONS, ...overrides })),
    ),
    subAgentMessage(
      "Sub-agent notes:\n" +
        fence(makeBlock([ECHO_FINDING], { sections: SECTIONS })),
    ),
    leadMessage("The sub-agent finished; nothing to add."),
  ];
}

function pipeline(options: { startMs?: number } = {}) {
  let t = options.startMs ?? Date.UTC(2026, 9, 4, 12, 0, 0);
  const clock = () => new Date(t);
  const writer = createFakeIssueWriter({ now: clock });
  const outbox = createInMemoryOutbox(clock);
  const mem = createInMemoryAuditLedger();
  const breakers = createFakeBreakerStore(clock);
  const control = { runId: "run-1", createMs: 0 };

  const origCreate = writer.createIssue.bind(writer);
  writer.createIssue = async (input) => {
    t += control.createMs;
    return origCreate(input);
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
        runId: control.runId,
        effects: batch.effects.map((e) => ({
          ...e,
          findingId: e.findingId ?? idByFp.get(e.fingerprint) ?? null,
        })),
        now: clock(),
      });
      return { effectsEnqueued };
    },
    async markIssueCreated(effect: AuditEffectRow, issueNumber, now) {
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
    log: () => undefined,
    capture: () => undefined,
    now: clock,
    sleep,
    rand: () => 0,
  };

  /** One full run: select -> parse -> execute. */
  async function runAudit({
    runId,
    messages,
    checks,
    deadlineMs = 60_000,
  }: {
    runId: string;
    messages: DBMessage[];
    checks?: Array<[FixtureFinding, CheckOutcome]>;
    deadlineMs?: number;
  }) {
    control.runId = runId;
    const parsed = parseAuditFindings(selectAuditTerminalText(messages), {
      repoFullName: REPO,
    });
    if (!parsed.ok) throw new Error(`unparseable: ${parsed.reason}`);
    const { block } = parsed;
    const complete =
      block.complete &&
      AUDIT_SECTIONS[block.audit].every((id) =>
        block.sections.some((section) => section.id === id),
      );
    // The fingerprint is derived by the parser, not by this test; a finding
    // dropped from a later block keeps the fingerprint seen when it was reported.
    for (const f of block.findings) {
      knownFingerprints.set(f.title, f.fingerprint);
    }
    const checkResults = checks
      ? new Map(
          checks.map(([finding, outcome]) => [
            knownFingerprints.get(finding.title) ?? "",
            outcome,
          ]),
        )
      : null;
    const issues = await writer.readIssueStates(
      rows()
        .map((r) => r.issueNumber)
        .filter((n): n is number => n !== null),
    );
    return executeAuditFindings({
      deps,
      input: {
        organizationId: FAKE_ORG,
        repoFullName: REPO,
        runId,
        audit: block.audit,
        mode: "on",
        block,
        complete,
        checkResults,
        issues,
        settings: SETTINGS,
        isPublicRepo: false,
        deadlineAt: new Date(t + deadlineMs),
      },
    });
  }
  const knownFingerprints = new Map<string, string>();

  return {
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
    clock,
    writer,
    outbox,
    mem,
    rows,
    control,
    ledger,
    breakers,
    runAudit,
    fingerprintOf: (title: string) => knownFingerprints.get(title) ?? "",
  };
}

/** Run 1 (candidate) + run 2 (check fails) file the issue for SCRIPT_FINDING. */
async function fileScriptIssue(h: ReturnType<typeof pipeline>) {
  await h.runAudit({ runId: "run-1", messages: transcript([SCRIPT_FINDING]) });
  h.advance(60_000);
  return h.runAudit({
    runId: "run-2",
    messages: transcript([SCRIPT_FINDING]),
    checks: [[SCRIPT_FINDING, "fail"]],
  });
}

describe("audit pipeline (deterministic end to end)", () => {
  it("files nothing on the first sighting; the sub-agent echo is ignored", async () => {
    const h = pipeline();
    const summary = await h.runAudit({
      runId: "run-1",
      messages: transcript([SCRIPT_FINDING]),
    });

    expect(summary.created).toBe(0);
    expect(h.writer.createCount()).toBe(0);
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]).toMatchObject({
      status: "candidate",
      title: SCRIPT_FINDING.title,
    });
  });

  it("files the exact issue once consensus and a failing check agree", async () => {
    const h = pipeline();
    const summary = await fileScriptIssue(h);

    expect(summary.outcome).toBe("applied");
    expect(summary.created).toBe(1);
    expect(h.writer.createCount()).toBe(1);
    const issue = [...h.writer.issues.values()][0];
    expect(issue?.title).toBe(`[${AUDIT}] ${SCRIPT_FINDING.title}`);
    expect([...(issue?.labels ?? [])].sort()).toEqual(
      expect.arrayContaining(["automata:auto-fix", "automata:finding"]),
    );
    const fingerprint = h.fingerprintOf(SCRIPT_FINDING.title);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(issue?.body.split("\n")[0]).toBe(
      `<!-- automata-finding:v1 fp=${fingerprint} -->`,
    );
    expect(issue?.fingerprint).toBe(fingerprint);
    expect(h.rows()[0]).toMatchObject({
      status: "open",
      autoFixLabeled: true,
      issueNumber: issue?.number,
    });
    // The echoed sub-agent finding never reached GitHub.
    expect(h.writer.issues.size).toBe(1);
  });

  it("a replay creates nothing, under the same run and under a new one", async () => {
    const h = pipeline();
    await fileScriptIssue(h);
    const effects = h.outbox.rows.size;

    h.advance(10_000);
    const sameRun = await h.runAudit({
      runId: "run-2",
      messages: transcript([SCRIPT_FINDING]),
      checks: [[SCRIPT_FINDING, "fail"]],
    });
    expect(sameRun.created).toBe(0);
    expect(h.outbox.rows.size).toBe(effects);

    h.advance(3_600_000);
    const newRun = await h.runAudit({
      runId: "run-3",
      messages: transcript([SCRIPT_FINDING]),
      checks: [[SCRIPT_FINDING, "fail"]],
    });
    expect(newRun.created).toBe(0);
    expect(h.writer.createCount()).toBe(1);
  });

  it("closes only after two consecutive passing checks", async () => {
    const h = pipeline();
    await fileScriptIssue(h);
    const number = h.rows()[0]?.issueNumber ?? -1;

    h.advance(3_600_000);
    await h.runAudit({
      runId: "run-4",
      messages: transcript([]),
      checks: [[SCRIPT_FINDING, "pass"]],
    });
    expect(h.writer.issues.get(number)?.state).toBe("open");
    expect(h.rows()[0]?.consecutiveCheckPasses).toBe(1);

    // An errored check in between resets nothing.
    h.advance(3_600_000);
    await h.runAudit({
      runId: "run-4b",
      messages: transcript([]),
      checks: [[SCRIPT_FINDING, "error"]],
    });
    expect(h.writer.issues.get(number)?.state).toBe("open");
    expect(h.rows()[0]?.consecutiveCheckPasses).toBe(1);

    h.advance(3_600_000);
    await h.runAudit({
      runId: "run-5",
      messages: transcript([]),
      checks: [[SCRIPT_FINDING, "pass"]],
    });
    expect(h.writer.issues.get(number)?.state).toBe("closed");
    expect(h.rows()[0]?.status).toBe("resolved");
  });

  it("an incomplete audit closes nothing and changes no streak", async () => {
    const h = pipeline();
    await fileScriptIssue(h);
    const number = h.rows()[0]?.issueNumber ?? -1;
    const before = h.rows()[0]?.consecutiveCheckPasses;

    h.advance(3_600_000);
    await h.runAudit({
      runId: "run-4",
      messages: transcript([], { complete: false }),
      checks: [[SCRIPT_FINDING, "pass"]],
    });
    h.advance(3_600_000);
    await h.runAudit({
      runId: "run-5",
      messages: transcript([], { complete: false }),
      checks: [[SCRIPT_FINDING, "pass"]],
    });

    expect(h.writer.issues.get(number)?.state).toBe("open");
    expect(h.rows()[0]?.consecutiveCheckPasses).toBe(before);
    expect(h.rows()[0]?.status).toBe("open");
  });

  it("finishes a run cut off at the deadline from the cron with no duplicate", async () => {
    const h = pipeline();
    h.control.createMs = 3_000;
    const findings = [SCRIPT_FINDING, SECOND_FINDING];
    await h.runAudit({ runId: "run-1", messages: transcript(findings) });
    h.advance(60_000);

    const partial = await h.runAudit({
      runId: "run-2",
      messages: transcript(findings),
      checks: [
        [SCRIPT_FINDING, "fail"],
        [SECOND_FINDING, "fail"],
      ],
      deadlineMs: 4_000,
    });
    expect(partial.outcome).toBe("applied_partial");
    expect(partial.pending).toBeGreaterThan(0);
    const createdByHook = h.writer.createCount();
    expect(createdByHook).toBeLessThan(2);

    // The cron drainer picks up what the hook could not reach.
    h.control.createMs = 0;
    h.advance(3 * 60_000);
    const drainDeps: OutboxDrainDeps = {
      isLoopEnabled: async () => true,
      claimDue: (args) => h.outbox.claimDueEffects(args),
      loadContext: (async () => ({
        flagEnabled: true,
        sideEffectsEnabled: true,
        shadow: false,
        resolved: { killed: false, settings: SETTINGS },
        breakers: {
          permissionLatched: false,
          loopAuditOpen: false,
          loopFixOpen: false,
        },
      })) as unknown as OutboxDrainDeps["loadContext"],
      mint: (async () => ({
        octokit: {},
        installationId: 42,
      })) as unknown as OutboxDrainDeps["mint"],
      createWriter: (() =>
        h.writer) as unknown as OutboxDrainDeps["createWriter"],
      applyEffects: (args) =>
        applyOutboxEffects({
          ...args,
          deps: {
            ...args.deps,
            db: FAKE_DB,
            outbox: h.outbox,
            breakers: h.breakers,
            onIssueCreated: (effect, issueNumber) =>
              h.ledger.markIssueCreated(effect, issueNumber, h.clock()),
            issueNumberFor: (effect) => h.ledger.issueNumberFor(effect),
          },
        }),
      now: h.clock,
    };
    const drained = await runOutboxDrain({
      db: FAKE_DB,
      now: h.clock(),
      deadlineAt: new Date(h.now() + 120_000),
      deps: drainDeps,
    });

    expect(drained.claimed).toBeGreaterThan(0);
    expect(h.writer.createCount()).toBe(2);
    const titles = [...h.writer.issues.values()].map((i) => i.title).sort();
    expect(titles).toEqual(
      [
        `[${AUDIT}] ${SCRIPT_FINDING.title}`,
        `[${AUDIT}] ${SECOND_FINDING.title}`,
      ].sort(),
    );
    expect(h.rows().every((r) => r.issueNumber !== null)).toBe(true);
    expect(
      [...h.outbox.rows.values()].filter((e) => e.status === "pending"),
    ).toHaveLength(0);
  });
});
