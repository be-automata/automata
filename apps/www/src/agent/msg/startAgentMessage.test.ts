import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { createOrganization } from "@terragon/shared/model/organizations";
import { nanoid } from "nanoid";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { User } from "@terragon/shared";
import { getThreadChat } from "@terragon/shared/model/threads";
import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { startAgentMessage } from "./startAgentMessage";
import { hasActiveDaemonToken, daemonRunKey } from "@/lib/daemon-token";
import { sendDaemonMessage } from "@/agent/daemon";

/**
 * Flag-on harness for the remote dispatch seam. Rather than mock the dispatch, we
 * drive startAgentMessage end-to-end (a thread pinned to sandboxProvider
 * "hatchet-remote" enables the seam without HATCHET_* env) and assert the
 * OBSERVABLE effect: dispatchAgentRun mints a daemon token NAMED by the per-run
 * key daemonRunKey(threadId, threadChatId). That token name is the exact thing the
 * dedup guard and terminal revoke key on, so it proves the call site forwarded the
 * thread's real per-thread ids — the regression class team-lead flagged. The
 * Hatchet trigger fetch is stubbed (its completion is deferred to the waitUntil
 * seam and irrelevant to the assertion).
 */
describe("startAgentMessage — flag-on (remote) dispatch seam", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ externalId: "run" }), { status: 200 }),
        ),
    );
  });

  it("dispatches remotely, keying the daemon token on the thread's OWN threadChatId (per-run key)", async () => {
    // enableThreadChatCreation defaults OFF → threadChatId is the shared legacy
    // sentinel, exactly the production condition. Keying on threadChatId ALONE made
    // one thread's token block all others; the per-run key is threadId-scoped.
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        // "hatchet-remote" drives hatchetDispatchEnabled without HATCHET_* env.
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/automata",
        repoBaseBranchName: "main",
      },
    });
    expect(threadChatId).toBe(LEGACY_THREAD_CHAT_ID); // sentinel, as in prod

    await startAgentMessage({
      db,
      userId: user.id,
      message: null,
      threadId,
      threadChatId,
      isNewThread: true,
    });

    // The dispatch ran and minted the per-run daemon token (name = threadId:chatId).
    expect(
      await hasActiveDaemonToken({
        userId: user.id,
        name: daemonRunKey({ threadId, threadChatId }),
      }),
    ).toBe(true);
  });

  it("fails the thread to a terminal error (not a stuck 'booting' zombie) when the dispatch fails", async () => {
    // FINDING #4: a dispatch that never creates a Hatchet run must surface a
    // terminal error, mirroring in-process sandbox-creation-failed — otherwise the
    // thread sits in `booting` forever (the b3ee96a5 zombie).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/automata",
        repoBaseBranchName: "main",
      },
    });

    await startAgentMessage({
      db,
      userId: user.id,
      message: null,
      threadId,
      threadChatId,
      isNewThread: true,
    });

    const threadChat = await getThreadChat({
      db,
      threadId,
      threadChatId,
      userId: user.id,
    });
    // Terminal error surfaced (withThreadChat → system.error), NOT stuck booting.
    expect(threadChat!.status).not.toBe("booting");
    expect(threadChat!.errorMessage).toBe("sandbox-creation-failed");
    // And the just-minted token was revoked (no stale dedup block).
    expect(
      await hasActiveDaemonToken({
        userId: user.id,
        name: daemonRunKey({ threadId, threadChatId }),
      }),
    ).toBe(false);
  });

  it("does NOT dispatch remotely for a normal (in-process) thread", async () => {
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "e2b" },
    });

    // The in-process path needs a sandbox; we only assert the remote seam is NOT
    // taken, so swallow whatever the sandbox path does after that decision point.
    await startAgentMessage({
      db,
      userId: user.id,
      message: null,
      threadId,
      threadChatId,
      isNewThread: true,
    }).catch(() => {});

    expect(
      await hasActiveDaemonToken({
        userId: user.id,
        name: daemonRunKey({ threadId, threadChatId }),
      }),
    ).toBe(false);
  });
});

/**
 * The permission-mode floor at Seam B (ADR-005 §2/§3/§3b, #82) — the LOCAL
 * (non-hatchet-remote, sandboxProvider "e2b") dispatch path. Pins the SAME
 * clamped mode Seam A resolves for an equivalent thread (ADR-005 §3b's
 * both-seams test), and pins the SECURITY FIX called out in the #82 commit:
 * before this ticket, this seam had NO review derivation at all — it always
 * sent `threadChat.permissionMode || "allowAll"` — so a PR-review automation
 * dispatched down this local path reached the daemon at "allowAll" even
 * though Seam A already pinned the SAME thread to "review". That gap is
 * closed here: the shared resolver now runs on both seams.
 */
