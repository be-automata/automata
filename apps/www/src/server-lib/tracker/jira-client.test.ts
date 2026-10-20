import { describe, expect, it, vi } from "vitest";

import {
  createJiraClient,
  flattenAdf,
  JIRA_SUBTASK_LINK,
  parseJiraIssue,
  toJiraWikiText,
} from "./jira-client";
import {
  describeTrackerError,
  TrackerConfigError,
  TrackerRequestError,
  TrackerTransitionError,
} from "./youtrack-client";

const BASE = "https://acme.atlassian.net";

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(responses: Array<{ status?: number; body?: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = queue.shift() ?? { status: 204 };
      const status = next.status ?? 200;
      return new Response(
        next.body === undefined ? null : JSON.stringify(next.body),
        { status },
      );
    },
  ) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch) =>
  createJiraClient({
    baseUrl: `${BASE}/`,
    username: "bot@acme.example",
    token: "jira-secret",
    fetchImpl,
  });

const adf = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string) => ({ type: "text", text });

const status = (name: string, category = "indeterminate") => ({
  name,
  statusCategory: { key: category },
});

const rawIssue = {
  key: "ACME-1",
  fields: {
    summary: "Void predictions",
    status: status("In Progress"),
    description: adf(
      {
        type: "heading",
        attrs: { level: 2 },
        content: [t("Acceptance Criteria")],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [p(t("AC-1 rejects closed questions"))],
          },
          { type: "listItem", content: [p(t("AC-2 recalculates"))] },
        ],
      },
    ),
    issuelinks: [
      {
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        outwardIssue: {
          key: "ACME-2",
          fields: { summary: "Next", status: status("Backlog", "new") },
        },
      },
      {
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        outwardIssue: {
          key: "ACME-3",
          fields: { summary: "Other", status: status("Done", "done") },
        },
      },
      {
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        inwardIssue: {
          key: "ACME-9",
          fields: { summary: "Before", status: status("Ready for QA") },
        },
      },
    ],
    subtasks: [
      {
        key: "ACME-4",
        fields: { summary: "Child", status: status("To Do", "new") },
      },
    ],
    comment: {
      comments: [
        {
          id: "100",
          body: adf(
            p(
              { type: "mention", attrs: { id: "x", text: "@Dana" } },
              t(" AC-2 deferred to ACME-901"),
            ),
          ),
        },
      ],
    },
  },
};

describe("flattenAdf", () => {
  it("renders paragraphs, headings, lists, code and mentions as plain text", () => {
    const text = flattenAdf(
      adf(
        { type: "heading", attrs: { level: 2 }, content: [t("Scope")] },
        p(t("First line"), { type: "hardBreak" }, t("second line")),
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [p(t("one"))] },
            {
              type: "listItem",
              content: [
                p(t("two")),
                {
                  type: "bulletList",
                  content: [{ type: "listItem", content: [p(t("nested"))] }],
                },
              ],
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [t("const a = 1;")],
        },
        p({ type: "mention", attrs: { text: "@Dana" } }, t(" see "), {
          type: "inlineCard",
          attrs: { url: "https://example.com/x" },
        }),
        {
          type: "panel",
          content: [p(t("inside a panel"))],
        },
      ),
    );
    expect(text).toBe(
      [
        "## Scope",
        "First line\nsecond line",
        "1. one\n2. two\n   - nested",
        "```ts\nconst a = 1;\n```",
        "@Dana see https://example.com/x",
        "inside a panel",
      ].join("\n\n"),
    );
  });

  it("passes a wiki-text string through and reads junk as empty", () => {
    expect(flattenAdf("h2. Plain")).toBe("h2. Plain");
    expect(flattenAdf(null)).toBe("");
    expect(flattenAdf(42)).toBe("");
  });
});

describe("parseJiraIssue", () => {
  it("maps status, Blocks links by direction, sub-tasks and ADF bodies", () => {
    const issue = parseJiraIssue(rawIssue);
    expect(issue.key).toBe("ACME-1");
    expect(issue.stage).toBe("In Progress");
    expect(issue.resolved).toBe(false);
    expect(issue.description).toBe(
      "## Acceptance Criteria\n\n- AC-1 rejects closed questions\n- AC-2 recalculates",
    );
    expect(issue.links).toEqual([
      {
        direction: "OUTWARD",
        typeName: "Blocks",
        verb: "blocks",
        issues: [
          { key: "ACME-2", summary: "Next", stage: "Backlog", resolved: false },
          { key: "ACME-3", summary: "Other", stage: "Done", resolved: true },
        ],
      },
      {
        direction: "INWARD",
        typeName: "Blocks",
        verb: "is blocked by",
        issues: [
          {
            key: "ACME-9",
            summary: "Before",
            stage: "Ready for QA",
            resolved: false,
          },
        ],
      },
      {
        direction: "OUTWARD",
        typeName: JIRA_SUBTASK_LINK,
        verb: "parent for",
        issues: [
          { key: "ACME-4", summary: "Child", stage: "To Do", resolved: false },
        ],
      },
    ]);
    expect(issue.comments).toEqual([
      { id: "100", text: "@Dana AC-2 deferred to ACME-901" },
    ]);
  });

  it("rejects a payload with no key", () => {
    expect(() => parseJiraIssue({ fields: {} })).toThrow(TrackerRequestError);
  });
});

