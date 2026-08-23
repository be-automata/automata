import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  CRED_BROKER_ALIAS,
  CRED_BROKER_GIT_PORT,
  CRED_BROKER_NETWORK_PREFIX,
  CRED_BROKER_SCRIPT_CONTAINER_PATH,
  CRED_BROKER_SECRETS_CONTAINER_PATH,
  addCredBrokerToNoProxy,
  buildCredBrokerSecretsFileContent,
  buildCredBrokerSidecarRunCommand,
  buildGuestCredBrokerGitConfig,
  credBrokerNetworkName,
  credBrokerSidecarName,
} from "./docker-cred-broker";
import { CRED_BROKER_SCRIPT } from "../cred-broker-standalone.generated";

const require = createRequire(import.meta.url);

// The standalone broker is CommonJS (bind-mounted into the sidecar, run with a
// bare `node`). Require it directly to exercise the relocated git-broker fences
// against a recording fetch — mirrors packages/worker git-broker.test.ts.
const { startCredBroker, parseSecrets } =
  require("../cred-broker-standalone.cjs") as {
    startCredBroker: (opts: {
      installationToken: string;
      repoFullName: string;
      runBearer: string;
      port?: number;
      host?: string;
      fetchImpl?: typeof fetch;
    }) => Promise<{ url: string; port: number; close: () => Promise<void> }>;
    parseSecrets: (json: string) => {
      installationToken: string;
      runBearer: string;
    };
  };

describe("docker cred-broker command builders (pure — no docker daemon)", () => {
  it("derives network and sidecar names from the container name", () => {
    expect(credBrokerNetworkName("terragon-sandbox-x")).toBe(
      "automata-cred-broker-terragon-sandbox-x",
    );
    expect(credBrokerNetworkName("terragon-sandbox-x")).toBe(
      `${CRED_BROKER_NETWORK_PREFIX}terragon-sandbox-x`,
    );
    expect(credBrokerSidecarName("terragon-sandbox-x")).toBe(
      "terragon-sandbox-x-cred-broker",
    );
  });

  it("builds the sidecar run command: internal net, alias, RO script + secret-file mounts, non-secret env only", () => {
    const command = buildCredBrokerSidecarRunCommand({
      sidecarName: "sb-cred-broker",
      networkName: "automata-cred-broker-sb",
      baseImage: "ghcr.io/terragon-labs/containers-test",
      scriptHostPath: "/tmp/x/cred-broker.cjs",
      secretsHostPath: "/tmp/x/secrets.json",
      repoFullName: "be-automata/automata",
    });
    expect(command).toContain("docker run -d --name sb-cred-broker");
    expect(command).toContain("--network automata-cred-broker-sb");
    expect(command).toContain(`--network-alias ${CRED_BROKER_ALIAS}`);
    expect(command).toContain(
      `-v '/tmp/x/cred-broker.cjs':${CRED_BROKER_SCRIPT_CONTAINER_PATH}:ro`,
    );
    expect(command).toContain(
      `-v '/tmp/x/secrets.json':${CRED_BROKER_SECRETS_CONTAINER_PATH}:ro`,
    );
    expect(command).toContain(
      `-e CRED_BROKER_REPO_FULL_NAME='be-automata/automata'`,
    );
    expect(command).toContain(
      `-e CRED_BROKER_GIT_PORT=${CRED_BROKER_GIT_PORT}`,
    );
    expect(command).toContain(
      `ghcr.io/terragon-labs/containers-test node ${CRED_BROKER_SCRIPT_CONTAINER_PATH}`,
    );
  });

  it("NEVER puts the installation token or bearer on argv/-e (file mount only)", () => {
    const command = buildCredBrokerSidecarRunCommand({
      sidecarName: "sb-cred-broker",
      networkName: "automata-cred-broker-sb",
      baseImage: "img",
      scriptHostPath: "/tmp/x/cred-broker.cjs",
      secretsHostPath: "/tmp/x/secrets.json",
      repoFullName: "be-automata/automata",
    });
    // The command carries only paths + non-secret repo/port — no secret values.
    expect(command).not.toContain("ghs_");
    expect(command).not.toContain("run-bearer");
    expect(command).not.toContain("installationToken");
    expect(command).not.toContain("runBearer");
    // The secret file's CONTENT is where the values live; assert that shape.
    const content = buildCredBrokerSecretsFileContent({
      installationToken: "ghs_token_secret",
      runBearer: "run-bearer-abc",
    });
    expect(JSON.parse(content)).toEqual({
      installationToken: "ghs_token_secret",
      runBearer: "run-bearer-abc",
    });
  });

  it("guest git-config routes github.com through the broker with the bearer and scrubs residue", () => {
    const lines = buildGuestCredBrokerGitConfig({
      alias: CRED_BROKER_ALIAS,
      port: CRED_BROKER_GIT_PORT,
      bearer: "run-bearer-abc",
    });
    const script = lines.join("\n");
    const brokerUrl = `http://${CRED_BROKER_ALIAS}:${CRED_BROKER_GIT_PORT}/`;
    // Brokered wiring.
    expect(script).toContain(
      `git config --global url.'${brokerUrl}'.insteadOf https://github.com/`,
    );
    expect(script).toContain(
      `git config --global http.${brokerUrl}.extraheader 'Authorization: Bearer run-bearer-abc'`,
    );
    expect(script).toContain(`git config --global credential.helper ''`);
    // Residue removal (belt-and-suspenders for #89).
    expect(script).toContain(`rm -f ~/.git-credentials`);
    expect(script).toContain(
      `git config --global --unset-all credential.helper`,
    );
    expect(script).toContain(
      `git config --global --unset-all http.https://github.com/.extraheader`,
    );
    // The installation token is NEVER present in the guest config.
    expect(script).not.toContain("x-access-token");
    expect(script).not.toContain("ghs_");
  });

  it("adds the cred-broker alias to NO_PROXY without duplicating", () => {
    expect(addCredBrokerToNoProxy("127.0.0.1,localhost")).toBe(
      `127.0.0.1,localhost,${CRED_BROKER_ALIAS}`,
    );
    // Idempotent.
    expect(
      addCredBrokerToNoProxy(`127.0.0.1,localhost,${CRED_BROKER_ALIAS}`),
    ).toBe(`127.0.0.1,localhost,${CRED_BROKER_ALIAS}`);
  });
});

