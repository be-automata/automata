import { describe, expect, it, vi } from "vitest";

import {
  createYouTrackClient,
  normalizeTrackerBaseUrl,
  parseTrackerIssue,
  TrackerConfigError,
  TrackerRequestError,
} from "./youtrack-client";

const BASE = "https://acme.youtrack.cloud";
const TOKEN = "perm:secret-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? "" : JSON.stringify(body), { status });
}

const rawIssue = {
  idReadable: "ACME-812",
  summary: "Void predictions",
  description: "## Acceptance Criteria\n- AC-1 thing",
  resolved: null,
  customFields: [
    { name: "Priority", value: { name: "Major" } },
    { name: "Stage", value: { name: "In Progress" } },
  ],
  links: [
    {
      direction: "OUTWARD",
      linkType: {
        name: "Depend",
        sourceToTarget: "is required for",
        targetToSource: "depends on",
      },
      issues: [
        {
          idReadable: "ACME-820",
          summary: "Dependent",
          resolved: null,
          customFields: [{ name: "Stage", value: { name: "Backlog" } }],
        },
      ],
    },
    {
      direction: "INWARD",
      linkType: {
        name: "Depend",
        sourceToTarget: "is required for",
        targetToSource: "depends on",
      },
      issues: [
        {
          idReadable: "ACME-700",
          summary: "Blocker",
          resolved: 1700000000000,
          customFields: [],
        },
      ],
    },
    {
      direction: "BOTH",
      linkType: { name: "Relates", sourceToTarget: "relates to" },
      issues: [],
    },
  ],
  comments: [{ id: "c1", text: "first" }],
};

describe("normalizeTrackerBaseUrl", () => {
  it("accepts an https hostname and strips a trailing slash", () => {
    expect(normalizeTrackerBaseUrl("https://acme.youtrack.cloud/")).toBe(BASE);
    expect(normalizeTrackerBaseUrl(" https://yt.example.com/youtrack/ ")).toBe(
      "https://yt.example.com/youtrack",
    );
  });

  it.each([
    "http://acme.youtrack.cloud",
    "https://127.0.0.1",
    "https://10.0.0.5:8443",
    "https://[::1]",
    "https://localhost",
    "https://tracker.internal",
    "https://box.local",
    "https://intranet",
    "https://localhost.",
    "https://tracker.internal./",
    "https://0x7f.0.0.1",
    "https://user:pw@acme.youtrack.cloud",
    "not a url",
  ])("rejects %s", (raw) => {
    expect(() => normalizeTrackerBaseUrl(raw)).toThrow(TrackerConfigError);
  });
});

describe("parseTrackerIssue", () => {
  it("reads the Stage field, links with their verb, and comments", () => {
    const issue = parseTrackerIssue(rawIssue);
    expect(issue).toMatchObject({
      key: "ACME-812",
      stage: "In Progress",
      resolved: false,
      comments: [{ id: "c1", text: "first" }],
    });
    // The empty Relates link is dropped.
    expect(issue.links).toHaveLength(2);
    expect(issue.links[0]).toMatchObject({
      direction: "OUTWARD",
      typeName: "Depend",
      verb: "is required for",
      issues: [{ key: "ACME-820", stage: "Backlog", resolved: false }],
    });
    expect(issue.links[1]).toMatchObject({
      direction: "INWARD",
      verb: "depends on",
      issues: [{ key: "ACME-700", stage: null, resolved: true }],
    });
  });

  it("falls back to a stock `State` field", () => {
    const issue = parseTrackerIssue({
      idReadable: "X-1",
      customFields: [{ name: "State", value: { name: "Open" } }],
    });
    expect(issue.stage).toBe("Open");
    expect(issue.description).toBe("");
  });

  it("rejects a payload that is not an issue", () => {
    expect(() => parseTrackerIssue({ error: "nope" })).toThrow(
      TrackerRequestError,
    );
    expect(() => parseTrackerIssue(null)).toThrow(TrackerRequestError);
  });
});

describe("createYouTrackClient", () => {
  it("getIssue sends a bearer GET to the issue path with the field list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(rawIssue));
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
    });

    const issue = await client.getIssue("ACME-812");

    expect(issue.key).toBe("ACME-812");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toMatch(
      /^https:\/\/acme\.youtrack\.cloud\/api\/issues\/ACME-812\?fields=/,
    );
    expect(decodeURIComponent(String(url))).toContain(
      "links(direction,linkType(",
    );
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // "manual", never "error": the Workers runtime throws on "error".
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeUndefined();
  });

  it("setStage posts the command ytctl sends for a stage change", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null));
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
    });

    await client.setStage("ACME-812", "PR Merged");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/commands`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      query: "Stage PR Merged",
      issues: [{ idReadable: "ACME-812" }],
    });
  });

  it("getStage asks for the stage field only — not the whole ticket", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        customFields: [{ name: "Stage", value: { name: "PR Merged" } }],
      }),
    );
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
    });

    expect(await client.getStage("ACME-812")).toBe("PR Merged");
    const requested = decodeURIComponent(String(fetchImpl.mock.calls[0]![0]));
    expect(requested).toBe(
      `${BASE}/api/issues/ACME-812?fields=customFields(name,value(name))`,
    );
  });

  it("uses the caller's timeout", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(rawIssue));
    const spy = vi.spyOn(AbortSignal, "timeout");
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      timeoutMs: 4_000,
      fetchImpl,
    });
    await client.getIssue("ACME-812");
    expect(spy).toHaveBeenCalledWith(4_000);
    spy.mockRestore();
  });

  it("addComment posts {text} to the issue's comments", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "c9" }));
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
    });

    await client.addComment("ACME-812", "hello");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/api/issues/ACME-812/comments?fields=id`);
    expect(JSON.parse(init.body)).toEqual({ text: "hello" });
  });

  it("surfaces only the status on failure — never the response body or the token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(`{"error":"bad ${TOKEN}"}`, { status: 403 }),
      );
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
    });

    const error = await client.getIssue("ACME-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrackerRequestError);
    expect((error as TrackerRequestError).status).toBe(403);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain("bad");
  });

  it("a redirect is an error, and the bearer is not replayed to its target", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example.com/" },
      }),
    );
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
    });
    const error = await client.getIssue("ACME-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrackerRequestError);
    expect((error as TrackerRequestError).status).toBe(302);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a key that is not an issue id before any request is made", async () => {
    const fetchImpl = vi.fn();
    const client = createYouTrackClient({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
    });

    for (const key of [
      "../admin/users",
      "ACME-1/comments",
      "acme-1",
      "ACME-1?x=1",
      "",
    ]) {
      await expect(client.getIssue(key)).rejects.toBeInstanceOf(
        TrackerConfigError,
      );
      await expect(client.getStage(key)).rejects.toBeInstanceOf(
        TrackerConfigError,
      );
      await expect(client.setStage(key, "To Do")).rejects.toBeInstanceOf(
        TrackerConfigError,
      );
      await expect(client.addComment(key, "x")).rejects.toBeInstanceOf(
        TrackerConfigError,
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to be built against a non-https or internal base URL", () => {
    expect(() =>
      createYouTrackClient({
        baseUrl: "http://acme.youtrack.cloud",
        token: TOKEN,
      }),
    ).toThrow(TrackerConfigError);
  });

  it("issueUrl points at the browser page", () => {
    const client = createYouTrackClient({
      baseUrl: `${BASE}/`,
      token: TOKEN,
      fetchImpl: vi.fn(),
    });
    expect(client.issueUrl("ACME-812")).toBe(`${BASE}/issue/ACME-812`);
  });
});
