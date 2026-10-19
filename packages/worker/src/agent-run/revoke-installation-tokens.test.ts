import { describe, expect, it, vi } from "vitest";

import {
  GITHUB_INSTALLATION_TOKEN_URL,
  createTokenRevoker,
  revokeInstallationTokens,
} from "./revoke-installation-tokens";

/**
 * #380 end-of-run token revocation.
 *
 * Cards:
 *  - 204 logged: protects=the DELETE is sent per token with the right
 *    auth header and its status is journaled; fails_when=a token is
 *    skipped, the header is wrong, or the line carries the token;
 *    no_claim=GitHub's behaviour (fetch is a fake).
 *  - failure never changes the outcome: protects=401 and a timeout are
 *    logged and swallowed; fails_when=revoke throws; no_claim=none.
 *  - once-only: protects=a second revokeOnce is a no-op; fails_when=two
 *    DELETEs for one run; no_claim=none.
 */

const TOKENS = {
  installationToken: "ghs_installationRevokeMe0123456789",
  githubReadToken: "ghs_readRevokeMe0123456789abcdef",
};

function fakeFetch(statusByToken: Record<string, number | "timeout">) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = String(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    );
    const token = auth.replace(/^token /, "");
    const status = statusByToken[token];
    if (status === "timeout") {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    return new Response(null, { status: status ?? 404 });
  }) as unknown as typeof fetch;
}

describe("revokeInstallationTokens", () => {
  it("DELETEs each present token with `Authorization: token …` and logs kind + status, never the token", async () => {
    const fetchFn = fakeFetch({
      [TOKENS.installationToken]: 204,
      [TOKENS.githubReadToken]: 204,
    });
    const lines: string[] = [];
    await revokeInstallationTokens({
      tokens: TOKENS,
      log: (l) => lines.push(l),
      fetchFn,
    });
    expect(lines).toEqual([
      'token.revoke {"kind":"installation","status":204}',
      'token.revoke {"kind":"read","status":204}',
    ]);
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [url, init] of calls) {
      expect(url).toBe(GITHUB_INSTALLATION_TOKEN_URL);
      expect((init as RequestInit).method).toBe("DELETE");
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      (calls[0]![1] as { headers: Record<string, string> }).headers
        .Authorization,
    ).toBe(`token ${TOKENS.installationToken}`);
    expect(lines.join("\n")).not.toContain(TOKENS.installationToken);
    expect(lines.join("\n")).not.toContain(TOKENS.githubReadToken);
  });

  it("no read token ⇒ one DELETE, one line", async () => {
    const fetchFn = fakeFetch({ [TOKENS.installationToken]: 204 });
    const lines: string[] = [];
    await revokeInstallationTokens({
      tokens: { installationToken: TOKENS.installationToken },
      log: (l) => lines.push(l),
      fetchFn,
    });
    expect(lines).toEqual([
      'token.revoke {"kind":"installation","status":204}',
    ]);
  });

  it("a 401 (already dead) and a timeout are logged by class and never throw", async () => {
    const fetchFn = fakeFetch({
      [TOKENS.installationToken]: 401,
      [TOKENS.githubReadToken]: "timeout",
    });
    const lines: string[] = [];
    await expect(
      revokeInstallationTokens({
        tokens: TOKENS,
        log: (l) => lines.push(l),
        fetchFn,
        timeoutMs: 50,
      }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([
      'token.revoke {"kind":"installation","status":401}',
      'token.revoke {"kind":"read","error":"timeout"}',
    ]);
  });

  it("a network error is logged by its error name and swallowed", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await revokeInstallationTokens({
      tokens: { installationToken: TOKENS.installationToken },
      log: (l) => lines.push(l),
      fetchFn,
    });
    expect(lines).toEqual([
      'token.revoke {"kind":"installation","error":"TypeError"}',
    ]);
  });
});

describe("createTokenRevoker", () => {
  it("revokeOnce runs the revoke exactly once; later calls return the same promise", async () => {
    const fetchFn = fakeFetch({
      [TOKENS.installationToken]: 204,
      [TOKENS.githubReadToken]: 204,
    });
    const lines: string[] = [];
    const revoker = createTokenRevoker(TOKENS, (l) => lines.push(l), {
      fetchFn,
    });
    expect(revoker.done).toBe(false);
    const first = revoker.revokeOnce();
    expect(revoker.done).toBe(true);
    const second = revoker.revokeOnce();
    expect(second).toBe(first);
    await first;
    await revoker.revokeOnce();
    expect(
      (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(2);
    expect(lines).toHaveLength(2);
  });
});