describe("startAgentMessage — permission-mode floor (#82, local/in-process seam)", () => {
  let user: User;
  let orgId: string;

  beforeEach(async () => {
    // Restore the real global `fetch` — the sibling "flag-on (remote)" describe
    // block above stubs it with a SINGLE-USE mocked Response, which persists
    // across the file otherwise and breaks any other fetch-based call (e.g. the
    // sandbox-creation rate limiter's Upstash Redis HTTP client) with "Body is
    // unusable: Body has already been read". This describe block exercises the
    // LOCAL path, which does NOT need the hatchet fetch stub.
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    const org = await createOrganization({
      db,
      name: "acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  function lastSentPermissionMode(): string | undefined {
    const calls = vi.mocked(sendDaemonMessage).mock.calls;
    const last = calls[calls.length - 1];
    return (last?.[0] as { message: { permissionMode?: string } })?.message
      ?.permissionMode;
  }

  it("PR automation with no trust-verified content reaches the daemon at 'review' (the fix)", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        repoFullName: "acme/widgets",
        triggerType: "pull_request",
        triggerConfig: {
          on: { open: true },
          filter: { includeAllAuthors: true },
          permissionMode: "allowAll",
        },
      },
    });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      // "e2b" (not "hatchet-remote") forces the LOCAL in-process path — the
      // global test setup mocks the sandbox provider + sendDaemonMessage, so
      // this drives the real dispatch code without a real sandbox.
      overrides: {
        sandboxProvider: "e2b",
        organizationId: orgId,
        automationId: automation.id,
        githubRepoFullName: "acme/widgets",
        githubPRNumber: 1,
        trustContext: {
          source: "github-pr",
          isFork: true,
          authorAssociation: "OWNER",
          capturedAt: new Date().toISOString(),
        },
      },
    });

    await startAgentMessage({
      db,
      userId: user.id,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "hello" }],
      },
      threadId,
      threadChatId,
      isNewThread: true,
    });

    expect(lastSentPermissionMode()).toBe("review");
  });

  it("non-PR (schedule) automation configured plan reaches the daemon at 'plan' (AC4 regression)", async () => {
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: {
        organizationId: orgId,
        triggerType: "schedule",
        triggerConfig: {
          cron: "0 9 * * *",
          timezone: "UTC",
          permissionMode: "plan",
        },
      },
    });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sandboxProvider: "e2b",
        organizationId: orgId,
        automationId: automation.id,
      },
    });

    await startAgentMessage({
      db,
      userId: user.id,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "hello" }],
      },
      threadId,
      threadChatId,
      isNewThread: true,
    });

    expect(lastSentPermissionMode()).toBe("plan");
  });
});

describe("startAgentMessage — resume clears the terminal PAIR (#153 read-tear fix)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ externalId: "run" }), { status: 200 }),
        ),
    );
  });

  it("a thread resumed after a typed terminal sheds terminalCause through the REAL boot path — the unstamped dispatch's post-trigger fallback", async () => {
    // Legacy (sentinel) thread: the production condition, and the only shape
    // this harness can dispatch — a chat-mode thread's daemon-token name
    // (threadId:threadChatId, two uuids = 73 chars) exceeds better-auth's
    // api-key name cap, so v1 dispatch fails at mint. Latent v1-only blocker,
    // tracked with the #153 v1 work; the pair-clearing itself is covered at
    // the writer level (hatchet-run.test.ts) and fence level
    // (generation-fence.integration.test.ts).
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        sandboxProvider: "hatchet-remote",
        githubRepoFullName: "be-automata/automata",
        repoBaseBranchName: "main",
      },
      chatOverrides: { status: "complete" },
    });
    expect(threadChatId).toBe(LEGACY_THREAD_CHAT_ID);
    // The thread previously reached a typed terminal.
    await db
      .update(schema.thread)
      .set({ terminalCause: "user-cancelled" })
      .where(eq(schema.thread.id, threadId));

    await startAgentMessage({
      db,
      userId: user.id,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "resume it" }],
      },
      threadId,
      threadChatId,
      isNewThread: false,
    });

    // Non-review remote dispatch is UNSTAMPED (stampFence false), so the
    // unfence is the post-trigger fallback in dispatchAgentRun — the cause is
    // shed only once the new run exists, never before (the #125 C1 window).
    const [t] = await db
      .select({ cause: schema.thread.terminalCause })
      .from(schema.thread)
      .where(eq(schema.thread.id, threadId));
    expect(t!.cause).toBeNull();
  });
});
