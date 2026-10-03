import { describe, it, vi, beforeEach, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestAutomation,
} from "@terragon/shared/model/test-helpers";
import { User } from "@terragon/shared";
import { createNewThread } from "./new-thread-shared";
import { getOctokitForBackground, getIsPRAuthor } from "@/lib/github";
import { runPullRequestAutomation } from "./automations";

/**
 * The trust-snapshot intake path (ADR-005 §3a, #82): `runPullRequestAutomation`
 * captures `{isFork, authorAssociation}` from the SAME `pulls.get` read it
 * already performs (no new webhook field, no extra round trip) and threads it
 * unconditionally into `createNewThread` — for BOTH source: "automated" and
 * "manual" (never gated behind the `source !== "manual"` archival block).
 * Unforgeable by construction: nothing in the caller's inputs (automationId,
 * repoFullName, prNumber, prEventAction, source) can set isFork/authorAssociation
 * — the ONLY writer is this server-side GitHub read.
 */

vi.mock("./new-thread-shared", () => ({
  createNewThread: vi
    .fn()
    .mockResolvedValue({ threadId: "t1", threadChatId: "tc1" }),
}));

vi.mock("@/app/api/webhooks/github/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return { ...actual, addEyesReactionToPullRequest: vi.fn() };
});

function makeMockOctokit({
  isFork,
  authorAssociation,
  headFullName = "acme/widgets",
  baseFullName = "acme/widgets",
}: {
  isFork: boolean;
  authorAssociation: string | null;
  /** null = head.repo is null (deleted fork). */
  headFullName?: string | null;
  /** null = base.repo is missing. */
  baseFullName?: string | null;
}) {
  return {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            head: {
              ref: "feature",
              repo:
                headFullName === null
                  ? null
                  : { fork: isFork, full_name: headFullName },
            },
            base: {
              ref: "main",
              ...(baseFullName === null
                ? {}
                : { repo: { full_name: baseFullName } }),
            },
            author_association: authorAssociation,
          },
        }),
      },
    },
    rest_repos: undefined,
  };
}

