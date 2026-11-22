import { describe, it, vi, beforeEach, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db } from "@/lib/db";
import { maybeRecheckOnComplete } from "@/server-lib/supersede-recheck";
import { getDaemonTokenContext } from "@/lib/auth-server";
import { DaemonAuthUnavailableError } from "@/lib/daemon-auth-unavailable";
import {
  createTestUser,
  createTestThread,
  createTestRemoteRun,
} from "@terragon/shared/model/test-helpers";
import { hatchetRun as hatchetRunTable } from "@terragon/shared/db/schema";
import { createOrganization } from "@terragon/shared/model/organizations";
import { setThreadActiveRun } from "@terragon/shared/model/threads";
import {
  thread as threadTable,
  threadChat as threadChatTable,
} from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { User } from "@terragon/shared";
import { DaemonTokenContext } from "@/lib/daemon-token-context";
import { getOctokitForApp } from "@/lib/github";
import { mentionReplyMarker } from "@/server-lib/review/mention-reply-finish";
import {
  continueOrReplyAtTerminal,
  reconcileAddonCalls,
  replyToMentionsAtTerminal,
} from "@/server-lib/review/mention-terminal-reply";
import { maybeContinueAfterTimeout } from "@/server-lib/cell-session/continuation";
import { advanceCellSessionHead } from "@terragon/shared/model/cell-session-checkpoint";
import {
  claimContinuation,
  countContinuations,
} from "@terragon/shared/model/cell-session-continuation";
import { getThreadChat } from "@terragon/shared/model/threads";
import { markThreadTerminal } from "@terragon/shared/model/threads";
import { setUserFeatureFlagOverride } from "@terragon/shared/model/feature-flags";
import { resolveBotLogin } from "@/server-lib/review/bot-login";

vi.mock("@/lib/auth-server", () => ({ getDaemonTokenContext: vi.fn() }));
vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn(),
}));
// The real decision by default; a test makes it throw once to prove fail-open.
vi.mock("@/server-lib/cell-session/continuation", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    maybeContinueAfterTimeout: vi.fn(
      (actual as { maybeContinueAfterTimeout: never })
        .maybeContinueAfterTimeout,
    ),
  };
});

function req(body: unknown) {
  return new NextRequest("http://localhost/api/daemon/run-terminal", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "X-Daemon-Token": "tok", "content-type": "application/json" },
  });
}

vi.mock("@/server-lib/supersede-recheck", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  maybeRecheckOnComplete: vi
    .fn()
    .mockResolvedValue({ rechecked: false, reason: "test" }),
}));

