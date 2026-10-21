import { describe, it, expect } from "vitest";
import {
  publishReviewNotice,
  renderReviewNotice,
  retireReviewNotices,
  reviewNoticeSha,
} from "./review-notice";
import { makeNoticeFake } from "./review-notice.fake";

const BOT = "automata-ai-bot[bot]";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const TARGET = { repoFullName: "o/r", prNumber: 7, botLogin: BOT };

describe("renderReviewNotice", () => {
  it("leads with the marker, names the short sha, and says it is not a pass", () => {
    const body = renderReviewNotice({
      sha: SHA,
      cause: "unparseable",
      reason: "no JSON intent block found in agent output",
    });
    expect(
      body.startsWith(`<!-- automata:review-notice sha=${SHA} -->\n`),
    ).toBe(true);
    expect(body).toContain("no verdict for commit `0123456`");
    expect(body).toContain("This is not a pass");
    expect(body).toContain("push a new commit");
  });

  it("round-trips: the rendered body is recognised as a notice at that sha", () => {
    const body = renderReviewNotice({
      sha: SHA,
      cause: "agent_unable",
      reason: "x",
    });
    expect(reviewNoticeSha({ id: 1, user: { login: BOT }, body }, BOT)).toBe(
      SHA,
    );
  });

  // The reason is agent output, shaped by an untrusted PR: it must not be able
  // to ping people, forge a second marker, or carry a live link.
  it("defuses mentions, HTML and links in the agent's reason", () => {
    const body = renderReviewNotice({
      sha: SHA,
      cause: "agent_unable",
      reason:
        "ask @octocat <!-- automata:review-notice sha=evil --> [click](http://x)\nnext line",
    });
    expect(body).not.toContain("@octocat");
    expect(body).not.toContain("<!-- automata:review-notice sha=evil");
    expect(body).not.toContain("[click](http://x)");
    expect(body.split("\n")).toHaveLength(6);
  });

  it("clips a very long reason", () => {
    const body = renderReviewNotice({
      sha: SHA,
      cause: "unparseable",
      reason: "word ".repeat(1000),
    });
    expect(body.length).toBeLessThan(1200);
  });
});

describe("reviewNoticeSha", () => {
  it("is null for another author and for a marker that is not the prefix", () => {
    const marker = `<!-- automata:review-notice sha=${SHA} -->`;
    expect(
      reviewNoticeSha({ id: 1, user: { login: "a-human" }, body: marker }, BOT),
    ).toBeNull();
    expect(
      reviewNoticeSha({ id: 1, user: null, body: marker }, BOT),
    ).toBeNull();
    expect(
      reviewNoticeSha(
        { id: 1, user: { login: BOT }, body: `quoted: ${marker}` },
        BOT,
      ),
    ).toBeNull();
  });
});

describe("publishReviewNotice / retireReviewNotices", () => {
  it("creates the new notice BEFORE deleting older ones", async () => {
    const github = makeNoticeFake(BOT);
    await publishReviewNotice({
      ...TARGET,
      github,
      sha: "old-sha",
      cause: "unparseable",
      reason: "r",
    });
    const order: string[] = [];
    github.createConversationComment.mockImplementationOnce(async () => {
      order.push("create");
    });
    github.deleteConversationComment.mockImplementationOnce(async () => {
      order.push("delete");
    });

    const res = await publishReviewNotice({
      ...TARGET,
      github,
      sha: "new-sha",
      cause: "unparseable",
      reason: "r",
    });
    expect(res).toEqual({ result: "posted" });
    expect(order).toEqual(["create", "delete"]);
  });

  it("a failed delete of the older notice still reports posted", async () => {
    const github = makeNoticeFake(BOT);
    await publishReviewNotice({
      ...TARGET,
      github,
      sha: "old-sha",
      cause: "unparseable",
      reason: "r",
    });
    github.deleteConversationComment.mockRejectedValueOnce(new Error("403"));
    const res = await publishReviewNotice({
      ...TARGET,
      github,
      sha: "new-sha",
      cause: "unparseable",
      reason: "r",
    });
    expect(res).toEqual({ result: "posted" });
    expect(github.comments).toHaveLength(2);
  });

  it("reports a failed create without throwing", async () => {
    const github = makeNoticeFake(BOT);
    github.createConversationComment.mockRejectedValueOnce(new Error("gh 500"));
    const res = await publishReviewNotice({
      ...TARGET,
      github,
      sha: SHA,
      cause: "unparseable",
      reason: "r",
    });
    expect(res).toEqual({ result: "post_failed", failureReason: "gh 500" });
  });

  it("retiring removes only our notices and never throws", async () => {
    const github = makeNoticeFake(BOT);
    await publishReviewNotice({
      ...TARGET,
      github,
      sha: SHA,
      cause: "unparseable",
      reason: "r",
    });
    github.comments.push(
      { id: 50, user: { login: "a-human" }, body: "looks good to me" },
      {
        id: 51,
        user: { login: BOT },
        body: "<!-- automata:pr-merged-audit:7 -->",
      },
    );

    await retireReviewNotices({ ...TARGET, github });
    expect(github.comments.map((comment) => comment.id)).toEqual([50, 51]);

    github.listConversationComments.mockRejectedValueOnce(new Error("502"));
    await expect(
      retireReviewNotices({ ...TARGET, github }),
    ).resolves.toBeUndefined();
  });
});

