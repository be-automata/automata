import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DB } from "@terragon/shared/db";
import type { BreakerRow } from "@terragon/shared/model/self-heal-breaker";

import {
  classifyGithubOutcome,
  SELF_HEAL_CALL_TIMEOUTS,
  withSelfHealCall,
  type GithubResponse,
  type SelfHealBreakerOps,
  type SelfHealCallDeps,
} from "./with-self-heal-call";

const ORG = "org-1";
const KEY = "inst-1";

function closedRow(overrides: Partial<BreakerRow> = {}): BreakerRow {
  return {
    id: "",
    organizationId: ORG,
    scopeKind: "github_write",
    scopeKey: KEY,
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
    ...overrides,
  };
}

function makeFixture(rows: Partial<Record<string, BreakerRow>> = {}) {
  const breaker = {
    getBreakerState: vi.fn(async (a: { scopeKind: string }) => {
      return (
        rows[a.scopeKind] ?? closedRow({ scopeKind: a.scopeKind as never })
      );
    }),
    recordBreakerEvent: vi.fn(async () => undefined),
    evaluateApiBreaker: vi.fn(async () => null),
    extendRateLimitedUntil: vi.fn(async (_a: { until: Date }) => undefined),
    setPermissionLatch: vi.fn(async () => undefined),
    acquireHalfOpenProbe: vi.fn(async () => true),
  };
  const sleep = vi.fn(async (_ms: number) => undefined);
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const deps: SelfHealCallDeps = {
    db: {} as DB,
    now: () => new Date(),
    log: (message, fields) => logs.push({ message, fields }),
    sleep,
    rand: () => 0.5,
    breaker: breaker as unknown as SelfHealBreakerOps,
  };
  return { breaker, sleep, logs, deps };
}

function ok<T>(
  data: T,
  headers: GithubResponse<T>["headers"] = {},
): GithubResponse<T> {
  return { data, status: 200, headers };
}

function httpError(
  status: number,
  message = "err",
  headers: Record<string, string> = {},
) {
  return Object.assign(new Error(message), { status, response: { headers } });
}

const NOW = new Date("2026-10-04T12:00:00Z");

