import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDaemonEnv } from "./daemon-env";
import { startGhBroker, type GhBroker } from "./gh-broker";
import { startGitBroker, type GitBroker } from "./git-broker";

const execFileAsync = promisify(execFile);

/**
 * End-to-end broker wiring proof (#81 spec §11): REAL child processes (`gh`,
 * `git`) driven with the REAL brokered env from buildDaemonEnv, against the
 * real brokers — with the upstream faked via fetchImpl, so no network and no
 * real token leaves the test. This is the piece the unit tests cannot pin:
 * that gh actually honours `http_unix_socket` + the bearer placeholder (the
 * `gh auth status` preflight path), and that git actually honours the
 * insteadOf + Bearer-extraheader GIT_CONFIG_* env against the git broker.
 *
 * Skipped wholesale when gh/git are not installed (CI images without them);
 * the fences themselves are pinned binary-free in gh-broker.test.ts /
 * git-broker.test.ts.
 */

const TOKEN = "ghs_integration_token_secret";
const BEARER = "integration-run-bearer";
const REPO = "be-automata/automata";

const hasGh = spawnSync("gh", ["--version"]).status === 0;
const hasGit = spawnSync("git", ["--version"]).status === 0;

let ghBroker: GhBroker | null = null;
let gitBroker: GitBroker | null = null;
let tmpDirs: string[] = [];

