import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@terragon/shared/github-app", () => ({
  getRepoInstallationId: vi.fn(),
  getReadOnlyInstallationToken: vi.fn(),
}));
vi.mock("@terragon/shared/model/github-installation", () => ({
  getInstallationOrgAndMode: vi.fn(),
}));

import {
  readDefaultBranchHead,
  type ReadDefaultBranchHeadDeps,
} from "./github-head";

const SHA = "a".repeat(39) + "1";
const TOKEN = "ghs_secret_token_value";

const text = (status: number, body: string) => new Response(body, { status });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

function makeDeps(
  responses: Response[],
  over: Partial<ReadDefaultBranchHeadDeps> = {},
) {
  const queue = [...responses];
  const fetchFn = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra GitHub call");
    return next;
  });
  const deps: ReadDefaultBranchHeadDeps = {
    getInstallationId: vi.fn(async () => 77),
    getInstallationOrganizationId: vi.fn(async () => "org1"),
    mintReadToken: vi.fn(async () => TOKEN),
    fetch: fetchFn as unknown as typeof fetch,
    ...over,
  };
  return { deps, fetchFn };
}

const input = (over: Record<string, unknown> = {}) => ({
  organizationId: "org1",
  repoFullName: "acme/repo-a",
  defaultBranch: "main" as string | null,
  signal: new AbortController().signal,
  ...over,
});

describe("readDefaultBranchHead", () => {
  it("reads the head with 3 GitHub calls (lookup, mint, head)", async () => {
    const { deps, fetchFn } = makeDeps([text(200, `${SHA}\n`)]);
    const r = await readDefaultBranchHead(input(), deps);
    expect(r).toEqual({ kind: "ok", sha: SHA, defaultBranch: "main" });
    expect(deps.getInstallationId).toHaveBeenCalledTimes(1);
    expect(deps.mintReadToken).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.github.com/repos/acme/repo-a/commits/main");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/vnd.github.sha",
    );
  });

  it("falls back to the repository's default branch on a 404, with 5 calls at most", async () => {
    const { deps, fetchFn } = makeDeps([
      text(404, "Not Found"),
      json(200, { default_branch: "trunk" }),
      text(200, SHA),
    ]);
    const r = await readDefaultBranchHead(input(), deps);
    expect(r).toEqual({ kind: "ok", sha: SHA, defaultBranch: "trunk" });
    // lookup + mint + 3 fetches = 5
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(deps.getInstallationId).toHaveBeenCalledTimes(1);
    expect(deps.mintReadToken).toHaveBeenCalledTimes(1);
  });

  it("asks the repository for the branch when the repo has no cursor", async () => {
    const { deps, fetchFn } = makeDeps([
      json(200, { default_branch: "main" }),
      text(200, SHA),
    ]);
    const r = await readDefaultBranchHead(input({ defaultBranch: null }), deps);
    expect(r).toEqual({ kind: "ok", sha: SHA, defaultBranch: "main" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns not_found when the fallback branch 404s too", async () => {
    const { deps } = makeDeps([
      text(404, ""),
      json(200, { default_branch: "trunk" }),
      text(404, ""),
    ]);
    expect(await readDefaultBranchHead(input(), deps)).toEqual({
      kind: "not_found",
    });
  });

  it("returns no_access when no installation covers the repo", async () => {
    const { deps, fetchFn } = makeDeps([], {
      getInstallationId: vi.fn(async () => null),
    });
    expect(await readDefaultBranchHead(input(), deps)).toEqual({
      kind: "no_access",
    });
    expect(deps.mintReadToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns installation_mismatch before minting for another org's installation", async () => {
    const { deps, fetchFn } = makeDeps([], {
      getInstallationOrganizationId: vi.fn(async () => "other-org"),
    });
    expect(await readDefaultBranchHead(input(), deps)).toEqual({
      kind: "installation_mismatch",
    });
    expect(deps.mintReadToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns empty on a 409 (empty repository)", async () => {
    const { deps } = makeDeps([text(409, "Git Repository is empty.")]);
    expect(await readDefaultBranchHead(input(), deps)).toEqual({
      kind: "empty",
    });
  });

  it.each([
    ["a non-hex body", text(200, "<html>nope</html>")],
    ["a 500", text(500, "boom")],
    ["a redirect", text(301, "")],
    ["a 403", text(403, "rate limited")],
  ])("returns error for %s", async (_label, response) => {
    const { deps } = makeDeps([response]);
    expect(await readDefaultBranchHead(input(), deps)).toEqual({
      kind: "error",
    });
  });

  it("returns error without starting a call when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps, fetchFn } = makeDeps([text(200, SHA)]);
    expect(
      await readDefaultBranchHead(input({ signal: ac.signal }), deps),
    ).toEqual({ kind: "error" });
    expect(deps.mintReadToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts a hung installation lookup at the deadline", async () => {
    const ac = new AbortController();
    const { deps, fetchFn } = makeDeps([], {
      getInstallationId: vi.fn(() => new Promise<number | null>(() => {})),
    });
    const pending = readDefaultBranchHead(input({ signal: ac.signal }), deps);
    ac.abort();
    expect(await pending).toEqual({ kind: "error" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts the in-flight request when the overall signal fires", async () => {
    const ac = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const { deps } = makeDeps([], {
      fetch: vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? undefined;
            requestSignal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ) as unknown as typeof fetch,
    });
    const pending = readDefaultBranchHead(input({ signal: ac.signal }), deps);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    ac.abort();
    expect(await pending).toEqual({ kind: "error" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects a malformed branch or repo name without any call", async () => {
    const { deps, fetchFn } = makeDeps([]);
    expect(
      await readDefaultBranchHead(input({ defaultBranch: "a b" }), deps),
    ).toEqual({ kind: "error" });
    expect(
      await readDefaultBranchHead(input({ repoFullName: "no-slash" }), deps),
    ).toEqual({ kind: "error" });
    expect(deps.getInstallationId).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never returns or logs the token", async () => {
    const spies = (["log", "error", "warn"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const results = [
      await readDefaultBranchHead(input(), makeDeps([text(200, SHA)]).deps),
      await readDefaultBranchHead(input(), makeDeps([text(500, "x")]).deps),
      await readDefaultBranchHead(
        input(),
        makeDeps([], {
          fetch: vi.fn(async () => {
            throw new Error(`failed with ${TOKEN}`);
          }) as unknown as typeof fetch,
        }).deps,
      ),
    ];
    expect(JSON.stringify(results)).not.toContain(TOKEN);
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(TOKEN);
      s.mockRestore();
    }
  });
});
