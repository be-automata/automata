import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DBUserMessage } from "@terragon/shared";
import type { DB } from "@terragon/shared/db";
import type {
  AuditFindingRow,
  AuditFixAttemptRow,
} from "@terragon/shared/model/audit-findings";

import { runAuditFixAutomation, type RunAuditFixDeps } from "./run-audit-fix";

vi.mock("@/lib/db", () => ({ db: {} }));
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

const ORG = "org-1";
const REPO = "acme/widgets";

const finding = {
  id: "finding-1",
  organizationId: ORG,
  repoFullName: REPO,
  fingerprint: "0123456789abcdef",
  ruleId: "supply.lockfile-missing",
  subject: "package.json",
  title: "Lockfile missing",
  planMd: "Add the lockfile.",
  acceptanceMd: "The lockfile exists.",
  planFiles: ["package.json", "pnpm-lock.yaml"],
  issueNumber: 42,
} as unknown as AuditFindingRow;

const attempt = {
  id: "attempt-1",
  organizationId: ORG,
  repoFullName: REPO,
  findingId: "finding-1",
  attemptNo: 1,
  branch: "automata/fix-42-01234567-a1",
} as unknown as AuditFixAttemptRow;

const automation = { id: "auto-1", userId: "user-1" };

/** A fake ledger with the bind CAS and the refund semantics of 09-04. */
function fakeLedger() {
  const state = {
    attempts: 1,
    phase: "claimed" as "claimed" | "dispatched" | "closed",
    threadId: null as string | null,
    refunded: false,
  };
  const bind = vi.fn(
    async ({ threadId }: { threadId: string }): Promise<boolean> => {
      if (state.phase === "claimed" && state.threadId === null) {
        state.threadId = threadId;
        state.phase = "dispatched";
        return true;
      }
      return state.threadId === threadId;
    },
  );
  const refund = vi.fn(async (): Promise<boolean> => {
    if (state.phase === "closed") return false;
    state.phase = "closed";
    state.refunded = true;
    state.attempts -= 1;
    return true;
  });
  return { state, bind, refund };
}

function harness(overrides: Partial<RunAuditFixDeps> = {}) {
  const ledger = fakeLedger();
  const lines: string[] = [];
  const errors: string[] = [];
  const events: { event: string; properties: Record<string, unknown> }[] = [];
  const deps: RunAuditFixDeps = {
    validateCanRun: vi.fn(async () => ({ canRun: true })),
    runAutomation: vi.fn(async () => ({
      threadId: "thread-1",
      threadChatId: "chat-1",
    })),
    bindFixAttemptThread: ledger.bind,
    refundFixAttempt: ledger.refund,
    closeFixAttempt: vi.fn(async () => true),
    setSlotHolderThread: vi.fn(async () => true),
    releaseSelfHealSlot: vi.fn(async () => true),
    log: (line: string) => {
      lines.push(line);
    },
    error: (message: string, fields: Record<string, unknown>) => {
      errors.push(`${message} ${JSON.stringify(fields)}`);
    },
    capture: (event, properties) => {
      events.push({ event, properties });
    },
    now: () => new Date("2026-10-04T03:00:00.000Z"),
    ...overrides,
  };
  return { deps, ledger, lines, errors, events };
}

function run(deps: RunAuditFixDeps) {
  return runAuditFixAutomation({
    db: {} as DB,
    automation,
    finding,
    attempt,
    baseBranch: "main",
    deps,
  });
}

