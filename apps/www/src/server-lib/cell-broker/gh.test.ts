import { describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { captureLogs } from "@/test-helpers/capture-logs";
import type { DB } from "@terragon/shared/db";
import {
  markStepDone,
  revokeAttempt,
} from "@terragon/shared/model/cell-authority";
import { createTestCellStep } from "@terragon/shared/model/test-helpers";

import {
  createGhBrokerHandler,
  type GhBrokerDeps,
} from "@terragon/cell-broker/gh";

const SENTINEL = "ghs_SENTINEL_read_token";
const HOST = "www.example.com";
const REST = `https://${HOST}/api/v3`;
const GRAPHQL = `https://${HOST}/api/graphql`;
/** A read inside the step's repository (fixture default), allowed under #727 OD-3. */
const IN_REPO = "/repos/acme/widgets";

const fixture = (repo = "acme/widgets") =>
  createTestCellStep({ db, repoFullName: repo });

interface Upstream {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: boolean;
  cookies?: string[];
}

async function bodyText(body: unknown): Promise<string> {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return typeof body === "string" ? body : "";
}

function harness(upstream: Upstream = {}, over: Partial<GhBrokerDeps> = {}) {
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: await bodyText(init?.body),
      });
      if (upstream.throws) throw new Error("network down");
      const headers = new Headers(
        upstream.headers ?? { "content-type": "application/json" },
      );
      for (const cookie of upstream.cookies ?? []) {
        headers.append("set-cookie", cookie);
      }
      // A 304 has no body.
      const body =
        upstream.status === 304 ? null : (upstream.body ?? '{"ok":true}');
      return new Response(body, {
        status: upstream.status ?? 200,
        headers,
      });
    },
  );
  const mintReadToken = vi.fn(async () => ({ token: SENTINEL }));
  const handler = createGhBrokerHandler({
    db,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    mintReadToken,
    enabled: () => true,
    ...over,
  });
  return { handler, calls, fetchImpl, mintReadToken };
}

