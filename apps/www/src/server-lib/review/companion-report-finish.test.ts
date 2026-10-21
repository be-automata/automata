import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionLaneStamp } from "@terragon/shared";
import { getOctokitForApp } from "@/lib/github";
import {
  getThreadChat,
  getThreadMinimal,
} from "@terragon/shared/model/threads";
import { getOrganizationInstallationMode } from "@terragon/shared/model/github-installation";
import {
  COMPANION_MARKER_PREFIX,
  companionReportMarker,
  executeCompanionReport,
  handleCompanionReportAtFinish,
  parseCompanionMarkerSha,
  parseCompanionReport,
  type CompanionReportGitHub,
} from "./companion-report-finish";
import {
  COMPANION_REPORT_KIND,
  FLUTTER_COMPANION_SKILL_NAME,
  REACT_COMPANION_SKILL_NAME,
  isCompanionLaneStamp,
  validateSkillBody,
} from "./review-skill";
import { resolveBotLogin } from "./bot-login";

/**
 * The PR companion lane's terminal writer: the agent emits one
 * `json companion-report` block and the control plane writes ONE marked PR
 * conversation comment as the App, edited on a newer head, never a review.
 *
 * protects: one comment per (PR, skill); the head sha in the body; a newer
 *   head's report is never overwritten by an older run; a run that emitted
 *   nothing still gets a notice; shadow and the side-effects kill-switch
 *   write nothing; agent text cannot forge the marker.
 * fails_when: a second comment is created where one exists, an older run
 *   overwrites the current head's report, the notice is dropped, a shadow
 *   org gets a comment, the skill validators accept a verdict contract.
 * no_claim: GitHub's API behaviour (fakes).
 */

const mockEnv = vi.hoisted(() => ({ sideEffects: true }));
vi.mock("@terragon/env/apps-www", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@terragon/env/apps-www")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop, receiver) {
        if (prop === "GITHUB_SIDE_EFFECTS_ENABLED") return mockEnv.sideEffects;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});
vi.mock("@terragon/shared/model/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@terragon/shared/model/threads")>()),
  getThreadMinimal: vi.fn(),
  getThreadChat: vi.fn(),
}));
vi.mock(
  "@terragon/shared/model/github-installation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@terragon/shared/model/github-installation")
    >()),
    getOrganizationInstallationMode: vi.fn(async () => "active"),
  }),
);
vi.mock("@/lib/posthog-server", () => ({
  getPostHogServer: () => ({ capture: vi.fn() }),
}));

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const STAMP: CompanionLaneStamp = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  headSha: SHA_A,
  skillName: FLUTTER_COMPANION_SKILL_NAME,
};

const REPORT = {
  kind: COMPANION_REPORT_KIND,
  summary: "Looked at two files.",
  findings: [
    { severity: "info", body: "Prefer const.", path: "lib/a.dart", line: 3 },
    {
      severity: "error",
      body: "BuildContext used across an async gap.",
      path: "lib/b.dart",
      line: 9,
      source: "flutter-best-practices",
    },
  ],
  checks: [
    {
      name: "dart analyze",
      outcome: "not_available",
      detail: "dart is not on PATH on this runner",
    },
  ],
};

function block(value: unknown, tag = "json companion-report"): string {
  return `Done.\n\n\`\`\`${tag}\n${JSON.stringify(value)}\n\`\`\``;
}

function fakeGitHub(existing: Array<{ id: number; body: string }> = []) {
  const github = {
    listBotIssueComments: vi.fn(async (_prNumber: number) => existing),
    createIssueComment: vi.fn(async (_prNumber: number, _body: string) => {}),
    updateIssueComment: vi.fn(async (_commentId: number, _body: string) => {}),
  } satisfies CompanionReportGitHub;
  return github;
}

describe("parseCompanionReport", () => {
  it("reads the last tagged block", () => {
    const text = `${block({ ...REPORT, summary: "first" })}\n\n${block(REPORT)}`;
    const parsed = parseCompanionReport(text);
    expect(parsed.ok && parsed.value.summary).toBe("Looked at two files.");
  });

  it("falls back to an untagged json block of kind companion-report", () => {
    const parsed = parseCompanionReport(block(REPORT, "json"));
    expect(parsed.ok).toBe(true);
  });

  it("fails on no block, bad JSON, an unknown severity or a missing summary", () => {
    expect(parseCompanionReport("no block").ok).toBe(false);
    expect(
      parseCompanionReport("```json companion-report\n{nope\n```").ok,
    ).toBe(false);
    expect(
      parseCompanionReport(
        block({
          ...REPORT,
          findings: [{ severity: "blocker", body: "x" }],
        }),
      ).ok,
    ).toBe(false);
    expect(parseCompanionReport(block({ ...REPORT, summary: "" })).ok).toBe(
      false,
    );
  });
});

