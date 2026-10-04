import { afterEach, describe, expect, it, vi } from "vitest";
import { Octokit } from "octokit";

import {
  createSelfHealOctokit,
  SELF_HEAL_OCTOKIT_OPTIONS,
  type SelfHealOctokitDeps,
} from "./self-heal-octokit";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeDeps(fetchImpl: typeof fetch) {
  const mintToken = vi.fn(
    async (_o: string, _r: string, _opts: { signal: AbortSignal }) => ({
      token: "tok",
      installationId: 5,
    }),
  );
  const deps: SelfHealOctokitDeps = {
    mintToken,
    OctokitCtor: Octokit,
    fetch: fetchImpl,
  };
  return { deps, mintToken };
}

describe("createSelfHealOctokit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RES-01: a 503 on issues.create makes exactly one HTTP request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { message: "down" }));
    const { deps } = makeDeps(fetchMock as unknown as typeof fetch);
    const { octokit } = await createSelfHealOctokit({
      owner: "o",
      repo: "r",
      deps,
    });
    await expect(
      octokit.rest.issues.create({ owner: "o", repo: "r", title: "t" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a secondary rate limit rejects after one call and never sleeps for the Retry-After", async () => {
    const longTimers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if ((ms ?? 0) >= 60_000) longTimers.push(ms ?? 0);
      return realSetTimeout(fn, ms, ...rest);
    }) as unknown as typeof setTimeout);
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        403,
        { message: "You have exceeded a secondary rate limit" },
        { "retry-after": "120" },
      ),
    );
    const { deps } = makeDeps(fetchMock as unknown as typeof fetch);
    const { octokit } = await createSelfHealOctokit({
      owner: "o",
      repo: "r",
      deps,
    });
    // plugin-throttling still paces notification writes (<= 3 s per isolate);
    // what must never happen is a Retry-After sleep.
    const startedAt = Date.now();
    await expect(
      octokit.rest.issues.create({ owner: "o", repo: "r", title: "t" }),
    ).rejects.toMatchObject({ status: 403 });
    spy.mockRestore();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(longTimers).toEqual([]);
  });

  it("mints once per factory call with a 5 s signal and no user-token helper", async () => {
    const { deps, mintToken } = makeDeps(vi.fn() as unknown as typeof fetch);
    const result = await createSelfHealOctokit({
      owner: "o",
      repo: "r",
      deps,
    });
    expect(result.installationId).toBe(5);
    expect(mintToken).toHaveBeenCalledTimes(1);
    const signal = mintToken.mock.calls[0]![2].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("exposes retry disabled and non-sleeping throttle handlers", () => {
    expect(SELF_HEAL_OCTOKIT_OPTIONS.retry.enabled).toBe(false);
    expect(SELF_HEAL_OCTOKIT_OPTIONS.throttle.onRateLimit()).toBe(false);
    expect(SELF_HEAL_OCTOKIT_OPTIONS.throttle.onSecondaryRateLimit()).toBe(
      false,
    );
  });
});
