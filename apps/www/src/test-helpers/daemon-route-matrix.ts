import { createRouterClient, ORPCError } from "@orpc/server";
import { NextRequest } from "next/server";
import { vi } from "vitest";

import { POST as agentCredentials } from "@/app/api/daemon/agent-credentials/route";
import { POST as cellCheckpoint } from "@/app/api/daemon/cell-checkpoint/route";
import { POST as cellPlan } from "@/app/api/daemon/cell-plan/route";
import { POST as egressEvent } from "@/app/api/daemon/egress-event/route";
import { POST as runCredentialSource } from "@/app/api/daemon/run-credential-source/route";
import { POST as runStaleness } from "@/app/api/daemon/run-staleness/route";
import { POST as nextMessage } from "@/app/api/daemon/next-message/route";
import { POST as runTerminal } from "@/app/api/daemon/run-terminal/route";
import { POST as threadStatus } from "@/app/api/daemon/thread-status/route";
import { POST as daemonEvent } from "@/app/api/daemon-event/route";
import { GET as broadcast } from "@/app/api/internal/broadcast/route";
import { POST as broadcastSandboxEnv } from "@/app/api/internal/broadcast/sandbox/env/route";
import { POST as broadcastSandboxKeepalive } from "@/app/api/internal/broadcast/sandbox/keepalive/route";
import { POST as anthropicProxy } from "@/app/api/proxy/anthropic/[[...path]]/route";
import { POST as googleProxy } from "@/app/api/proxy/google/[[...path]]/route";
import { POST as openaiProxy } from "@/app/api/proxy/openai/[[...path]]/route";
import { POST as openrouterProxy } from "@/app/api/proxy/openrouter/[[...path]]/route";
import { cliRouter } from "@/server/orpc/cli-router";

/**
 * Every route that verifies an X-Daemon-Token, called the way a real client
 * would, for the DB-backed "this token class is refused everywhere" matrices
 * (retired tokens, #656 PR-D; a cell's event-scoped token, #693). Real auth:
 * the caller's test file must not mock `@/lib/auth-server`. It must mock what
 * leaves the process (see retired-daemon-token.integration.test.ts).
 */
export interface Outcome {
  status: number;
  body: string;
}

export interface DaemonRouteCase {
  name: string;
  call: (token: string) => Promise<Outcome>;
  /** The live token's answer is itself not 401 (else the log reason is the control). */
  liveIsNot401: boolean;
}

export async function outcomeOf(res: Response): Promise<Outcome> {
  return { status: res.status, body: await res.text() };
}

export function jsonRequest(
  url: string,
  token: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "X-Daemon-Token": token,
      "content-type": "application/json",
      ...extraHeaders,
    },
  });
}

/** Whether verifyDaemonApiKey logged this refusal reason (spy on console.log). */
export function refusedFor(
  logSpy: { mock: { calls: unknown[][] } },
  reason: string,
): boolean {
  return logSpy.mock.calls.some(
    (call) =>
      call[0] === "Unauthorized" && call[1] === "reason" && call[2] === reason,
  );
}

/**
 * The matrix. `ids` is read at call time (the test's beforeEach sets them).
 * Each daemon body names a foreign threadChat, so a live token is refused
 * AFTER auth (403) and never mutates anything.
 */
