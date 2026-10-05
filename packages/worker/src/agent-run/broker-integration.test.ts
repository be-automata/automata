import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      fetchImpl: (async (url: string) => {
        // gh 2.95.0's auth status issues POST /graphql (viewer) + GET /.
        // Upstream auth-header injection is pinned by the gh-broker unit tests;
        // this test's job is only "real gh honours socket + bearer".
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

describe.skipIf(!hasGh)(
  "phase 7: a read-only GITHUB_TOKEN does not pull gh off the broker",
  () => {
    it("real `gh api` still reaches the gh broker with the per-run BEARER, and `gh auth token` prints only the bearer", async () => {
      const READ_TOKEN = "ghs_fake_read_token";
      const socketDir = tmpDir("broker-int-rt-");
      const ghConfigDir = tmpDir("broker-int-rtcfg-");
      const upstream: Array<{ url: string; auth: string | null }> = [];
      ghBroker = await startGhBroker({
        installationToken: TOKEN,
        runBearer: BEARER,
        socketPath: path.join(socketDir, "gh.sock"),
        // The broker forwards ONLY after the caller's bearer matched; this sees
        // the upstream request with the broker-injected installation token.
        fetchImpl: (async (url: string, init?: RequestInit) => {
          upstream.push({
            url: String(url),
            auth: new Headers(init?.headers).get("authorization"),
          });
          return new Response(JSON.stringify({ full_name: REPO }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      });
      fs.writeFileSync(
        path.join(ghConfigDir, "config.yml"),
        `version: 1\nhttp_unix_socket: ${ghBroker.socketPath}\n`,
      );
      const env = buildDaemonEnv({
        baseEnv: process.env,
        anthropicApiKey: "",
        claudeBinDir: "",
        installationToken: TOKEN,
        ghConfigDir,
        botLogin: "automata-ai-bot[bot]",
        broker: {
          gitUrl: "http://127.0.0.1:1",
          ghSocketPath: "",
          bearer: BEARER,
          repoFullName: REPO,
        },
        githubReadToken: READ_TOKEN,
      });
      expect(env.GITHUB_TOKEN).toBe(READ_TOKEN);
      expect(env.GH_TOKEN).toBe(BEARER);

      // No login shell: execFile resolves gh on the env's PATH directly.
      const api = await execFileAsync("gh", ["api", `repos/${REPO}`], {
        env,
        timeout: 15_000,
      });
      expect(api.stdout).toContain(REPO);
      // The broker accepted the call (bearer matched) and forwarded it with the
      // installation token it holds — never the read token gh had in its env.
      expect(upstream).toHaveLength(1);
      expect(upstream[0]!.url).toContain(`/repos/${REPO}`);
      expect(upstream[0]!.auth ?? "").toContain(TOKEN);
      expect(upstream[0]!.auth ?? "").not.toContain(READ_TOKEN);

      const token = await execFileAsync("gh", ["auth", "token"], {
        env,
        timeout: 15_000,
      });
      expect(token.stdout.trim()).toBe(BEARER);
      expect(token.stdout).not.toContain(READ_TOKEN);
    });
  },
);

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

describe.skipIf(!hasGit)(
  "FENCE-01: a REAL git push through the fenced git broker",
  () => {
    const FIX_BRANCH = "automata/fix-12-deadbeef-a1";

    /**
     * A bare upstream served over smart HTTP by `git receive-pack|upload-pack
     * --stateless-rpc`, behind a broker fenced to FIX_BRANCH. Returns the
     * broker, the bare repo, and a git helper.
     */
    async function fencedUpstream() {
      const bare = tmpDir("broker-int-fbare-");
      const seed = tmpDir("broker-int-fseed-");
      const git = (cwd: string, ...args: string[]) =>
        spawnSync(
          "git",
          ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
          {
            cwd,
          },
        );
      const ok = (cwd: string, ...args: string[]) => {
        const res = git(cwd, ...args);
        expect(res.status, `git ${args.join(" ")}: ${res.stderr}`).toBe(0);
        return res.stdout.toString().trim();
      };
      ok(bare, "init", "--bare", ".");
      ok(seed, "init", ".");
      ok(seed, "commit", "--allow-empty", "-m", "one");
      ok(seed, "commit", "--allow-empty", "-m", "two");
      ok(seed, "push", bare, "HEAD:refs/heads/main");
      const forwarded: string[] = [];
      gitBroker = await startGitBroker({
        installationToken: TOKEN,
        repoFullName: REPO,
        runBearer: BEARER,
        refFence: { exactRef: `refs/heads/${FIX_BRANCH}` },
        fetchImpl: (async (url: string, init?: RequestInit) => {
          const u = new URL(String(url));
          if (u.pathname.endsWith("/info/refs")) {
            const service = u.searchParams.get("service")!;
            const verb = service.replace(/^git-/, "");
            const adv = spawnSync("git", [
              verb,
              "--stateless-rpc",
              "--advertise-refs",
              bare,
            ]).stdout;
            const announce = Buffer.from(`# service=${service}\n`);
            return new Response(
              Buffer.concat([
                Buffer.from(
                  (announce.length + 4).toString(16).padStart(4, "0"),
                ),
                announce,
                Buffer.from("0000"),
                adv,
              ]),
              {
                status: 200,
                headers: {
                  "content-type": `application/x-${service}-advertisement`,
                },
              },
            );
          }
          const verb = u.pathname.endsWith("/git-receive-pack")
            ? "receive-pack"
            : "upload-pack";
          forwarded.push(verb);
          const reqBody = Buffer.from(
            await new Response(init?.body).arrayBuffer(),
          );
          const out = spawnSync("git", [verb, "--stateless-rpc", bare], {
            input: reqBody,
          }).stdout;
          return new Response(out, {
            status: 200,
            headers: { "content-type": `application/x-git-${verb}-result` },
          });
        }) as unknown as typeof fetch,
      });
      const env = brokeredEnv(tmpDir("broker-int-fcfg-"), gitBroker.url);
      return { bare, git, ok, env, forwarded, broker: gitBroker };
    }

    async function push(
      cwd: string,
      env: NodeJS.ProcessEnv,
      refspec: string,
    ): Promise<{ code: number; stderr: string }> {
      try {
        const r = await execFileAsync("git", ["push", "origin", refspec], {
          cwd,
          env,
          timeout: 15_000,
        });
        return { code: 0, stderr: r.stderr };
      } catch (err) {
        const e = err as { code?: number; stderr?: string };
        return { code: e.code ?? 1, stderr: e.stderr ?? "" };
      }
    }

    it("a push of the attempt branch from a SHALLOW clone lands, and the broker records its sha", async () => {
      const { bare, ok, env, forwarded, broker } = await fencedUpstream();
      // A shallow clone (provision clones --depth 1): its push sends `shallow`
      // pkt-lines ahead of the commands, exactly what the parser must accept.
      const work = tmpDir("broker-int-fwork-");
      ok(work, "clone", "--depth", "1", `file://${bare}`, ".");
      ok(work, "remote", "set-url", "origin", `https://github.com/${REPO}.git`);
      ok(work, "checkout", "-b", FIX_BRANCH);
      ok(work, "commit", "--allow-empty", "-m", "fix");
      const head = ok(work, "rev-parse", "HEAD");

      const res = await push(work, env, `HEAD:refs/heads/${FIX_BRANCH}`);
      expect(res.code, res.stderr).toBe(0);
      expect(ok(bare, "rev-parse", `refs/heads/${FIX_BRANCH}`)).toBe(head);
      expect(broker.lastPushedSha()).toBe(head);
      expect(forwarded).toEqual(["receive-pack"]);
    });

    it("a push to main, a tag, or a delete is refused and NOTHING reaches the upstream", async () => {
      const { bare, ok, env, forwarded, broker } = await fencedUpstream();
      const mainBefore = ok(bare, "rev-parse", "refs/heads/main");
      // The attempt branch exists upstream, so the delete really is attempted
      // (git refuses to delete a missing remote ref without dialling).
      ok(bare, "update-ref", `refs/heads/${FIX_BRANCH}`, mainBefore);
      const work = tmpDir("broker-int-fwork2-");
      ok(work, "clone", `file://${bare}`, ".");
      ok(work, "remote", "set-url", "origin", `https://github.com/${REPO}.git`);
      ok(work, "commit", "--allow-empty", "-m", "evil");
      ok(work, "tag", "v1");

      const refusals = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const refspec of [
        "HEAD:refs/heads/main",
        "refs/tags/v1",
        `:refs/heads/${FIX_BRANCH}`,
      ]) {
        const res = await push(work, env, refspec);
        expect(res.code, refspec).not.toBe(0);
      }
      expect(ok(bare, "rev-parse", "refs/heads/main")).toBe(mainBefore);
      expect(ok(bare, "rev-parse", `refs/heads/${FIX_BRANCH}`)).toBe(
        mainBefore,
      );
      expect(ok(bare, "tag", "--list")).toBe("");
      expect(forwarded).toEqual([]);
      expect(broker.lastPushedSha()).toBeNull();
      // Each push was refused BY THE FENCE, not by git client-side.
      const reasons = refusals.mock.calls.map((c) => String(c[0]));
      refusals.mockRestore();
      expect(reasons).toEqual([
        expect.stringContaining("ref_not_allowed) ref=refs/heads/main"),
        expect.stringContaining("ref_not_allowed) ref=refs/tags/v1"),
        expect.stringContaining("delete_not_allowed"),
      ]);
    });
  },
);