describe("createJiraClient", () => {
  it("getIssue: Basic auth, v3 issue path with the audit fields, no redirects", async () => {
    const { fetchImpl, calls } = mockFetch([{ body: rawIssue }]);
    const issue = await client(fetchImpl).getIssue("ACME-1");
    expect(issue.summary).toBe("Void predictions");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${BASE}/rest/api/3/issue/ACME-1?fields=${encodeURIComponent("summary,description,status,issuelinks,subtasks,comment")}`,
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${btoa("bot@acme.example:jira-secret")}`,
    );
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("getStage reads status.name", async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: { key: "ACME-1", fields: { status: status("Code Review") } } },
    ]);
    expect(await client(fetchImpl).getStage("ACME-1")).toBe("Code Review");
    expect(calls[0]!.url).toBe(`${BASE}/rest/api/3/issue/ACME-1?fields=status`);
  });

  const transitions = {
    transitions: [
      { id: "11", name: "Start", to: { name: "In Progress" } },
      { id: "21", name: "Send to QA", to: { name: "Ready for QA" } },
      { id: "31", name: "Finish", to: { name: "Done" } },
    ],
  };

  it("setStage posts the transition whose destination matches, case-insensitively", async () => {
    const { fetchImpl, calls } = mockFetch([
      { body: transitions },
      { status: 204 },
    ]);
    await client(fetchImpl).setStage("ACME-1", "ready for qa");
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", `${BASE}/rest/api/3/issue/ACME-1/transitions`],
      ["POST", `${BASE}/rest/api/3/issue/ACME-1/transitions`],
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      transition: { id: "21" },
    });
  });

  it("setStage with no matching transition throws a typed error and writes nothing", async () => {
    const { fetchImpl, calls } = mockFetch([{ body: transitions }]);
    const error = await client(fetchImpl)
      .setStage("ACME-1", "Code Review")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerTransitionError);
    expect(describeTrackerError(error)).toBe(
      "no transition to Code Review is available",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("listStageTargets returns the reachable destination statuses", async () => {
    const { fetchImpl } = mockFetch([{ body: transitions }]);
    expect(await client(fetchImpl).listStageTargets!("ACME-1")).toEqual([
      "In Progress",
      "Ready for QA",
      "Done",
    ]);
  });

  it("addComment posts a v2 wiki body", async () => {
    const { fetchImpl, calls } = mockFetch([
      { status: 201, body: { id: "1" } },
    ]);
    await client(fetchImpl).addComment(
      "ACME-1",
      "PR merged: https://github.com/acme-inc/acme-core/pull/7\n\n[Full audit with evidence on the PR](https://github.com/acme-inc/acme-core/pull/7)",
    );
    expect(calls[0]!.url).toBe(`${BASE}/rest/api/2/issue/ACME-1/comment`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      body: "PR merged: https://github.com/acme-inc/acme-core/pull/7\n\n[Full audit with evidence on the PR|https://github.com/acme-inc/acme-core/pull/7]",
    });
  });

  it("surfaces a non-2xx (including a redirect) as status only", async () => {
    const { fetchImpl } = mockFetch([{ status: 302 }]);
    const error = await client(fetchImpl)
      .getIssue("ACME-1")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerRequestError);
    expect(describeTrackerError(error)).toBe("issue fetch failed (HTTP 302)");
  });

  it("refuses a malformed key before any request", async () => {
    const { fetchImpl, calls } = mockFetch([]);
    await expect(
      client(fetchImpl).getIssue("../../admin"),
    ).rejects.toBeInstanceOf(TrackerConfigError);
    expect(calls).toHaveLength(0);
  });

  it("issueUrl is the browse link", () => {
    expect(client(mockFetch([]).fetchImpl).issueUrl("ACME-1")).toBe(
      `${BASE}/browse/ACME-1`,
    );
  });

  it("rejects an unsafe base URL", () => {
    expect(() =>
      createJiraClient({
        baseUrl: "http://10.0.0.1",
        username: "u",
        token: "t",
      }),
    ).toThrow(TrackerConfigError);
  });
});

describe("toJiraWikiText", () => {
  it("rewrites only unescaped https Markdown links", () => {
    expect(
      toJiraWikiText("see [docs](https://x.example/a) and \\[x\\](y)"),
    ).toBe("see [docs|https://x.example/a] and \\[x\\](y)");
  });
});