describe("runAuditFixAutomation", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts one stamped fix thread, binds it and records the slot holder", async () => {
    const h = harness();
    const result = await run(h.deps);

    expect(result).toEqual({ threadId: "thread-1" });
    expect(h.deps.validateCanRun).toHaveBeenCalledWith({
      userId: "user-1",
      automationId: "auto-1",
      triggerTypes: ["issue"],
      throwOnError: false,
    });
    expect(h.deps.runAutomation).toHaveBeenCalledTimes(1);
    const call = vi.mocked(h.deps.runAutomation).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      userId: "user-1",
      automationId: "auto-1",
      source: "automated",
      options: {
        branchName: "main",
        issueNumber: 42,
        stampExtra: { selfHealAttemptId: "attempt-1" },
      },
    });
    // The transform appends the platform section built from the DB snapshot.
    const transform = call?.options?.transformMessage;
    expect(transform).toBeTypeOf("function");
    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "skill body" }],
    };
    const transformed = transform?.(message);
    expect(transformed?.parts).toHaveLength(2);
    expect(JSON.stringify(transformed?.parts[1])).toContain(
      "automata/fix-42-01234567-a1",
    );

    expect(h.ledger.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        attemptId: "attempt-1",
        threadId: "thread-1",
      }),
    );
    expect(h.deps.setSlotHolderThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
    );
    expect(h.ledger.refund).not.toHaveBeenCalled();
    expect(h.deps.releaseSelfHealSlot).not.toHaveBeenCalled();
    expect(h.lines).toEqual([
      `[self-heal] v=1 org=${ORG} repo=${REPO} run=attempt-1 fp=01234567 decision=dispatch reason=started mode=on`,
    ]);
    expect(h.events.map((e) => e.event)).toContain("self_heal_fix_dispatch");
  });

  it("RACE-01: the planner binds first; the later bind is a no-op and one attempt is consumed", async () => {
    const ledger = fakeLedger();
    const h = harness({
      bindFixAttemptThread: ledger.bind,
      refundFixAttempt: ledger.refund,
      runAutomation: vi.fn(async () => {
        // The dispatch planner reads the stamp and binds inside dispatch.
        expect(
          await ledger.bind({
            db: {} as DB,
            organizationId: ORG,
            attemptId: "attempt-1",
            threadId: "thread-1",
          } as never),
        ).toBe(true);
        return { threadId: "thread-1", threadChatId: "chat-1" };
      }),
    });

    const result = await run(h.deps);

    expect(result).toEqual({ threadId: "thread-1" });
    expect(ledger.bind).toHaveBeenCalledTimes(2);
    expect(await ledger.bind.mock.results[1]?.value).toBe(true);
    expect(ledger.state).toMatchObject({
      attempts: 1,
      phase: "dispatched",
      threadId: "thread-1",
      refunded: false,
    });
    expect(ledger.refund).not.toHaveBeenCalled();
  });

  it("runAutomation returning undefined refunds the attempt and releases the slot", async () => {
    const h = harness({ runAutomation: vi.fn(async () => undefined) });
    const result = await run(h.deps);

    expect(result).toBeNull();
    expect(h.ledger.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        attemptId: "attempt-1",
        cause: "thread_create_failed",
      }),
    );
    expect(h.ledger.state.attempts).toBe(0);
    expect(h.deps.releaseSelfHealSlot).toHaveBeenCalledWith({ db: {} });
    expect(h.ledger.bind).not.toHaveBeenCalled();
    expect(h.deps.setSlotHolderThread).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(1);
  });

  it("runAutomation throwing refunds, releases, never throws, and redacts the log", async () => {
    const h = harness({
      runAutomation: vi.fn(async () => {
        throw new Error("boom token ghs_abcdefghijklmnopqrstuvwxyz");
      }),
    });
    const result = await run(h.deps);

    expect(result).toBeNull();
    expect(h.ledger.refund).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "thread_create_failed" }),
    );
    expect(h.deps.releaseSelfHealSlot).toHaveBeenCalledTimes(1);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz");
    expect(h.errors[0]).toContain("<redacted>");
  });

  it("a refund that throws is still contained (resolves null)", async () => {
    const h = harness({
      runAutomation: vi.fn(async () => undefined),
      refundFixAttempt: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(run(h.deps)).resolves.toBeNull();
    expect(h.deps.releaseSelfHealSlot).toHaveBeenCalledTimes(1);
  });

  it("an automation that cannot run (no access tier) refunds without starting", async () => {
    const h = harness({
      validateCanRun: vi.fn(async () => ({ canRun: false })),
    });
    const result = await run(h.deps);

    expect(result).toBeNull();
    expect(h.deps.runAutomation).not.toHaveBeenCalled();
    expect(h.ledger.refund).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "automation_cannot_run" }),
    );
    expect(h.deps.releaseSelfHealSlot).toHaveBeenCalledTimes(1);
  });

  it("a snapshot that cannot support a fix closes the attempt counted and starts nothing", async () => {
    const h = harness();
    const result = await runAuditFixAutomation({
      db: {} as DB,
      automation,
      finding: { ...finding, planFiles: [] } as AuditFindingRow,
      attempt,
      baseBranch: "main",
      deps: h.deps,
    });

    expect(result).toBeNull();
    expect(h.deps.runAutomation).not.toHaveBeenCalled();
    expect(h.deps.closeFixAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "attempt-1",
        outcome: "invalid_snapshot",
        counted: true,
      }),
    );
    expect(h.ledger.refund).not.toHaveBeenCalled();
    expect(h.deps.releaseSelfHealSlot).toHaveBeenCalledTimes(1);
  });

  it("a bind refused (attempt already refunded) aborts: null, no refund, slot holder still recorded", async () => {
    const h = harness({ bindFixAttemptThread: vi.fn(async () => false) });
    const result = await run(h.deps);

    expect(result).toBeNull();
    expect(h.ledger.refund).not.toHaveBeenCalled();
    // The thread exists; the slot frees when it goes terminal.
    expect(h.deps.setSlotHolderThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
    );
    expect(h.lines.join("\n")).toContain("reason=bind_lost");
  });

  it("a lapsed slot lease is logged; the run is live", async () => {
    const h = harness({ setSlotHolderThread: vi.fn(async () => false) });
    const result = await run(h.deps);
    expect(result).toEqual({ threadId: "thread-1" });
    expect(h.errors.join("\n")).toContain("slot");
  });

  it("never calls runIssueAutomation and adds no eyes reaction", () => {
    const source = readFileSync(join(__dirname, "run-audit-fix.ts"), "utf8");
    expect(source).not.toMatch(/runIssueAutomation/);
    expect(source).not.toMatch(/EyesReaction/i);
  });
});
