import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import type { BreakerRow } from "@terragon/shared/model/self-heal-breaker";

import { createIssueWriter } from "./issue-writer";
import type {
  SelfHealBreakerOps,
  SelfHealCallDeps,
} from "./with-self-heal-call";

const ORG = "org-1";
const BOT = "automata[bot]";
const FP = "fp-abc";
const marker = (fp: string) => `<!-- automata-finding:v1 fp=${fp} -->`;

function closedRow(scopeKind: "github_read" | "github_write"): BreakerRow {
  return {
    id: "",
    organizationId: ORG,
    scopeKind,
    scopeKey: "42",
    state: "closed",
    openedAt: null,
    openUntil: null,
    halfOpenProbesLeft: 0,
    probeInFlightUntil: null,
    tripCount: 0,
    lastTripReason: null,
    lastTripEvidence: null,
    rateLimitedUntil: null,
    version: -1,
    updatedAt: new Date(0),
  };
}

function rawIssue(
  number: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    state: "open",
    state_reason: null,
    labels: [{ name: "automata:finding" }],
    body: `${marker(`fp-${number}`)}\nbody`,
    created_at: "2026-10-04T00:00:00Z",
    user: { login: BOT },
    ...over,
  };
}

function res<T>(data: T) {
  return { data, status: 200, headers: {} };
}

function httpError(status: number, message = "boom") {
  return Object.assign(new Error(message), { status });
}

function setup() {
  const issues = {
    listForRepo: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    createLabel: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    listComments: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
  };
  const repos = { get: vi.fn() };
  const octokit = { rest: { issues, repos } } as unknown as Octokit;
  const breaker = {
    getBreakerState: vi.fn(
      async (a: { scopeKind: "github_read" | "github_write" }) =>
        closedRow(a.scopeKind),
    ),
    recordBreakerEvent: vi.fn(async (_a: { signal: string }) => undefined),
    evaluateApiBreaker: vi.fn(async () => null),
    extendRateLimitedUntil: vi.fn(async () => undefined),
    setPermissionLatch: vi.fn(async () => undefined),
    acquireHalfOpenProbe: vi.fn(async () => true),
  };
  const deps: SelfHealCallDeps = {
    db: {} as DB,
    now: () => new Date(),
    log: () => undefined,
    sleep: async () => undefined,
    rand: () => 0.5,
    breaker: breaker as unknown as SelfHealBreakerOps,
  };
  const writer = createIssueWriter({
    octokit,
    owner: "acme",
    repo: "widgets",
    botLogin: BOT,
    organizationId: ORG,
    installationKey: "42",
    deadlineAt: new Date(Date.now() + 60_000),
    deps,
  });
  return { writer, issues, repos, breaker };
}

function page(from: number, count: number) {
  return res(Array.from({ length: count }, (_, i) => rawIssue(from + i)));
}

describe("createIssueWriter.readIssueStates", () => {
  it("builds the map from two pages and fetches an absent ledger number once", async () => {
    const { writer, issues } = setup();
    issues.listForRepo
      .mockResolvedValueOnce(page(1, 100))
      .mockResolvedValueOnce(page(101, 3));
    issues.get.mockResolvedValueOnce(
      res(rawIssue(500, { state: "closed", state_reason: "completed" })),
    );
    const map = await writer.readIssueStates([1, 500]);
    expect(map?.size).toBe(104);
    expect(map?.get(500)).toEqual({
      state: "closed",
      stateReason: "completed",
      labels: ["automata:finding"],
    });
    expect(issues.listForRepo).toHaveBeenCalledTimes(2);
    expect(issues.get).toHaveBeenCalledTimes(1);
    expect(issues.listForRepo.mock.calls[0]?.[0]).toMatchObject({
      labels: "automata:finding",
      state: "open",
    });
  });

  it("returns null when a sixth page would be needed", async () => {
    const { writer, issues } = setup();
    issues.listForRepo.mockImplementation(async (a: { page: number }) =>
      page((a.page - 1) * 100 + 1, 100),
    );
    expect(await writer.readIssueStates([])).toBeNull();
    expect(issues.listForRepo).toHaveBeenCalledTimes(5);
  });

  it("returns null when more than 20 per-number gets are needed", async () => {
    const { writer, issues } = setup();
    issues.listForRepo.mockResolvedValueOnce(res([]));
    const numbers = Array.from({ length: 21 }, (_, i) => 1000 + i);
    expect(await writer.readIssueStates(numbers)).toBeNull();
    expect(issues.get).not.toHaveBeenCalled();
  });

  it("returns null when a listing call fails with a server error", async () => {
    const { writer, issues } = setup();
    issues.listForRepo.mockRejectedValue(httpError(500));
    expect(await writer.readIssueStates([])).toBeNull();
  });

  it("excludes non-bot authors, issues without a line-1 marker and pull requests", async () => {
    const { writer, issues } = setup();
    issues.listForRepo.mockResolvedValueOnce(
      res([
        rawIssue(1),
        rawIssue(2, { user: { login: "mallory" } }),
        rawIssue(3, { body: `intro\n${marker("fp-3")}` }),
        rawIssue(4, { pull_request: { url: "x" } }),
      ]),
    );
    const map = await writer.readIssueStates([]);
    expect([...(map?.keys() ?? [])]).toEqual([1]);
  });
});

