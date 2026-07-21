import { describe, it, expect, vi } from "vitest";
import { executeReviewFromIntent } from "./execute-review-from-intent";
import {
  toleranceToPolicy,
  DEFAULT_APPROVE_SEVERITY_POLICY,
} from "@terragon/review/severity-policy";
import type {
  GitHubReview,
  ReviewGitHubClient,
} from "@terragon/review/state/review-github-client";

/**
 * The load-bearing per-repo floor test (ADR-036 review floor): the SAME emitted
 * intent posts a DIFFERENT verdict depending on the resolved `approveFloorPolicy`
 * — proving the server-side floor is what decides the external PR verdict, not
 * the LLM's self-issued verdict. `applyApproveSeverityFloor` only ever downgrades
 * a too-generous `approve`; `request_changes` / `comment` pass through untouched.
 */

const BOT = "automata-ai-bot[bot]";
const REPO = "o/r";
const PR = 7;
const HEAD = "head-sha";

function makeGithub(reviews: GitHubReview[] = []) {
  return {
    listReviews: vi.fn(async (_repo: string, _pr: number) => reviews),
    submitReview: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _verdict: "APPROVE" | "REQUEST_CHANGES",
        _body: string,
      ) => {},
    ),
    submitReviewWithComments: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _sha: string,
        _verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
        _body: string,
        _comments: Array<{ path: string; line: number; body: string }>,
      ) => {},
    ),
    dismissReview: vi.fn(
      async (_repo: string, _pr: number, _id: number, _msg: string) => {},
    ),
    postInlineComment: vi.fn(
      async (
        _repo: string,
        _pr: number,
        _path: string,
        _line: number,
        _body: string,
        _sha: string,
      ) => {},
    ),
  } satisfies ReviewGitHubClient;
}

function fenced(obj: unknown): string {
  return `Review done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
}

/** An `approve` intent carrying a single finding of the given severity. */
function approveWith(severity: string) {
  return fenced({
    verdict: "approve",
    commit: HEAD,
    summary: "Looks fine overall.",
    findings: [{ severity, path: "a.ts", line: 3, body: "a nit" }],
  });
}

async function run(
  terminalText: string,
  policy = DEFAULT_APPROVE_SEVERITY_POLICY,
  isDraft = false,
) {
  const github = makeGithub([]);
  const res = await executeReviewFromIntent({
    github,
    repoFullName: REPO,
    prNumber: PR,
    botLogin: BOT,
    currentHeadSha: HEAD,
    terminalText,
    approveFloorPolicy: policy,
    isDraft,
  });
  return { github, res };
}

describe("executeReviewFromIntent — per-repo approve floor", () => {
  it("default (warning) floor: approve + info finding stays APPROVE (info non-gating)", async () => {
    const { github, res } = await run(approveWith("info"));
    expect(res).toMatchObject({ outcome: "posted", verdict: "approve" });
    expect(github.submitReview.mock.calls[0]![2]).toBe("APPROVE");
  });

  it("info tolerance: the SAME approve + info finding is DOWNGRADED to REQUEST_CHANGES", async () => {
    const { github, res } = await run(
      approveWith("info"),
      toleranceToPolicy("info"),
    );
    expect(res).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
    });
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("default (warning) floor: approve + warning finding is DOWNGRADED to REQUEST_CHANGES", async () => {
    const { github, res } = await run(approveWith("warning"));
    expect(res).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
    });
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("error tolerance: approve + warning finding SURFACES as COMMENT (not blocking, not approve)", async () => {
    const { github, res } = await run(
      approveWith("warning"),
      toleranceToPolicy("error"),
    );
    expect(res).toMatchObject({ outcome: "posted", verdict: "comment" });
    // COMMENT routes through submitReviewWithComments, never the verdict path.
    expect(github.submitReviewWithComments).toHaveBeenCalledTimes(1);
    expect(github.submitReviewWithComments.mock.calls[0]![3]).toBe("COMMENT");
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("error tolerance: approve + error finding still BLOCKS (REQUEST_CHANGES)", async () => {
    const { github, res } = await run(
      approveWith("error"),
      toleranceToPolicy("error"),
    );
    expect(res).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
    });
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("the floor never UPGRADES: an emitted request_changes posts REQUEST_CHANGES under a lax (error) tolerance", async () => {
    const rc = fenced({
      verdict: "request_changes",
      commit: HEAD,
      summary: "Real bug.",
      findings: [
        { severity: "info", path: "a.ts", line: 3, body: "still blocking" },
      ],
    });
    const { github, res } = await run(rc, toleranceToPolicy("error"));
    expect(res).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
    });
    expect(github.submitReview.mock.calls[0]![2]).toBe("REQUEST_CHANGES");
  });

  it("draft cap: a blocking floor on a DRAFT PR caps at COMMENT, never a formal request_changes", async () => {
    const { github, res } = await run(
      approveWith("error"),
      DEFAULT_APPROVE_SEVERITY_POLICY,
      true,
    );
    expect(res).toMatchObject({ outcome: "posted", verdict: "comment" });
    expect(github.submitReviewWithComments.mock.calls[0]![3]).toBe("COMMENT");
    expect(github.submitReview).not.toHaveBeenCalled();
  });

  it("no approveFloorPolicy passed → the locked default floor still applies (never a verbatim pass-through)", async () => {
    // A caller that forgets to resolve a policy must NOT get an unfloored approve.
    const github = makeGithub([]);
    const res = await executeReviewFromIntent({
      github,
      repoFullName: REPO,
      prNumber: PR,
      botLogin: BOT,
      currentHeadSha: HEAD,
      terminalText: approveWith("warning"),
    });
    expect(res).toMatchObject({
      outcome: "posted",
      verdict: "request_changes",
    });
  });
});