function rest(
  path: string,
  token: string | null,
  init: RequestInit = {},
  scheme = "token",
): Request {
  return new Request(`${REST}${path}`, {
    method: "GET",
    ...init,
    headers: {
      ...(token ? { authorization: `${scheme} ${token}` } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

function graphql(
  body: string,
  token: string | null,
  headers: Record<string, string> = {},
): Request {
  return new Request(GRAPHQL, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `token ${token}` } : {}),
      ...headers,
    },
  });
}

const gql = (query: string) => JSON.stringify({ query });

/** The REST status the handler answers for one request. */
async function allowed(
  h: Pick<ReturnType<typeof harness>, "handler">,
  path: string,
  token: string,
  method = "GET",
): Promise<number> {
  return (await h.handler(rest(path, token, { method }), "rest")).status;
}

describe("gh broker REST", () => {
  it("AC6 forwards reads to api.github.com, bytes, status and query intact; HEAD works", async () => {
    const f = await fixture();
    const h = harness({ status: 200, body: '{"n":1}' });
    const res = await h.handler(
      rest("/repos/acme/widgets/pulls?state=open", f.token),
      "rest",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"n":1}');
    expect(h.calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/widgets/pulls?state=open",
    );
    expect(h.calls[0]?.method).toBe("GET");

    const head = await h.handler(
      rest("/repos/acme/widgets", f.token, { method: "HEAD" }),
      "rest",
    );
    expect(head.status).toBe(200);
    expect(h.calls[1]?.method).toBe("HEAD");
  });

  it("AC6 keeps compare ranges and an encoded slash inside one segment", async () => {
    const f = await fixture();
    const h = harness();
    await h.handler(
      rest("/repos/acme/widgets/compare/main...feat", f.token),
      "rest",
    );
    await h.handler(
      rest("/repos/acme/widgets/branches/feat%2Fx", f.token),
      "rest",
    );
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/compare/main...feat",
      "https://api.github.com/repos/acme/widgets/branches/feat%2Fx",
    ]);
  });

  // card: protects=#727 OD-3: REST reads stay on the step's repo, plus the two repo-free paths gh calls; fails_when=another repo, the API root, /user, /search or /repositories/<id> reach GitHub, or the step repo (any case) or /rate_limit or /meta is refused; no_claim=GraphQL (mutation-free, repo-unbounded by design)
  it("OD-3 forwards only the step's repo, /rate_limit and /meta; everything else is 403 forbidden_path", async () => {
    const f = await fixture();
    const h = harness();
    for (const path of [
      "/repos/acme/widgets",
      "/repos/ACME/Widgets/issues/1",
      "/rate_limit",
      "/meta",
    ]) {
      expect(await allowed(h, path, f.token), path).toBe(200);
    }
    for (const path of [
      "",
      "/",
      "/user",
      "/repos/acme/other",
      "/repos/other/widgets/issues",
      "/repos/acme",
      "/repos",
      "/repositories/1",
      "/search/issues?q=repo:acme/other",
      "/orgs/acme/repos",
      "/rate_limit/x",
      "/meta/x",
    ]) {
      const res = await h.handler(rest(path, f.token), "rest");
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toEqual({ error: "forbidden_path" });
    }
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/widgets",
      "https://api.github.com/repos/ACME/Widgets/issues/1",
      "https://api.github.com/rate_limit",
      "https://api.github.com/meta",
    ]);
    // Refused before minting: only the four allowed reads asked for a token.
    expect(h.mintReadToken).toHaveBeenCalledTimes(4);
  });

  it("AC6 refuses writes on /api/v3 without calling GitHub", async () => {
    const f = await fixture();
    const h = harness();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await h.handler(
        rest("/repos/acme/widgets/issues", f.token, { method, body: "{}" }),
        "rest",
      );
      expect(res.status, method).toBe(403);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses backslash and control-character segments without an upstream call", async () => {
    const f = await fixture();
    const h = harness();
    for (const path of [
      "/repos/o%5Cr/issues",
      "/repos/o%00r/issues",
      "/repos/o%0Ar/issues",
    ]) {
      expect(await allowed(h, path, f.token), path).toBe(403);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("never lets a dot segment reach GitHub: the URL parser resolves it first, so the call stays under /api/v3", async () => {
    const f = await fixture();
    const h = harness();
    for (const path of [
      "/repos/acme/widgets/x/../issues",
      "/repos/acme/widgets/x/%2e%2e/issues",
      "/repos/acme/widgets/x/%2E./issues",
    ]) {
      await allowed(h, path, f.token);
    }
    // `Request` resolves raw and percent-encoded dot segments before the
    // handler runs, so these arrive as /api/v3/repos/acme/widgets/issues.
    expect(h.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/issues",
      "https://api.github.com/repos/acme/widgets/issues",
      "https://api.github.com/repos/acme/widgets/issues",
    ]);
    expect(h.calls.every((c) => !/\.\.|%2e/i.test(c.url))).toBe(true);
    // A dot segment that climbs out of the repo lands outside it: refused.
    expect(await allowed(h, "/repos/acme/widgets/../../user", f.token)).toBe(
      403,
    );
  });

  it("answers 400 for a malformed percent escape", async () => {
    const f = await fixture();
    const h = harness();
    const bad = await h.handler(rest("/repos/%E0%A4%A/x", f.token), "rest");
    expect(bad.status).toBe(400);
  });

  it("rewrites Link URLs to the broker host and drops set-cookie", async () => {
    const f = await fixture();
    const h = harness({
      headers: {
        "content-type": "application/json",
        link: '<https://api.github.com/repositories/1/pulls?page=2>; rel="next"',
      },
      cookies: ["a=b"],
    });
    const res = await h.handler(
      rest("/repos/acme/widgets/pulls", f.token),
      "rest",
    );
    expect(res.headers.get("link")).toBe(
      `<https://${HOST}/api/v3/repos/acme/widgets/pulls?page=2>; rel="next"`,
    );
    expect(res.headers.has("set-cookie")).toBe(false);
  });

  // card: protects=#727 OD-3 x pagination: GitHub's Link names the repo by id (`/repositories/<id>/…`), which OD-3 refuses, so `gh api --paginate` would 403 on page 2; the broker points it back at the step's `/repos/<o>/<r>/…`; fails_when=a next/last link stays on /repositories or following it is refused; no_claim=other repos' ids (never in an in-repo response)
  it("OD-3 keeps --paginate inside the repo: a /repositories/<id> Link becomes /repos/<owner>/<repo>", async () => {
    const f = await fixture();
    const h = harness({
      headers: {
        "content-type": "application/json",
        link: [
          '<https://api.github.com/repositories/42/issues/7/comments?page=2>; rel="next"',
          '<https://api.github.com/repositories/42/issues/7/comments?page=5>; rel="last"',
          '<https://api.github.com/repositories/42>; rel="repo"',
        ].join(", "),
      },
    });
    const res = await h.handler(
      rest("/repos/acme/widgets/issues/7/comments", f.token),
      "rest",
    );
    const link = res.headers.get("link") ?? "";
    expect(link).toBe(
      [
        `<https://${HOST}/api/v3/repos/acme/widgets/issues/7/comments?page=2>; rel="next"`,
        `<https://${HOST}/api/v3/repos/acme/widgets/issues/7/comments?page=5>; rel="last"`,
        `<https://${HOST}/api/v3/repos/acme/widgets>; rel="repo"`,
      ].join(", "),
    );
    const next = /<([^>]+)>; rel="next"/.exec(link)?.[1] ?? "";
    const page2 = await h.handler(
      new Request(next, { headers: { authorization: `token ${f.token}` } }),
      "rest",
    );
    expect(page2.status).toBe(200);
  });

  // card: protects=#727 OD-3 edge cases: HEAD obeys the same allowlist, a trailing slash and a query keep a read allowed, an empty owner segment is refused, the step repo's own case does not matter, and dotted/underscored repo names match exactly; fails_when=any of these flips; no_claim=GraphQL
  it("OD-3 edges: HEAD, trailing slash, query, empty segment, case, dots and underscores", async () => {
    const h = harness();
    const f = await fixture();
    expect(await allowed(h, "/repos/acme/other", f.token, "HEAD")).toBe(403);
    expect(await allowed(h, "/user", f.token, "HEAD")).toBe(403);
    expect(await allowed(h, "/repos/acme/widgets/", f.token)).toBe(200);
    expect(await allowed(h, "/rate_limit/", f.token)).toBe(200);
    expect(await allowed(h, "/rate_limit?x=y", f.token)).toBe(200);
    expect(await allowed(h, "/repos//acme/widgets", f.token)).toBe(403);
    expect(await allowed(h, "/repos/acme//widgets", f.token)).toBe(403);
    expect(await allowed(h, "/repos/acme/widgets.git", f.token)).toBe(403);

    const upper = await fixture("Acme/Widgets");
    expect(await allowed(h, "/repos/acme/widgets/issues", upper.token)).toBe(
      200,
    );
    expect(await allowed(h, "/repos/ACME/WIDGETS", upper.token)).toBe(200);

    const dotted = await fixture("acme/my.repo");
    expect(await allowed(h, "/repos/acme/my.repo/issues/1", dotted.token)).toBe(
      200,
    );
    expect(await allowed(h, "/repos/acme/my-repo", dotted.token)).toBe(403);
    expect(await allowed(h, "/repos/acme/myxrepo", dotted.token)).toBe(403);
    const under = await fixture("acme/my_repo");
    expect(await allowed(h, "/repos/acme/my_repo", under.token)).toBe(200);
    expect(await allowed(h, "/repos/acme/my-repo", under.token)).toBe(403);

    expect(h.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/widgets",
      "https://api.github.com/rate_limit",
      "https://api.github.com/rate_limit?x=y",
      "https://api.github.com/repos/acme/widgets/issues",
      "https://api.github.com/repos/ACME/WIDGETS",
      "https://api.github.com/repos/acme/my.repo/issues/1",
      "https://api.github.com/repos/acme/my_repo",
    ]);
  });

  // card: protects=#727 OD-3: a segment with an encoded slash may not carry a dot component, so an upstream that decodes %2F cannot climb out of the step's repo; fails_when=`..%2F` inside a segment reaches GitHub; no_claim=a branch name with a plain encoded slash (still allowed above)
  it("OD-3 refuses dot components hidden behind an encoded slash", async () => {
    const f = await fixture();
    const h = harness();
    for (const path of [
      "/repos/acme/widgets/contents/..%2F..%2F..%2Fother%2Frepo",
      "/repos/acme/widgets/git/ref/heads%2F..%2F..",
      "/repos/acme/widgets/x/.%2Fy",
    ]) {
      const res = await h.handler(rest(path, f.token), "rest");
      expect(res.status, path).toBe(403);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("gh broker GraphQL", () => {
  it("AC6 forwards a query with the same body", async () => {
    const f = await fixture();
    const h = harness({ body: '{"data":{}}' });
    const body = gql("query { viewer { login } }");
    const res = await h.handler(graphql(body, f.token), "graphql");
    expect([res.status, await res.text()]).toEqual([200, '{"data":{}}']);
    expect(h.calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(h.calls[0]?.method).toBe("POST");
    expect(h.calls[0]?.body).toBe(body);
  });

  it("AC6 refuses a mutation, including one after a string mentioning query", async () => {
    const f = await fixture();
    const h = harness();
    for (const query of [
      "mutation { x }",
      'query { f(q: "query") } mutation M { x }',
    ]) {
      const res = await h.handler(graphql(gql(query), f.token), "graphql");
      expect([res.status, (await res.json()).error]).toEqual([
        403,
        "graphql_mutation_refused",
      ]);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("AC6 refuses a mutation hidden behind a quote inside a comment", async () => {
    const f = await fixture();
    const h = harness();
    const query =
      'query Q { viewer { login } } # "\nmutation M { addStar(input:{starrableId:"x"}) { clientMutationId } } # "';
    const res = await h.handler(graphql(gql(query), f.token), "graphql");
    expect([res.status, (await res.json()).error]).toEqual([
      403,
      "graphql_mutation_refused",
    ]);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("AC6 answers 413 over the cap (declared or streamed), 400 for non-JSON or a non-string query, 403 for GET", async () => {
    const f = await fixture();
    const h = harness({}, { maxGraphqlBytes: 100 });
    const big = gql(`query { a(x: "${"y".repeat(200)}") }`);
    expect((await h.handler(graphql(big, f.token), "graphql")).status).toBe(
      413,
    );
    expect(
      (
        await h.handler(
          graphql(gql("query{a}"), f.token, { "content-length": "101" }),
          "graphql",
        )
      ).status,
    ).toBe(413);
    expect(
      (await h.handler(graphql("not json", f.token), "graphql")).status,
    ).toBe(400);
    expect(
      (
        await h.handler(
          graphql(JSON.stringify({ query: 5 }), f.token),
          "graphql",
        )
      ).status,
    ).toBe(400);
    const getRes = await h.handler(
      new Request(GRAPHQL, {
        method: "GET",
        headers: { authorization: `token ${f.token}` },
      }),
      "graphql",
    );
    expect(getRes.status).toBe(403);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("gh broker auth and secrets", () => {
  it("AC3 maps every refusal and rejects a missing credential, with no upstream call", async () => {
    const h = harness();
    const none = await h.handler(rest(IN_REPO, null), "rest");
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthenticated" });
    const noneGql = await h.handler(graphql(gql("query{a}"), null), "graphql");
    expect(noneGql.status).toBe(401);

    const unknown = await h.handler(rest(IN_REPO, "nope"), "rest");
    expect([unknown.status, (await unknown.json()).error]).toEqual([
      401,
      "unknown_bearer",
    ]);

    const revoked = await fixture();
    await revokeAttempt({ db, stepKey: revoked.stepKey, attempt: 1 });
    const r = await h.handler(rest(IN_REPO, revoked.token), "rest");
    expect([r.status, (await r.json()).error]).toEqual([401, "revoked"]);

    const expired = await fixture();
    const short = await expired.bearer(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const e = await h.handler(rest(IN_REPO, short), "rest");
    expect([e.status, (await e.json()).error]).toEqual([401, "expired"]);

    const fenced = await fixture();
    await fenced.open(2);
    const fe = await h.handler(rest(IN_REPO, fenced.token), "rest");
    expect([fe.status, (await fe.json()).error]).toEqual([409, "fenced"]);

    const done = await fixture();
    await markStepDone({ db, token: done.token });
    const d = await h.handler(rest(IN_REPO, done.token), "rest");
    expect([d.status, (await d.json()).error]).toEqual([409, "step_done"]);

    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("AC3 accepts both `token` and `Bearer` schemes", async () => {
    const f = await fixture();
    const h = harness();
    expect((await h.handler(rest(IN_REPO, f.token), "rest")).status).toBe(200);
    expect(
      (await h.handler(rest(IN_REPO, f.token, {}, "Bearer"), "rest")).status,
    ).toBe(200);
  });

  it("AC7 the installation token reaches GitHub only as `authorization: token <sentinel>`", async () => {
    const f = await fixture();
    const h = harness({ headers: { "content-type": "text/plain" } });
    const res = await h.handler(
      rest(IN_REPO, f.token, {
        headers: { cookie: "s=1", "x-forwarded-for": "1.1.1.1" },
      }),
      "rest",
    );
    const seen =
      (await res.text()) + JSON.stringify([...res.headers.entries()]);
    expect(seen).not.toContain(SENTINEL);
    const sent = h.calls[0]!.headers;
    expect(sent.get("authorization")).toBe(`token ${SENTINEL}`);
    expect(sent.has("cookie")).toBe(false);
    expect(sent.has("x-forwarded-for")).toBe(false);
    expect(h.calls[0]?.url).not.toContain(SENTINEL);

    const failed = harness(
      {},
      {
        mintReadToken: async () => {
          throw new Error(`boom ${SENTINEL}`);
        },
      },
    );
    const bad = await failed.handler(rest(IN_REPO, f.token), "rest");
    expect(bad.status).toBe(502);
    expect(await bad.text()).not.toContain(SENTINEL);
  });

  it("AC8 answers 404 and touches neither the database nor GitHub when disabled", async () => {
    const touched = vi.fn();
    const guard = new Proxy({} as DB, {
      get() {
        touched();
        throw new Error("db must not be touched");
      },
    });
    const h = harness({}, { enabled: () => false, db: guard });
    expect((await h.handler(rest(IN_REPO, "x"), "rest")).status).toBe(404);
    expect(
      (await h.handler(graphql(gql("query{a}"), "x"), "graphql")).status,
    ).toBe(404);
    expect(touched).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.mintReadToken).not.toHaveBeenCalled();
  });

  it("refuses an encoded GraphQL body with a 415 before minting or calling GitHub; identity is fine", async () => {
    const f = await fixture();
    const h = harness();
    const body = gql("query { viewer { login } }");
    const gz = await h.handler(
      graphql(body, f.token, { "content-encoding": "gzip" }),
      "graphql",
    );
    expect([gz.status, (await gz.json()).error]).toEqual([
      415,
      "unsupported_encoding",
    ]);
    expect(h.mintReadToken).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    const identity = await h.handler(
      graphql(body, f.token, { "content-encoding": "identity" }),
      "graphql",
    );
    expect(identity.status).toBe(200);
  });

  it("passes a 304 through with its ETag, while a 302 is still a 502", async () => {
    const f = await fixture();
    const notModified = harness({
      status: 304,
      headers: { etag: '"abc"' },
    });
    const res = await notModified.handler(rest(IN_REPO, f.token), "rest");
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"abc"');

    const redirected = harness({
      status: 302,
      headers: { location: "https://evil.test/" },
    });
    const moved = await redirected.handler(rest(IN_REPO, f.token), "rest");
    expect(moved.status).toBe(502);
  });

  describe("redirects", () => {
    const redirect =
      (location: string, status = 302) =>
      () =>
        new Response(null, { status, headers: { location } });
    const ok = (body: string) => () => new Response(body, { status: 200 });

    function redirecting(responses: Array<() => Response>) {
      const calls: { url: string; headers: Headers }[] = [];
      const fetchImpl = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({
            url: String(input),
            headers: new Headers(init?.headers),
          });
          const next = responses[calls.length - 1];
          if (!next) throw new Error("unexpected request");
          return next();
        },
      );
      const handler = createGhBrokerHandler({
        db,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        mintReadToken: async () => ({ token: SENTINEL }),
        enabled: () => true,
      });
      return { handler, calls };
    }

    it("follows one hop to an allowlisted asset host with no credential", async () => {
      const f = await fixture();
      const h = redirecting([
        redirect("https://objects.githubusercontent.com/asset?sig=1"),
        ok("blob-bytes"),
      ]);
      const res = await h.handler(
        rest("/repos/acme/widgets/releases/assets/1", f.token, {
          headers: { accept: "application/octet-stream", range: "bytes=0-9" },
        }),
        "rest",
      );
      expect([res.status, await res.text()]).toEqual([200, "blob-bytes"]);
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]!.url).toBe(
        "https://objects.githubusercontent.com/asset?sig=1",
      );
      expect(h.calls[1]!.headers.has("authorization")).toBe(false);
      expect(h.calls[1]!.headers.get("accept")).toBe(
        "application/octet-stream",
      );
      expect(h.calls[1]!.headers.get("range")).toBe("bytes=0-9");
      expect(h.calls[0]!.headers.get("authorization")).toBe(
        `token ${SENTINEL}`,
      );
    });

    it("follows a renamed-repo 301 back to api.github.com, with the token", async () => {
      const f = await fixture();
      const h = redirecting([
        redirect("https://api.github.com/repositories/1/pulls", 301),
        ok("[]"),
      ]);
      const res = await h.handler(
        rest("/repos/acme/widgets/pulls", f.token),
        "rest",
      );
      expect(res.status).toBe(200);
      expect(h.calls[1]!.url).toBe(
        "https://api.github.com/repositories/1/pulls",
      );
      expect(h.calls[1]!.headers.get("authorization")).toBe(
        `token ${SENTINEL}`,
      );
    });

    it("follows release-assets and *.actions.githubusercontent.com hops, and refuses look-alikes", async () => {
      const f = await fixture();
      const assets = redirecting([
        redirect("https://release-assets.githubusercontent.com/a?sig=1"),
        ok("asset"),
      ]);
      expect(
        (await assets.handler(rest(IN_REPO, f.token), "rest")).status,
      ).toBe(200);
      expect(assets.calls[1]!.headers.has("authorization")).toBe(false);

      const actions = redirecting([
        redirect("https://pipelines.actions.githubusercontent.com/log"),
        ok("log"),
      ]);
      expect(
        (await actions.handler(rest(IN_REPO, f.token), "rest")).status,
      ).toBe(200);
      expect(actions.calls[1]!.headers.has("authorization")).toBe(false);

      for (const host of [
        "evilactions.githubusercontent.com",
        "x.actions.githubusercontent.com.evil.com",
      ]) {
        const spoof = redirecting([redirect(`https://${host}/x`)]);
        expect(
          (await spoof.handler(rest(IN_REPO, f.token), "rest")).status,
          host,
        ).toBe(502);
        expect(spoof.calls).toHaveLength(1);
      }
    });

    it("refuses a redirect to any other host, a non-https Location and a second hop with a 502", async () => {
      const f = await fixture();
      const evil = redirecting([redirect("https://evil.example/x")]);
      expect((await evil.handler(rest(IN_REPO, f.token), "rest")).status).toBe(
        502,
      );
      expect(evil.calls).toHaveLength(1);

      const plain = redirecting([
        redirect("http://objects.githubusercontent.com/x"),
      ]);
      expect((await plain.handler(rest(IN_REPO, f.token), "rest")).status).toBe(
        502,
      );
      expect(plain.calls).toHaveLength(1);

      const chain = redirecting([
        redirect("https://objects.githubusercontent.com/a"),
        redirect("https://objects.githubusercontent.com/b"),
      ]);
      expect((await chain.handler(rest(IN_REPO, f.token), "rest")).status).toBe(
        502,
      );
      expect(chain.calls).toHaveLength(2);
    });
  });

  it("mints the read token for the step's owner and repo, and 502s on a 3xx or a thrown fetch", async () => {
    const f = await fixture("Acme/Widgets");
    const h = harness();
    await h.handler(rest(IN_REPO, f.token), "rest");
    await h.handler(graphql(gql("query{a}"), f.token), "graphql");
    expect(h.mintReadToken).toHaveBeenCalledTimes(2);
    expect(h.mintReadToken).toHaveBeenCalledWith("acme", "widgets");

    const redirected = harness({ status: 302 });
    expect(
      (await redirected.handler(rest(IN_REPO, f.token), "rest")).status,
    ).toBe(502);
    const down = harness({ throws: true });
    expect((await down.handler(rest(IN_REPO, f.token), "rest")).status).toBe(
      502,
    );
  });

  it("a missing required permission is a 403 missing_permission with no upstream call", async () => {
    const f = await fixture();
    const h = harness(
      {},
      {
        mintReadToken: async () => {
          throw Object.assign(new Error("lacks contents"), {
            name: "MissingInstallationPermissionError",
            permission: "contents",
            needed: "read",
            granted: undefined,
          });
        },
      },
    );
    const res = await h.handler(rest(IN_REPO, f.token), "rest");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "missing_permission",
      permission: "contents",
      needed: "read",
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("AC7 nothing logged carries the installation token or the bearer", async () => {
    const f = await fixture();
    const logs = captureLogs();
    try {
      const failedMint = harness(
        {},
        {
          mintReadToken: async () => {
            throw new Error(`boom ${SENTINEL} ${f.token}`);
          },
        },
      );
      expect(
        (await failedMint.handler(rest(IN_REPO, f.token), "rest")).status,
      ).toBe(502);
      const down = harness({ throws: true });
      expect((await down.handler(rest(IN_REPO, f.token), "rest")).status).toBe(
        502,
      );
      const writes = harness();
      expect(
        (
          await writes.handler(
            rest(IN_REPO, f.token, { method: "POST", body: "{}" }),
            "rest",
          )
        ).status,
      ).toBe(403);
      const failingDb = harness(
        {},
        {
          db: new Proxy({} as DB, {
            get() {
              throw new Error(`db down ${SENTINEL} ${f.token}`);
            },
          }),
        },
      );
      expect(
        (await failingDb.handler(rest(IN_REPO, f.token), "rest")).status,
      ).toBe(500);
      expect(logs.text()).not.toContain(SENTINEL);
      expect(logs.text()).not.toContain(f.token);
    } finally {
      logs.restore();
    }
  });
});
