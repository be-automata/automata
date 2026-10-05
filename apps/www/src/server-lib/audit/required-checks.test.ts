import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "octokit";

import type { DB } from "@terragon/shared/db";
import type { BreakerRow } from "@terragon/shared/model/self-heal-breaker";

import {
  ALL_CHECKS_SETTLE_MS,
  NO_CI_WINDOW_MS,
  readRequiredChecks,
  selectGateSource,
  summarizeCheckRuns,
  type CheckRunLike,
  type CommitStatusLike,
} from "./required-checks";
import type {
  SelfHealBreakerOps,
  SelfHealCallDeps,
} from "./with-self-heal-call";

const ORG = "org-1";
const KEY = "77";
const NOW = new Date("2026-10-04T12:00:00Z");
const MIN = 60_000;

function closedRow(scopeKind: string, scopeKey: string): BreakerRow {
  return {
    id: "x",
    organizationId: ORG,
    scopeKind: scopeKind as BreakerRow["scopeKind"],
    scopeKey,
    state: "closed",
    openedAt: null,
    openUntil: null,
    halfOpenProbesLeft: 0,
    probeInFlightUntil: null,
    tripCount: 0,
    lastTripReason: null,
    lastTripEvidence: null,
    rateLimitedUntil: null,
    version: 1,
    updatedAt: NOW,
  };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), {
    status,
    response: { headers: {} },
  });
}

function ok<T>(data: T) {
  return { data, status: 200, headers: {} };
}

function fixture({
  branch,
  rules,
}: {
  branch: () => Promise<unknown>;
  rules: () => Promise<unknown>;
}) {
  const breaker = {
    getBreakerState: vi.fn(async (a: { scopeKind: string; scopeKey: string }) =>
      closedRow(a.scopeKind, a.scopeKey),
    ),
    recordBreakerEvent: vi.fn(async () => undefined),
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
    rand: () => 0,
    breaker: breaker as unknown as SelfHealBreakerOps,
  };
  const octokit = {
    rest: {
      repos: {
        getBranch: vi.fn(async () => branch()),
        getBranchRules: vi.fn(async () => rules()),
      },
    },
  };
  const read = () =>
    readRequiredChecks({
      octokit: octokit as unknown as Octokit,
      owner: "acme",
      repo: "widgets",
      defaultBranch: "main",
      organizationId: ORG,
      installationKey: KEY,
      deadlineAt: new Date(Date.now() + 60_000),
      deps,
    });
  return { breaker, octokit, read };
}

describe("readRequiredChecks", () => {
  it("classic protection contexts → names", async () => {
    const f = fixture({
      branch: async () =>
        ok({
          protected: true,
          protection: {
            enabled: true,
            required_status_checks: {
              contexts: ["check", "test"],
              checks: [{ context: "check" }],
            },
          },
        }),
      rules: async () => ok([]),
    });
    expect(await f.read()).toEqual({ names: ["check", "test"] });
  });

  it("ruleset required_status_checks merge with classic, deduplicated", async () => {
    const f = fixture({
      branch: async () =>
        ok({
          protected: true,
          protection: {
            required_status_checks: { contexts: ["test"], checks: [] },
          },
        }),
      rules: async () =>
        ok([
          { type: "pull_request", parameters: {} },
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [
                { context: "lint" },
                { context: "test" },
              ],
            },
          },
        ]),
    });
    expect(await f.read()).toEqual({ names: ["lint", "test"] });
  });

  it("no protection and no rules → names []", async () => {
    const f = fixture({
      branch: async () => ok({ protected: false }),
      rules: async () => ok([]),
    });
    expect(await f.read()).toEqual({ names: [] });
  });

  it("403 (free plan, private repo) and 404 (unprotected) → names [], never a latch", async () => {
    const f = fixture({
      branch: async () => {
        throw httpError(
          403,
          "Upgrade to GitHub Pro or make this repository public to enable this feature.",
        );
      },
      rules: async () => {
        throw httpError(404, "Not Found");
      },
    });
    expect(await f.read()).toEqual({ names: [] });
    expect(f.breaker.setPermissionLatch).not.toHaveBeenCalled();
  });

  it("a timeout → unavailable", async () => {
    const f = fixture({
      branch: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      rules: async () => ok([]),
    });
    expect(await f.read()).toEqual({ unavailable: true });
  });
});

const run = (over: Partial<CheckRunLike> = {}): CheckRunLike => ({
  name: "test",
  status: "completed",
  conclusion: "success",
  completed_at: new Date(NOW.getTime() - 5 * MIN).toISOString(),
  ...over,
});

const status = (over: Partial<CommitStatusLike> = {}): CommitStatusLike => ({
  context: "ci/legacy",
  state: "success",
  updated_at: new Date(NOW.getTime() - 5 * MIN).toISOString(),
  ...over,
});

