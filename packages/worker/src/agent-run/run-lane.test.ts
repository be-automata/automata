import { describe, expect, it } from "vitest";

import { formatRunStartLine, resolveRunLane } from "./run-lane";

const base = {
  repoFullName: "acme/widgets",
  branch: "feat/x",
};

describe("resolveRunLane (UAT #229 F2)", () => {
  it("a review-plan run (prKey + policy snapshot) is the review lane", () => {
    expect(
      resolveRunLane({
        prNumber: 229,
        prKey: "org_1/acme/widgets/229",
        supersedePolicy: "newest-wins",
      }),
    ).toBe("review");
  });

  it("a PR-scoped run without the review plan (e.g. a mention) is the pr lane", () => {
    expect(resolveRunLane({ prNumber: 229 })).toBe("pr");
  });

  it("a run with no PR is a task", () => {
    expect(resolveRunLane({})).toBe("task");
  });
});

describe("formatRunStartLine (UAT #229 F2)", () => {
  it("names lane, PR, repo, branch and policy on a review run", () => {
    expect(
      formatRunStartLine({
        ...base,
        prNumber: 229,
        prKey: "org_1/acme/widgets/229",
        supersedePolicy: "newest-wins",
      }),
    ).toBe(
      "run start: lane=review pr=229 repo=acme/widgets branch=feat/x policy=newest-wins",
    );
  });

  it("omits pr and policy when the run has neither", () => {
    expect(formatRunStartLine(base)).toBe(
      "run start: lane=task repo=acme/widgets branch=feat/x",
    );
  });

  it("never echoes the run's tokens even when handed the whole input", () => {
    const input = {
      ...base,
      threadId: "thr_1",
      threadChatId: "chat_1",
      daemonCallbackUrl: "https://example.test",
      installationToken: "ghs_SECRET_INSTALL",
      daemonToken: "dmn_SECRET_DAEMON",
      orgId: "org_1",
      prNumber: 7,
    };
    const line = formatRunStartLine(input);
    expect(line).toBe(
      "run start: lane=pr pr=7 repo=acme/widgets branch=feat/x",
    );
    expect(line).not.toContain("SECRET");
  });
});

describe("formatRunStartLine lane tag for self-heal (OBS-01)", () => {
  it("tags an audit-stamped run lane=self-heal-audit", () => {
    const line = formatRunStartLine({
      ...base,
      selfHeal: { kind: "audit", checks: [], checkToken: "TOKEN_SENTINEL" },
    });
    expect(line).toBe(
      "run start: lane=self-heal-audit repo=acme/widgets branch=feat/x",
    );
    expect(line).not.toContain("TOKEN_SENTINEL");
  });

  it("keeps lane=review and lane=task for other runs", () => {
    expect(formatRunStartLine({ ...base, prKey: "k" })).toContain(
      "lane=review",
    );
    expect(formatRunStartLine(base)).toContain("lane=task");
  });
});
