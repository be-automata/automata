import { DaemonMessageStop, DaemonMessageClaude } from "./shared";
import { DaemonRuntime, writeToUnixSocket } from "./runtime";
import { TerragonDaemon } from "./daemon";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  MockInstance,
} from "vitest";
import { nanoid } from "nanoid/non-secure";

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

const TEST_INPUT_MESSAGE: DaemonMessageClaude = {
  type: "claude",
  model: "opus",
  agent: "claudeCode",
  agentVersion: 0,
  token: "TEST_TOKEN_STRING",
  prompt: "TEST_PROMPT_STRING",
  sessionId: null,
  threadId: "TEST_THREAD_ID_STRING",
  threadChatId: "TEST_THREAD_CHAT_ID_STRING",
};

const TEST_STOP_MESSAGE: DaemonMessageStop = {
  type: "stop",
  threadId: "TEST_THREAD_ID_STRING",
  threadChatId: "TEST_THREAD_CHAT_ID_STRING",
  token: "TEST_TOKEN_STRING",
};

describe("daemon", () => {
  let runtime: DaemonRuntime;
  let daemon: TerragonDaemon;
  let killChildProcessGroupMock: MockInstance<
    DaemonRuntime["killChildProcessGroup"]
  >;
  let spawnCommandLineMock: MockInstance<DaemonRuntime["spawnCommandLine"]>;
  let serverPostMock: MockInstance<DaemonRuntime["serverPost"]>;
  let execSyncMock: MockInstance<DaemonRuntime["execSync"]>;
  let readFileSyncMock: MockInstance<DaemonRuntime["readFileSync"]>;
  let spawnPid = 1234;
  beforeEach(() => {
    // Mock Intl.DateTimeFormat to return a fixed timezone
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: vi.fn(() => ({
        resolvedOptions: () => ({ timeZone: "America/New_York" }),
      })),
    });
    const unixSocketPath = `/tmp/terragon-daemon-${nanoid()}.sock`;
    runtime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath,
      outputFormat: "text",
    });
    vi.spyOn(runtime, "listenToUnixSocket");
    vi.spyOn(runtime, "exitProcess").mockImplementation(() => {});
    killChildProcessGroupMock = vi
      .spyOn(runtime, "killChildProcessGroup")
      .mockImplementation(() => {});
    spawnCommandLineMock = vi
      .spyOn(runtime, "spawnCommandLine")
      .mockImplementation(() => ({
        processId: ++spawnPid,
        pollInterval: undefined,
      }));
    serverPostMock = vi.spyOn(runtime, "serverPost").mockResolvedValue();
    execSyncMock = vi
      .spyOn(runtime, "execSync")
      .mockReturnValue("NOT_EXISTS\n");
    readFileSyncMock = vi
      .spyOn(runtime, "readFileSync")
      .mockImplementation((path: string) => {
        // Default behavior: throw error when .git-credentials doesn't exist
        if (path.endsWith("/.git-credentials")) {
          throw new Error("File not found");
        }
        throw new Error(`Unexpected call to readFileSync: ${path}`);
      });
    vi.spyOn(runtime, "appendFileSync").mockImplementation(() => {
      throw new Error("Unexpected call to appendFileSync");
    });
    daemon = new TerragonDaemon({
      runtime,
      messageHandleDelay: 5,
      messageFlushDelay: 10,
      retryConfig: {
        baseDelayMs: 10,
        maxDelayMs: 100,
        maxAttempts: 10,
        backoffMultiplier: 2,
        jitterFactor: 0,
      },
    });
  });

  function mockSpawnCommandStdoutLine(claudeMessage: any) {
    spawnCommandLineMock.mock.calls[0]![1].onStdoutLine(
      JSON.stringify(claudeMessage),
    );
  }

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await runtime.teardown();
  });

  it("should kill the active claude process when another message is received", async () => {
    spawnCommandLineMock.mockReturnValue({
      processId: 1234,
      pollInterval: undefined,
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
    expect(killChildProcessGroupMock).toHaveBeenCalledTimes(0);

    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleepUntil(() => killChildProcessGroupMock.mock.calls.length === 1);
    expect(killChildProcessGroupMock).toHaveBeenCalledWith(1234);
    expect(spawnCommandLineMock).toHaveBeenCalledTimes(2);
    expect(killChildProcessGroupMock).toHaveBeenCalledTimes(1);
  });

  it("should kill the active claude process when stop message is received", async () => {
    spawnCommandLineMock.mockReturnValue({
      processId: 1234,
      pollInterval: undefined,
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
    expect(killChildProcessGroupMock).toHaveBeenCalledTimes(0);

    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_STOP_MESSAGE),
    });
    await sleepUntil(() => killChildProcessGroupMock.mock.calls.length === 1);

    expect(killChildProcessGroupMock).toHaveBeenCalledTimes(1);
    expect(killChildProcessGroupMock).toHaveBeenCalledWith(1234);
    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
  });

  it("should not kill an already finished process when starting a new command", async () => {
    let firstOnClose: ((code: number | null) => void) | undefined;
    spawnCommandLineMock.mockImplementation((command, handlers) => {
      firstOnClose = handlers?.onClose;
      return {
        processId: ++spawnPid,
        pollInterval: undefined,
      };
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

    expect(typeof firstOnClose).toBe("function");
    firstOnClose?.(0);
    await sleep();
    killChildProcessGroupMock.mockClear();

    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...TEST_INPUT_MESSAGE,
        prompt: "second run",
      }),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);
    expect(killChildProcessGroupMock).not.toHaveBeenCalled();
  });

  it("review-mode run strips every GitHub credential from the agent env; a normal run keeps them (#65 wiring)", async () => {
    // Pin the ACTUAL security property at its decision point (daemon.ts:
    // withholdGitCredentials = permissionMode === "review"), not just the
    // stripGithubCredentials helper in isolation: a review agent (emit-only,
    // ADR-036) must reach the spawn with NO GitHub credential vector, while a
    // normal-mode agent — which legitimately needs authenticated git/gh —
    // keeps them. These enter the child env via process.env, so stub them there.
    vi.stubEnv("GH_TOKEN", "ghs_secret_token");
    vi.stubEnv("GITHUB_TOKEN", "ghs_secret_token");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "AUTHORIZATION: basic REDACTED");

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...TEST_INPUT_MESSAGE,
        permissionMode: "review",
      }),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
    const reviewEnv = spawnCommandLineMock.mock.calls[0]![1].env as Record<
      string,
      string | undefined
    >;
    expect(reviewEnv.GH_TOKEN).toBeUndefined();
    expect(reviewEnv.GITHUB_TOKEN).toBeUndefined();
    expect(reviewEnv.GIT_CONFIG_COUNT).toBeUndefined();
    expect(reviewEnv.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(reviewEnv.GIT_CONFIG_VALUE_0).toBeUndefined();

    // End the review run, then a normal-mode run keeps the credentials.
    spawnCommandLineMock.mock.calls[0]![1].onClose?.(0);
    await sleep();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...TEST_INPUT_MESSAGE,
        permissionMode: "allowAll",
        prompt: "normal run",
      }),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);
    const normalEnv = spawnCommandLineMock.mock.calls[1]![1].env as Record<
      string,
      string | undefined
    >;
    expect(normalEnv.GH_TOKEN).toBe("ghs_secret_token");
    expect(normalEnv.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/.extraheader",
    );
  });

  it("should spawn the claude command and send output to the API", async () => {
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();
    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
    const spawnCommandArg1 = spawnCommandLineMock.mock.calls[0]![0];
    const spawnCommandArg2 = spawnCommandLineMock.mock.calls[0]![1];
    expect(spawnCommandArg1).toMatch(
      /^cat \/tmp\/claude-prompt-.* \| claude -p/,
    );
    expect(spawnCommandArg2).toMatchObject({
      env: expect.any(Object),
      onStdoutLine: expect.any(Function),
      onStderr: expect.any(Function),
      onError: expect.any(Function),
      onClose: expect.any(Function),
    });
    const claudeMessage1 = {
      role: "assistant",
      content: "TEST_RESPONSE_STRING",
    };

    mockSpawnCommandStdoutLine(claudeMessage1);
    await sleep();
    expect(serverPostMock).toHaveBeenCalledTimes(1);
    expect(serverPostMock).toHaveBeenCalledWith(
      {
        messages: [claudeMessage1],
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
  });

  it("sets Anthropic proxy environment variables when using built-in credits", async () => {
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...TEST_INPUT_MESSAGE,
        useCredits: true,
      }),
    });
    await sleep();

    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
    const env = spawnCommandLineMock.mock.calls[0]![1]!.env as Record<
      string,
      string | undefined
    >;
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "http://localhost:3000/api/proxy/anthropic",
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("TEST_TOKEN_STRING");
  });

  it("should spawn the claude command and batch messages to the API", async () => {
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();
    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
    const spawnCommandArg1 = spawnCommandLineMock.mock.calls[0]![0];
    const spawnCommandArg2 = spawnCommandLineMock.mock.calls[0]![1];
    expect(spawnCommandArg1).toMatch(
      /^cat \/tmp\/claude-prompt-.* \| claude -p/,
    );
    expect(spawnCommandArg2).toMatchObject({
      env: expect.any(Object),
      onStdoutLine: expect.any(Function),
      onStderr: expect.any(Function),
      onError: expect.any(Function),
      onClose: expect.any(Function),
    });

    // Simulate 3 batches of messages to the API
    const messageBatch1 = [
      { role: "assistant", content: "TEST_RESPONSE_STRING_1" },
      { role: "assistant", content: "TEST_RESPONSE_STRING_2" },
      { role: "assistant", content: "TEST_RESPONSE_STRING_3" },
      { role: "assistant", content: "TEST_RESPONSE_STRING_4" },
    ];
    for (const message of messageBatch1) {
      mockSpawnCommandStdoutLine(message);
      await sleep(2);
    }
    await sleep(10);

    // Batch 2
    const messageBatch2 = [
      { role: "assistant", content: "TEST_RESPONSE_STRING_5" },
      { role: "assistant", content: "TEST_RESPONSE_STRING_6" },
    ];
    for (const message of messageBatch2) {
      mockSpawnCommandStdoutLine(message);
      await sleep(2);
    }
    await sleep(10);

    // Batch 3
    const messageBatch3 = [
      { role: "assistant", content: "TEST_RESPONSE_STRING_7" },
      { role: "assistant", content: "TEST_RESPONSE_STRING_8" },
    ];
    for (const message of messageBatch3) {
      mockSpawnCommandStdoutLine(message);
      await sleep(2);
    }

    await sleep();
    expect(serverPostMock).toHaveBeenCalledTimes(3);
    expect(serverPostMock).toHaveBeenNthCalledWith(
      1,
      {
        messages: messageBatch1,
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
    expect(serverPostMock).toHaveBeenNthCalledWith(
      2,
      {
        messages: messageBatch2,
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
    expect(serverPostMock).toHaveBeenNthCalledWith(
      3,
      {
        messages: messageBatch3,
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
  });

  it("should flush the message buffer when the daemon is terminated", async () => {
    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();

    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_STRING",
    });

    expect(serverPostMock).toHaveBeenCalledTimes(0);
    await runtime.teardown();
    await sleep();
    expect(serverPostMock).toHaveBeenCalledTimes(1);
  });

  it("should prevent concurrent flushes when messages arrive during API call", async () => {
    // Make serverPost take some time to simulate network delay
    let serverPostCallCount = 0;
    serverPostMock.mockImplementation(async () => {
      serverPostCallCount++;
      await sleep(50); // Simulate 50ms API call
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();

    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);

    // Send 3 messages quickly
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_1",
    });
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_2",
    });
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_3",
    });

    // Wait for the flush timer
    await sleep(15);

    // While the first flush is in progress, send more messages
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_4",
    });
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_5",
    });

    // Wait for all flushes to complete
    await sleep(100);

    // Should have exactly 2 API calls, not 3
    expect(serverPostCallCount).toBe(2);

    // First call should have the first 3 messages
    expect(serverPostMock).toHaveBeenNthCalledWith(
      1,
      {
        messages: [
          { role: "assistant", content: "TEST_RESPONSE_1" },
          { role: "assistant", content: "TEST_RESPONSE_2" },
          { role: "assistant", content: "TEST_RESPONSE_3" },
        ],
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );

    // Second call should have the last 2 messages
    expect(serverPostMock).toHaveBeenNthCalledWith(
      2,
      {
        messages: [
          { role: "assistant", content: "TEST_RESPONSE_4" },
          { role: "assistant", content: "TEST_RESPONSE_5" },
        ],
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
  });

  it("should handle rapid message arrivals without losing messages", async () => {
    // Make serverPost take some time
    serverPostMock.mockImplementation(async () => {
      await sleep(30);
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();

    // Send many messages rapidly
    for (let i = 1; i <= 10; i++) {
      mockSpawnCommandStdoutLine({
        role: "assistant",
        content: `TEST_RESPONSE_${i}`,
      });
      await sleep(2); // Small delay between messages
    }

    // Wait for all flushes to complete
    await sleep(150);

    // All messages should be sent, none should be lost
    const allMessagesSent = serverPostMock.mock.calls
      .flatMap((call) => call[0].messages)
      .map((msg) => msg.content);

    expect(allMessagesSent).toHaveLength(10);
    for (let i = 1; i <= 10; i++) {
      expect(allMessagesSent).toContain(`TEST_RESPONSE_${i}`);
    }
  });

  it("should retry messages when API call fails", async () => {
    let apiCallCount = 0;

    // Make the first API call fail, subsequent calls succeed
    serverPostMock.mockImplementation(async () => {
      apiCallCount++;
      if (apiCallCount === 1) {
        throw new Error("Network error");
      }
      // Subsequent calls succeed
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();

    // Send messages that will fail on first API call
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_1",
    });
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_RESPONSE_2",
    });

    // Wait for first flush attempt (which will fail)
    await sleep(15);

    // First API call should have been attempted
    expect(apiCallCount).toBe(1);

    // Wait for retry
    await sleep(15);

    // Second API call should succeed
    expect(apiCallCount).toBe(2);

    // Check that the same messages were sent in both attempts
    expect(serverPostMock).toHaveBeenCalledTimes(2);
    expect(serverPostMock).toHaveBeenNthCalledWith(
      1,
      {
        messages: [
          { role: "assistant", content: "TEST_RESPONSE_1" },
          { role: "assistant", content: "TEST_RESPONSE_2" },
        ],
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
    expect(serverPostMock).toHaveBeenNthCalledWith(
      2,
      {
        messages: [
          { role: "assistant", content: "TEST_RESPONSE_1" },
          { role: "assistant", content: "TEST_RESPONSE_2" },
        ],
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
  });

  it("should preserve message order when retrying after API failure", async () => {
    let apiCallCount = 0;

    // Make the first API call fail
    serverPostMock.mockImplementation(async () => {
      apiCallCount++;
      if (apiCallCount === 1) {
        await sleep(30); // Simulate network delay
        throw new Error("API error");
      }
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();

    // Send first batch of messages
    mockSpawnCommandStdoutLine({ role: "assistant", content: "BATCH_1_MSG_1" });
    mockSpawnCommandStdoutLine({ role: "assistant", content: "BATCH_1_MSG_2" });

    // Wait for first flush to start (and fail)
    await sleep(15);

    // While the first flush is failing, send more messages
    mockSpawnCommandStdoutLine({ role: "assistant", content: "BATCH_2_MSG_1" });
    mockSpawnCommandStdoutLine({ role: "assistant", content: "BATCH_2_MSG_2" });

    // Wait for everything to complete
    await sleep(100);

    // Should have 2 successful API calls
    expect(serverPostMock).toHaveBeenCalledTimes(2);

    // First call fails, second call should contain all messages in order
    expect(serverPostMock).toHaveBeenNthCalledWith(
      2,
      {
        messages: [
          { role: "assistant", content: "BATCH_1_MSG_1" },
          { role: "assistant", content: "BATCH_1_MSG_2" },
          { role: "assistant", content: "BATCH_2_MSG_1" },
          { role: "assistant", content: "BATCH_2_MSG_2" },
        ],
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "TEST_THREAD_CHAT_ID_STRING",
        timezone: "America/New_York",
      },
      "TEST_TOKEN_STRING",
    );
  });

  it("should handle multiple consecutive API failures", async () => {
    let apiCallCount = 0;

    // Make the first 3 API calls fail
    serverPostMock.mockImplementation(async () => {
      apiCallCount++;
      if (apiCallCount <= 3) {
        throw new Error(`API error ${apiCallCount}`);
      }
    });

    await daemon.start();
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleep();

    // Send a message
    mockSpawnCommandStdoutLine({
      role: "assistant",
      content: "TEST_MESSAGE",
    });

    // Wait for multiple retry attempts
    // Delays will be: 10ms (1st retry), 20ms (2nd), 40ms (3rd), need to wait for all
    await sleep(100);

    // Should have made 4 API calls (3 failures + 1 success)
    expect(apiCallCount).toBe(4);

    // All calls should have the same message
    for (let i = 1; i <= 4; i++) {
      expect(serverPostMock).toHaveBeenNthCalledWith(
        i,
        {
          messages: [{ role: "assistant", content: "TEST_MESSAGE" }],
          threadId: "TEST_THREAD_ID_STRING",
          threadChatId: "TEST_THREAD_CHAT_ID_STRING",
          timezone: "America/New_York",
        },
        "TEST_TOKEN_STRING",
      );
    }
  });

  describe("Claude credentials handling", () => {
    it("should use environment ANTHROPIC_API_KEY when Claude credentials file does not exist", async () => {
      // Mock execSync to return "NOT_EXISTS" (no credentials file)
      execSyncMock.mockReturnValue("NOT_EXISTS\n");

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleep();

      // Check that execSync was called to check for credentials
      expect(execSyncMock).toHaveBeenCalledWith(
        "cd && test -f .claude/.credentials.json && echo 'EXISTS' || echo 'NOT_EXISTS'",
      );

      // Check that spawnCommand was called with the API key from environment
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const spawnEnv = spawnCommandLineMock.mock.calls[0]![1].env;
      expect(spawnEnv.ANTHROPIC_API_KEY).toBe("test-api-key-from-env");
    });

    it("useCredits routes through the proxy and does NOT also send ANTHROPIC_API_KEY", async () => {
      // Two credentials for one call means the CLI's precedence rule decides who
      // pays. Harmless in a sandbox (nothing injects a key there, so the fallback
      // is ""), but on an execution-plane box the operator's key is populated and
      // would compete with the proxy token.
      execSyncMock.mockReturnValue("NOT_EXISTS\n");

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify({ ...TEST_INPUT_MESSAGE, useCredits: true }),
      });
      await sleep();

      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const spawnEnv = spawnCommandLineMock.mock.calls[0]![1].env;
      expect(spawnEnv.ANTHROPIC_AUTH_TOKEN).toBe("TEST_TOKEN_STRING");
      expect(spawnEnv.ANTHROPIC_BASE_URL).toContain("/api/proxy/anthropic");
      // Blanked, not omitted: the child env is {...process.env, ...env}, so
      // omitting the key would let the box's ambient one through — which is
      // exactly the collision this is meant to prevent. The ambient value here
      // is "test-api-key-from-env"; it must NOT survive.
      expect(spawnEnv.ANTHROPIC_API_KEY).toBe("");
    });

    it("without useCredits the proxy vars are absent and the key path is used", async () => {
      execSyncMock.mockReturnValue("NOT_EXISTS\n");

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleep();

      const spawnEnv = spawnCommandLineMock.mock.calls[0]![1].env;
      expect(spawnEnv.ANTHROPIC_API_KEY).toBe("test-api-key-from-env");
      expect(spawnEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(spawnEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    });

    it("should set empty ANTHROPIC_API_KEY when Claude credentials file exists", async () => {
      // Mock execSync to return "EXISTS" (credentials file exists)
      execSyncMock.mockReturnValue("EXISTS\n");
      // Mock readFileSync to handle both .git-credentials and .credentials.json
      readFileSyncMock.mockImplementation((path: string) => {
        if (path.endsWith("/.git-credentials")) {
          throw new Error("File not found");
        }
        if (path.endsWith("/.claude/.credentials.json")) {
          return '{"claudeAiOauth": {}}';
        }
        throw new Error(`Unexpected file read: ${path}`);
      });

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleep();

      // Check that execSync was called to check for credentials
      expect(execSyncMock).toHaveBeenCalledWith(
        "cd && test -f .claude/.credentials.json && echo 'EXISTS' || echo 'NOT_EXISTS'",
      );

      // Check that spawnCommand was called with empty API key
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const spawnEnv = spawnCommandLineMock.mock.calls[0]![1].env;
      expect(spawnEnv.ANTHROPIC_API_KEY).toBe("");
    });

    it("should use the anthropicApiKey from the credentials file when it exists", async () => {
      execSyncMock.mockReturnValue("EXISTS\n");
      // Mock readFileSync to handle both .git-credentials and .credentials.json
      readFileSyncMock.mockImplementation((path: string) => {
        if (path.endsWith("/.git-credentials")) {
          throw new Error("File not found");
        }
        if (path.endsWith("/.claude/.credentials.json")) {
          return '{"anthropicApiKey": "anthropic-api-key-from-credentials"}';
        }
        throw new Error(`Unexpected file read: ${path}`);
      });

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleep();

      // Check that execSync was called to check for credentials
      expect(execSyncMock).toHaveBeenCalledWith(
        "cd && test -f .claude/.credentials.json && echo 'EXISTS' || echo 'NOT_EXISTS'",
      );

      // Check that spawnCommand was called with empty API key
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const spawnEnv = spawnCommandLineMock.mock.calls[0]![1].env;
      expect(spawnEnv.ANTHROPIC_API_KEY).toBe(
        "anthropic-api-key-from-credentials",
      );
    });

    it("should handle execSync output with whitespace correctly", async () => {
      // Mock execSync to return "EXISTS" with various whitespace
      execSyncMock.mockReturnValue("  EXISTS  \n\n");
      // Mock readFileSync to handle both .git-credentials and .credentials.json
      readFileSyncMock.mockImplementation((path: string) => {
        if (path.endsWith("/.git-credentials")) {
          throw new Error("File not found");
        }
        if (path.endsWith("/.claude/.credentials.json")) {
          return '{"claudeAiOauth": {}}';
        }
        throw new Error(`Unexpected file read: ${path}`);
      });

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleep();

      // Check that spawnCommand was called with empty API key (credentials exist)
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const spawnEnv = spawnCommandLineMock.mock.calls[0]![1].env;
      expect(spawnEnv.ANTHROPIC_API_KEY).toBe("");
    });

    it("should check for credentials on each Claude command", async () => {
      await daemon.start();

      // First command - credentials don't exist
      execSyncMock.mockReturnValue("NOT_EXISTS\n");
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleep();

      // Second command - credentials now exist
      execSyncMock.mockReturnValue("EXISTS\n");
      readFileSyncMock.mockImplementation((path: string) => {
        if (path.endsWith("/.git-credentials")) {
          throw new Error("File not found");
        }
        if (path.endsWith("/.claude/.credentials.json")) {
          return '{"claudeAiOauth": {}}';
        }
        throw new Error(`Unexpected file read: ${path}`);
      });
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify({
          ...TEST_INPUT_MESSAGE,
          prompt: "second prompt",
        }),
      });
      await sleep();

      // Check that first command used env API key and second used empty
      const firstSpawnEnv = spawnCommandLineMock.mock.calls[0]![1].env;
      const secondSpawnEnv = spawnCommandLineMock.mock.calls[1]![1].env;

      expect(firstSpawnEnv.ANTHROPIC_API_KEY).toBe(
        process.env.ANTHROPIC_API_KEY,
      );
      expect(secondSpawnEnv.ANTHROPIC_API_KEY).toBe("");
    });
  });

  describe("Error handling with result messages", () => {
    it("should not send custom-error when Claude sends a result message with is_error: true (rate limit case)", async () => {
      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);

      // Simulate Claude sending a rate limit error result message
      const rateLimitResult = {
        type: "result",
        subtype: "success",
        is_error: true,
        duration_ms: 529,
        duration_api_ms: 0,
        num_turns: 117,
        result: "Claude AI usage limit reached|1752519600",
        session_id: "549ccae5-23cc-4c3d-a7ca-b448b11446e7",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: {
            web_search_requests: 0,
          },
          service_tier: "standard",
        },
      };

      mockSpawnCommandStdoutLine(rateLimitResult);

      // Simulate process exiting with non-zero code
      const onCloseCallback = spawnCommandLineMock.mock.calls[0]![1].onClose;
      onCloseCallback(1);

      // Wait for message flush
      await sleep(20);

      // Should have sent only the result message, not an additional custom-error
      expect(serverPostMock).toHaveBeenCalledTimes(1);
      expect(serverPostMock).toHaveBeenCalledWith(
        {
          messages: [rateLimitResult],
          threadId: "TEST_THREAD_ID_STRING",
          threadChatId: "TEST_THREAD_CHAT_ID_STRING",
          timezone: "America/New_York",
        },
        "TEST_TOKEN_STRING",
      );
    });

    it("should send custom-error when process exits with non-zero code without a result message", async () => {
      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);

      // Simulate some normal Claude output (not a result message)
      mockSpawnCommandStdoutLine({
        role: "assistant",
        content: "Starting to process...",
      });

      // Simulate process exiting with non-zero code (e.g., crash)
      const onCloseCallback = spawnCommandLineMock.mock.calls[0]![1].onClose;
      onCloseCallback(1);

      // Wait for message flush
      await sleep(20);

      // Should have sent both the assistant message and a custom-error
      expect(serverPostMock).toHaveBeenCalledTimes(1);
      const sentMessages = serverPostMock.mock.calls[0]![0].messages;
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0]).toEqual({
        role: "assistant",
        content: "Starting to process...",
      });
      expect(sentMessages[1]).toMatchObject({
        type: "custom-error",
        session_id: null,
        duration_ms: expect.any(Number),
      });
    });

    it("should not send custom-error when process is explicitly stopped", async () => {
      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);

      // Simulate some Claude output
      mockSpawnCommandStdoutLine({
        role: "assistant",
        content: "Processing...",
      });

      // Send stop message
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_STOP_MESSAGE),
      });
      await sleep(20);
      // Simulate process being killed (exit code 1 when killed)
      const onCloseCallback = spawnCommandLineMock.mock.calls[0]![1].onClose;
      onCloseCallback(1);

      // Wait for message flush
      await sleep(20);

      // Should have sent the assistant message and custom-stop, but no custom-error
      expect(serverPostMock).toHaveBeenCalledTimes(1);
      const sentMessages = serverPostMock.mock.calls[0]![0].messages;
      expect(sentMessages).toContainEqual({
        role: "assistant",
        content: "Processing...",
      });
      expect(sentMessages).toContainEqual(
        expect.objectContaining({
          type: "custom-stop",
        }),
      );
      // Should not contain custom-error
      expect(
        sentMessages.find((m: any) => m.type === "custom-error"),
      ).toBeUndefined();
    });
  });

  it("should not send custom-error when old process closes after being superseded", async () => {
    let firstProcessOnClose: ((code: number) => void) | undefined;
    let secondProcessOnClose: ((code: number) => void) | undefined;

    spawnCommandLineMock.mockImplementation((command, handlers) => {
      const processId = spawnCommandLineMock.mock.calls.length;
      // Capture the onClose handlers
      if (processId === 1) {
        firstProcessOnClose = handlers!.onClose;
      } else if (processId === 2) {
        secondProcessOnClose = handlers!.onClose;
      }
      return {
        processId,
        pollInterval: undefined,
      };
    });

    await daemon.start();

    // Start first process
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

    // Start second process - this kills the first one
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({
        ...TEST_INPUT_MESSAGE,
        prompt: "second prompt",
      }),
    });

    // Wait for second process to spawn
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);
    await sleepUntil(() => killChildProcessGroupMock.mock.calls.length === 1);

    // Now the first process finally closes with an error code (because it was killed)
    if (typeof firstProcessOnClose === "function") {
      firstProcessOnClose(1); // Exit code 1 (killed)
    }

    // Wait a bit for any message processing
    await sleep(20);

    // Should NOT have sent a custom-error message for the first process
    // because it was superseded by the second process
    const allMessages = serverPostMock.mock.calls.flatMap(
      (call) => call[0].messages,
    );
    const customErrors = allMessages.filter(
      (msg: any) => msg.type === "custom-error",
    );

    // Should be no custom-error messages since the first process was killed intentionally
    expect(customErrors).toHaveLength(0);

    // Now if the second process crashes, it SHOULD send a custom-error
    if (typeof secondProcessOnClose === "function") {
      secondProcessOnClose(1); // Exit code 1 (crashed)
    }

    await sleep(20);

    // Now there should be exactly one custom-error for the second process
    const allMessagesAfter = serverPostMock.mock.calls.flatMap(
      (call) => call[0].messages,
    );
    const customErrorsAfter = allMessagesAfter.filter(
      (msg: any) => msg.type === "custom-error",
    );

    expect(customErrorsAfter).toHaveLength(1);
  });

  it("should include the Gemini session id in the success result message", async () => {
    await daemon.start();

    const geminiMessage: DaemonMessageClaude = {
      ...TEST_INPUT_MESSAGE,
      agent: "gemini",
      model: "gemini-2.5-pro",
    };

    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(geminiMessage),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

    // Simulate Gemini sending an INIT event with session_id
    const initEvent = {
      type: "init",
      timestamp: new Date().toISOString(),
      session_id: "gemini-session-12345",
      model: "gemini-2.5-pro",
    };
    mockSpawnCommandStdoutLine(initEvent);

    // Simulate a simple message
    const messageEvent = {
      type: "message",
      timestamp: new Date().toISOString(),
      role: "assistant",
      content: "Hello from Gemini",
      delta: false,
    };
    mockSpawnCommandStdoutLine(messageEvent);

    // Simulate success result
    const resultEvent = {
      type: "result",
      timestamp: new Date().toISOString(),
      status: "success",
      stats: {
        total_tokens: 100,
        input_tokens: 50,
        output_tokens: 50,
        duration_ms: 1000,
        tool_calls: 0,
      },
    };
    mockSpawnCommandStdoutLine(resultEvent);

    await sleep(20); // Give time for messages to be buffered and sent
    const lastCall =
      serverPostMock.mock.calls[serverPostMock.mock.calls.length - 1];
    const messages = lastCall?.[0]?.messages ?? [];

    // Find the init message which should have the session_id
    const initMessage = messages.find(
      (msg: any) => msg.type === "system" && msg.subtype === "init",
    );
    expect(initMessage?.session_id).toBe("gemini-session-12345");
  });

  it("should parse and handle Opencode JSON output", async () => {
    await daemon.start();
    const opencodeMessage: DaemonMessageClaude = {
      ...TEST_INPUT_MESSAGE,
      agent: "opencode",
      model: "opencode/grok-code",
    };

    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(opencodeMessage),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

    expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
    const opencodeCommand = spawnCommandLineMock.mock.calls[0]![0];
    expect(
      opencodeCommand.replace(/\/tmp\/.*.txt/, "<txt>"),
    ).toMatchInlineSnapshot(
      `"cat <txt> | opencode run --model terry/grok-code --format json"`,
    );

    // Simulate Opencode sending a step_start event
    const stepStartEvent = {
      type: "step_start",
      timestamp: Date.now(),
      sessionID: "opencode-session-123",
      part: {
        id: "step-1",
        type: "step-start",
        sessionID: "opencode-session-123",
        messageID: "msg-1",
      },
    };
    mockSpawnCommandStdoutLine(stepStartEvent);

    // Simulate Opencode sending a text event
    const textEvent = {
      type: "text",
      timestamp: Date.now(),
      sessionID: "opencode-session-123",
      part: {
        id: "text-1",
        type: "text",
        text: "Hello from Opencode",
        sessionID: "opencode-session-123",
        messageID: "msg-2",
        time: {
          start: Date.now() - 1000,
          end: Date.now(),
        },
      },
    };
    mockSpawnCommandStdoutLine(textEvent);

    // Simulate Opencode sending a tool_use event
    const toolUseEvent = {
      type: "tool_use",
      timestamp: Date.now(),
      sessionID: "opencode-session-123",
      part: {
        id: "tool-1",
        type: "tool",
        tool: "bash",
        callID: "call-123",
        sessionID: "opencode-session-123",
        messageID: "msg-3",
        state: {
          status: "completed",
          input: { command: "echo 'test'" },
          output: "test",
          title: "Execute command",
          metadata: {},
          time: { start: Date.now() - 500, end: Date.now() },
        },
      },
    };
    mockSpawnCommandStdoutLine(toolUseEvent);

    await sleep(20);

    // All messages should be sent to the server
    expect(serverPostMock).toHaveBeenCalled();
    const allMessages = serverPostMock.mock.calls.flatMap(
      (call) => call[0].messages,
    );

    // Should have system (from step_start), assistant (from text and tool_use), and user (from tool_result) messages
    expect(allMessages.some((m: any) => m.type === "system")).toBe(true);
    expect(allMessages.filter((m: any) => m.type === "assistant")).toHaveLength(
      2,
    ); // One from text, one from tool_use
    expect(allMessages.some((m: any) => m.type === "user")).toBe(true); // From tool_result
    expect(allMessages).toHaveLength(4); // system + assistant + assistant + user
  });

  it("should handle Opencode session ID correctly", async () => {
    await daemon.start();

    const opencodeMessage: DaemonMessageClaude = {
      ...TEST_INPUT_MESSAGE,
      agent: "opencode",
      model: "opencode/grok-code",
      sessionId: "existing-session-456",
    };

    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(opencodeMessage),
    });
    await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

    const opencodeCommand = spawnCommandLineMock.mock.calls[0]![0];
    // Should include existing session ID
    expect(opencodeCommand).toContain("--session existing-session-456");
  });

  describe("Multiple process tracking", () => {
    it("should track multiple processes by threadChatId", async () => {
      const process1Pid = 5001;
      const process2Pid = 5002;
      let processCounter = 0;

      spawnCommandLineMock.mockImplementation(() => ({
        processId: processCounter === 0 ? process1Pid : process2Pid,
        pollInterval: undefined,
      }));

      await daemon.start();

      // Start first process
      const message1 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_1",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message1),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      processCounter++;

      // Start second process with different threadChatId
      const message2 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_2",
        prompt: "second prompt",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message2),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);

      // Both processes should be running, neither should have been killed
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(2);
      expect(killChildProcessGroupMock).toHaveBeenCalledTimes(0);
    });

    it("should kill only the corresponding process when stop message is received", async () => {
      const process1Pid = 6001;
      const process2Pid = 6002;
      let processCounter = 0;

      spawnCommandLineMock.mockImplementation(() => ({
        processId: processCounter === 0 ? process1Pid : process2Pid,
        pollInterval: undefined,
      }));

      await daemon.start();

      // Start first process
      const message1 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_1",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message1),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      processCounter++;

      // Start second process
      const message2 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_2",
        prompt: "second prompt",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message2),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);

      expect(spawnCommandLineMock).toHaveBeenCalledTimes(2);
      expect(killChildProcessGroupMock).toHaveBeenCalledTimes(0);

      // Send stop message for first process only
      const stopMessage1 = {
        type: "stop" as const,
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "CHAT_1",
        token: "TEST_TOKEN_STRING",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(stopMessage1),
      });
      await sleepUntil(() => killChildProcessGroupMock.mock.calls.length === 1);

      // Only first process should be killed
      expect(killChildProcessGroupMock).toHaveBeenCalledTimes(1);
      expect(killChildProcessGroupMock).toHaveBeenCalledWith(process1Pid);

      // Second process should still be running
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(2);
    });

    it("should flush buffered messages per thread when multiple processes emit output", async () => {
      await daemon.start();

      const message1 = {
        ...TEST_INPUT_MESSAGE,
        threadId: "TEST_THREAD_ID_ONE",
        threadChatId: "CHAT_1",
        token: "TOKEN_ONE",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message1),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);

      const message2 = {
        ...TEST_INPUT_MESSAGE,
        threadId: "TEST_THREAD_ID_TWO",
        threadChatId: "CHAT_2",
        token: "TOKEN_TWO",
        prompt: "second prompt",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message2),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);

      const chat1Output = { role: "assistant", content: "CHAT_1_OUTPUT" };
      const chat2Output = { role: "assistant", content: "CHAT_2_OUTPUT" };

      const chat1Stdout =
        spawnCommandLineMock.mock.calls[0]![1].onStdoutLine ?? null;
      const chat2Stdout =
        spawnCommandLineMock.mock.calls[1]![1].onStdoutLine ?? null;

      expect(chat1Stdout).toBeTypeOf("function");
      expect(chat2Stdout).toBeTypeOf("function");

      chat1Stdout?.(JSON.stringify(chat1Output));
      chat2Stdout?.(JSON.stringify(chat2Output));

      await sleepUntil(() => serverPostMock.mock.calls.length > 0);
      await sleep(50);

      expect(serverPostMock).toHaveBeenCalledTimes(2);

      const firstCall = serverPostMock.mock.calls[0]!;
      const secondCall = serverPostMock.mock.calls[1]!;

      expect(firstCall[1]).toBe("TOKEN_ONE");
      expect(secondCall[1]).toBe("TOKEN_TWO");

      expect(firstCall[0]).toMatchObject({
        threadId: "TEST_THREAD_ID_ONE",
        threadChatId: "CHAT_1",
      });
      expect(secondCall[0]).toMatchObject({
        threadId: "TEST_THREAD_ID_TWO",
        threadChatId: "CHAT_2",
      });

      expect(firstCall[0].messages).toHaveLength(1);
      expect(firstCall[0].messages[0]).toMatchObject(chat1Output);

      expect(secondCall[0].messages).toHaveLength(1);
      expect(secondCall[0].messages[0]).toMatchObject(chat2Output);
    });

    it("should replace a process when a new message with same threadChatId is received", async () => {
      const process1Pid = 7001;
      const process2Pid = 7002;
      let processCounter = 0;

      spawnCommandLineMock.mockImplementation(() => ({
        processId: processCounter === 0 ? process1Pid : process2Pid,
        pollInterval: undefined,
      }));

      await daemon.start();

      // Start first process
      const message1 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_1",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message1),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      processCounter++;

      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      expect(killChildProcessGroupMock).toHaveBeenCalledTimes(0);

      // Start another process with the same threadChatId
      const message2 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_1",
        prompt: "second prompt for same chat",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message2),
      });
      await sleepUntil(() => killChildProcessGroupMock.mock.calls.length === 1);

      // First process should be killed and second should start
      expect(killChildProcessGroupMock).toHaveBeenCalledTimes(1);
      expect(killChildProcessGroupMock).toHaveBeenCalledWith(process1Pid);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(2);
    });

    it("should send custom-stop message only for the stopped process", async () => {
      const process1Pid = 8001;
      const process2Pid = 8002;
      let processCounter = 0;

      spawnCommandLineMock.mockImplementation(() => ({
        processId: processCounter === 0 ? process1Pid : process2Pid,
        pollInterval: undefined,
      }));

      await daemon.start();

      // Start first process
      const message1 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_1",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message1),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      processCounter++;

      // Start second process
      const message2 = {
        ...TEST_INPUT_MESSAGE,
        threadChatId: "CHAT_2",
        prompt: "second prompt",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message2),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);

      serverPostMock.mockClear();

      // Send stop message for first process
      const stopMessage1 = {
        type: "stop" as const,
        threadId: "TEST_THREAD_ID_STRING",
        threadChatId: "CHAT_1",
        token: "TEST_TOKEN_STRING",
      };
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(stopMessage1),
      });
      await sleepUntil(() => serverPostMock.mock.calls.length > 0);

      // Should send custom-stop message for CHAT_1
      expect(serverPostMock).toHaveBeenCalled();
      const sentMessages = serverPostMock.mock.calls.flatMap(
        (call) => call[0].messages,
      );
      const customStopMessages = sentMessages.filter(
        (msg: any) => msg.type === "custom-stop",
      );
      expect(customStopMessages).toHaveLength(1);

      // Verify the custom-stop is for the correct threadChatId
      const lastCall =
        serverPostMock.mock.calls[serverPostMock.mock.calls.length - 1];
      expect(lastCall?.[0]?.threadChatId).toBe("CHAT_1");
    });
  });

  describe("permission mode handling", () => {
    it("should use --permission-mode plan flag when permissionMode is plan", async () => {
      const planModeMessage: DaemonMessageClaude = {
        ...TEST_INPUT_MESSAGE,
        permissionMode: "plan",
      };

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(planModeMessage),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const claudeCommand = spawnCommandLineMock.mock.calls[0]![0];

      // Should include --permission-mode plan
      expect(claudeCommand).toContain("--permission-mode plan");
      // Should include --allowedTools for WebSearch and WebFetch
      expect(claudeCommand).toContain("--allowedTools");
      expect(claudeCommand).toContain("WebSearch");
      expect(claudeCommand).toContain("WebFetch");
      // Should NOT include --dangerously-skip-permissions
      expect(claudeCommand).not.toContain("--dangerously-skip-permissions");
    });

    it("should use --dangerously-skip-permissions when permissionMode is allowAll", async () => {
      const allowAllMessage: DaemonMessageClaude = {
        ...TEST_INPUT_MESSAGE,
        permissionMode: "allowAll",
      };

      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(allowAllMessage),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const claudeCommand = spawnCommandLineMock.mock.calls[0]![0];

      // Should include --dangerously-skip-permissions
      expect(claudeCommand).toContain("--dangerously-skip-permissions");
      // Should NOT include --permission-mode
      expect(claudeCommand).not.toContain("--permission-mode");
    });

    it("should default to --dangerously-skip-permissions when permissionMode is not specified", async () => {
      // TEST_INPUT_MESSAGE doesn't have permissionMode field
      await daemon.start();
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(TEST_INPUT_MESSAGE),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      const claudeCommand = spawnCommandLineMock.mock.calls[0]![0];

      // Should include --dangerously-skip-permissions (default behavior)
      expect(claudeCommand).toContain("--dangerously-skip-permissions");
      // Should NOT include --permission-mode
      expect(claudeCommand).not.toContain("--permission-mode");
    });

    it("should handle permission mode changes between messages", async () => {
      const planMessage: DaemonMessageClaude = {
        ...TEST_INPUT_MESSAGE,
        permissionMode: "plan",
        threadId: "THREAD_1",
      };

      const allowAllMessage: DaemonMessageClaude = {
        ...TEST_INPUT_MESSAGE,
        permissionMode: "allowAll",
        threadId: "THREAD_2",
      };

      await daemon.start();

      // First message with plan mode
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(planMessage),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 1);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(1);
      let claudeCommand = spawnCommandLineMock.mock.calls[0]![0];
      expect(claudeCommand).toContain("--permission-mode plan");
      expect(claudeCommand).toContain("--allowedTools");
      expect(claudeCommand).toContain("WebSearch");
      expect(claudeCommand).toContain("WebFetch");
      expect(claudeCommand).not.toContain("--dangerously-skip-permissions");

      // Second message with allowAll mode
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(allowAllMessage),
      });
      await sleepUntil(() => spawnCommandLineMock.mock.calls.length === 2);
      expect(spawnCommandLineMock).toHaveBeenCalledTimes(2);
      claudeCommand = spawnCommandLineMock.mock.calls[1]![0];
      expect(claudeCommand).toContain("--dangerously-skip-permissions");
      expect(claudeCommand).not.toContain("--permission-mode");
    });
  });
});