describe("POST /api/daemon/run-terminal (#125 C1 generation fence)", () => {
  let user: User;
  let orgId: string;
  let threadId: string;
  let threadChatId: string;

  function ctx(over: Partial<DaemonTokenContext> = {}): DaemonTokenContext {
    return {
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: orgId,
      threadChatId,
      threadId,
      tokenType: "daemon",
      ...over,
    };
  }

  async function threadRow() {
    const [row] = await db
      .select({
        status: threadTable.status,
        errorMessage: threadTable.errorMessage,
      })
      .from(threadTable)
      .where(eq(threadTable.id, threadId));
    return row!;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "Org",
      slug: `org-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { organizationId: orgId },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    // A live (reapable) run.
    await db
      .update(threadTable)
      .set({ status: "working" })
      .where(eq(threadTable.id, threadId));
    vi.mocked(getDaemonTokenContext).mockResolvedValue(ctx());
  });

  const body = (runExternalId: string) => ({
    threadId,
    threadChatId,
    runExternalId,
    cause: "superseded",
    detail: { policy: "newest-wins" },
  });

  it("503 + Retry-After (never 401) when daemon auth is unavailable", async () => {
    vi.mocked(getDaemonTokenContext).mockRejectedValueOnce(
      new DaemonAuthUnavailableError("api key lookup failed"),
    );
    const res = await POST(req(body("r1")));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(await res.json()).toEqual({
      error: "Authentication temporarily unavailable",
    });
  });

  it("401 without a token context; 403 for a non-daemon token", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(null);
    expect((await POST(req(body("r1")))).status).toBe(401);
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ tokenType: null }),
    );
    expect((await POST(req(body("r1")))).status).toBe(403);
  });

  it("403 when the token is bound to another thread (F2)", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ threadId: "thr_other" }),
    );
    expect((await POST(req(body("r1")))).status).toBe(403);
  });

  it("400 on an unknown cause", async () => {
    const res = await POST(req({ ...body("r1"), cause: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("applies the superseded terminal when runExternalId matches the active run (AC3)", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-active" });
    const res = await POST(req(body("run-active")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    expect(await threadRow()).toEqual({
      status: "complete",
      errorMessage: "superseded",
    });
  });

  it("409 when a NEWER generation owns the thread (AC5 — cancel race closed)", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-new" });
    const res = await POST(req(body("run-old")));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "superseded",
      activeRunExternalId: "run-new",
    });
    // The live (newer) run's thread is untouched.
    expect((await threadRow()).status).toBe("working");
  });

  it("fails OPEN when no active run is stamped (legacy dispatch)", async () => {
    const res = await POST(req(body("anything")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
  });

  it("is idempotent: a retry after success is applied:false, never a second transition", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-active" });
    expect(await (await POST(req(body("run-active")))).json()).toEqual({
      applied: true,
    });
    expect(await (await POST(req(body("run-active")))).json()).toEqual({
      applied: false,
    });
    expect((await threadRow()).errorMessage).toBe("superseded");
  });

  it("403 when the runExternalId names ANOTHER thread's run — a daemon token never retires someone else's run", async () => {
    const other = await createTestRemoteRun({
      db,
      userId: user.id,
      organizationId: orgId,
      prNumber: 99,
      externalId: "run-of-other-thread",
    });
    const res = await POST(req(body("run-of-other-thread")));
    expect(res.status).toBe(403);
    // Neither side moved: our thread is still live, their run still in flight.
    expect((await threadRow()).status).toBe("working");
    const [row] = await db
      .select({ status: hatchetRunTable.status })
      .from(hatchetRunTable)
      .where(eq(hatchetRunTable.threadId, other.threadId));
    expect(row!.status).toBe("in_flight");
  });

  it("a retried (already-applied) terminal still fires the recheck reconciliation — the lost-claim healing path", async () => {
    await setThreadActiveRun({ db, threadId, externalId: "run-active" });
    vi.mocked(maybeRecheckOnComplete).mockClear();
    const first = await POST(req(body("run-active")));
    expect(await first.json()).toEqual({ applied: true });
    const retry = await POST(req(body("run-active")));
    expect(await retry.json()).toEqual({ applied: false });
    expect(maybeRecheckOnComplete).toHaveBeenCalledTimes(2);
  });

  it("404 for an unknown thread", async () => {
    vi.mocked(getDaemonTokenContext).mockResolvedValueOnce(
      ctx({ threadId: null, threadChatId: null }),
    );
    const res = await POST(
      req({ ...body("r1"), threadId: "00000000-0000-0000-0000-000000000000" }),
    );
    expect(res.status).toBe(404);
  });
});

/** A thread with a live (reapable) run and a daemon token bound to it. */
async function freshThread() {
  const user = (await createTestUser({ db })).user;
  const org = await createOrganization({
    db,
    name: "Org",
    slug: `org-${nanoid(8).toLowerCase()}`,
  });
  const t = await createTestThread({
    db,
    userId: user.id,
    overrides: { organizationId: org.id },
  });
  await db
    .update(threadTable)
    .set({ status: "working" })
    .where(eq(threadTable.id, t.threadId));
  vi.mocked(getDaemonTokenContext).mockResolvedValueOnce({
    userId: user.id,
    apiKeyId: "apikey_test",
    organizationId: org.id,
    threadChatId: t.threadChatId,
    threadId: t.threadId,
    tokenType: "daemon",
  });
  return t;
}

describe("POST /api/daemon/run-terminal — typed causes (#125 C4)", () => {
  it("accepts every cause in the taxonomy and persists terminalCause", async () => {
    for (const cause of ["stale-skipped", "discarded", "timeout"] as const) {
      const t = await freshThread();
      const res = await POST(
        req({
          threadId: t.threadId,
          threadChatId: t.threadChatId,
          runExternalId: `run-${cause}`,
          cause,
        }),
      );
      expect(res.status).toBe(200);
      const [row] = await db
        .select({ terminalCause: threadTable.terminalCause })
        .from(threadTable)
        .where(eq(threadTable.id, t.threadId));
      expect(row!.terminalCause).toBe(cause);
    }
  });
});

describe("POST /api/daemon/run-terminal — detail.info and error mapping (#437)", () => {
  async function post(
    t: { threadId: string; threadChatId: string },
    cause: string,
    detail?: Record<string, unknown>,
  ) {
    return POST(
      req({
        threadId: t.threadId,
        threadChatId: t.threadChatId,
        runExternalId: `run-${cause}`,
        cause,
        ...(detail ? { detail } : {}),
      }),
    );
  }

  async function row(threadId: string) {
    const [r] = await db
      .select({
        terminalCause: threadTable.terminalCause,
        errorMessage: threadTable.errorMessage,
        errorMessageInfo: threadTable.errorMessageInfo,
      })
      .from(threadTable)
      .where(eq(threadTable.id, threadId));
    return r!;
  }

  it("maps timeout to the request-timeout error type and stores detail.info", async () => {
    // protects=a timed-out run rendering "Request timed out" with the worker's
    // salvage note, not a generic error; fails_when=errorMessage stays NULL or
    // detail.info is dropped; no_claim=the worker authoring that text.
    const t = await freshThread();
    const info =
      "Unfinished work was saved to branch automata/x (commit 1234abcd).";
    const res = await post(t, "timeout", { info });
    expect(res.status).toBe(200);
    expect(await row(t.threadId)).toEqual({
      terminalCause: "timeout",
      errorMessage: "request-timeout",
      errorMessageInfo: info,
    });
  });

  it("maps out-of-memory to the out-of-memory error type", async () => {
    // protects=an OOM-killed run rendering "Ran out of memory" with readable
    // info; fails_when=the cause is refused or errorMessage is not set;
    // no_claim=the worker detecting OOM.
    const t = await freshThread();
    const info = "Memory limit 5000M reached (13 process(es) killed).";
    const res = await post(t, "out-of-memory", { info });
    expect(res.status).toBe(200);
    expect(await row(t.threadId)).toEqual({
      terminalCause: "out-of-memory",
      errorMessage: "out-of-memory",
      errorMessageInfo: info,
    });
  });

  it("400 when detail.info exceeds 300 chars, and the thread is untouched", async () => {
    // protects=the 300-char cap on worker-authored text; fails_when=a longer
    // string is persisted; no_claim=none beyond protects.
    const t = await freshThread();
    const res = await post(t, "timeout", { info: "x".repeat(301) });
    expect(res.status).toBe(400);
    expect(await row(t.threadId)).toEqual({
      terminalCause: null,
      errorMessage: null,
      errorMessageInfo: null,
    });
  });
});

/**
 * #668: a mention run the worker ends with a typed terminal never reaches the
 * daemon finish, so this route is where its mention gets answered. Real
 * database, real writer; only GitHub is a fake.
 *
 * protects: the person who mentioned the App gets one reply naming what
 *   happened; a retried terminal and a non-mention thread post nothing.
 * fails_when: the route stops calling the mention writer, calls it for an
 *   unapplied write, or the writer cannot resolve the thread's chat.
 * no_claim: GitHub's API (fake) and the worker posting this terminal.
 */
describe("POST /api/daemon/run-terminal — mention reply (#668)", () => {
  const STAMP = {
    repoFullName: "acme/widgets",
    issueOrPrNumber: 664,
    isPullRequest: true,
    commentId: 6954998535,
    commentKind: "issue" as const,
    commenterLogin: "alice",
  };
  const posted: { issue_number: number; body: string }[] = [];
  let answered: { user: { login: string }; body: string }[] = [];
  const octokit = {
    paginate: vi.fn(async () => answered),
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(
          async (args: { issue_number: number; body: string }) => {
            posted.push({ issue_number: args.issue_number, body: args.body });
            answered = [
              ...answered,
              { user: { login: resolveBotLogin() }, body: args.body },
            ];
            return { data: {} };
          },
        ),
      },
    },
  };
  let user: User;
  let threadId: string;
  let threadChatId: string;

  async function seed(sourceMetadata: unknown) {
    user = (await createTestUser({ db })).user;
    const t = await createTestThread({ db, userId: user.id });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    await db
      .update(threadTable)
      .set({ status: "working", sourceMetadata: sourceMetadata as never })
      .where(eq(threadTable.id, threadId));
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: null,
      threadChatId,
      threadId,
      tokenType: "daemon",
    } as DaemonTokenContext);
  }
  const terminal = (cause: string) =>
    POST(req({ threadId, threadChatId, runExternalId: "run-m", cause }));

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    answered = [];
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
  });

  it("a mention run ended by timeout → one reply on the mention, with its marker", async () => {
    await seed({
      type: "automation-skill",
      skillName: "github-mention",
      contentSha: "x",
      source: "db-version",
      mention: STAMP,
    });
    const res = await terminal("timeout");
    expect(await res.json()).toEqual({ applied: true });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.issue_number).toBe(664);
    expect(posted[0]!.body).toBe(
      `I couldn't finish this: the run hit its time limit before it could answer. Mention me again to retry.\n\n${mentionReplyMarker(STAMP.commentId)}`,
    );

    // A retried terminal is applied:false and answers nothing again.
    expect(await (await terminal("timeout")).json()).toEqual({
      applied: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(posted).toHaveLength(1);
  });

  it("a mention run that never ran (plane-offline) is answered too", async () => {
    await seed({
      type: "automation-skill",
      skillName: "github-mention",
      contentSha: "x",
      source: "db-version",
      mention: STAMP,
    });
    await terminal("plane-offline");
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toContain(
      "the run never started on the execution plane",
    );
  });

  // The worker names the chat; the writer must read THAT chat, not guess. A
  // chat-mode thread with a newer, empty chat beside it: only the named chat
  // holds the agent's reply, so a guess posts the timeout notice instead.
  it("a chat-mode mention: the reply comes from the chat the worker named", async () => {
    user = (await createTestUser({ db })).user;
    const agentText =
      'Done.\n\n```json mention-reply\n{"kind":"mention-reply","reply":"Re-reviewed at 183c8a6."}\n```';
    const t = await createTestThread({
      db,
      userId: user.id,
      enableThreadChatCreation: true,
      chatOverrides: { status: "working" },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    await db
      .update(threadChatTable)
      .set({
        messages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [{ type: "text", text: agentText }],
          },
        ] as never,
      })
      .where(eq(threadChatTable.id, threadChatId));
    await db
      .update(threadTable)
      .set({
        sourceMetadata: {
          type: "automation-skill",
          skillName: "github-mention",
          contentSha: "x",
          source: "db-version",
          mention: STAMP,
        } as never,
      })
      .where(eq(threadTable.id, threadId));
    await db.insert(threadChatTable).values({
      userId: user.id,
      threadId,
      status: "complete",
      messages: [],
      updatedAt: new Date(Date.now() + 60_000),
    } as never);
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: null,
      threadChatId,
      threadId,
      tokenType: "daemon",
    } as DaemonTokenContext);

    expect(await (await terminal("timeout")).json()).toEqual({
      applied: true,
    });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toBe(
      `Re-reviewed at 183c8a6.\n\n${mentionReplyMarker(STAMP.commentId)}`,
    );
  });

  // The sweeps name no chat: the writer must find the one the terminal moved
  // (its terminalCause mirror), not merely the newest.
  it("no chat named (sweep/watchdog): the reply comes from the chat the terminal moved", async () => {
    user = (await createTestUser({ db })).user;
    const t = await createTestThread({
      db,
      userId: user.id,
      enableThreadChatCreation: true,
      chatOverrides: { status: "working" },
    });
    threadId = t.threadId;
    await db
      .update(threadChatTable)
      .set({
        messages: [
          {
            type: "agent",
            parent_tool_use_id: null,
            parts: [
              {
                type: "text",
                text: '```json mention-reply\n{"kind":"mention-reply","reply":"From the run chat."}\n```',
              },
            ],
          },
        ] as never,
      })
      .where(eq(threadChatTable.id, t.threadChatId));
    await db
      .update(threadTable)
      .set({
        sourceMetadata: {
          type: "automation-skill",
          skillName: "github-mention",
          contentSha: "x",
          source: "db-version",
          mention: STAMP,
        } as never,
      })
      .where(eq(threadTable.id, threadId));
    // A newer chat the terminal does not move (already complete, empty).
    await db.insert(threadChatTable).values({
      userId: user.id,
      threadId,
      status: "complete",
      messages: [],
      updatedAt: new Date(Date.now() + 60 * 60_000),
    } as never);

    expect(await markThreadTerminal({ db, threadId, cause: "timeout" })).toBe(
      true,
    );
    await replyToMentionsAtTerminal([{ threadId }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe(
      `From the run chat.\n\n${mentionReplyMarker(STAMP.commentId)}`,
    );
  });

  it("a person's stop (user-cancelled) and a non-mention thread post nothing", async () => {
    await seed({
      type: "automation-skill",
      skillName: "github-mention",
      contentSha: "x",
      source: "db-version",
      mention: STAMP,
    });
    await terminal("user-cancelled");
    await seed(null);
    await terminal("timeout");
    await new Promise((r) => setTimeout(r, 100));
    expect(posted).toHaveLength(0);
    expect(getOctokitForApp).not.toHaveBeenCalled();
  });
});