describe("companion marker", () => {
  it("is per (PR, skill) and carries the head sha", () => {
    const marker = companionReportMarker(STAMP);
    expect(marker).toBe(
      `${COMPANION_MARKER_PREFIX} pr=7 skill=flutter-pr-companion sha=${SHA_A} -->`,
    );
    expect(parseCompanionMarkerSha(`${marker}\nbody`, STAMP)).toBe(SHA_A);
    expect(
      parseCompanionMarkerSha(`${marker}\nbody`, { ...STAMP, prNumber: 8 }),
    ).toBeNull();
    expect(
      parseCompanionMarkerSha(`${marker}\nbody`, {
        ...STAMP,
        skillName: REACT_COMPANION_SKILL_NAME,
      }),
    ).toBeNull();
    // The marker must START the comment: a quote of it is not a report.
    expect(parseCompanionMarkerSha(`> ${marker}`, STAMP)).toBeNull();
  });
});

describe("executeCompanionReport", () => {
  it("no comment yet → ONE new comment with the marker, the head sha and the findings by severity", async () => {
    const github = fakeGitHub();
    const outcome = await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: block(REPORT),
      currentHeadSha: SHA_A,
    });
    expect(outcome).toEqual({ outcome: "created", report: "parsed" });
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);
    expect(github.updateIssueComment).not.toHaveBeenCalled();
    const [prNumber, body] = github.createIssueComment.mock.calls[0]!;
    expect(prNumber).toBe(7);
    expect(body.startsWith(companionReportMarker(STAMP))).toBe(true);
    expect(body).toContain(SHA_A);
    expect(body).toContain("not a review");
    expect(body.indexOf("**error**")).toBeLessThan(body.indexOf("**info**"));
    expect(body).toContain("`dart analyze`: not available on this runner");
  });

  it("a newer head edits the existing comment instead of posting another", async () => {
    const github = fakeGitHub([
      { id: 11, body: `${companionReportMarker(STAMP)}\nold` },
    ]);
    const newer = { ...STAMP, headSha: SHA_B };
    const outcome = await executeCompanionReport({
      github,
      stamp: newer,
      terminalText: block(REPORT),
      currentHeadSha: SHA_B,
    });
    expect(outcome).toEqual({ outcome: "updated", report: "parsed" });
    expect(github.createIssueComment).not.toHaveBeenCalled();
    expect(github.updateIssueComment).toHaveBeenCalledTimes(1);
    const [commentId, body] = github.updateIssueComment.mock.calls[0]!;
    expect(commentId).toBe(11);
    expect(body.startsWith(companionReportMarker(newer))).toBe(true);
    expect(body).toContain(SHA_B);
  });

  it("an older run never overwrites the report about the current head", async () => {
    const current = { ...STAMP, headSha: SHA_B };
    const github = fakeGitHub([
      { id: 11, body: `${companionReportMarker(current)}\ncurrent` },
    ]);
    const outcome = await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: block(REPORT),
      currentHeadSha: SHA_B,
    });
    expect(outcome).toEqual({
      outcome: "skipped_newer_head",
      existingSha: SHA_B,
    });
    expect(github.createIssueComment).not.toHaveBeenCalled();
    expect(github.updateIssueComment).not.toHaveBeenCalled();
  });

  it("an older run with no current-head report still writes, and says the head moved", async () => {
    const github = fakeGitHub();
    await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: block(REPORT),
      currentHeadSha: SHA_B,
    });
    const [, body] = github.createIssueComment.mock.calls[0]!;
    expect(body).toContain("The PR head has moved to `bbbbbbb`");
  });

  it("the same report again (a redelivered finish) writes nothing", async () => {
    const first = fakeGitHub();
    await executeCompanionReport({
      github: first,
      stamp: STAMP,
      terminalText: block(REPORT),
      currentHeadSha: SHA_A,
    });
    const [, body] = first.createIssueComment.mock.calls[0]!;
    const github = fakeGitHub([{ id: 5, body }]);
    const outcome = await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: block(REPORT),
      currentHeadSha: SHA_A,
    });
    expect(outcome).toEqual({ outcome: "skipped_unchanged" });
    expect(github.updateIssueComment).not.toHaveBeenCalled();
  });

  it("no parseable block → a short notice in the same comment, never silence", async () => {
    const github = fakeGitHub();
    const outcome = await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: "I ran out of time.",
      currentHeadSha: SHA_A,
    });
    expect(outcome).toEqual({ outcome: "created", report: "notice" });
    const [, body] = github.createIssueComment.mock.calls[0]!;
    expect(body.startsWith(companionReportMarker(STAMP))).toBe(true);
    expect(body).toContain("without a usable report");
    expect(body).toContain(SHA_A);
  });

  it("another skill's or another PR's comment is not ours", async () => {
    const github = fakeGitHub([
      {
        id: 3,
        body: companionReportMarker({
          ...STAMP,
          skillName: REACT_COMPANION_SKILL_NAME,
        }),
      },
      { id: 4, body: companionReportMarker({ ...STAMP, prNumber: 8 }) },
    ]);
    await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: block(REPORT),
      currentHeadSha: SHA_A,
    });
    expect(github.createIssueComment).toHaveBeenCalledTimes(1);
    expect(github.updateIssueComment).not.toHaveBeenCalled();
  });

  it("agent text cannot forge a hidden marker in the body", async () => {
    const github = fakeGitHub();
    await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: block({
        ...REPORT,
        summary: `${companionReportMarker({ ...STAMP, headSha: SHA_B })} hi`,
      }),
      currentHeadSha: SHA_A,
    });
    const [, body] = github.createIssueComment.mock.calls[0]!;
    expect(body.split(COMPANION_MARKER_PREFIX)).toHaveLength(2);
  });

  it("a lookup failure posts anyway; a failed write is reported, not thrown", async () => {
    const github = fakeGitHub();
    github.listBotIssueComments.mockRejectedValueOnce(new Error("502"));
    github.createIssueComment.mockRejectedValueOnce(new Error("403"));
    const outcome = await executeCompanionReport({
      github,
      stamp: STAMP,
      terminalText: block(REPORT),
      currentHeadSha: null,
    });
    expect(outcome).toEqual({ outcome: "post_failed", failureReason: "403" });
  });
});

