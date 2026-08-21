/**
 * (a) Daemon-level goldens for #75/#76 — drives the REAL daemon over the
 * unix socket and captures the exact spawnCommandLine command string + env
 * for codex, amp, gemini, and opencode (claude's daemon-level goldens
 * already live in daemon.test.ts). Originally written against the per-agent
 * `run*Command` methods (#75); as of #76 the daemon dispatches every agent
 * through the single generic `runAgentCommand`, and these same goldens now
 * exercise that path — the byte-identical command/env output proves the
 * cutover changed no observable behavior. `adapter-golden.test.ts` asserts
 * the façades in `packages/daemon/src/adapters/*-adapter.ts` reproduce these
 * same values in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nanoid } from "nanoid/non-secure";
import { DaemonRuntime, writeToUnixSocket } from "../runtime";
import { TerragonDaemon } from "../daemon";
import type { DaemonMessageClaude } from "../shared";
import {
  NORMALIZED_URL,
  TOKEN,
  REVIEW_POLICY_JOINED,
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
  OPENCODE_REVIEW_MODE_ENV_KEY,
  OPENCODE_REVIEW_MODE_ENV_VALUE,
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

  it("review-mode run strips every GitHub credential for EVERY agent (#76, epic #70 DoD 6)", async () => {
    // INVERTS the pre-#76 labelled gap test: before the cutover, review mode
    // on codex/amp/gemini/opencode did NOT strip GH_TOKEN (only Claude's old
    // per-agent method passed withholdGitCredentials). #76's generic
    // runAgentCommand reads adapter.capabilities.withholdGitCredentialsInReviewMode
    // uniformly for every agent, so this security assertion now flips from
    // "token present" to "token absent" — closing the gap the pre-#76 test
    // pinned as still-open.
    vi.stubEnv("GH_TOKEN", "ghs_secret_token");
    vi.stubEnv("GITHUB_TOKEN", "ghs_secret_token");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "AUTHORIZATION: basic REDACTED");

    await daemon.start();
    const agents = [
      "claudeCode",
      "codex",
      "gemini",
      "amp",
      "opencode",
    ] as const;
    for (const agent of agents) {
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify({
          ...BASE_MESSAGE,
          agent,
          model: agent === "claudeCode" ? "opus" : BASE_MESSAGE.model,
          permissionMode: "review",
          threadChatId: `REVIEW_${agent}`,
          prompt: `review-mode ${agent}`,
        }),
      });
    }
    await sleepUntil(
      () =>
        (runtime.spawnCommandLine as any).mock.calls.length === agents.length,
    );
    const reviewCalls = (runtime.spawnCommandLine as any).mock.calls as Array<
      [
        string,
        {
          env: Record<string, string | undefined>;
          onClose?: (code: number | null) => void;
        },
      ]
    >;
    for (const [index, [command, opts]] of reviewCalls.entries()) {
      const agent = agents[index]!;
      expect(opts.env.GH_TOKEN).toBeUndefined();
      expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(opts.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(opts.env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(opts.env.GIT_CONFIG_VALUE_0).toBeUndefined();

      // #88: per-agent review tool-policy carried in the command string
      // where reviewPolicyArgs() is non-empty (claude only — the other
      // four ship [] per their adapter's documented reason).
      if (agent === "claudeCode") {
        expect(command).toContain(REVIEW_POLICY_JOINED);
      }
      // #88 AC2: opencode's review fence is the env marker, not a command arg.
      if (agent === "opencode") {
        expect(opts.env[OPENCODE_REVIEW_MODE_ENV_KEY]).toBe(
          OPENCODE_REVIEW_MODE_ENV_VALUE,
        );
      }
      // Close each run before dispatching the next batch so processes don't
      // collide on threadChatId reuse below.
      opts.onClose?.(0);
    }

    // Negative half: permissionMode "allowAll" per agent keeps the creds
    // AND never carries the review tool-policy / opencode review marker.
    (runtime.spawnCommandLine as any).mockClear();
    for (const agent of agents) {
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify({
          ...BASE_MESSAGE,
          agent,
          model: agent === "claudeCode" ? "opus" : BASE_MESSAGE.model,
          permissionMode: "allowAll",
          threadChatId: `ALLOWALL_${agent}`,
          prompt: `allowAll-mode ${agent}`,
        }),
      });
    }
    await sleepUntil(
      () =>
        (runtime.spawnCommandLine as any).mock.calls.length === agents.length,
    );
    const allowAllCalls = (runtime.spawnCommandLine as any).mock.calls as Array<
      [string, { env: Record<string, string | undefined> }]
    >;
    for (const [index, [command, opts]] of allowAllCalls.entries()) {
      const agent = agents[index]!;
      expect(opts.env.GH_TOKEN).toBe("ghs_secret_token");
      expect(opts.env.GIT_CONFIG_KEY_0).toBe(
        "http.https://github.com/.extraheader",
      );
      expect(command).not.toContain(REVIEW_POLICY_JOINED);
      if (agent === "opencode") {
        expect(opts.env[OPENCODE_REVIEW_MODE_ENV_KEY]).toBeUndefined();
      }
    }
  });

  it("codex: an is_error result flushes the message buffer immediately (Gap B), via the socket (#76 characterization — no daemon-level pin existed pre-cutover)", async () => {
    // Long flush delay so the natural debounce timer cannot fire during this
    // test's window — any serverPost we observe must come from codex's
    // immediate is_error flush (adapter capabilities.flushBufferOnErrorResult).
    const longFlushDaemon = new TerragonDaemon({
      runtime,
      messageFlushDelay: 60_000,
    });
    await longFlushDaemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(BASE_MESSAGE), // agent: codex
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const onStdoutLine = (runtime.spawnCommandLine as any).mock.calls[0][1]
      .onStdoutLine as (line: string) => void;

    onStdoutLine(JSON.stringify({ type: "error", message: "boom" }));

    await sleepUntil(() => (runtime.serverPost as any).mock.calls.length === 1);
    const [payload] = (runtime.serverPost as any).mock.calls[0];
    expect(payload.messages).toEqual([
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "",
        error: "boom",
        is_error: true,
        num_turns: 0,
        duration_ms: 0,
      },
    ]);
  });

  it("amp: echoed first user message is dropped, via the socket (#76 characterization — no daemon-level pin existed pre-cutover)", async () => {
    vi.stubEnv("AMP_API_KEY", "amp-secret-key");
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({ ...BASE_MESSAGE, agent: "amp" }),
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const onStdoutLine = (runtime.spawnCommandLine as any).mock.calls[0][1]
      .onStdoutLine as (line: string) => void;

    // Amp echoes the prompt the daemon just sent it as a "user" role
    // message; the adapter's parser drops it so it never reaches the buffer.
    onStdoutLine(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "echoed" }] },
      }),
    );
    // A real assistant message that must survive, to prove the buffer isn't
    // simply empty for an unrelated reason.
    onStdoutLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    );

    await sleepUntil(() => (runtime.serverPost as any).mock.calls.length === 1);
    const [payload] = (runtime.serverPost as any).mock.calls[0];
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toMatchObject({ type: "assistant" });
  });

  it("claude: 'any-message' session tracking sets sessionId from a bare assistant message (no system/init wrapper) (#76 Gap C characterization)", async () => {
    vi.stubEnv("IDLE_TIMEOUT_MS", "50");
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...BASE_MESSAGE,
        agent: "claudeCode",
        model: "opus",
      }),
    });
    await sleepUntil(
      () => (runtime.spawnCommandLine as any).mock.calls.length === 1,
    );
    const onStdoutLine = (runtime.spawnCommandLine as any).mock.calls[0][1]
      .onStdoutLine as (line: string) => void;

    // No "type": "system" wrapper — just an assistant message carrying a
    // session_id. The "any-message" policy must still track it.
    onStdoutLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        session_id: "CLAUDE_SESSION_ANY",
      }),
    );

    // The idle watchdog's timeout message reads the tracked sessionId from
    // activeProcesses — the only externally-observable proof the "any-
    // message" policy captured it without a system/init wrapper. The
    // assistant message flushes first (10ms debounce); the watchdog result
    // flushes separately once it fires (~50ms idle), so wait for both
    // serverPost calls and inspect all sent messages.
    await sleepUntil(
      () => (runtime.serverPost as any).mock.calls.length >= 2,
      5000,
    );
    const allSentMessages = (runtime.serverPost as any).mock.calls.flatMap(
      (call: any) => call[0].messages,
    );
    const watchdogMessage = allSentMessages.find(
      (m: any) => m.is_error === true,
    );
    expect(watchdogMessage).toMatchObject({
      is_error: true,
      session_id: "CLAUDE_SESSION_ANY",
    });
  });
});
