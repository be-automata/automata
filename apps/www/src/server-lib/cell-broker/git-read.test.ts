import { describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { captureLogs, basic } from "@/test-helpers/capture-logs";
import type { DB } from "@terragon/shared/db";
import {
  markStepDone,
  revokeAttempt,
} from "@terragon/shared/model/cell-authority";
import { createTestCellStep } from "@terragon/shared/model/test-helpers";

import {
  createGitBrokerHandler,
  type GitBrokerDeps,
} from "@terragon/cell-broker/git";

const SENTINEL = "ghs_SENTINEL_installation_token";
const BASE = "https://www.example.com/api/cell/git";

const fixture = (repo = "acme/widgets") =>
  createTestCellStep({ db, repoFullName: repo });

interface Upstream {
  status?: number;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
  throws?: boolean;
}

function harness(upstream: Upstream = {}, over: Partial<GitBrokerDeps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (upstream.throws) throw new Error("network down");
      return new Response(upstream.body ?? "advert", {
        status: upstream.status ?? 200,
        headers: upstream.headers ?? {
          "content-type": "application/x-git-upload-pack-advertisement",
        },
      });
    },
  );
  const mintReadToken = vi.fn(async () => ({ token: SENTINEL }));
  const mintWriteToken = vi.fn(async () => ({ token: SENTINEL }));
  const handler = createGitBrokerHandler({
    db,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    mintReadToken,
    mintWriteToken,
    sideEffectsEnabled: () => true,
    enabled: () => true,
    ...over,
  });
  return { handler, calls, fetchImpl, mintReadToken, mintWriteToken };
}

