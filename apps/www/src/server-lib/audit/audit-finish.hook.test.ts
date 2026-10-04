import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEAD_FINDING,
  fence,
  makeBlock,
} from "./__fixtures__/audit-terminal-messages";

/**
 * The audit finish hook: assertions are on call ARGUMENTS and recorded
 * outcomes. Every collaborator with IO is mocked; the pure resolver, the
 * parser and the terminal-text selector are real.
 */

const ORG = "org_1";
const REPO = "acme/widgets";
const FULL_SECTIONS = [
  "sensitive-files",
  "secret-detection",
  "dependency-security",
  "supply-chain",
  "security-automation",
].map((id) => ({ id, name: id, score: 80 }));
const FULL_TEXT =
  "done\n" + fence(makeBlock([LEAD_FINDING], { sections: FULL_SECTIONS }));

const AUDIT_STAMP = {
  type: "automation-skill",
  skillName: "audit-findings",
  contentSha: "sha",
  source: "db",
};

const h = vi.hoisted(() => ({
  thread: { value: null as Record<string, unknown> | null },
  messages: { value: [] as unknown[] },
  run: { value: null as Record<string, unknown> | null },
  context: { value: null as Record<string, unknown> | null },
  capability: { value: { ok: true, installationId: 77 } as unknown },
  mintFails: { value: false },
  executeImpl: { value: null as null | (() => Promise<unknown>) },
}));

vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));
vi.mock("@terragon/env/apps-www", () => ({
  env: {
    GITHUB_SIDE_EFFECTS_ENABLED: true,
    GITHUB_BOT_LOGIN: "automata-ai-bot[bot]",
    NEXT_PUBLIC_GITHUB_APP_NAME: "automata-ai-bot",
  },
}));
vi.mock("@terragon/shared/model/threads", () => ({
  getThreadMinimal: vi.fn(async () => h.thread.value),
  getThreadChat: vi.fn(async () => ({ messages: h.messages.value })),
}));
vi.mock("@terragon/shared/model/audit-findings", () => ({
  claimAuditRun: vi.fn(async () => h.run.value),
  finishAuditRun: vi.fn(async () => null),
  releaseAuditRunClaim: vi.fn(async () => {}),
}));
vi.mock("./resolve-self-heal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-self-heal")>()),
  loadSelfHealContext: vi.fn(async () => h.context.value),
}));
vi.mock("./self-heal-octokit", () => ({
  createSelfHealOctokit: vi.fn(async () => {
    if (h.mintFails.value) throw new Error("mint failed");
    return { octokit: {}, installationId: 77 };
  }),
}));
vi.mock("./self-heal-preflight", () => ({
  preflightCapabilities: vi.fn(async () => h.capability.value),
}));
vi.mock("./issue-writer", () => ({
  createIssueWriter: vi.fn(() => ({
    readIssueStates: vi.fn(async () => new Map()),
    isPrivateRepo: vi.fn(async () => false),
  })),
}));
vi.mock("./audit-ledger", () => ({
  createDbAuditLedger: vi.fn(() => ({ list: vi.fn(async () => []) })),
}));
vi.mock("./execute-audit-findings", () => ({
  executeAuditFindings: vi.fn(async () =>
    h.executeImpl.value
      ? h.executeImpl.value()
      : {
          outcome: "applied",
          created: 1,
          updated: 0,
          closed: 0,
          reopened: 0,
          needsHuman: 0,
          suppressed: 0,
          pending: 0,
          skipped: 0,
          decisions: [],
        },
  ),
}));

// The global test setup may already have loaded the real modules.
vi.resetModules();
const audit = await import("@terragon/shared/model/audit-findings");
const threads = await import("@terragon/shared/model/threads");
const octokit = await import("./self-heal-octokit");
const preflight = await import("./self-heal-preflight");
const executor = await import("./execute-audit-findings");
const { handleAuditFindingsAtFinish, getAuditFindingsStamp } = await import(
  "./audit-finish"
);

function context(over: Record<string, unknown> = {}) {
  const base = {
    flagEnabled: true,
    sideEffectsEnabled: true,
    shadow: false,
    resolved: {
      killed: false,
      settings: { mode: "on" },
    },
    breakers: {
      permissionLatched: false,
      loopAuditOpen: false,
      loopFixOpen: false,
    },
  };
  return { ...base, ...over };
}