describe("withSelfHealCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = (deadlineMs = 30_000) => ({
    organizationId: ORG,
    installationKey: KEY,
    signalName: "gh_create",
    deadlineAt: new Date(NOW.getTime() + deadlineMs),
  });

  it("RES-05: a hung create rejects at the create timeout, classified timeout", async () => {
    const f = makeFixture();
    let seen: AbortSignal | undefined;
    const call = vi.fn(
      (signal: AbortSignal) =>
        new Promise<GithubResponse<unknown>>(() => {
          seen = signal;
        }),
    );
    const promise = withSelfHealCall({
      ...base(),
      kind: "create",
      call,
      deps: f.deps,
    });
    await vi.advanceTimersByTimeAsync(SELF_HEAL_CALL_TIMEOUTS.create + 1);
    await expect(promise).resolves.toEqual({ ok: false, outcome: "timeout" });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(f.breaker.recordBreakerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "timeout", signal: "gh_timeout" }),
    );
  });

  it("returns deadline with zero calls when under 1 s is left", async () => {
    const f = makeFixture();
    const call = vi.fn();
    const r = await withSelfHealCall({
      ...base(500),
      kind: "create",
      call,
      deps: f.deps,
    });
    expect(r).toEqual({ ok: false, outcome: "deadline" });
    expect(call).not.toHaveBeenCalled();
  });

  it("an open breaker blocks without any call", async () => {
    const f = makeFixture({
      github_write: closedRow({
        state: "open",
        openUntil: new Date(NOW.getTime() + 60_000),
      }),
    });
    const call = vi.fn();
    const r = await withSelfHealCall({
      ...base(),
      kind: "create",
      call,
      deps: f.deps,
    });
    expect(r).toMatchObject({ ok: false, outcome: "breaker_open" });
    expect(call).not.toHaveBeenCalled();
  });

  it("a future rate_limited_until blocks without any call", async () => {
    const f = makeFixture({
      github_write: closedRow({
        rateLimitedUntil: new Date(NOW.getTime() + 90_000),
      }),
    });
    const call = vi.fn();
    const r = await withSelfHealCall({
      ...base(),
      kind: "read",
      signalName: "gh_list",
      call,
      deps: f.deps,
    });
    expect(r).toMatchObject({ ok: false, outcome: "rate_limited" });
    expect(call).not.toHaveBeenCalled();
  });

  it("RES-03 unit: secondary limit extends the horizon by max(Retry-After,60)s x jitter, no sleep", async () => {
    const f = makeFixture();
    const call = vi.fn(async () => {
      throw httpError(403, "You have exceeded a secondary rate limit", {
        "retry-after": "120",
      });
    });
    const r = await withSelfHealCall({
      ...base(),
      kind: "create",
      call,
      deps: f.deps,
    });
    expect(r).toMatchObject({
      ok: false,
      outcome: "rate_limited",
      status: 403,
    });
    const until = f.breaker.extendRateLimitedUntil.mock.calls[0]![0].until;
    const deltaS = (until.getTime() - NOW.getTime()) / 1000;
    expect(deltaS).toBeGreaterThanOrEqual(120);
    expect(deltaS).toBeLessThanOrEqual(156);
    expect(f.breaker.recordBreakerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ignored" }),
    );
    expect(f.sleep).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("a Retry-After under 60 s is lifted to 60 s", async () => {
    const f = makeFixture();
    await withSelfHealCall({
      ...base(),
      kind: "create",
      call: async () => {
        throw httpError(429, "slow down", { "retry-after": "5" });
      },
      deps: f.deps,
    });
    const until = f.breaker.extendRateLimitedUntil.mock.calls[0]![0].until;
    expect((until.getTime() - NOW.getTime()) / 1000).toBeGreaterThanOrEqual(60);
  });

  it("403 without a rate-limit signature latches the permission and is ignored", async () => {
    const f = makeFixture();
    const r = await withSelfHealCall({
      ...base(),
      kind: "create",
      permission: "issues",
      call: async () => {
        throw httpError(403, "Resource not accessible by integration", {
          "x-ratelimit-remaining": "4000",
        });
      },
      deps: f.deps,
    });
    expect(r).toMatchObject({ ok: false, outcome: "permission" });
    expect(f.breaker.setPermissionLatch).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "issues", installationId: KEY }),
    );
    expect(f.breaker.recordBreakerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ignored", signal: "gh_403" }),
    );
    expect(f.breaker.extendRateLimitedUntil).not.toHaveBeenCalled();
  });

  it("404 is not_found (ignored); 422 is unprocessable with signal gh_422", async () => {
    const f = makeFixture();
    const r404 = await withSelfHealCall({
      ...base(),
      kind: "write",
      call: async () => {
        throw httpError(404);
      },
      deps: f.deps,
    });
    expect(r404).toMatchObject({ ok: false, outcome: "not_found" });
    const r422 = await withSelfHealCall({
      ...base(),
      kind: "create",
      call: async () => {
        throw httpError(422);
      },
      deps: f.deps,
    });
    expect(r422).toMatchObject({ ok: false, outcome: "unprocessable" });
    expect(f.breaker.recordBreakerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ignored", signal: "gh_422" }),
    );
  });

  describe("09-13 gh_403 / gh_422 rule input: per-repo loop_fix events", () => {
    const REPO_KEY = "acme/widgets";
    const loopFixCalls = (f: ReturnType<typeof makeFixture>) =>
      (
        f.breaker.recordBreakerEvent.mock.calls as unknown as Array<
          [
            {
              scopeKind: string;
              scopeKey: string;
              signal?: string;
              outcome: string;
            },
          ]
        >
      )
        .map(([a]) => a)
        .filter((a) => a.scopeKind === "loop_fix");

    it.each([
      [403, "gh_403", "write"],
      [422, "gh_422", "write"],
      [403, "gh_403", "create"],
      [422, "gh_422", "create"],
    ] as const)(
      "%s on a lane %s records %s on the repo's loop_fix breaker",
      async (status, signal, kind) => {
        const f = makeFixture();
        await withSelfHealCall({
          ...base(),
          kind,
          loopFixScopeKey: REPO_KEY,
          call: async () => {
            throw httpError(status);
          },
          deps: f.deps,
        });
        expect(loopFixCalls(f)).toEqual([
          expect.objectContaining({
            organizationId: ORG,
            scopeKey: REPO_KEY,
            outcome: "failure",
            signal,
          }),
        ]);
      },
    );

    it("reads, calls without a repo key, rate limits and other failures record nothing on loop_fix", async () => {
      const f = makeFixture();
      const fail =
        (status: number, headers: Record<string, string> = {}) =>
        async () => {
          throw httpError(status, "err", headers);
        };
      await withSelfHealCall({
        ...base(),
        kind: "read",
        loopFixScopeKey: REPO_KEY,
        call: fail(403),
        deps: f.deps,
      });
      await withSelfHealCall({
        ...base(),
        kind: "write",
        call: fail(422),
        deps: f.deps,
      });
      await withSelfHealCall({
        ...base(),
        kind: "write",
        loopFixScopeKey: REPO_KEY,
        call: fail(403, { "x-ratelimit-remaining": "0" }),
        deps: f.deps,
      });
      await withSelfHealCall({
        ...base(),
        kind: "write",
        loopFixScopeKey: REPO_KEY,
        call: fail(404),
        deps: f.deps,
      });
      await withSelfHealCall({
        ...base(),
        kind: "write",
        loopFixScopeKey: REPO_KEY,
        call: async () => ok({}),
        deps: f.deps,
      });
      expect(loopFixCalls(f)).toEqual([]);
    });
  });

  it("502 on create is one call, a failure event, server_error", async () => {
    const f = makeFixture();
    const call = vi.fn(async () => {
      throw httpError(502);
    });
    const r = await withSelfHealCall({
      ...base(),
      kind: "create",
      call,
      deps: f.deps,
    });
    expect(r).toMatchObject({
      ok: false,
      outcome: "server_error",
      status: 502,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.breaker.recordBreakerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", signal: "gh_5xx" }),
    );
  });

  it("read: 502 then 200 succeeds after one jittered retry", async () => {
    const f = makeFixture();
    const call = vi
      .fn()
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce(ok({ n: 1 }));
    const r = await withSelfHealCall({
      ...base(),
      kind: "read",
      signalName: "gh_list",
      call,
      deps: f.deps,
    });
    expect(r).toMatchObject({ ok: true, data: { n: 1 } });
    expect(call).toHaveBeenCalledTimes(2);
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.sleep.mock.calls[0]![0]).toBe(250);
  });

  it("read retries stop after two retries", async () => {
    const f = makeFixture();
    const call = vi.fn(async () => {
      throw httpError(503);
    });
    const r = await withSelfHealCall({
      ...base(),
      kind: "read",
      signalName: "gh_list",
      call,
      deps: f.deps,
    });
    expect(r).toMatchObject({ ok: false, outcome: "server_error" });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("does not retry when the deadline leaves under 5 s after the backoff", async () => {
    const f = makeFixture();
    const call = vi.fn(async () => {
      throw httpError(503);
    });
    const r = await withSelfHealCall({
      ...base(4_000),
      kind: "read",
      signalName: "gh_list",
      call,
      deps: f.deps,
    });
    expect(r).toMatchObject({ ok: false, outcome: "server_error" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("success below 20% quota flags reserveHit and stops later calls", async () => {
    const f = makeFixture();
    const execution = { reserveHit: false };
    const deps = { ...f.deps, execution };
    const r = await withSelfHealCall({
      ...base(),
      kind: "create",
      call: async () =>
        ok(
          { id: 1 },
          { "x-ratelimit-remaining": "400", "x-ratelimit-limit": "5000" },
        ),
      deps,
    });
    expect(r).toMatchObject({ ok: true, reserveHit: true });
    const next = vi.fn();
    const r2 = await withSelfHealCall({
      ...base(),
      kind: "create",
      call: next,
      deps,
    });
    expect(r2).toEqual({ ok: false, outcome: "primary_quota_reserve" });
    expect(next).not.toHaveBeenCalled();
  });

  it("create success is recorded as ignored under its own signal", async () => {
    const f = makeFixture();
    await withSelfHealCall({
      ...base(),
      kind: "create",
      call: async () => ok({}),
      deps: f.deps,
    });
    expect(f.breaker.recordBreakerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ignored", signal: "gh_create" }),
    );
  });

  it("never logs the Authorization header or a token-shaped string", async () => {
    const f = makeFixture();
    const token = "ghs_" + "a".repeat(36);
    const r = await withSelfHealCall({
      ...base(),
      kind: "create",
      call: async () => {
        throw httpError(500, `boom authorization: token ${token}`);
      },
      deps: f.deps,
    });
    const dump = JSON.stringify([f.logs, r]);
    expect(dump).not.toContain(token);
    expect(dump.toLowerCase()).not.toContain("authorization: token ghs_");
  });

  it("never throws when the breaker store fails", async () => {
    const f = makeFixture();
    f.breaker.getBreakerState.mockRejectedValue(new Error("db down"));
    const call = vi.fn();
    const r = await withSelfHealCall({
      ...base(),
      kind: "create",
      call,
      deps: f.deps,
    });
    expect(r).toEqual({ ok: false, outcome: "other" });
    expect(call).not.toHaveBeenCalled();
  });
});

describe("classifyGithubOutcome", () => {
  it("treats x-ratelimit-remaining 0 on a 403 as a rate limit", () => {
    expect(
      classifyGithubOutcome(
        httpError(403, "forbidden", { "x-ratelimit-remaining": "0" }),
      ),
    ).toMatchObject({ kind: "rate_limited" });
  });
  it("treats a status-less error as a network failure", () => {
    expect(classifyGithubOutcome(new Error("ECONNRESET"))).toEqual({
      kind: "server_error",
      status: undefined,
    });
  });
});
