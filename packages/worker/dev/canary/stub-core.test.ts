import { describe, expect, it } from "vitest";

import {
  createStubHandler,
  createThreadStore,
  makeScrubber,
  nextStatusForEvent,
  type StubRequest,
  type StubResponse,
} from "./stub-core";
import type { CanaryThreadSpec } from "./thread-spec";

const TOKEN = "daemon-token-0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "daemon-token-ffffffffffffffffffffffffffffffff";
const API_KEY = "sk-ant-canary-test-key-0123456789";
const SETUP_TOKEN = "sk-ant-oat01-canary-test-token-0123456789";

function spec(over: Partial<CanaryThreadSpec> = {}): CanaryThreadSpec {
  return {
    version: 1,
    threadId: "thread-1",
    threadChatId: "chat-1",
    daemonToken: TOKEN,
    lane: "task",
    repoFullName: "be-automata/automata-container-canary",
    createdAt: "2026-10-23T10:00:00.000Z",
    message: {
      type: "claude",
      model: "sonnet",
      agent: "claudeCode",
      agentVersion: 1,
      prompt: "say hi",
      sessionId: null,
      permissionMode: "allowAll",
      featureFlags: {},
    },
    ...over,
  };
}

function harness(specs: CanaryThreadSpec[]) {
  const records: Record<string, unknown>[] = [];
  const store = createThreadStore(() => specs);
  const handle = createStubHandler({
    store,
    readAnthropicKey: () => API_KEY,
    record: (e) => records.push(e),
  });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { "x-daemon-token": TOKEN },
  ): StubResponse =>
    handle({
      method: "POST",
      path,
      headers,
      body: JSON.stringify(body),
    } satisfies StubRequest);
  const ids = { threadId: "thread-1", threadChatId: "chat-1" };
  return { records, store, handle, post, ids };
}

describe("canary stub: daemon-token check", () => {
  // card: protects=every daemon route refuses a request without the run's X-Daemon-Token (401, as www); fails_when=a missing or foreign token reaches a handler; no_claim=better-auth's real verification
  it("answers 401 for a missing or unknown token on every daemon route", () => {
    const { post, ids } = harness([spec()]);
    for (const path of [
      "/api/daemon/next-message",
      "/api/daemon/agent-credentials",
      "/api/daemon-event",
      "/api/daemon/thread-status",
      "/api/daemon/run-terminal",
      "/api/daemon/run-staleness",
      "/api/daemon/egress-event",
      "/api/daemon/run-credential-source",
    ]) {
      expect(post(path, ids, {}).status).toBe(401);
      expect(post(path, ids, { "x-daemon-token": OTHER_TOKEN }).status).toBe(
        401,
      );
    }
  });

  // card: protects=F2 — a token is bound to its own thread and threadChat; fails_when=a valid token can read or write another thread; no_claim=the org/owner checks www adds
  it("refuses a valid token naming another thread (403) or no ids (400)", () => {
    const { post } = harness([
      spec(),
      spec({
        threadId: "thread-2",
        threadChatId: "chat-2",
        daemonToken: OTHER_TOKEN,
      }),
    ]);
    expect(
      post("/api/daemon/next-message", {
        threadId: "thread-2",
        threadChatId: "chat-2",
      }).status,
    ).toBe(403);
    expect(
      post("/api/daemon/next-message", {
        threadId: "thread-1",
        threadChatId: "chat-2",
      }).status,
    ).toBe(403);
    expect(post("/api/daemon/next-message", {}).status).toBe(400);
  });

  // card: protects=the agent credential is the owner-mode API-key json-file shape www returns; fails_when=the shape drifts so the worker would materialise nothing or the daemon would not find anthropicApiKey; no_claim=www's credential decryption
  it("serves the API key as www's claudeCode json-file credential", () => {
    const { post, ids, records } = harness([spec()]);
    const res = post("/api/daemon/agent-credentials", ids);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      agent: "claudeCode",
      credentials: {
        type: "json-file",
        contents: JSON.stringify({ anthropicApiKey: API_KEY }),
      },
    });
    expect(JSON.stringify(records)).not.toContain(API_KEY);
  });

  // card: protects=a subscription setup-token is served in www's claudeAiOauth shape, not as an API key; fails_when=the CLI gets the token as anthropicApiKey and every model call 401s; no_claim=the token's validity
  it("serves a setup-token as www's claudeAiOauth json-file credential", () => {
    const records: Record<string, unknown>[] = [];
    const at = new Date("2026-10-25T00:00:00Z");
    const handle = createStubHandler({
      store: createThreadStore(() => [spec()]),
      readAnthropicKey: () => SETUP_TOKEN,
      record: (e) => records.push(e),
      now: () => at,
    });
    const res = handle({
      method: "POST",
      path: "/api/daemon/agent-credentials",
      headers: { "x-daemon-token": TOKEN },
      body: JSON.stringify({ threadId: "thread-1", threadChatId: "chat-1" }),
    });
    expect(res.status).toBe(200);
    const body = res.json as { credentials: { contents: string } };
    expect(JSON.parse(body.credentials.contents)).toEqual({
      claudeAiOauth: {
        accessToken: SETUP_TOKEN,
        refreshToken: "",
        expiresAt: at.getTime() + 365 * 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: null,
      },
    });
    expect(JSON.stringify(records)).not.toContain(SETUP_TOKEN);
  });
});