describe("createIssueWriter.findByMarkerSince", () => {
  it("returns the bot issue number, null when none, unknown on failure", async () => {
    const { writer, issues } = setup();
    issues.listForRepo.mockResolvedValue(
      res([
        rawIssue(7, { body: `${marker(FP)}\nx` }),
        rawIssue(8, { body: `${marker(FP)}\nx`, user: { login: "mallory" } }),
      ]),
    );
    const since = new Date("2026-10-04T00:00:00Z");
    expect(await writer.findByMarkerSince(FP, since)).toBe(7);
    expect(await writer.findByMarkerSince("other", since)).toBeNull();
    expect(issues.listForRepo.mock.calls[0]?.[0]).toMatchObject({
      since: since.toISOString(),
    });
    issues.listForRepo.mockRejectedValue(httpError(503));
    expect(await writer.findByMarkerSince(FP, since)).toBe("unknown");
  });
});

describe("createIssueWriter.upsertComment", () => {
  const MARK = "<!-- automata-finding-comment:v1 fp=a kind=x run=r -->";

  it("updates an existing bot comment with the marker; never creates", async () => {
    const { writer, issues } = setup();
    issues.listComments.mockResolvedValueOnce(
      res([{ id: 9, body: `${MARK}\nold`, user: { login: BOT } }]),
    );
    issues.updateComment.mockResolvedValueOnce(res({}));
    const result = await writer.upsertComment({
      number: 3,
      marker: MARK,
      body: `${MARK}\nnew`,
    });
    expect(result).toMatchObject({ ok: true, data: "updated" });
    expect(issues.updateComment).toHaveBeenCalledTimes(1);
    expect(issues.createComment).not.toHaveBeenCalled();
  });

  it("ignores a human comment carrying the marker and creates", async () => {
    const { writer, issues } = setup();
    issues.listComments.mockResolvedValueOnce(
      res([{ id: 9, body: `${MARK}\nforged`, user: { login: "mallory" } }]),
    );
    issues.createComment.mockResolvedValueOnce(res({ id: 10 }));
    const result = await writer.upsertComment({
      number: 3,
      marker: MARK,
      body: `${MARK}\nnew`,
    });
    expect(result).toMatchObject({ ok: true, data: "created" });
    expect(issues.updateComment).not.toHaveBeenCalled();
  });
});

describe("createIssueWriter writes", () => {
  it("treats 422 already_exists as success in ensureLabels", async () => {
    const { writer, issues } = setup();
    issues.createLabel
      .mockRejectedValueOnce(httpError(422, "already_exists"))
      .mockResolvedValueOnce(res({}));
    const result = await writer.ensureLabels(["a", "b"]);
    expect(result.ok).toBe(true);
    expect(issues.createLabel).toHaveBeenCalledTimes(2);
  });

  it("routes issue and comment creates through the create path (gh_create) and returns the number", async () => {
    const { writer, issues, breaker } = setup();
    issues.create.mockResolvedValueOnce(res({ number: 77 }));
    issues.listComments.mockResolvedValueOnce(res([]));
    issues.createComment.mockResolvedValueOnce(res({ id: 1 }));
    const created = await writer.createIssue({
      title: "t",
      body: "b",
      labels: ["automata:finding"],
    });
    expect(created).toMatchObject({ ok: true, data: 77 });
    await writer.upsertComment({ number: 77, marker: "m", body: "m\nx" });
    const signals = breaker.recordBreakerEvent.mock.calls.map(
      (c) => c[0].signal,
    );
    expect(signals.filter((s) => s === "gh_create")).toHaveLength(2);
  });

  it("applies labels set-based and closes only when the state differs", async () => {
    const { writer, issues } = setup();
    issues.get.mockResolvedValue(
      res(rawIssue(5, { labels: [{ name: "keep" }, { name: "old" }] })),
    );
    issues.addLabels.mockResolvedValue(res([]));
    issues.removeLabel.mockResolvedValue(res([]));
    await writer.updateIssue({
      number: 5,
      labelsAdd: ["keep", "new"],
      labelsRemove: ["old", "absent"],
    });
    expect(issues.addLabels.mock.calls[0]?.[0]).toMatchObject({
      labels: ["new"],
    });
    expect(issues.removeLabel).toHaveBeenCalledTimes(1);

    await writer.setIssueState({ number: 5, state: "open" });
    expect(issues.update).not.toHaveBeenCalled();
    issues.update.mockResolvedValueOnce(res({}));
    await writer.setIssueState({
      number: 5,
      state: "closed",
      stateReason: "completed",
    });
    expect(issues.update.mock.calls[0]?.[0]).toMatchObject({
      state: "closed",
      state_reason: "completed",
    });
  });

  it("reads repo visibility and reports null on failure", async () => {
    const { writer, repos } = setup();
    repos.get.mockResolvedValueOnce(res({ private: true }));
    expect(await writer.isPrivateRepo()).toBe(true);
    repos.get.mockRejectedValueOnce(httpError(500));
    expect(await writer.isPrivateRepo()).toBeNull();
  });
});