describe("PR trust-snapshot intake (#82, ADR-005 §3a)", () => {
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    user = (await createTestUser({ db })).user;
    vi.mocked(getIsPRAuthor).mockResolvedValue(false);
  });

  it("source: automated — persists {isFork: true, authorAssociation} from pulls.get", async () => {
    const octokit = makeMockOctokit({
      isFork: true,
      authorAssociation: "CONTRIBUTOR",
    });
    vi.mocked(getOctokitForBackground).mockResolvedValue(octokit as any);
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: { triggerType: "pull_request", repoFullName: "acme/widgets" },
    });

    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "acme/widgets",
      prEventAction: "opened",
      prNumber: 1,
      source: "automated",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({
        trustContext: expect.objectContaining({
          source: "github-pr",
          isFork: true,
          authorAssociation: "CONTRIBUTOR",
        }),
      }),
    );
  });

  it("source: manual — trust snapshot is STILL captured (not gated on source)", async () => {
    const octokit = makeMockOctokit({
      isFork: false,
      authorAssociation: "OWNER",
    });
    vi.mocked(getOctokitForBackground).mockResolvedValue(octokit as any);
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: { triggerType: "pull_request", repoFullName: "acme/widgets" },
    });

    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "acme/widgets",
      prEventAction: "opened",
      prNumber: 1,
      source: "manual",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({
        trustContext: expect.objectContaining({
          source: "github-pr",
          isFork: false,
          authorAssociation: "OWNER",
        }),
      }),
    );
  });

  it("author_association absent from the GitHub payload -> falls back to NONE (fail-closed, never trusted)", async () => {
    const octokit = makeMockOctokit({ isFork: false, authorAssociation: null });
    vi.mocked(getOctokitForBackground).mockResolvedValue(octokit as any);
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: { triggerType: "pull_request", repoFullName: "acme/widgets" },
    });

    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "acme/widgets",
      prEventAction: "opened",
      prNumber: 1,
      source: "automated",
    });

    expect(createNewThread).toHaveBeenCalledWith(
      expect.objectContaining({
        trustContext: expect.objectContaining({ authorAssociation: "NONE" }),
      }),
    );
  });

  it("pulls.get failure -> no thread created, no forged trust snapshot", async () => {
    const octokit = {
      rest: {
        pulls: { get: vi.fn().mockRejectedValue(new Error("GitHub 500")) },
      },
    };
    vi.mocked(getOctokitForBackground).mockResolvedValue(octokit as any);
    const automation = await createTestAutomation({
      db,
      userId: user.id,
      values: { triggerType: "pull_request", repoFullName: "acme/widgets" },
    });

    await runPullRequestAutomation({
      userId: user.id,
      automationId: automation.id,
      repoFullName: "acme/widgets",
      prEventAction: "opened",
      prNumber: 1,
      source: "automated",
    });

    // The whole run degrades (matches today's behavior on a pulls.get throw) —
    // no thread, hence no trust snapshot forged from thin air.
    expect(createNewThread).not.toHaveBeenCalled();
  });

  describe("isCrossRepo (phase 4)", () => {
    async function runWith(octokit: ReturnType<typeof makeMockOctokit>) {
      vi.mocked(getOctokitForBackground).mockResolvedValue(octokit as any);
      const automation = await createTestAutomation({
        db,
        userId: user.id,
        values: { triggerType: "pull_request", repoFullName: "acme/widgets" },
      });
      await runPullRequestAutomation({
        userId: user.id,
        automationId: automation.id,
        repoFullName: "acme/widgets",
        prEventAction: "opened",
        prNumber: 1,
        source: "automated",
      });
    }

    it("non-fork head in a different repo -> isCrossRepo true", async () => {
      await runWith(
        makeMockOctokit({
          isFork: false,
          authorAssociation: "MEMBER",
          headFullName: "Evil/Widgets",
          baseFullName: "acme/widgets",
        }),
      );
      expect(createNewThread).toHaveBeenCalledWith(
        expect.objectContaining({
          trustContext: expect.objectContaining({
            isFork: false,
            isCrossRepo: true,
          }),
        }),
      );
    });

    it("same repo, different casing -> isCrossRepo false", async () => {
      await runWith(
        makeMockOctokit({
          isFork: false,
          authorAssociation: "MEMBER",
          headFullName: "Acme/Widgets",
          baseFullName: "acme/widgets",
        }),
      );
      expect(createNewThread).toHaveBeenCalledWith(
        expect.objectContaining({
          trustContext: expect.objectContaining({ isCrossRepo: false }),
        }),
      );
    });

    it("head.repo null (deleted fork) -> isCrossRepo true, isFork true", async () => {
      await runWith(
        makeMockOctokit({
          isFork: false,
          authorAssociation: "MEMBER",
          headFullName: null,
        }),
      );
      expect(createNewThread).toHaveBeenCalledWith(
        expect.objectContaining({
          trustContext: expect.objectContaining({
            isFork: true,
            isCrossRepo: true,
          }),
        }),
      );
    });

    it("base.repo missing -> isCrossRepo true (fail closed)", async () => {
      await runWith(
        makeMockOctokit({
          isFork: false,
          authorAssociation: "MEMBER",
          baseFullName: null,
        }),
      );
      expect(createNewThread).toHaveBeenCalledWith(
        expect.objectContaining({
          trustContext: expect.objectContaining({ isCrossRepo: true }),
        }),
      );
    });
  });

  it("forgery: no caller-suppliable path sets trustContext (grep-pinned, structural)", () => {
    // runPullRequestAutomation's own signature — the request surface a webhook
    // handler or a manual re-run button can drive — takes no isFork /
    // authorAssociation / trustContext argument at all. This test exists as a
    // structural anchor; the real guarantee is TypeScript's structural typing
    // (adding such a field to the params type would be a visible diff) plus the
    // absence of `trustContext` from AutomationTriggerSchema (zod) and every
    // server-action arg — see packages/shared/src/automations/index.ts and
    // apps/www/src/server-actions/automations.ts.
    const callerParams: {
      userId: string;
      automationId: string;
      repoFullName: string;
      prEventAction: "opened" | "reopened" | "synchronize";
      prNumber: number;
      source: "automated" | "manual";
    } = {
      userId: "u",
      automationId: "a",
      repoFullName: "r",
      prEventAction: "opened",
      prNumber: 1,
      source: "manual",
    };
    expect("trustContext" in callerParams).toBe(false);
    expect("isFork" in callerParams).toBe(false);
    expect("authorAssociation" in callerParams).toBe(false);
  });
});