describe("canary stub: thread state machine", () => {
  // card: protects=queued → working on the first event → complete on a result, and thread-status ends the worker's poll; fails_when=the worker's poll never sees terminal=true or sees it early; no_claim=www's checkpoint/PR side effects
  it("moves queued → working → complete and reports terminal", () => {
    const { post, ids } = harness([spec()]);
    expect(post("/api/daemon/thread-status", ids).json).toEqual({
      status: "queued",
      terminal: false,
    });
    expect(post("/api/daemon/next-message", ids).status).toBe(200);
    post("/api/daemon-event", {
      ...ids,
      timezone: "UTC",
      messages: [{ type: "system", subtype: "init" }],
    });
    expect(post("/api/daemon/thread-status", ids).json).toEqual({
      status: "working",
      terminal: false,
    });
    post("/api/daemon-event", {
      ...ids,
      timezone: "UTC",
      messages: [
        { type: "result", subtype: "success", is_error: false, result: "done" },
      ],
    });
    expect(post("/api/daemon/thread-status", ids).json).toEqual({
      status: "complete",
      terminal: true,
    });
  });

  // card: protects=revoke-on-terminal-READ (ADR-003 F3): the token dies only after terminal=true was served; fails_when=the token dies before the read (worker would fail a finished run) or never (a post-terminal write would be accepted); no_claim=the 1-day expiry backstop
  it("revokes the token right after serving terminal=true", () => {
    const { post, ids } = harness([spec()]);
    post("/api/daemon-event", {
      ...ids,
      messages: [{ type: "custom-error", error_info: "boom" }],
    });
    expect(post("/api/daemon/thread-status", ids).json).toEqual({
      status: "error",
      terminal: true,
    });
    expect(post("/api/daemon/thread-status", ids).status).toBe(401);
    expect(post("/api/daemon/next-message", ids).status).toBe(401);
  });

  // card: protects=www's daemon-event status reduction (stop > error > done > working; terminal is sticky); fails_when=an error result reads as complete or a late event reopens a finished thread; no_claim=rate-limit/overload retries www layers on top
  it("reduces event batches like handleDaemonEvent", () => {
    expect(nextStatusForEvent("queued", [{ type: "assistant" }])).toBe(
      "working",
    );
    expect(
      nextStatusForEvent("working", [{ type: "result", is_error: true }]),
    ).toBe("error");
    expect(
      nextStatusForEvent("working", [{ type: "result", is_error: false }]),
    ).toBe("complete");
    expect(nextStatusForEvent("working", [{ type: "custom-stop" }])).toBe(
      "stopped",
    );
    expect(nextStatusForEvent("complete", [{ type: "assistant" }])).toBe(
      "complete",
    );
  });

  // card: protects=the typed run-terminal is applied once (markThreadTerminal from a non-terminal status) and fenced by generation; fails_when=a retry double-applies or a superseded run rewrites the thread; no_claim=hatchet_run retirement and recheck
  it("applies run-terminal once and refuses a foreign generation (409)", () => {
    const { post, ids } = harness([spec({ activeRunExternalId: "run-A" })]);
    expect(
      post("/api/daemon/run-terminal", {
        ...ids,
        runExternalId: "run-B",
        cause: "timeout",
      }).status,
    ).toBe(409);
    expect(
      post("/api/daemon/run-terminal", {
        ...ids,
        runExternalId: "run-A",
        cause: "timeout",
      }).json,
    ).toEqual({ applied: true });
    expect(
      post("/api/daemon/run-terminal", {
        ...ids,
        runExternalId: "run-A",
        cause: "timeout",
      }).json,
    ).toEqual({ applied: false });
    expect(
      post("/api/daemon/run-terminal", {
        ...ids,
        runExternalId: "run-A",
        cause: "nope",
      }).status,
    ).toBe(400);
  });

  // card: protects=next-message serves the dispatched message while live and 204 once terminal (www's "nothing to send"); fails_when=a finished thread hands the worker a prompt again; no_claim=compaction/session resume
  it("serves next-message until terminal, then 204", () => {
    const { post, ids } = harness([spec()]);
    expect(post("/api/daemon/next-message", ids).json).toMatchObject({
      type: "claude",
      prompt: "say hi",
      permissionMode: "allowAll",
    });
    post("/api/daemon-event", {
      ...ids,
      messages: [{ type: "result", is_error: false }],
    });
    expect(post("/api/daemon/next-message", ids).status).toBe(204);
  });

  // card: protects=the evidence log keeps the agent's final result (the review verdict block) and never a daemon token; fails_when=the verdict is missing from the log or a secret lands in it; no_claim=posting the GitHub review (www code ADR-013 does not change)
  it("records the result message and scrubs known secrets", () => {
    const { post, ids, records } = harness([spec({ lane: "review" })]);
    post("/api/daemon-event", {
      ...ids,
      messages: [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: `verdict block ${TOKEN}`,
        },
      ],
    });
    const result = records.find((r) => r.kind === "agent-result");
    expect(result).toMatchObject({ lane: "review", type: "result" });
    const scrub = makeScrubber(() => [TOKEN, API_KEY]);
    const line = scrub(JSON.stringify(records));
    expect(line).not.toContain(TOKEN);
    expect(line).toContain("verdict block <redacted>");
  });

  // card: protects=the staleness self-check answers stale only for a NEWER dispatch on the same PR key; fails_when=an older or unrelated run makes a live review skip itself; no_claim=www's hatchet_run table
  it("reports staleness only when a newer run shares the PR key", () => {
    const older = spec({ lane: "review", prKey: "o/r/1" });
    const newer = spec({
      lane: "review",
      prKey: "o/r/1",
      threadId: "thread-2",
      threadChatId: "chat-2",
      daemonToken: OTHER_TOKEN,
      createdAt: "2026-10-23T11:00:00.000Z",
    });
    const { post, ids } = harness([older, newer]);
    expect(
      post("/api/daemon/run-staleness", { ...ids, runExternalId: "x" }).json,
    ).toEqual({ stale: true });
    expect(
      post(
        "/api/daemon/run-staleness",
        { threadId: "thread-2", threadChatId: "chat-2", runExternalId: "y" },
        { "x-daemon-token": OTHER_TOKEN },
      ).json,
    ).toEqual({ stale: false });
  });

  // card: protects=the credits proxy is never silently served (the canary needs WORKER_BOX_TRUST=owner); fails_when=a credits-mode run's model calls get a misleading answer; no_claim=www's real /api/proxy/anthropic
  it("answers 501 on the model proxy path and 404 elsewhere", () => {
    const { handle } = harness([spec()]);
    expect(
      handle({
        method: "POST",
        path: "/api/proxy/anthropic/v1/messages",
        headers: {},
        body: "",
      }).status,
    ).toBe(501);
    expect(
      handle({ method: "POST", path: "/api/nope", headers: {}, body: "" })
        .status,
    ).toBe(404);
  });
});
