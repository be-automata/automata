import { Readable } from "node:stream";

import { describe, it, expect, afterEach, vi } from "vitest";

import { startGitBroker, type GitBroker } from "./git-broker";

const TOKEN = "ghs_installation_token_secret";
const BEARER = "run-bearer-abc123";
const REPO = "be-automata/automata";

let broker: GitBroker | null = null;
afterEach(async () => {
  await broker?.close();
  broker = null;
});

/** A fetch stand-in that records what the broker sent upstream. */
function recordingFetch() {
  const calls: Array<{
    url: string;
    method?: string;
    auth?: string;
    headers: Record<string, string>;
    hasBody: boolean;
  }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method,
      auth: headers.get("Authorization") ?? undefined,
      headers: Object.fromEntries(headers),
      hasBody: init?.body != null,
    });
    return new Response("UPSTREAM-BODY", {
      status: 200,
      headers: {
        "content-type": "application/x-git-upload-pack-advertisement",
      },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Start a broker over a recording fetch — the setup every test shares. */
async function boot() {
  const { impl, calls } = recordingFetch();
  broker = await startGitBroker({
    installationToken: TOKEN,
    repoFullName: REPO,
    runBearer: BEARER,
    fetchImpl: impl,
  });
  return { b: broker, calls };
}

const withBearer = { Authorization: `Bearer ${BEARER}` };

describe("startGitBroker (#65 — local git credential broker)", () => {
  it("injects the token upstream and NEVER exposes it to the caller", async () => {
    const { b, calls } = await boot();
    const res = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toBe("UPSTREAM-BODY");
    // The caller's response carries NO token.
    expect(body).not.toContain(TOKEN);
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
    // Upstream got the injected Basic auth (x-access-token:TOKEN), not the bearer.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://github.com/be-automata/automata.git/info/refs?service=git-upload-pack",
    );
    const expectedAuth =
      "Basic " + Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    expect(calls[0]!.auth).toBe(expectedAuth);
  });

  it("401 without the per-run bearer, and never reaches upstream", async () => {
    const { b, calls } = await boot();
    const res = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("401 for a wrong bearer (timing-safe compare)", async () => {
    const { b, calls } = await boot();
    const res = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      { headers: { Authorization: "Bearer wrong" } },
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("404 for a different repo — the path fence holds", async () => {
    const { b, calls } = await boot();
    const res = await fetch(
      `${b.url}/attacker/other.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("403 for a non-git method/endpoint (arbitrary GET) — the allowlist holds", async () => {
    const { b, calls } = await boot();
    for (const path of [
      "be-automata/automata.git/config",
      "be-automata/automata.git/info/refs?service=evil",
      "be-automata/automata.git/info/refs", // no service
    ]) {
      const res = await fetch(`${b.url}/${path}`, { headers: withBearer });
      expect(res.status, path).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it("POST git-upload-pack (fetch) and git-receive-pack (push) both proxy with a body", async () => {
    const { b, calls } = await boot();
    for (const endpoint of ["git-upload-pack", "git-receive-pack"]) {
      const res = await fetch(`${b.url}/be-automata/automata.git/${endpoint}`, {
        method: "POST",
        headers: {
          ...withBearer,
          "content-type": `application/x-${endpoint}-request`,
        },
        body: "PACK-BYTES",
      });
      expect(res.status, endpoint).toBe(200);
    }
    expect(calls.map((c) => [c.method, c.hasBody])).toEqual([
      ["POST", true],
      ["POST", true],
    ]);
    expect(calls[0]!.url).toBe(
      "https://github.com/be-automata/automata.git/git-upload-pack",
    );
  });

  it("forwards arbitrary git headers verbatim but REPLACES authorization (denylist)", async () => {
    const { b, calls } = await boot();
    await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      {
        headers: {
          ...withBearer,
          "git-protocol": "version=2",
          "user-agent": "git/2.53.0",
          // A hop-by-hop / owned header the broker must NOT forward.
          connection: "keep-alive",
        },
      },
    );
    const sent = calls[0]!.headers;
    // Load-bearing git header forwarded (the bug that broke real clones once).
    expect(sent["git-protocol"]).toBe("version=2");
    // A future/unknown git header rides through by default (denylist, not allowlist).
    expect(sent["user-agent"]).toBe("git/2.53.0");
    // The client's bearer is REPLACED with the injected token, never forwarded.
    expect(calls[0]!.auth).toBe(
      "Basic " + Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
    );
    // Hop-by-hop header is dropped.
    expect(sent["connection"]).toBeUndefined();
  });

  it("refuses to start with an empty bearer or token (the fence can't collapse)", async () => {
    await expect(
      startGitBroker({
        installationToken: TOKEN,
        repoFullName: REPO,
        runBearer: "",
      }),
    ).rejects.toThrow(/runBearer must be a non-empty/);
    await expect(
      startGitBroker({
        installationToken: "",
        repoFullName: REPO,
        runBearer: BEARER,
      }),
    ).rejects.toThrow(/installationToken must be non-empty/);
  });

  it("case-insensitive repo match (GitHub slugs are case-insensitive)", async () => {
    const { b, calls } = await boot();
    const res = await fetch(
      `${b.url}/Be-Automata/Automata.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    expect(res.status).toBe(200);
    // Upstream is rebuilt from the fenced (lowercased) owner/repo.
    expect(calls[0]!.url).toContain("github.com/be-automata/automata.git");
  });
});

// ---------------------------------------------------------------------------
// FENCE-01 (phase 9): the self-heal fix lane's ref fence.
// ---------------------------------------------------------------------------

const FIX_REF = "refs/heads/automata/fix-12-deadbeef-a1";
const OLD_SHA = "1".repeat(40);
const NEW_SHA = "a".repeat(40);

function pkt(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([
    Buffer.from((body.length + 4).toString(16).padStart(4, "0"), "ascii"),
    body,
  ]);
}

/** A receive-pack request body as `git push` sends it: commands, flush, PACK. */
function pushBody(commands: Array<[string, string, string]>): Buffer {
  const lines = commands.map(([o, n, ref], i) =>
    pkt(
      i === 0
        ? `${o} ${n} ${ref}\u0000 report-status agent=git/2.53.0`
        : `${o} ${n} ${ref}`,
    ),
  );
  return Buffer.concat([
    ...lines,
    Buffer.from("0000", "ascii"),
    Buffer.from("PACK\u0000\u0000\u0000\u0002pack-object-bytes"),
  ]);
}

/** A fetch stand-in that CONSUMES the request body, so byte identity can be asserted. */
function bodyReadingFetch() {
  const calls: Array<{ url: string; method?: string; body: Buffer | null }> =
    [];
  const dials = { count: 0 };
  const impl = (async (url: string, init?: RequestInit) => {
    dials.count += 1;
    const body =
      init?.body != null
        ? Buffer.from(await new Response(init.body).arrayBuffer())
        : null;
    calls.push({ url: String(url), method: init?.method, body });
    return new Response("REPORT-STATUS", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls, dials };
}

async function bootFenced() {
  const { impl, calls, dials } = bodyReadingFetch();
  broker = await startGitBroker({
    installationToken: TOKEN,
    repoFullName: REPO,
    runBearer: BEARER,
    fetchImpl: impl,
    refFence: { exactRef: FIX_REF },
  });
  return { b: broker, calls, dials };
}

async function postReceivePack(b: GitBroker, body: Buffer) {
  return fetch(`${b.url}/be-automata/automata.git/git-receive-pack`, {
    method: "POST",
    headers: {
      ...withBearer,
      "content-type": "application/x-git-receive-pack-request",
    },
    body,
  });
}

describe("startGitBroker refFence (FENCE-01 — self-heal fix runs)", () => {
  it("a push to the exact attempt branch is forwarded byte-identically and its sha recorded", async () => {
    const { b, calls } = await bootFenced();
    expect(b.lastPushedSha()).toBeNull();
    const body = pushBody([[OLD_SHA, NEW_SHA, FIX_REF]]);
    const res = await postReceivePack(b, body);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("REPORT-STATUS");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://github.com/be-automata/automata.git/git-receive-pack",
    );
    expect(calls[0]!.body!.equals(body)).toBe(true);
    expect(b.lastPushedSha()).toBe(NEW_SHA);
  });

  it("a push to main → 403 and the upstream receives NOTHING", async () => {
    const { b, calls } = await bootFenced();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await postReceivePack(
      b,
      pushBody([[OLD_SHA, NEW_SHA, "refs/heads/main"]]),
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(b.lastPushedSha()).toBeNull();
    // One log line: reason + ref, never the token.
    expect(errors).toHaveBeenCalledTimes(1);
    const line = errors.mock.calls.flat().join(" ");
    expect(line).toContain("ref_not_allowed");
    expect(line).toContain("refs/heads/main");
    expect(line).not.toContain(TOKEN);
    errors.mockRestore();
  });

  it("a good update bundled with a tag update → 403 as a whole", async () => {
    const { b, calls } = await bootFenced();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await postReceivePack(
      b,
      pushBody([
        [OLD_SHA, NEW_SHA, FIX_REF],
        ["0".repeat(40), NEW_SHA, "refs/tags/v1"],
      ]),
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    errors.mockRestore();
  });

  it("a delete of the attempt branch → 403", async () => {
    const { b, calls } = await bootFenced();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await postReceivePack(
      b,
      pushBody([[OLD_SHA, "0".repeat(40), FIX_REF]]),
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(errors.mock.calls.flat().join(" ")).toContain("delete_not_allowed");
    errors.mockRestore();
  });

  it("a malformed or truncated command list → 403, nothing forwarded", async () => {
    const { b, calls } = await bootFenced();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const body of [
      Buffer.from("zzzz-not-a-pkt-line"),
      pkt(`${OLD_SHA} ${NEW_SHA} ${FIX_REF}`), // body ends before the flush
      Buffer.from("0000PACK"), // no commands at all
    ]) {
      const res = await postReceivePack(b, body);
      expect(res.status, body.toString("latin1")).toBe(403);
    }
    expect(calls).toHaveLength(0);
    errors.mockRestore();
  });

  it("a 70 KiB command section → 413, nothing forwarded", async () => {
    const { b, calls } = await bootFenced();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const commands: Array<[string, string, string]> = [];
    // Every update targets the exact ref, so only the size cap can refuse it.
    while (commands.length * 120 < 72 * 1024) {
      commands.push([OLD_SHA, NEW_SHA, FIX_REF]);
    }
    const body = pushBody(commands);
    expect(body.length).toBeGreaterThan(70 * 1024);
    const res = await postReceivePack(b, body);
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
    errors.mockRestore();
  });

  it("a compressed receive-pack body → 415 (the fence cannot read it)", async () => {
    const { b, calls } = await bootFenced();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(
      `${b.url}/be-automata/automata.git/git-receive-pack`,
      {
        method: "POST",
        headers: { ...withBearer, "content-encoding": "gzip" },
        body: pushBody([[OLD_SHA, NEW_SHA, FIX_REF]]),
      },
    );
    expect(res.status).toBe(415);
    expect(calls).toHaveLength(0);
    errors.mockRestore();
  });

  it("fetch traffic is unaffected: info/refs and upload-pack pass through", async () => {
    const { b, calls } = await bootFenced();
    const adv = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-receive-pack`,
      { headers: withBearer },
    );
    expect(adv.status).toBe(200);
    const up = await fetch(
      `${b.url}/be-automata/automata.git/git-upload-pack`,
      {
        method: "POST",
        headers: withBearer,
        body: "not-a-command-list",
      },
    );
    expect(up.status).toBe(200);
    expect(calls.map((c) => c.body?.toString() ?? null)).toEqual([
      null,
      "not-a-command-list",
    ]);
    expect(b.lastPushedSha()).toBeNull();
  });

  it("the command section is checked before the upstream is dialled (buffered prefix)", async () => {
    const { b, calls, dials } = await bootFenced();
    const body = pushBody([[OLD_SHA, NEW_SHA, FIX_REF]]);
    const { status, sentBeforeEnd } = await streamedPost(
      b,
      body,
      10,
      () => dials.count,
    );
    // Only 10 bytes of the command list were sent before we paused: the
    // broker must not have dialled GitHub yet.
    expect(sentBeforeEnd).toBe(0);
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body!.equals(body)).toBe(true);
  });

  it("a multi-chunk fenced push forwards the FULL body and never wraps req in toWeb", async () => {
    const { b, calls } = await bootFenced();
    const toWeb = vi.spyOn(Readable, "toWeb");
    const pack = Buffer.alloc(2 * 1024 * 1024, 7);
    const body = Buffer.concat([pushBody([[OLD_SHA, NEW_SHA, FIX_REF]]), pack]);
    // Split inside the command section so the fence must loop over chunks.
    const { status } = await streamedPost(b, body, 30, () => 0);
    expect(status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body!.length).toBe(body.length);
    expect(calls[0]!.body!.equals(body)).toBe(true);
    expect(toWeb).not.toHaveBeenCalled();
    toWeb.mockRestore();
  });
});

describe("startGitBroker without refFence — today's behaviour", () => {
  it("streams a receive-pack body upstream without buffering it", async () => {
    let dialled = 0;
    const impl = (async (_url: string, init?: RequestInit) => {
      dialled += 1;
      // Drain whatever arrives so the request can complete.
      if (init?.body != null) await new Response(init.body).arrayBuffer();
      return new Response("OK", { status: 200 });
    }) as unknown as typeof fetch;
    broker = await startGitBroker({
      installationToken: TOKEN,
      repoFullName: REPO,
      runBearer: BEARER,
      fetchImpl: impl,
    });
    const body = pushBody([[OLD_SHA, NEW_SHA, "refs/heads/main"]]);
    const { status, sentBeforeEnd } = await streamedPost(
      broker,
      body,
      10,
      () => dialled,
    );
    // Upstream was dialled while the body was still open: no buffering.
    expect(sentBeforeEnd).toBe(1);
    expect(status).toBe(200);
    expect(broker.lastPushedSha()).toBeNull();
  });
});

/**
 * POST `body` with node:http, pausing after `splitAt` bytes. Returns how many
 * upstream dials `probe` saw while the body was still open.
 */
async function streamedPost(
  b: GitBroker,
  body: Buffer,
  splitAt: number,
  probe: () => number,
): Promise<{ status: number; sentBeforeEnd: number }> {
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    let sentBeforeEnd = -1;
    const req = request(
      `${b.url}/be-automata/automata.git/git-receive-pack`,
      {
        method: "POST",
        headers: { ...withBearer, "transfer-encoding": "chunked" },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, sentBeforeEnd }),
        );
      },
    );
    req.on("error", reject);
    req.write(body.subarray(0, splitAt));
    setTimeout(() => {
      sentBeforeEnd = probe();
      req.end(body.subarray(splitAt));
    }, 150);
  });
}