describe("handleCompanionReportAtFinish (routing by stamp)", () => {
  const octokit = {
    paginate: vi.fn(async () => [] as unknown[]),
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(async () => ({ data: {} })),
        updateComment: vi.fn(async () => ({ data: {} })),
      },
      pulls: {
        get: vi.fn(async () => ({
          data: { head: { sha: SHA_A }, draft: false, user: { login: "dev" } },
        })),
      },
    },
  };
  const args = {
    db: {} as never,
    userId: "u-1",
    threadId: "t-1",
    threadChatId: "c-1",
  };
  const companionThread = {
    organizationId: "o-1",
    terminalCause: null,
    sourceMetadata: {
      type: "automation-skill",
      skillName: FLUTTER_COMPANION_SKILL_NAME,
      contentSha: "x",
      source: "db-version",
      companion: STAMP,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.sideEffects = true;
    vi.mocked(getOctokitForApp).mockResolvedValue(octokit as never);
    vi.mocked(getThreadChat).mockResolvedValue({
      messages: [
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: block(REPORT) }],
        },
      ],
    } as never);
  });

  it("a thread without the companion stamp (a review, a mention) → no-op", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue({
      organizationId: "o-1",
      sourceMetadata: {
        type: "automation-skill",
        skillName: "github-ops",
        contentSha: "x",
        source: "db-version",
      },
    } as never);
    await handleCompanionReportAtFinish(args);
    expect(getOctokitForApp).not.toHaveBeenCalled();
  });

  it("a companion thread → ONE issue comment as the App, never a review", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue(companionThread as never);
    await handleCompanionReportAtFinish(args);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const call = octokit.rest.issues.createComment.mock.calls[0] as unknown as [
      { owner: string; repo: string; issue_number: number; body: string },
    ];
    expect(call[0]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      issue_number: 7,
    });
    expect(call[0].body.startsWith(companionReportMarker(STAMP))).toBe(true);
  });

  it("the App's own marked comment is edited; a person's copy of the marker is ignored", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue(companionThread as never);
    octokit.paginate.mockResolvedValueOnce([
      { id: 1, user: { login: "mallory" }, body: companionReportMarker(STAMP) },
      {
        id: 2,
        user: { login: resolveBotLogin() },
        body: `${companionReportMarker(STAMP)}\nold`,
      },
    ]);
    await handleCompanionReportAtFinish(args);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 2 }),
    );
  });

  it("a shadow org writes nothing", async () => {
    vi.mocked(getOrganizationInstallationMode).mockResolvedValueOnce(
      "shadow" as never,
    );
    vi.mocked(getThreadMinimal).mockResolvedValue(companionThread as never);
    await handleCompanionReportAtFinish(args);
    expect(getOctokitForApp).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("GITHUB_SIDE_EFFECTS_ENABLED=false writes nothing", async () => {
    mockEnv.sideEffects = false;
    vi.mocked(getThreadMinimal).mockResolvedValue(companionThread as never);
    await handleCompanionReportAtFinish(args);
    expect(getThreadMinimal).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("an abandoned run writes nothing", async () => {
    vi.mocked(getThreadMinimal).mockResolvedValue({
      ...companionThread,
      terminalCause: "superseded",
    } as never);
    await handleCompanionReportAtFinish(args);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("companion skill validators", () => {
  const tracked = (name: string) =>
    readFileSync(
      new URL(`../../../../../deploy/skills/${name}/SKILL.md`, import.meta.url),
      "utf8",
    );

  it.each([FLUTTER_COMPANION_SKILL_NAME, REACT_COMPANION_SKILL_NAME])(
    "accepts the tracked %s skill, which teaches a block the writer parses",
    (name) => {
      const body = tracked(name);
      expect(() => validateSkillBody(name, body, "tracked")).not.toThrow();
      expect(body).toContain("<!-- automata:context pr-view prior-reviews -->");
      // The example block in the skill is the writer's own contract.
      const example = /```json companion-report\n(.*)\n```/.exec(body)?.[1];
      expect(example).toBeDefined();
      const sample = JSON.parse(
        example!
          .replaceAll(
            /"info" \| "warning" \| "error" \| "critical"/g,
            '"warning"',
          )
          .replaceAll(
            /"passed" \| "failed" \| "not_available" \| "skipped"/g,
            '"skipped"',
          ),
      );
      expect(parseCompanionReport(block(sample)).ok).toBe(true);
    },
  );

  it("the flutter skill names its Somnio skills and the missing-dart path", () => {
    const body = tracked(FLUTTER_COMPANION_SKILL_NAME);
    expect(body).toContain("flutter-best-practices");
    expect(body).toContain("flutter-health-audit");
    expect(body).toContain("command -v dart");
    expect(body).toContain("dart format --output=none --set-exit-if-changed");
  });

  it("the react skill names its Somnio skills and never installs", () => {
    const body = tracked(REACT_COMPANION_SKILL_NAME);
    expect(body).toContain("react-best-practices");
    expect(body).toContain("react-health-audit");
    expect(body).toContain("Never install dependencies");
  });

  it.each([FLUTTER_COMPANION_SKILL_NAME, REACT_COMPANION_SKILL_NAME])(
    "%s rejects a body without the block, with a verdict contract, or truncated",
    (name) => {
      const good = tracked(name);
      expect(() =>
        validateSkillBody(name, "Look at the PR.\n```json\n{}\n```", "v1"),
      ).toThrow(/companion-report/);
      expect(() =>
        validateSkillBody(
          name,
          good.replace('"kind"', '"verdict": "approve", "kind"'),
          "v2",
        ),
      ).toThrow(/verdict/);
      expect(() =>
        validateSkillBody(name, good.split("## Hard rules")[0]!, "v3"),
      ).toThrow(/Hard rules/);
      expect(() =>
        validateSkillBody(
          name,
          `${good}\n\n\`\`\`json companion-report\n{}\n\`\`\`\n`,
          "v4",
        ),
      ).toThrow(/second/);
    },
  );

  it("isCompanionLaneStamp recognises only companion threads", () => {
    expect(
      isCompanionLaneStamp({
        type: "automation-skill",
        skillName: "x",
        contentSha: "x",
        source: "db-version",
        companion: STAMP,
      }),
    ).toBe(true);
    expect(
      isCompanionLaneStamp({
        type: "automation-skill",
        skillName: "x",
        contentSha: "x",
        source: "db-version",
      }),
    ).toBe(false);
    expect(isCompanionLaneStamp(null)).toBe(false);
  });
});