describe("selectGateSource", () => {
  const pushedAt = new Date(NOW.getTime() - 5 * MIN);

  it("required names → protection", () => {
    expect(
      selectGateSource({
        requiredNames: ["test"],
        checkRuns: [],
        statuses: [],
        pushedAt,
        now: NOW,
      }),
    ).toBe("protection");
  });

  it("no names + 3 check runs → all-checks", () => {
    expect(
      selectGateSource({
        requiredNames: [],
        checkRuns: [run(), run({ name: "lint" }), run({ name: "build" })],
        statuses: [],
        pushedAt,
        now: NOW,
      }),
    ).toBe("all-checks");
  });

  it("no names + only a legacy status → all-checks", () => {
    expect(
      selectGateSource({
        requiredNames: [],
        checkRuns: [],
        statuses: [status()],
        pushedAt,
        now: NOW,
      }),
    ).toBe("all-checks");
  });

  it("no names + no checks at 5 min → pending; at 10 min → finding-check-only", () => {
    const input = {
      requiredNames: [],
      checkRuns: [],
      statuses: [],
    };
    expect(selectGateSource({ ...input, pushedAt, now: NOW })).toBe("pending");
    expect(
      selectGateSource({
        ...input,
        pushedAt: new Date(NOW.getTime() - NO_CI_WINDOW_MS),
        now: NOW,
      }),
    ).toBe("finding-check-only");
  });

  it("protection unavailable (timeout) → pending, never a refusal", () => {
    expect(
      selectGateSource({
        requiredNames: null,
        checkRuns: [run()],
        statuses: [],
        pushedAt: new Date(NOW.getTime() - 30 * MIN),
        now: NOW,
      }),
    ).toBe("pending");
  });
});

describe("summarizeCheckRuns — protection", () => {
  const summarize = (
    checkRuns: CheckRunLike[],
    statuses: CommitStatusLike[] = [],
  ) =>
    summarizeCheckRuns({
      source: "protection",
      required: ["check", "test"],
      checkRuns,
      statuses,
      now: NOW,
    });

  it("all required success → success", () => {
    expect(summarize([run({ name: "check" }), run({ name: "test" })])).toEqual({
      state: "success",
    });
  });

  it("one queued → pending", () => {
    expect(
      summarize([
        run({ name: "check" }),
        run({ name: "test", status: "queued", conclusion: null }),
      ]).state,
    ).toBe("pending");
  });

  it("one failure → failure listing it", () => {
    expect(
      summarize([
        run({ name: "check" }),
        run({ name: "test", conclusion: "failure" }),
      ]),
    ).toEqual({ state: "failure", failing: ["test"] });
  });

  it("timed_out and action_required are failures", () => {
    expect(
      summarize([
        run({ name: "check", conclusion: "timed_out" }),
        run({ name: "test", conclusion: "action_required" }),
      ]),
    ).toEqual({ state: "failure", failing: ["check", "test"] });
  });

  it("one cancelled → infra", () => {
    expect(
      summarize([
        run({ name: "check" }),
        run({ name: "test", conclusion: "cancelled" }),
      ]),
    ).toEqual({ state: "infra", failing: ["test"] });
  });

  it("a required check absent from the runs → pending", () => {
    expect(summarize([run({ name: "check" })]).state).toBe("pending");
  });

  it("a legacy commit status satisfies a required context", () => {
    expect(
      summarize([run({ name: "check" })], [status({ context: "test" })]),
    ).toEqual({ state: "success" });
    expect(
      summarize(
        [run({ name: "check" })],
        [status({ context: "test", state: "error" })],
      ),
    ).toEqual({ state: "failure", failing: ["test"] });
  });

  it("non-required failing checks are ignored", () => {
    expect(
      summarize([
        run({ name: "check" }),
        run({ name: "test" }),
        run({ name: "optional-e2e", conclusion: "failure" }),
      ]),
    ).toEqual({ state: "success" });
  });
});

describe("summarizeCheckRuns — all-checks", () => {
  const summarize = (
    checkRuns: CheckRunLike[],
    statuses: CommitStatusLike[] = [],
  ) =>
    summarizeCheckRuns({
      source: "all-checks",
      required: [],
      checkRuns,
      statuses,
      now: NOW,
    });

  it("success|neutral|skipped and last completion ≥ 2 min ago → success", () => {
    expect(
      summarize([
        run(),
        run({ name: "lint", conclusion: "neutral" }),
        run({
          name: "deploy",
          conclusion: "skipped",
          completed_at: new Date(
            NOW.getTime() - ALL_CHECKS_SETTLE_MS,
          ).toISOString(),
        }),
      ]),
    ).toEqual({ state: "success" });
  });

  it("last completion 30 s ago → pending (settle window)", () => {
    expect(
      summarize([
        run(),
        run({
          name: "lint",
          completed_at: new Date(NOW.getTime() - 30_000).toISOString(),
        }),
      ]).state,
    ).toBe("pending");
  });

  it("a legacy status updated 30 s ago also holds the settle window", () => {
    expect(
      summarize(
        [run()],
        [
          status({
            updated_at: new Date(NOW.getTime() - 30_000).toISOString(),
          }),
        ],
      ).state,
    ).toBe("pending");
  });

  it("any failure → failure", () => {
    expect(
      summarize([run(), run({ name: "lint", conclusion: "failure" })]),
    ).toEqual({ state: "failure", failing: ["lint"] });
    expect(summarize([run()], [status({ state: "failure" })])).toEqual({
      state: "failure",
      failing: ["ci/legacy"],
    });
  });

  it("a cancelled check → infra", () => {
    expect(
      summarize([run(), run({ name: "lint", conclusion: "cancelled" })]),
    ).toEqual({ state: "infra", failing: ["lint"] });
    expect(summarize([run({ conclusion: "startup_failure" })]).state).toBe(
      "infra",
    );
    expect(summarize([run({ conclusion: "stale" })]).state).toBe("infra");
  });

  it("a new check registering after the others completed → pending again", () => {
    expect(
      summarize([
        run(),
        run({ name: "late", status: "queued", conclusion: null }),
      ]).state,
    ).toBe("pending");
  });

  it("a rerun supersedes the earlier run of the same name", () => {
    expect(
      summarize([
        run({ id: 1, conclusion: "failure" }),
        run({ id: 2, conclusion: "success" }),
      ]),
    ).toEqual({ state: "success" });
  });

  it("no checks at all → pending", () => {
    expect(summarize([]).state).toBe("pending");
  });
});
