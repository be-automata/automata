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