function auditThread(over: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    githubRepoFullName: REPO,
    repoBaseBranchName: "main",
    sourceMetadata: AUDIT_STAMP,
    terminalCause: null,
    ...over,
  };
}

const call = () =>
  handleAuditFindingsAtFinish({
    db: {} as never,
    userId: "user_1",
    threadId: "thread_1",
    threadChatId: "chat_1",
  });

function leadMessages(text: string) {
  return [
    {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text }],
    },
  ];
}

function lastFinish(): Record<string, unknown> {
  const calls = vi.mocked(audit.finishAuditRun).mock.calls;
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  h.thread.value = auditThread();
  h.messages.value = leadMessages(FULL_TEXT);
  h.run.value = { id: "run_1", claimCount: 1, checkResults: null };
  h.context.value = context();
  h.capability.value = { ok: true, installationId: 77 };
  h.mintFails.value = false;
  h.executeImpl.value = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getAuditFindingsStamp", () => {
  it("returns the stamp for an audit thread and null otherwise", () => {
    expect(getAuditFindingsStamp(auditThread() as never)).toMatchObject({
      skillName: "audit-findings",
    });
    expect(
      getAuditFindingsStamp({
        sourceMetadata: { ...AUDIT_STAMP, skillName: "github-ops" },
      } as never),
    ).toBeNull();
    expect(getAuditFindingsStamp(null)).toBeNull();
  });

  it("is null for an abandoned run", () => {
    expect(
      getAuditFindingsStamp(
        auditThread({ terminalCause: "superseded" }) as never,
      ),
    ).toBeNull();
  });
});

