/**
 * (a) Daemon-level goldens for #75 — drives the REAL daemon (today's path:
 * the per-agent `run*Command` methods in daemon.ts) over the unix socket and
 * captures the exact spawnCommandLine command string + env for codex, amp,
 * gemini, and opencode (claude's daemon-level goldens already live in
 * daemon.test.ts). `adapter-golden.test.ts` asserts the façades in
 * `packages/daemon/src/adapters/*-adapter.ts` reproduce these same values —
 * they are A2's (#76) guardrail that the cutover is byte-identical.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { DaemonRuntime, writeToUnixSocket } from "../runtime";
import { TerragonDaemon } from "../daemon";
import type { DaemonMessageClaude } from "../shared";
import {
  NORMALIZED_URL,
  TOKEN,
  normalizePromptPath,
  expectedGeminiEnv,
  expectedOpencodeEnv,
  expectedAmpEnv,
  EXPECTED_OPENCODE_MOCK,
  EXPECTED_CODEX_MOCK,
  EXPECTED_CODEX_COMMAND_DEFAULT,
  EXPECTED_CODEX_COMMAND_CREDITS_RESUME,
  EXPECTED_AMP_COMMAND,
  EXPECTED_GEMINI_COMMAND,
  EXPECTED_OPENCODE_COMMAND,
} from "./__golden-fixtures";

async function sleep(ms: number = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntil(condition: () => boolean, maxWaitMs: number = 2000) {
  const startTime = Date.now();
  while (!condition()) {
    await sleep(100);
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error("Timeout waiting for condition");
    }
  }
}

const BASE_MESSAGE: DaemonMessageClaude = {
  type: "claude",
  model: "gpt-5",
  agent: "codex",
  agentVersion: 0,
  token: TOKEN,
  prompt: "TEST_PROMPT_STRING",
  sessionId: null,
  threadId: "TEST_THREAD_ID_STRING",
  threadChatId: "TEST_THREAD_CHAT_ID_STRING",
};

describe("daemon-golden (#75, part a) — today's per-agent run*Command path", () => {
  let runtime: DaemonRuntime;
  let daemon: TerragonDaemon;

  beforeEach(() => {
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn(() => ({
        resolvedOptions: () => ({ timeZone: "America/New_York" }),
      })),
    });
    const unixSocketPath = `/tmp/terragon-daemon-golden-${nanoid()}.sock`;
    runtime = new DaemonRuntime({
      url: NORMALIZED_URL,
      unixSocketPath,
      outputFormat: "text",
    });
    vi.spyOn(runtime, "listenToUnixSocket");
    vi.spyOn(runtime, "exitProcess").mockImplementation(() => {});
    vi.spyOn(runtime, "killChildProcessGroup").mockImplementation(() => {});
    vi.spyOn(runtime, "spawnCommandLine").mockImplementation(() => ({
      processId: 1234,
      pollInterval: undefined,
    }));
    vi.spyOn(runtime, "serverPost").mockResolvedValue();
    vi.spyOn(runtime, "execSync").mockReturnValue("NOT_EXISTS\n");
    vi.spyOn(runtime, "readFileSync").mockImplementation(() => {
      throw new Error("File not found");
    });
    vi.spyOn(runtime, "appendFileSync").mockImplementation(() => {});
    daemon = new TerragonDaemon({ runtime, messageFlushDelay: 10 });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await runtime.teardown();
  });

  it("codex: default model + no session + useCredits=false — no per-agent env, mock success result 'Codex successfully completed'", async () => {
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(BASE_MESSAGE),
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const [command, opts] = (runtime.spawnCommandLine as any).mock.calls[0] as [
      string,
      { env: Record<string, string | undefined> },
    ];
    expect(normalizePromptPath(command)).toBe(EXPECTED_CODEX_COMMAND_DEFAULT);
    // No codex-specific env keys are injected (daemon.ts:818-828 passes none).
    expect(opts.env.AMP_API_KEY).toBeUndefined();
    expect(opts.env.OPENCODE_API_KEY).toBeUndefined();
  });

  it("codex: useCredits=true appends the terry model_provider flag; sessionId appends resume", async () => {
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...BASE_MESSAGE,
        useCredits: true,
        sessionId: "SESSION_ABC",
        model: "gpt-5-codex-high",
      }),
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const [command] = (runtime.spawnCommandLine as any).mock.calls[0] as [
      string,
    ];
    expect(normalizePromptPath(command)).toBe(
      EXPECTED_CODEX_COMMAND_CREDITS_RESUME,
    );
  });

  it("amp: command + AMP_API_KEY from process.env", async () => {
    vi.stubEnv("AMP_API_KEY", "amp-secret-key");
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({ ...BASE_MESSAGE, agent: "amp" }),
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const [command, opts] = (runtime.spawnCommandLine as any).mock.calls[0] as [
      string,
      { env: Record<string, string | undefined> },
    ];
    expect(normalizePromptPath(command)).toBe(EXPECTED_AMP_COMMAND);
    expect(opts.env).toMatchObject(expectedAmpEnv("amp-secret-key"));
  });

  it("gemini: command + proxy env (GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY=input.token)", async () => {
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...BASE_MESSAGE,
        agent: "gemini",
        model: "gemini-3-pro",
      }),
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const [command, opts] = (runtime.spawnCommandLine as any).mock.calls[0] as [
      string,
      { env: Record<string, string | undefined> },
    ];
    expect(normalizePromptPath(command)).toBe(EXPECTED_GEMINI_COMMAND);
    expect(opts.env).toMatchObject(expectedGeminiEnv());
  });

  it("opencode: command normalizes legacy model prefix inline; env + mock success result", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "opencode-secret-key");
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...BASE_MESSAGE,
        agent: "opencode",
        model: "opencode/grok-code",
      }),
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const [command, opts] = (runtime.spawnCommandLine as any).mock.calls[0] as [
      string,
      { env: Record<string, string | undefined> },
    ];
    expect(normalizePromptPath(command)).toBe(EXPECTED_OPENCODE_COMMAND);
    expect(opts.env).toMatchObject(expectedOpencodeEnv("opencode-secret-key"));
    expect(EXPECTED_OPENCODE_MOCK).toBe("Opencode successfully completed");
    expect(EXPECTED_CODEX_MOCK).toBe("Codex successfully completed");
  });

  it("LABELLED old-path gap (ADR-004 amendment / epic #70 DoD item 6): review mode on codex/amp/gemini/opencode does NOT strip GH_TOKEN today — closes in #76, not #75", async () => {
    vi.stubEnv("GH_TOKEN", "ghs_secret_token");
    await daemon.start();
    for (const agent of ["codex", "amp", "gemini", "opencode"] as const) {
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify({
          ...BASE_MESSAGE,
          agent,
          permissionMode: "review",
          prompt: `review-mode ${agent}`,
        }),
      });
    }
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 4,
    );
    const calls = (runtime.spawnCommandLine as any).mock.calls as Array<
      [string, { env: Record<string, string | undefined> }]
    >;
    for (const [, opts] of calls) {
      // The gap: today's daemon.ts only passes withholdGitCredentials from
      // runClaudeCodeCommand (daemon.ts:656) — the other four run methods
      // never do, so a review run on any of them keeps GH_TOKEN resident.
      // HarnessAdapter.capabilities.withholdGitCredentialsInReviewMode is
      // `true` for every adapter (see adapter-golden.test.ts) as the TARGET
      // contract; #76's generic runAgentCommand is what actually closes
      // this gap by reading that field.
      expect(opts.env.GH_TOKEN).toBe("ghs_secret_token");
    }
  });
});
