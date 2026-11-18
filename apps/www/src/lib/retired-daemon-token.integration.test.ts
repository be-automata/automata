import { createRouterClient, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as agentCredentials } from "@/app/api/daemon/agent-credentials/route";
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
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  mintDaemonToken,
  retireDaemonTokenById,
  daemonRunKey,
} from "@/lib/daemon-token";
import { cliRouter } from "@/server/orpc/cli-router";
import { mockLoggedOutUser, mockWaitUntil } from "@/test-helpers/mock-next";
import {
  apikey as apikeyTable,
  thread as threadTable,
  threadChat as threadChatTable,
} from "@terragon/shared/db/schema";
import { createOrganization } from "@terragon/shared/model/organizations";
import { setThreadActiveRun } from "@terragon/shared/model/threads";
import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { and } from "drizzle-orm";

// Real auth, real database. Nothing between the route and `verifyDaemonApiKey`
// is mocked: the route tests mock `@/lib/auth-server` file-wide, so they cannot
// prove that a retired token is refused. Only the daemon-event side effects
// that leave the process are stubbed, as generation-fence.integration.test.ts
// does.
// The google and openrouter proxies answer 503 before auth when their upstream
// key is unset, so a fake key makes the request reach verifyDaemonApiKey.
vi.mock("@terragon/env/apps-www", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@terragon/env/apps-www");
  const overrides: Record<string, string> = {
    GOOGLE_AI_STUDIO_API_KEY: "fake-google-upstream-key",
    OPENROUTER_API_KEY: "fake-openrouter-upstream-key",
  };
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop, receiver) =>
        typeof prop === "string" && prop in overrides
          ? overrides[prop]
          : Reflect.get(target, prop, receiver),
    }),
  };
});
vi.mock("@/server-lib/checkpoint-thread", () => ({
  checkpointThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@terragon/sandbox", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, extendSandboxLife: vi.fn().mockResolvedValue(undefined) };
});

interface Outcome {
  status: number;
  body: string;
}

async function outcomeOf(res: Response): Promise<Outcome> {
  return { status: res.status, body: await res.text() };
}

describe("a retired daemon token is refused everywhere but cell-teardown", () => {
  let userId: string;
  let sessionToken: string;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;
  let retiredToken: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  async function mintLive(): Promise<string> {
    return mintDaemonToken({
      userId,
      threadId,
      threadChatId,
      name: daemonRunKey({ threadId, threadChatId }),
    });
  }

  async function mintRetired(): Promise<string> {
    // Production mints with name = runKey exactly (the plugin caps names at 64),
    // then the terminal read retires it by a direct rename, which frees the name
    // for the follow-up run's live token.
    const name = daemonRunKey({ threadId, threadChatId });
    const token = await mintDaemonToken({
      userId,
      threadId,
      threadChatId,
      name,
    });
    const [row] = await db
      .select({ id: apikeyTable.id })
      .from(apikeyTable)
      .where(
        and(eq(apikeyTable.referenceId, userId), eq(apikeyTable.name, name)),
      );
    if (!row) throw new Error("minted token not found");
    expect(await retireDaemonTokenById({ userId, apiKeyId: row.id })).toBe(
      true,
    );
    return token;
  }

  /** Whether verifyDaemonApiKey refused a retired token since the last clear. */
  function refusedAsRetired(): boolean {
    return logSpy.mock.calls.some(
      (call: unknown[]) =>
        call[0] === "Unauthorized" &&
        call[1] === "reason" &&
        call[2] === "retired token",
    );
  }

  beforeEach(async () => {
    await mockWaitUntil();
    // The internal broadcast routes fall back to the session, which reads
    // next/headers: a logged-out request scope, as in production with no cookie.
    await mockLoggedOutUser();
    const created = await createTestUser({ db });
    userId = created.user.id;
    sessionToken = created.session.token;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
    const t = await createTestThread({
      db,
      userId,
      overrides: { organizationId: orgId },
      chatOverrides: { status: "working" },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    retiredToken = await mintRetired();
    logSpy = vi.spyOn(console, "log");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function jsonRequest(
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

  /**
   * A body the route refuses AFTER auth (a foreign threadChatId: 403) so a live
   * token's control never mutates anything.
   */
  const foreignChat = () => ({ threadId, threadChatId: "tc_other" });

  const daemonRoutes: {
    name: string;
    call: (token: string) => Promise<Outcome>;
    /** The live token's answer is itself not 401 (else the log reason is the control). */
    liveIsNot401: boolean;
  }[] = [
    {
      name: "daemon-event (ordinary batch)",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await daemonEvent(
            jsonRequest("http://localhost/api/daemon-event", token, {
              messages: [],
              ...foreignChat(),
            }),
          ),
        ),
    },
    {
      name: "next-message",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await nextMessage(
            jsonRequest(
              "http://localhost/api/daemon/next-message",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "agent-credentials",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await agentCredentials(
            jsonRequest(
              "http://localhost/api/daemon/agent-credentials",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "run-terminal",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await runTerminal(
            // No cause: refused by the body schema after auth.
            jsonRequest(
              "http://localhost/api/daemon/run-terminal",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "egress-event",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await egressEvent(
            jsonRequest(
              "http://localhost/api/daemon/egress-event",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "run-staleness",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await runStaleness(
            jsonRequest(
              "http://localhost/api/daemon/run-staleness",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "run-credential-source",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await runCredentialSource(
            jsonRequest(
              "http://localhost/api/daemon/run-credential-source",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "thread-status",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await threadStatus(
            jsonRequest(
              "http://localhost/api/daemon/thread-status",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "cell-plan",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await cellPlan(
            jsonRequest(
              "http://localhost/api/daemon/cell-plan",
              token,
              foreignChat(),
            ),
          ),
        ),
    },
    {
      name: "internal/broadcast",
      liveIsNot401: true,
      call: async (token) =>
        outcomeOf(
          await broadcast(
            new Request(
              `http://localhost/api/internal/broadcast?channel=user:${userId}`,
              { headers: { "X-Daemon-Token": token } },
            ),
          ),
        ),
    },
    {
      // A live token reaches the thread lookup, which answers 401 for an
      // unknown thread too, so the log reason is this route's control.
      name: "internal/broadcast/sandbox/env",
      liveIsNot401: false,
      call: async (token) =>
        outcomeOf(
          await broadcastSandboxEnv(
            jsonRequest(
              "http://localhost/api/internal/broadcast/sandbox/env",
              token,
              { threadId: "no-such-thread", sandboxId: "sbx" },
            ),
          ),
        ),
    },
    {
      name: "internal/broadcast/sandbox/keepalive",
      liveIsNot401: false,
      call: async (token) =>
        outcomeOf(
          await broadcastSandboxKeepalive(
            jsonRequest(
              "http://localhost/api/internal/broadcast/sandbox/keepalive",
              token,
              { threadId: "no-such-thread", sandboxId: "sbx" },
            ),
          ),
        ),
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
  const proxyRoutes = proxies.map((p) => ({
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

  const cliRoute = {
    // A live daemon token is already refused by F1, so its control is the log
    // reason: "not reached past auth" versus "401 from verify".
    name: "cli-router",
    liveIsNot401: false,
    call: async (token: string): Promise<Outcome> => {
      const client = createRouterClient(cliRouter, {
        context: {
          headers: new Headers({ "X-Daemon-Token": token }),
          userId: null as unknown as string,
          organizationId: null,
        },
      });
      const error = await client.auth.whoami().catch((e: unknown) => e);
      if (!(error instanceof ORPCError)) {
        return { status: 200, body: JSON.stringify(error) };
      }
      return { status: error.status, body: error.code };
    },
  };

  it.each([...daemonRoutes, ...proxyRoutes, cliRoute])(
    "$name: the retired token gets the unknown token's 401; the live token does not",
    async ({ call, liveIsNot401 }) => {
      const unknown = await call(`unknown-${nanoid(32)}`);
      expect(unknown.status).toBe(401);

      logSpy.mockClear();
      const retired = await call(retiredToken);
      expect(retired).toEqual(unknown);
      expect(refusedAsRetired()).toBe(true);

      logSpy.mockClear();
      const live = await call(await mintLive());
      expect(refusedAsRetired()).toBe(false);
      if (liveIsNot401) expect(live.status).not.toBe(401);
    },
  );

  describe("onFailure's run-failed on daemon-event (the stale-write case)", () => {
    const runFailed = (token: string, runExternalId: string) =>
      daemonEvent(
        jsonRequest(
          "http://localhost/api/daemon-event",
          token,
          {
            threadId,
            threadChatId,
            messages: [
              {
                type: "custom-error",
                session_id: null,
                duration_ms: 0,
                error_info: "run-failed",
              },
            ],
          },
          { "x-run-external-id": runExternalId },
        ),
      );

    async function snapshot(): Promise<string> {
      const [t] = await db
        .select()
        .from(threadTable)
        .where(eq(threadTable.id, threadId));
      const chats = await db
        .select()
        .from(threadChatTable)
        .where(eq(threadChatTable.threadId, threadId));
      return JSON.stringify({ t, chats });
    }

    it("on a task thread with no activeRunExternalId: 401, and the thread row is unchanged", async () => {
      const before = await snapshot();
      const res = await runFailed(retiredToken, "run-old");
      expect(res.status).toBe(401);
      expect(refusedAsRetired()).toBe(true);
      expect(await snapshot()).toBe(before);
    });

    it("on a review-stamped thread: also 401, and unchanged (the refusal does not depend on the fence)", async () => {
      await setThreadActiveRun({
        db,
        threadId,
        externalId: "run-review",
      });
      const before = await snapshot();
      const res = await runFailed(retiredToken, "run-old");
      expect(res.status).toBe(401);
      expect(await snapshot()).toBe(before);
    });

    it("control: the live token with the same message is not refused as 401", async () => {
      logSpy.mockClear();
      const res = await runFailed(await mintLive(), "run-live");
      expect(res.status).not.toBe(401);
      expect(refusedAsRetired()).toBe(false);
    });
  });

  describe("the api-key update endpoint is disabled", () => {
    it("refuses a signed-in owner renaming their retired token back (404), and the row is unchanged", async () => {
      const headers = {
        Authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
      };
      const [row] = await db
        .select({ id: apikeyTable.id, name: apikeyTable.name })
        .from(apikeyTable)
        .where(
          and(
            eq(apikeyTable.referenceId, userId),
            eq(
              apikeyTable.name,
              `${daemonRunKey({ threadId, threadChatId })}:retired`,
            ),
          ),
        );
      if (!row) throw new Error("retired token row not found");
      const bare = daemonRunKey({ threadId, threadChatId });

      const res = await auth.handler(
        new Request("http://localhost:3000/api/auth/api-key/update", {
          method: "POST",
          headers,
          body: JSON.stringify({ keyId: row.id, name: bare }),
        }),
      );
      expect(res.status).toBe(404);
      const [after] = await db
        .select({ name: apikeyTable.name })
        .from(apikeyTable)
        .where(eq(apikeyTable.id, row.id));
      expect(after?.name).toBe(row.name);
    });

    it("control: the path is mounted, an enabled sibling endpoint is not 404", async () => {
      const res = await auth.handler(
        new Request("http://localhost:3000/api/auth/api-key/list", {
          method: "GET",
        }),
      );
      expect(res.status).not.toBe(404);
    });
  });
});