describe("cred-broker-standalone.cjs", () => {
  it("generated TS module is in sync with the .cjs source (run pnpm -C packages/sandbox build-cred-broker)", () => {
    const source = readFileSync(
      join(__dirname, "..", "cred-broker-standalone.cjs"),
      "utf8",
    );
    expect(CRED_BROKER_SCRIPT).toBe(source);
  });

  describe("parseSecrets (fail-closed)", () => {
    it("accepts a valid secret file", () => {
      expect(
        parseSecrets('{"installationToken":"ghs_x","runBearer":"b"}'),
      ).toEqual({ installationToken: "ghs_x", runBearer: "b" });
    });

    it("throws on garbage / missing fields", () => {
      expect(() => parseSecrets("")).toThrow(/not JSON/);
      expect(() => parseSecrets('{"installationToken":"x"}')).toThrow(
        /secrets must be/,
      );
      expect(() => parseSecrets('{"runBearer":"b"}')).toThrow(
        /secrets must be/,
      );
      expect(() =>
        parseSecrets('{"installationToken":1,"runBearer":"b"}'),
      ).toThrow(/secrets must be/);
    });
  });
});

// The relocated git-smart-HTTP broker fences — copied verbatim from the worker
// (packages/worker/src/agent-run/git-broker.ts + broker-common.ts) into the
// standalone. These pin the fences at this plane. Behavioral changes must land
// in BOTH sources.
describe("startCredBroker (relocated git broker fences)", () => {
  const TOKEN = "ghs_installation_token_secret";
  const BEARER = "run-bearer-abc123";
  const REPO = "be-automata/automata";
  const withBearer = { Authorization: `Bearer ${BEARER}` };

  let broker: { url: string; port: number; close: () => Promise<void> } | null =
    null;
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

  async function boot() {
    const { impl, calls } = recordingFetch();
    broker = await startCredBroker({
      installationToken: TOKEN,
      repoFullName: REPO,
      runBearer: BEARER,
      port: 0,
      host: "127.0.0.1",
      fetchImpl: impl,
    });
    return { b: broker, calls };
  }

  it("injects the token upstream and NEVER exposes it to the caller", async () => {
    const { b, calls } = await boot();
    const res = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toBe("UPSTREAM-BODY");
    expect(body).not.toContain(TOKEN);
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://github.com/be-automata/automata.git/info/refs?service=git-upload-pack",
    );
    const expectedAuth =
      "Basic " + Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    expect(calls[0]!.auth).toBe(expectedAuth);
  });

  it("401 without / with a wrong per-run bearer, and never reaches upstream", async () => {
    const { b, calls } = await boot();
    const noBearer = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
    );
    expect(noBearer.status).toBe(401);
    const wrong = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      { headers: { Authorization: "Bearer wrong" } },
    );
    expect(wrong.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("404 for a DIFFERENT repo — the confused-deputy path fence holds", async () => {
    const { b, calls } = await boot();
    for (const path of [
      "attacker/other.git/info/refs?service=git-upload-pack",
      "be-automata/other.git/info/refs?service=git-upload-pack",
      "other-owner/automata.git/info/refs?service=git-upload-pack",
    ]) {
      const res = await fetch(`${b.url}/${path}`, { headers: withBearer });
      expect(res.status, path).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("cross-repo cannot be reached via an alternate Host header (target rebuilt from the fenced repo)", async () => {
    const { b, calls } = await boot();
    // A valid bearer + the FENCED repo path, but an attacker Host header: the
    // upstream is rebuilt from owner/repo, never the Host, so it still targets
    // the trusted repo (and the Host header is broker-owned, not forwarded).
    const res = await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      { headers: { ...withBearer, host: "evil.example.com" } },
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(
      "https://github.com/be-automata/automata.git/info/refs?service=git-upload-pack",
    );
    expect(calls[0]!.headers["host"]).toBeUndefined();
  });

  it("403 for a non-git method/endpoint (the allowlist holds)", async () => {
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

  it("POST upload-pack and receive-pack both proxy with a body", async () => {
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
  });

  it("forwards arbitrary git headers verbatim but REPLACES authorization", async () => {
    const { b, calls } = await boot();
    await fetch(
      `${b.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      {
        headers: {
          ...withBearer,
          "git-protocol": "version=2",
          "user-agent": "git/2.53.0",
          connection: "keep-alive",
        },
      },
    );
    const sent = calls[0]!.headers;
    expect(sent["git-protocol"]).toBe("version=2");
    expect(sent["user-agent"]).toBe("git/2.53.0");
    expect(calls[0]!.auth).toBe(
      "Basic " + Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
    );
    expect(sent["connection"]).toBeUndefined();
  });

  it("bare-502s on an upstream error without leaking the token", async () => {
    const impl = (async () => {
      throw new Error(`network exploded ${TOKEN}`);
    }) as unknown as typeof fetch;
    broker = await startCredBroker({
      installationToken: TOKEN,
      repoFullName: REPO,
      runBearer: BEARER,
      port: 0,
      host: "127.0.0.1",
      fetchImpl: impl,
    });
    const res = await fetch(
      `${broker.url}/be-automata/automata.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toBe("bad gateway");
    expect(body).not.toContain(TOKEN);
  });

  it("refuses to start with an empty bearer or token (the fence can't collapse)", async () => {
    await expect(
      startCredBroker({
        installationToken: TOKEN,
        repoFullName: REPO,
        runBearer: "",
      }),
    ).rejects.toThrow(/runBearer must be a non-empty/);
    await expect(
      startCredBroker({
        installationToken: "",
        repoFullName: REPO,
        runBearer: BEARER,
      }),
    ).rejects.toThrow(/installationToken must be non-empty/);
  });

  it("case-insensitive repo match, rebuilt from the fenced (lowercased) slug", async () => {
    const { b, calls } = await boot();
    const res = await fetch(
      `${b.url}/Be-Automata/Automata.git/info/refs?service=git-upload-pack`,
      { headers: withBearer },
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toContain("github.com/be-automata/automata.git");
  });
});