function get(path: string, token: string | null, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, {
    method: "GET",
    ...init,
    headers: {
      ...(token ? { authorization: basic(token) } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

function post(
  path: string,
  token: string,
  headers: Record<string, string> = {},
) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    body: "0000",
    headers: { authorization: basic(token), ...headers },
  });
}

const UPLOAD_ADVERT = "/acme/widgets.git/info/refs?service=git-upload-pack";
const RECEIVE_ADVERT = "/acme/widgets.git/info/refs?service=git-receive-pack";

describe("git broker reads", () => {
  it("AC1 forwards the upload-pack advertisement and POST to github.com, bytes and status intact, gzip kept", async () => {
    const f = await fixture();
    const h = harness({
      status: 200,
      body: new Uint8Array([0, 1, 2, 250]),
      headers: { "content-type": "application/x-git-upload-pack-result" },
    });

    const advert = await h.handler(get(UPLOAD_ADVERT, f.token));
    expect(advert.status).toBe(200);
    expect(new Uint8Array(await advert.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2, 250]),
    );
    expect(advert.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-result",
    );
    expect(h.calls[0]?.url).toBe(
      "https://github.com/acme/widgets.git/info/refs?service=git-upload-pack",
    );

    const pack = await h.handler(
      post("/acme/widgets.git/git-upload-pack", f.token, {
        "content-encoding": "gzip",
        "content-type": "application/x-git-upload-pack-request",
        "git-protocol": "version=2",
      }),
    );
    expect(pack.status).toBe(200);
    const call = h.calls[1]!;
    expect(call.url).toBe(
      "https://github.com/acme/widgets.git/git-upload-pack",
    );
    expect(call.init.method).toBe("POST");
    const sent = new Headers(call.init.headers);
    expect(sent.get("content-encoding")).toBe("gzip");
    expect(sent.get("git-protocol")).toBe("version=2");
    expect(call.init.redirect).toBe("manual");
  });

  it("a dotted repo name works and the upstream URL uses the step's repo", async () => {
    const f = await fixture("org/Next.js");
    const h = harness();
    const res = await h.handler(
      get("/Org/Next.js.git/info/refs?service=git-upload-pack", f.token),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0]?.url).toBe(
      "https://github.com/org/next.js.git/info/refs?service=git-upload-pack",
    );
  });

  it("AC2 refuses another repo, unlisted endpoints, bad queries and unsafe segments without an upstream call", async () => {
    const f = await fixture();
    const h = harness();
    const refused: Request[] = [
      get("/other/widgets.git/info/refs?service=git-upload-pack", f.token),
      get("/acme/other.git/info/refs?service=git-upload-pack", f.token),
      get("/acme/widgets.git/HEAD", f.token),
      get("/acme/widgets.git/objects/info/packs", f.token),
      get("/acme/widgets.git/info/refs?service=foo", f.token),
      get("/acme/widgets.git/info/refs", f.token),
      get(`${UPLOAD_ADVERT}&x=1`, f.token),
      get(`${UPLOAD_ADVERT}&service=git-receive-pack`, f.token),
      post("/acme/widgets.git/info/refs?service=git-upload-pack", f.token),
      post("/acme/widgets.git/git-upload-pack?x=1", f.token),
      get("/acme/widgets/info/refs?service=git-upload-pack", f.token),
      get("/acme/../info/refs?service=git-upload-pack", f.token),
      get(
        "/acme/%2e%2e/widgets.git/info/refs?service=git-upload-pack",
        f.token,
      ),
      get("/acme/widgets.git%2Finfo/refs?service=git-upload-pack", f.token),
      get("/acme%2Fwidgets.git/info/refs?service=git-upload-pack", f.token),
      get("/acme/widgets.git/info%5Crefs?service=git-upload-pack", f.token),
      new Request(
        `${BASE}/acme/widgets.git/info/refs?service=git-upload-pack`,
        {
          method: "HEAD",
          headers: { authorization: basic(f.token) },
        },
      ),
    ];
    for (const request of refused) {
      const res = await h.handler(request);
      expect(res.status, request.url).toBe(403);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("AC3 maps every bearer refusal and challenges a missing credential, with no upstream call", async () => {
    const h = harness();

    const none = await h.handler(get(UPLOAD_ADVERT, null));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      'Basic realm="automata-cell"',
    );

    const unknown = await h.handler(get(UPLOAD_ADVERT, "nope"));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "unknown_bearer" });

    const revoked = await fixture();
    await revokeAttempt({ db, stepKey: revoked.stepKey, attempt: 1 });
    const r = await h.handler(get(UPLOAD_ADVERT, revoked.token));
    expect([r.status, (await r.json()).error]).toEqual([401, "revoked"]);

    const expired = await fixture();
    const short = await expired.bearer(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const e = await h.handler(get(UPLOAD_ADVERT, short));
    expect([e.status, (await e.json()).error]).toEqual([401, "expired"]);

    const fenced = await fixture();
    await fenced.open(2);
    const fe = await h.handler(get(UPLOAD_ADVERT, fenced.token));
    expect([fe.status, (await fe.json()).error]).toEqual([409, "fenced"]);

    const done = await fixture();
    await markStepDone({ db, token: done.token });
    const d = await h.handler(get(UPLOAD_ADVERT, done.token));
    expect([d.status, (await d.json()).error]).toEqual([409, "step_done"]);

    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("AC7 the installation token only reaches GitHub, in Authorization, never the cell", async () => {
    const f = await fixture();
    const h = harness({
      headers: { "content-type": "text/plain", "x-note": "ok" },
    });
    const res = await h.handler(get(UPLOAD_ADVERT, f.token));
    const body = await res.text();
    const everything =
      body + JSON.stringify([...res.headers.entries()]) + res.url;
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain(btoa(`x-access-token:${SENTINEL}`));
    const sent = new Headers(h.calls[0]?.init.headers);
    expect(sent.get("authorization")).toBe(basic(SENTINEL));
    // The cell's own bearer is replaced, never forwarded.
    expect(sent.get("authorization")).not.toContain(btoa(f.token));
    const rest = [...sent.entries()].filter(([k]) => k !== "authorization");
    expect(JSON.stringify(rest)).not.toContain(SENTINEL);
    expect(h.calls[0]?.url).not.toContain(SENTINEL);

    const refused = await h.handler(get("/x/y.git/info/refs", f.token));
    expect(await refused.text()).not.toContain(SENTINEL);
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
    const res = await h.handler(get(UPLOAD_ADVERT, "anything"));
    expect(res.status).toBe(404);
    expect(touched).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.mintReadToken).not.toHaveBeenCalled();
    expect(h.mintWriteToken).not.toHaveBeenCalled();
  });

  it("AC11 upload-pack legs mint the read token, the receive-pack advertisement the write token, scoped to the step's repo", async () => {
    const f = await fixture();
    const h = harness();
    await h.handler(get(UPLOAD_ADVERT, f.token));
    await h.handler(post("/acme/widgets.git/git-upload-pack", f.token));
    expect(h.mintReadToken).toHaveBeenCalledTimes(2);
    expect(h.mintReadToken).toHaveBeenCalledWith("acme", "widgets");
    expect(h.mintWriteToken).not.toHaveBeenCalled();

    const advert = await h.handler(get(RECEIVE_ADVERT, f.token));
    expect(advert.status).toBe(200);
    expect(h.mintWriteToken).toHaveBeenCalledTimes(1);
    expect(h.mintWriteToken).toHaveBeenCalledWith("acme", "widgets");
    expect(h.mintReadToken).toHaveBeenCalledTimes(2);
    expect(h.calls[2]?.url).toBe(
      "https://github.com/acme/widgets.git/info/refs?service=git-receive-pack",
    );
  });

  it("with side effects off the receive-pack advertisement is 503 and upload-pack still works", async () => {
    const f = await fixture();
    const h = harness({}, { sideEffectsEnabled: () => false });
    const advert = await h.handler(get(RECEIVE_ADVERT, f.token));
    expect([advert.status, (await advert.json()).error]).toEqual([
      503,
      "side_effects_disabled",
    ]);
    const push = await h.handler(
      post("/acme/widgets.git/git-receive-pack", f.token),
    );
    expect(push.status).toBe(503);
    expect(h.mintWriteToken).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();

    const fetchSide = await h.handler(get(UPLOAD_ADVERT, f.token));
    expect(fetchSide.status).toBe(200);
  });

  it("a 3xx from GitHub, a thrown fetch and a failed mint all answer 502 upstream_error", async () => {
    const f = await fixture();
    const redirected = harness({
      status: 302,
      headers: { location: "https://evil.test/" },
    });
    const a = await redirected.handler(get(UPLOAD_ADVERT, f.token));
    expect([a.status, (await a.json()).error]).toEqual([502, "upstream_error"]);

    const down = harness({ throws: true });
    const b = await down.handler(get(UPLOAD_ADVERT, f.token));
    expect([b.status, (await b.json()).error]).toEqual([502, "upstream_error"]);

    const failedMint = harness(
      {},
      {
        mintReadToken: async () => {
          throw new Error(`boom ${SENTINEL}`);
        },
      },
    );
    const c = await failedMint.handler(get(UPLOAD_ADVERT, f.token));
    const text = await c.text();
    expect(c.status).toBe(502);
    expect(text).not.toContain(SENTINEL);
    expect(failedMint.fetchImpl).not.toHaveBeenCalled();
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
        (await failedMint.handler(get(UPLOAD_ADVERT, f.token))).status,
      ).toBe(502);
      const down = harness({ throws: true });
      expect((await down.handler(get(UPLOAD_ADVERT, f.token))).status).toBe(
        502,
      );
      const redirected = harness({ status: 302 });
      expect(
        (await redirected.handler(get(UPLOAD_ADVERT, f.token))).status,
      ).toBe(502);
      const refused = harness();
      expect(
        (await refused.handler(get("/x/y.git/info/refs", f.token))).status,
      ).toBe(403);
      expect(logs.text()).not.toContain(SENTINEL);
      expect(logs.text()).not.toContain(f.token);
    } finally {
      logs.restore();
    }
  });
});
