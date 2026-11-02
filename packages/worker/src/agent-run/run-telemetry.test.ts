import { describe, expect, it } from "vitest";

import {
  parseRunOtlpUrl,
  parseRunTelemetryConfig,
  parseToolFailureStreakLimit,
  runTelemetrySettingsEnv,
} from "./run-telemetry";

describe("parseRunOtlpUrl", () => {
  it("unset or blank is off", () => {
    expect(parseRunOtlpUrl(undefined)).toBeNull();
    expect(parseRunOtlpUrl("  ")).toBeNull();
  });

  it("accepts a plain-HTTP loopback URL with a port, normalized", () => {
    expect(parseRunOtlpUrl("http://127.0.0.1:4320")).toBe(
      "http://127.0.0.1:4320",
    );
    expect(parseRunOtlpUrl("http://localhost:4320/")).toBe(
      "http://localhost:4320",
    );
    expect(parseRunOtlpUrl("http://[::1]:4320")).toBe("http://[::1]:4320");
  });

  it.each([
    "https://127.0.0.1:4320",
    "http://collector.example.com:4320",
    "http://10.0.0.5:4320",
    "http://127.0.0.1",
    "http://user:pw@127.0.0.1:4320",
    "http://127.0.0.1:4320/v1/logs",
    "http://127.0.0.1:4320?x=1",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(() => parseRunOtlpUrl(raw)).toThrow(/WORKER_RUN_OTLP_URL/);
  });
});

describe("parseToolFailureStreakLimit", () => {
  it("unset or 0 is observe only", () => {
    expect(parseToolFailureStreakLimit(undefined)).toBe(0);
    expect(parseToolFailureStreakLimit("0")).toBe(0);
  });

  it("accepts 3..100", () => {
    expect(parseToolFailureStreakLimit("3")).toBe(3);
    expect(parseToolFailureStreakLimit(" 12 ")).toBe(12);
    expect(parseToolFailureStreakLimit("100")).toBe(100);
  });

  it.each(["1", "2", "101", "-5", "8.5", "eight"])("refuses %s", (raw) => {
    expect(() => parseToolFailureStreakLimit(raw)).toThrow(
      /WORKER_TOOL_FAILURE_STREAK_LIMIT/,
    );
  });
});

describe("parseRunTelemetryConfig", () => {
  it("reads both box keys", () => {
    expect(
      parseRunTelemetryConfig({
        WORKER_RUN_OTLP_URL: "http://127.0.0.1:4320",
        WORKER_TOOL_FAILURE_STREAK_LIMIT: "8",
      }),
    ).toEqual({ otlpUrl: "http://127.0.0.1:4320", toolFailureStreakLimit: 8 });
    expect(parseRunTelemetryConfig({})).toEqual({
      otlpUrl: null,
      toolFailureStreakLimit: 0,
    });
  });
});

describe("runTelemetrySettingsEnv", () => {
  const identity = {
    lane: "review",
    orgId: "u:a,b=c",
    threadId: "thr_1",
    threadChatId: "chat_1",
  };

  it("pins prompts and tool details off and points at the in-container bridge", () => {
    const env = runTelemetrySettingsEnv(identity);
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("0");
    expect(env.OTEL_LOG_TOOL_DETAILS).toBe("0");
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:4318");
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe("");
    expect(env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID).toBe("false");
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  });

  it("a review's shared placeholder chat id falls back to the thread id (seen live: every review run was 'legacy-thread-chat-id')", () => {
    expect(
      runTelemetrySettingsEnv({
        ...identity,
        threadChatId: "legacy-thread-chat-id",
      }).OTEL_RESOURCE_ATTRIBUTES,
    ).toMatch(/^automata\.run_id=thr_1,/);
    expect(
      runTelemetrySettingsEnv({ ...identity, threadChatId: "" })
        .OTEL_RESOURCE_ATTRIBUTES,
    ).toMatch(/^automata\.run_id=thr_1,/);
  });

  it("percent-encodes resource attribute values so separators cannot inject keys", () => {
    expect(runTelemetrySettingsEnv(identity).OTEL_RESOURCE_ATTRIBUTES).toBe(
      "automata.run_id=chat_1,automata.thread_id=thr_1,automata.lane=review,automata.org=u%3Aa%2Cb%3Dc",
    );
  });
});
