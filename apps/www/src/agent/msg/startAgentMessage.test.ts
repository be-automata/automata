import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";
import { User } from "@terragon/shared";
import type { SandboxProvider } from "@terragon/types/sandbox";
import { startAgentMessage } from "./startAgentMessage";
import { hasActiveDaemonToken, daemonRunKey } from "@/lib/daemon-token";

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
        // "hatchet-remote" is the per-thread opt-in read by hatchetDispatchEnabled;
        // it is not in the SandboxProvider union (env HATCHET_ENABLED is the prod
        // enabler), so cast to drive the seam here without HATCHET_* env.
        sandboxProvider: "hatchet-remote" as SandboxProvider,
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