// #441: a run the provider refused names that cause, never the account, and
// corrects a same-commit generic notice in place instead of adding a second.
describe("provider_unavailable notice (#441)", () => {
  const RESET = Date.UTC(2026, 9, 22, 17, 0);

  // Card: protects=the per-kind wording, the UTC reset format and the kept
  // "Nothing was approved or blocked." + Next line; fails_when=a kind renders
  // the generic "could not be read" text, a reset prints in another format,
  // or the Next line is lost; no_claim=which lanes call it (executor suite).
  it("renders each kind with its reset and next step", () => {
    const render = (
      provider: Parameters<typeof renderReviewNotice>[0]["provider"],
    ) =>
      renderReviewNotice({
        sha: SHA,
        cause: "provider_unavailable",
        reason: "no JSON intent block found in agent output",
        provider,
      });

    const weekly = render({
      kind: "usage_limit",
      window: "weekly",
      resetsAt: RESET,
    });
    expect(weekly.split("\n")[0]).toBe(
      `<!-- automata:review-notice sha=${SHA} cause=provider_unavailable -->`,
    );
    expect(weekly).toContain(
      "⚠️ **Automata has no verdict for commit `0123456`.** The connected Claude subscription hit its weekly usage limit; it resets at 17:00 UTC on 22 Oct. Nothing was approved or blocked.",
    );
    expect(weekly).toContain(
      "**Next:** push a new commit after the reset, or have a teammate review.",
    );
    expect(weekly).not.toContain("no JSON intent block");

    expect(render({ kind: "usage_limit", window: "five_hour" })).toContain(
      "hit its five-hour usage limit and is unavailable until the limit resets.",
    );
    const disabled = render({ kind: "subscription_disabled" });
    expect(disabled).toContain(
      "an admin of the connected Claude organization disabled Claude Code access; it will not reset on its own.",
    );
    expect(disabled).toContain("Nothing was approved or blocked.");
    expect(render({ kind: "credit_exhausted" })).toContain(
      "The Claude API credit balance is too low to run the agent.",
    );
    // The marker round-trips to the same sha.
    expect(
      reviewNoticeSha({ id: 1, user: { login: BOT }, body: weekly }, BOT),
    ).toBe(SHA);
  });

  // Card: protects=decision 5, no account identity reaches the PR;
  // fails_when=an email or org name from the run's output is rendered;
  // no_claim=credential metadata is never read here at all (it is not an
  // input).
  it("never renders account identity, even when the run's output carries it", () => {
    const body = renderReviewNotice({
      sha: SHA,
      cause: "provider_unavailable",
      reason:
        "Your organization (Example Org, owner someone@example.com) has disabled access",
      provider: { kind: "subscription_disabled" },
    });
    expect(body).not.toContain("@example.com");
    expect(body).not.toContain("Example Org");
    expect(body).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  // Card: protects=edit-in-place of a same-sha notice whose cause differs, and
  // still one notice per commit; fails_when=a second comment is created at the
  // sha, the generic text survives, or an identical provider notice is
  // re-written; no_claim=GitHub's PATCH semantics (fake).
  it("edits a same-sha generic notice in place; an identical provider notice is a duplicate", async () => {
    const github = makeNoticeFake(BOT);
    await publishReviewNotice({
      ...TARGET,
      github,
      sha: SHA,
      cause: "unparseable",
      reason: "no JSON intent block found in agent output",
    });
    const provider = {
      kind: "usage_limit" as const,
      window: "weekly" as const,
      resetsAt: RESET,
    };
    const first = await publishReviewNotice({
      ...TARGET,
      github,
      sha: SHA,
      cause: "provider_unavailable",
      reason: "r",
      provider,
    });
    expect(first).toEqual({ result: "updated", commentId: 1 });
    expect(github.createConversationComment).toHaveBeenCalledTimes(1);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain("weekly usage limit");
    expect(github.comments[0]!.body).not.toContain("could be read");

    const again = await publishReviewNotice({
      ...TARGET,
      github,
      sha: SHA,
      cause: "provider_unavailable",
      reason: "r",
      provider,
    });
    expect(again).toEqual({ result: "duplicate_at_commit", commentId: 1 });
    expect(github.updateConversationComment).toHaveBeenCalledTimes(1);

    // Two generic causes at one sha still dedupe on the commit (#220).
    const githubB = makeNoticeFake(BOT);
    await publishReviewNotice({
      ...TARGET,
      github: githubB,
      sha: SHA,
      cause: "unparseable",
      reason: "a",
    });
    expect(
      await publishReviewNotice({
        ...TARGET,
        github: githubB,
        sha: SHA,
        cause: "agent_unable",
        reason: "b",
      }),
    ).toEqual({ result: "duplicate_at_commit", commentId: 1 });
    expect(githubB.updateConversationComment).not.toHaveBeenCalled();
  });
});