export function daemonRouteMatrix(
  ids: () => { userId: string; threadId: string },
): DaemonRouteCase[] {
  const foreignChat = () => ({
    threadId: ids().threadId,
    threadChatId: "tc_other",
  });
  const daemonPost = (
    name: string,
    post: (request: NextRequest) => Promise<Response>,
    path: string,
    body: () => unknown = foreignChat,
  ): DaemonRouteCase => ({
    name,
    liveIsNot401: true,
    call: async (token) =>
      outcomeOf(
        await post(jsonRequest(`http://localhost${path}`, token, body())),
      ),
  });

  const daemonRoutes: DaemonRouteCase[] = [
    daemonPost(
      "daemon-event (ordinary batch)",
      daemonEvent as (r: NextRequest) => Promise<Response>,
      "/api/daemon-event",
      () => ({ messages: [], ...foreignChat() }),
    ),
    daemonPost("next-message", nextMessage, "/api/daemon/next-message"),
    daemonPost(
      "agent-credentials",
      agentCredentials,
      "/api/daemon/agent-credentials",
    ),
    // No cause: refused by the body schema after auth.
    daemonPost("run-terminal", runTerminal, "/api/daemon/run-terminal"),
    daemonPost("egress-event", egressEvent, "/api/daemon/egress-event"),
    daemonPost("run-staleness", runStaleness, "/api/daemon/run-staleness"),
    daemonPost(
      "run-credential-source",
      runCredentialSource,
      "/api/daemon/run-credential-source",
    ),
    daemonPost("thread-status", threadStatus, "/api/daemon/thread-status"),
    daemonPost("cell-plan", cellPlan, "/api/daemon/cell-plan"),
    daemonPost(
      "cell-checkpoint",
      cellCheckpoint,
      "/api/daemon/cell-checkpoint",
    ),
    {
      name: "internal/broadcast",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await broadcast(
            new Request(
              `http://localhost/api/internal/broadcast?channel=user:${ids().userId}`,
              { headers: { "X-Daemon-Token": token } },
            ),
          ),
        ),
    },
    {
      // A live token reaches the thread lookup, which answers 401 for an
      // unknown thread too, so the log reason is this route's control.
      ...daemonPost(
        "internal/broadcast/sandbox/env",
        broadcastSandboxEnv,
        "/api/internal/broadcast/sandbox/env",
        () => ({ threadId: "no-such-thread", sandboxId: "sbx" }),
      ),
      liveIsNot401: false,
    },
    {
      ...daemonPost(
        "internal/broadcast/sandbox/keepalive",
        broadcastSandboxKeepalive,
        "/api/internal/broadcast/sandbox/keepalive",
        () => ({ threadId: "no-such-thread", sandboxId: "sbx" }),
      ),
      liveIsNot401: false,
    },
  ];

  // Promise-shaped params satisfy every proxy at runtime (they all `await` it).
  const proxyArgs = { params: Promise.resolve({ path: ["v1", "messages"] }) };
  const proxies: {
    name: string;
    post: (request: NextRequest, args: never) => Promise<Response>;
  }[] = [
    { name: "anthropic proxy", post: anthropicProxy },
    { name: "google proxy", post: googleProxy },
    { name: "openai proxy", post: openaiProxy },
    { name: "openrouter proxy", post: openrouterProxy },
  ];
  const proxyRoutes: DaemonRouteCase[] = proxies.map((p) => ({
    name: p.name,
    liveIsNot401: true,
    call: async (token: string): Promise<Outcome> => {
      // The upstream call is stubbed: nothing leaves the process.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      );
      return outcomeOf(
        await p.post(
          jsonRequest(
            `http://localhost/api/proxy/${p.name.split(" ")[0]}/v1/messages`,
            token,
            {},
          ),
          proxyArgs as never,
        ),
      );
    },
  }));

  const cliRoute: DaemonRouteCase = {
    // A live daemon token is already refused by F1, so its control is the log
    // reason: "not reached past auth" versus "401 from verify".
    name: "cli-router",
    liveIsNot401: false,
    call: async (token: string): Promise<Outcome> => {
      const client = createRouterClient(cliRouter, {
        context: {
          headers: new Headers({ "X-Daemon-Token": token }),
        },
      });
      const error = await client.auth.whoami().catch((e: unknown) => e);
      if (!(error instanceof ORPCError)) {
        return { status: 200, body: JSON.stringify(error) };
      }
      return { status: error.status, body: error.code };
    },
  };

  return [...daemonRoutes, ...proxyRoutes, cliRoute];
}
