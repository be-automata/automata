import { describe, it, expect, afterEach } from "vitest";
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
    hasBody: boolean;
  }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method,
      auth: headers.get("Authorization") ?? undefined,
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

async function start(fetchImpl: typeof fetch) {
  broker = await startGitBroker({
    installationToken: TOKEN,
    repoFullName: REPO,
    runBearer: BEARER,
    fetchImpl,
  });
  return broker;
}

const withBearer = { Authorization: `Bearer ${BEARER}` };

describe("startGitBroker (#65 — local git credential broker)", () => {
  it("injects the token upstream and NEVER exposes it to the caller", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
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
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    const res = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("401 for a wrong bearer (timing-safe compare)", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    const res = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      { headers: { Authorization: "Bearer wrong" } },
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("404 for a different repo — the path fence holds", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    const res = await fetch(
      `${b.url}/attacker/other.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("403 for a non-git method/endpoint (arbitrary GET) — the allowlist holds", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
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
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
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

  it("case-insensitive repo match (GitHub slugs are case-insensitive)", async () => {
    const { impl, calls } = recordingFetch();
    const b = await start(impl);
    const res = await fetch(
      `${b.url}/Be-Automata/Automata.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    expect(res.status).toBe(200);
    // Upstream is rebuilt from the fenced (lowercased) owner/repo.
    expect(calls[0]!.url).toContain("github.com/be-automata/automata.git");
  });
});