describe("handleAuditFindingsAtFinish", () => {
  it("stamped thread with no PR: claims then executes once with the lead's block", async () => {
    h.run.value = {
      id: "run_1",
      claimCount: 1,
      checkResults: [{ fingerprint: "fp1", outcome: "pass" }],
    };
    vi.useFakeTimers({ now: new Date("2026-10-04T10:00:00Z") });
    await call();

    expect(audit.claimAuditRun).toHaveBeenCalledTimes(1);
    expect(audit.claimAuditRun).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        repoFullName: REPO,
        threadId: "thread_1",
      }),
    );
    expect(executor.executeAuditFindings).toHaveBeenCalledTimes(1);
    const { input } = vi.mocked(executor.executeAuditFindings).mock
      .calls[0]![0];
    expect(input.mode).toBe("on");
    expect(input.runId).toBe("run_1");
    expect(input.complete).toBe(true);
    expect(input.block.findings).toHaveLength(1);
    expect(input.checkResults?.get("fp1")).toBe("pass");
    expect(input.deadlineAt.getTime()).toBe(
      new Date("2026-10-04T10:00:00Z").getTime() + 20_000,
    );
    expect(lastFinish()).toMatchObject({
      status: "done",
      outcome: "applied",
      mode: "on",
      counts: { parsed: 1, created: 1 },
    });
  });

  it("an unstamped thread returns after one getThreadMinimal", async () => {
    h.thread.value = auditThread({ sourceMetadata: null });
    await call();
    expect(threads.getThreadMinimal).toHaveBeenCalledTimes(1);
    expect(audit.claimAuditRun).not.toHaveBeenCalled();
  });

  it("an abandoned run does not claim", async () => {
    h.thread.value = auditThread({ terminalCause: "superseded" });
    await call();
    expect(audit.claimAuditRun).not.toHaveBeenCalled();
  });

  it("a lost claim does not execute and logs 'already processed' once", async () => {
    h.run.value = null;
    await call();
    expect(executor.executeAuditFindings).not.toHaveBeenCalled();
    const logged = vi
      .mocked(console.log)
      .mock.calls.filter((c) => String(c[0]).includes("already processed"));
    expect(logged).toHaveLength(1);
  });

  it("organizationId null skips with a log and no claim", async () => {
    h.thread.value = auditThread({ organizationId: null });
    await call();
    expect(audit.claimAuditRun).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it("flag off records 'killed' and never builds a GitHub client", async () => {
    h.context.value = context({ flagEnabled: false });
    await call();
    expect(octokit.createSelfHealOctokit).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: "done", outcome: "killed" });
  });

  it("kill switch records 'killed'", async () => {
    h.context.value = context({
      resolved: { killed: true, settings: { mode: "on" } },
    });
    await call();
    expect(octokit.createSelfHealOctokit).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ outcome: "killed" });
  });

  it("mode off records 'disabled'", async () => {
    h.context.value = context({
      resolved: { killed: false, settings: { mode: "off" } },
    });
    await call();
    expect(octokit.createSelfHealOctokit).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ outcome: "disabled" });
  });

  it("side effects disabled runs the executor in dry-run", async () => {
    h.context.value = context({ sideEffectsEnabled: false });
    await call();
    const { input } = vi.mocked(executor.executeAuditFindings).mock
      .calls[0]![0];
    expect(input.mode).toBe("dry-run");
    expect(lastFinish()).toMatchObject({ outcome: "dry_run", mode: "dry-run" });
  });

  it("shadow installation with mode on runs the executor in dry-run", async () => {
    h.context.value = context({ shadow: true });
    await call();
    expect(
      vi.mocked(executor.executeAuditFindings).mock.calls[0]![0].input.mode,
    ).toBe("dry-run");
  });

  it("unparseable terminal text records 'unparseable' with no client", async () => {
    h.messages.value = leadMessages("I could not finish the audit.");
    await call();
    expect(octokit.createSelfHealOctokit).not.toHaveBeenCalled();
    expect(executor.executeAuditFindings).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({
      status: "failed",
      outcome: "unparseable",
    });
  });

  it("missing writer capability in on mode records 'missing-permission' and names issues: write", async () => {
    h.capability.value = { ok: false, missing: ["issues"], installationId: 77 };
    await call();
    expect(executor.executeAuditFindings).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ outcome: "missing-permission" });
    const warned = vi
      .mocked(console.warn)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(warned).toContain("issues: write");
  });

  it("missing writer capability in dry-run still runs the executor and counts skipped.missing_permission", async () => {
    h.capability.value = { ok: false, missing: ["issues"], installationId: 77 };
    h.context.value = context({
      resolved: { killed: false, settings: { mode: "dry-run" } },
    });
    await call();
    expect(
      vi.mocked(executor.executeAuditFindings).mock.calls[0]![0].input.mode,
    ).toBe("dry-run");
    expect(lastFinish()).toMatchObject({ skipped: { missing_permission: 1 } });
  });

  it("an unavailable preflight releases the claim", async () => {
    h.capability.value = { ok: false, unavailable: true };
    await call();
    expect(audit.releaseAuditRunClaim).toHaveBeenCalledTimes(1);
    expect(audit.finishAuditRun).not.toHaveBeenCalled();
    expect(executor.executeAuditFindings).not.toHaveBeenCalled();
  });

  it("a failed token mint releases the claim", async () => {
    h.mintFails.value = true;
    await call();
    expect(audit.releaseAuditRunClaim).toHaveBeenCalledTimes(1);
    expect(preflight.preflightCapabilities).not.toHaveBeenCalled();
  });

  it("claim_count 5 with an unavailable preflight finishes the run failed", async () => {
    h.run.value = { id: "run_1", claimCount: 5, checkResults: null };
    h.capability.value = { ok: false, unavailable: true };
    await call();
    expect(audit.releaseAuditRunClaim).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({
      status: "failed",
      outcome: "preflight_unavailable",
    });
  });

  it("on mode files issues without any branch-protection read (protection is optional)", async () => {
    await call();
    expect(
      vi.mocked(executor.executeAuditFindings).mock.calls[0]![0].input.mode,
    ).toBe("on");
  });

  it("RES-04: an executor that eats the whole budget cannot hold the hook past the deadline", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-04T10:00:00Z") });
    h.executeImpl.value = () => new Promise(() => {});
    let settled = false;
    const running = call().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(20_999);
    expect(settled).toBe(true);
    await running;
    expect(lastFinish()).toMatchObject({
      status: "done",
      outcome: "applied_partial",
    });
  });

  it("an executor that throws finishes the run failed with a redacted error and resolves", async () => {
    h.executeImpl.value = async () => {
      throw new Error("boom ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    };
    await expect(call()).resolves.toBeUndefined();
    const finish = lastFinish();
    expect(finish).toMatchObject({ status: "failed", outcome: "error" });
    expect(String(finish.error)).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz",
    );
  });
});