afterEach(async () => {
  await ghBroker?.close();
  ghBroker = null;
  await gitBroker?.close();
  gitBroker = null;
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function tmpDir(prefix: string): string {
  // /tmp directly (not os.tmpdir()'s long /var/folders path) — the gh socket
  // must stay under the sun_path assertion, like production's /tmp root.
  const dir = fs.mkdtempSync(`/tmp/${prefix}`);
  tmpDirs.push(dir);
  return dir;
}

/** The env exactly as a brokered run's child gets it (bearer, no raw token). */
function brokeredEnv(ghConfigDir: string, gitUrl: string): NodeJS.ProcessEnv {
  return buildDaemonEnv({
    baseEnv: process.env,
    anthropicApiKey: "",
    claudeBinDir: "",
    installationToken: TOKEN,
    ghConfigDir,
    botLogin: "automata-ai-bot[bot]",
    broker: { gitUrl, ghSocketPath: "", bearer: BEARER, repoFullName: REPO },
  });
}

describe.skipIf(!hasGh)("gh through the gh broker (the preflight path)", () => {
  it("`gh auth status` succeeds via config.yml + socket + bearer, and `gh auth token` prints ONLY the bearer", async () => {
    const socketDir = tmpDir("broker-int-gh-");
    const ghConfigDir = tmpDir("broker-int-cfg-");
    ghBroker = await startGhBroker({
      installationToken: TOKEN,
      runBearer: BEARER,
      socketPath: path.join(socketDir, "gh.sock"),
      fetchImpl: (async (url: string, init?: RequestInit) => {
        // gh 2.95.0's auth status issues POST /graphql (viewer) + GET / —
        // the broker must have injected the REAL token by the time we're here.
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`token ${TOKEN}`);
        if (String(url).endsWith("/graphql")) {
          return new Response(
            JSON.stringify({ data: { viewer: { login: "automata-bot" } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": "",
          },
        });
      }) as unknown as typeof fetch,
    });
    // What DaemonProcess.ensureEnv() writes into the isolated gh config dir.
    fs.writeFileSync(
      path.join(ghConfigDir, "config.yml"),
      `version: 1\nhttp_unix_socket: ${ghBroker.socketPath}\n`,
    );
    const env = brokeredEnv(ghConfigDir, "http://127.0.0.1:1");

    // The exact preflight invocation (verify-gh-auth.ts): login shell + status.
    const status = await execFileAsync("bash", ["-lc", "gh auth status"], {
      env,
      timeout: 15_000,
    });
    expect(status.stdout + status.stderr).toContain("Logged in");

    // DoD: the only "token" the agent can extract is the useless bearer.
    const token = await execFileAsync("bash", ["-lc", "gh auth token"], {
      env,
      timeout: 15_000,
    });
    // endsWith, not equals: a noisy login-shell profile may prepend ANSI
    // escapes to stdout (the same box quirk the daemon runtime tests hit).
    expect(token.stdout.trim().endsWith(BEARER)).toBe(true);
    expect(token.stdout).not.toContain(TOKEN);
  });
});

describe.skipIf(!hasGit)(
  "git through the git broker (insteadOf + Bearer)",
  () => {
    it("`git ls-remote origin` on a github.com remote is rewritten onto the broker and authenticates with the bearer", async () => {
      // A local bare upstream with one commit, served to the broker's fetchImpl
      // via `git upload-pack --stateless-rpc` (smart-HTTP, no network).
      const bare = tmpDir("broker-int-bare-");
      const seed = tmpDir("broker-int-seed-");
      const git = (cwd: string, ...args: string[]) => {
        const res = spawnSync("git", args, { cwd });
        expect(res.status, `git ${args.join(" ")}: ${res.stderr}`).toBe(0);
        return res;
      };
      git(bare, "init", "--bare", ".");
      git(seed, "init", ".");
      git(
        seed,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-m",
        "seed",
      );
      git(seed, "push", bare, "HEAD:refs/heads/main");
      const headSha = git(bare, "rev-parse", "refs/heads/main")
        .stdout.toString()
        .trim();

      const seen: Array<{ url: string; auth: string | null }> = [];
      gitBroker = await startGitBroker({
        installationToken: TOKEN,
        repoFullName: REPO,
        runBearer: BEARER,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          seen.push({ url: String(url), auth: headers.get("authorization") });
          const u = new URL(String(url));
          // Honour protocol v2 when the client asked for it (the broker must
          // have forwarded the load-bearing git-protocol header).
          const env = {
            ...process.env,
            ...(headers.get("git-protocol")
              ? { GIT_PROTOCOL: headers.get("git-protocol")! }
              : {}),
          };
          if (u.pathname.endsWith("/info/refs")) {
            const service = u.searchParams.get("service")!;
            const adv = spawnSync(
              "git",
              ["upload-pack", "--stateless-rpc", "--advertise-refs", bare],
              { env },
            ).stdout;
            const announce = Buffer.from(`# service=${service}\n`);
            const body = Buffer.concat([
              Buffer.from((announce.length + 4).toString(16).padStart(4, "0")),
              announce,
              Buffer.from("0000"),
              adv,
            ]);
            return new Response(body, {
              status: 200,
              headers: {
                "content-type": `application/x-${service}-advertisement`,
              },
            });
          }
          const reqBody = Buffer.from(
            await new Response(init?.body).arrayBuffer(),
          );
          const out = spawnSync(
            "git",
            ["upload-pack", "--stateless-rpc", bare],
            {
              input: reqBody,
              env,
            },
          ).stdout;
          return new Response(out, {
            status: 200,
            headers: { "content-type": "application/x-git-upload-pack-result" },
          });
        }) as unknown as typeof fetch,
      });

      // A workdir whose origin is the REAL github.com URL — the clone from
      // provision.ts keeps it untouched; only the brokered env rewrites it.
      const work = tmpDir("broker-int-work-");
      git(work, "init", ".");
      git(work, "remote", "add", "origin", `https://github.com/${REPO}.git`);

      const env = brokeredEnv(tmpDir("broker-int-cfg2-"), gitBroker.url);
      const ls = await execFileAsync("git", ["ls-remote", "origin"], {
        cwd: work,
        env,
        timeout: 15_000,
      });
      expect(ls.stdout).toContain(headSha);
      // The broker rebuilt the upstream path from the FENCED repo and injected
      // Basic x-access-token — the agent-side env only ever presented the bearer.
      expect(seen.length).toBeGreaterThan(0);
      const expectedBasic =
        "Basic " + Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
      for (const call of seen) {
        expect(call.url).toContain(`https://github.com/${REPO}.git/`);
        expect(call.auth).toBe(expectedBasic);
      }
    });
  },
);