describe("POST /api/daemon/run-terminal — timeout continuation (#743 phase 10)", () => {
  // Unique per test: the ledger's source-run key is global.
  let RUN = "";
  const STAMP = {
    repoFullName: "acme/widgets",
    issueOrPrNumber: 743,
    isPullRequest: false,
    commentId: 7430001,
    commentKind: "issue" as const,
    commenterLogin: "alice",
  };
  const posted: string[] = [];
  const octokit = {
    paginate: vi.fn(async () => []),
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(async (args: { body: string }) => {
          posted.push(args.body);
          return { data: {} };
        }),
      },
    },
  };
  let user: User;
  let threadId: string;
  let threadChatId: string;

  async function seed({ checkpoint }: { checkpoint: boolean }) {
    RUN = `run-cont-${nanoid(8)}`;
    user = (await createTestUser({ db })).user;
    // #743 phase 11: the continuation is behind cellSessionContinuation.
    await setUserFeatureFlagOverride({
      db,
      userId: user.id,
      name: "cellSessionContinuation",
      value: true,
    });
    const t = await createTestThread({
      db,
      userId: user.id,
      overrides: { branchName: "work/branch" },
    });
    threadId = t.threadId;
    threadChatId = t.threadChatId;
    await db
      .update(threadTable)
      .set({
        status: "working",
        sourceMetadata: {
          type: "automation-skill",
          skillName: "github-mention",
          contentSha: "x",
          source: "db-version",
          mention: STAMP,
        } as never,
      })
      .where(eq(threadTable.id, threadId));
    await setThreadActiveRun({ db, threadId, externalId: RUN });
    if (checkpoint) {
      await advanceCellSessionHead({
        db,
        threadId,
        threadChatId,
        expectedVersion: 0,
        move: {
          sessionId: "s",
          headManifestId: "manifest-1",
          headTurn: 3,
          nativeBytes: 10,
          callIndexSha256: null,
          lastRunExternalId: RUN,
        },
      });
    }
    vi.mocked(getDaemonTokenContext).mockResolvedValue({
      userId: user.id,
      apiKeyId: "apikey_test",
      organizationId: null,
      threadChatId,
      threadId,
      tokenType: "daemon",
    } as DaemonTokenContext);
  }
  const timeout = () =>
    POST(req({ threadId, threadChatId, runExternalId: RUN, cause: "timeout" }));
  const queuedCount = async () =>
    (await getThreadChat({ db, threadId, threadChatId, userId: user.id }))
      ?.queuedMessages?.length ?? 0;
  const settle = () => new Promise((r) => setTimeout(r, 100));

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
  });

  it("a first timeout with a checkpoint re-dispatches once and defers the reply", async () => {
    await seed({ checkpoint: true });
    expect(await (await timeout()).json()).toEqual({ applied: true });
    await vi.waitFor(async () =>
      expect(await countContinuations({ db, threadId })).toBe(1),
    );
    expect(await queuedCount()).toBe(1);
    await settle();
    expect(posted).toHaveLength(0);
    expect(getOctokitForApp).not.toHaveBeenCalled();
  });

  it("F1: a redelivered terminal takes the early branch, claims at most once and posts no reply", async () => {
    await seed({ checkpoint: true });
    // The first attempt's decision is lost after the terminal write.
    vi.mocked(maybeContinueAfterTimeout).mockRejectedValueOnce(
      new Error("lost"),
    );
    expect(await (await timeout()).json()).toEqual({ applied: true });
    // Not continued, so today's reply went out once.
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(await countContinuations({ db, threadId })).toBe(0);

    // The redelivery: applied:false from the superseded branch.
    expect(await (await timeout()).json()).toEqual({ applied: false });
    await vi.waitFor(async () =>
      expect(await countContinuations({ db, threadId })).toBe(1),
    );
    expect(await queuedCount()).toBe(1);

    // A further redelivery claims nothing more.
    expect(await (await timeout()).json()).toEqual({ applied: false });
    await settle();
    expect(await countContinuations({ db, threadId })).toBe(1);
    expect(await queuedCount()).toBe(1);
    // No reply from the early branch.
    expect(posted).toHaveLength(1);
    expect(getOctokitForApp).toHaveBeenCalledTimes(1);
  });

  it("a spent budget puts the limit in the reply (AC-3)", async () => {
    await seed({ checkpoint: true });
    // A run id of its own: the ledger's source-run key is unique across the
    // whole test database, so a shared literal would make another suite's
    // claim lose silently.
    const earlier = await claimContinuation({
      db,
      threadId,
      threadChatId,
      sourceRunExternalId: `run-earlier-${nanoid()}`,
      checkpointManifestId: "manifest-0",
      checkpointTurn: 2,
    });
    expect(earlier).toMatchObject({ claimed: true });
    await timeout();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toContain(
      "the limit of one automatic continuation per thread was already used",
    );
    expect(await queuedCount()).toBe(0);
  });

  it("no checkpoint keeps today's reply and queues nothing (OQ-1)", async () => {
    await seed({ checkpoint: false });
    await timeout();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toBe(
      `I couldn't finish this: the run hit its time limit before it could answer. Mention me again to retry.\n\n${mentionReplyMarker(STAMP.commentId)}`,
    );
    expect(await countContinuations({ db, threadId })).toBe(0);
    expect(await queuedCount()).toBe(0);
  });

  it("a hook throw is fail-open: the terminal still lands and the mention is answered", async () => {
    await seed({ checkpoint: true });
    vi.mocked(maybeContinueAfterTimeout).mockRejectedValueOnce(
      new TypeError("boom"),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await timeout();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(errors).toHaveBeenCalledWith(
      `continuation: hook failed (TypeError) thread=${threadId}`,
    );
    errors.mockRestore();
  });

  it("the add-on reconcile stub runs before the decision and does nothing", async () => {
    await seed({ checkpoint: false });
    expect(await reconcileAddonCalls({ threadId })).toEqual({
      reason: "receiver-off",
    });
    const reconcile = vi.fn(reconcileAddonCalls);
    await continueOrReplyAtTerminal(
      {
        threadId,
        threadChatId,
        runExternalId: RUN,
        cause: "timeout",
        reply: false,
      },
      reconcile,
    );
    expect(reconcile).toHaveBeenCalledWith({ threadId });
    expect(reconcile.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(maybeContinueAfterTimeout).mock.invocationCallOrder[0]!,
    );
  });

  it("a non-timeout cause never consults the decision", async () => {
    await seed({ checkpoint: true });
    await continueOrReplyAtTerminal({
      threadId,
      threadChatId,
      runExternalId: RUN,
      cause: "daemon-failed",
      reply: false,
    });
    expect(maybeContinueAfterTimeout).not.toHaveBeenCalled();
  });
});
