import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  startRouteServer,
  type RouteServer,
} from "@/test-helpers/route-http-server";
import { createTestCellStep } from "@terragon/shared/model/test-helpers";

import { createGhBrokerHandler } from "@terragon/cell-broker/gh";
import { CELL_GH_TOKEN_PLACEHOLDER } from "@terragon/types/cell";

const execFileAsync = promisify(execFile);
const hasGh = spawnSync("gh", ["--version"]).status === 0;
const SENTINEL = "ghs_SENTINEL_real_gh";
const HOST = "cell.test";
const PORT_HOST = "cell.test:8443";

/**
 * #727 B: gh exactly as a cell's bootstrap sets it up. `hosts.yml` holds the
 * placeholder, `GH_HOST`/`GH_REPO` name the broker host and the run's repo,
 * and no token env is set. The route server stands in for the vault binding:
 * it overwrites `Authorization` with the run bearer (the OpenSandbox IT
 * proves the real proxy replaces gh's header rather than adding one).
 *
 * gh speaks HTTPS to an Enterprise host, and a self-signed certificate cannot
 * be trusted portably (Go on macOS ignores SSL_CERT_FILE). gh's
 * `http_unix_socket` config key dials a unix socket and speaks plain HTTP over
 * it, so the broker is reached that way: gh still builds the real
 * `https://cell.test/api/v3/...` request.
 */
describe.skipIf(!hasGh)(
  "real gh with the cell's own gh config (#727 B)",
  () => {
    let server: RouteServer | null = null;
    let home = "";
    let bearer = "";
    const brokerSaw: Array<{
      method: string;
      path: string;
      auth: string | null;
    }> = [];
    const upstreamSaw: Array<{
      url: string;
      auth: string | null;
      body: string;
    }> = [];

    const ISSUE = {
      number: 7,
      title: "Canned issue",
      body: "## Scope\ncanned body",
      state: "OPEN",
      url: "https://github.com/o/r/issues/7",
    };
    const PR = {
      number: 9,
      title: "Canned PR",
      body: "canned pr body",
      state: "OPEN",
      url: "https://github.com/o/r/pull/9",
    };

    beforeAll(async () => {
      bearer = (await createTestCellStep({ db, repoFullName: "o/r" })).token;
      const fetchImpl = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const headers = new Headers(init?.headers);
        const body =
          init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : typeof init?.body === "string"
              ? init.body
              : "";
        upstreamSaw.push({
          url: String(input),
          auth: headers.get("authorization"),
          body,
        });
        const u = new URL(String(input));
        let json: unknown = { number: ISSUE.number, title: ISSUE.title };
        const extra: Record<string, string> = {};
        // GitHub paginates by repo id; the broker must keep page 2 in-repo.
        if (u.pathname.endsWith("/issues/7/comments")) {
          const page2 = u.searchParams.get("page") === "2";
          json = [{ id: page2 ? 2 : 1, body: page2 ? "second" : "first" }];
          if (!page2) {
            extra.link =
              '<https://api.github.com/repositories/42/issues/7/comments?page=2>; rel="next", <https://api.github.com/repositories/42/issues/7/comments?page=2>; rel="last"';
          }
        }
        if (u.pathname === "/graphql") {
          const repository = body.includes("pullRequest(")
            ? { pullRequest: PR }
            : { hasIssuesEnabled: true, issue: ISSUE };
          json = { data: { repository } };
        }
        return new Response(JSON.stringify(json), {
          status: 200,
          headers: { "content-type": "application/json", ...extra },
        });
      }) as unknown as typeof fetch;
      const handler = createGhBrokerHandler({
        db,
        fetchImpl,
        mintReadToken: async () => ({ token: SENTINEL }),
        enabled: () => true,
      });

      home = fs.mkdtempSync(path.join(os.tmpdir(), "cgc-"));
      const ghDir = path.join(home, ".config", "gh");
      fs.mkdirSync(ghDir, { recursive: true });
      const socketPath = path.join(home, "g.sock");
      // The cell's hosts.yml, byte for byte (cell-run bootstrap).
      fs.writeFileSync(
        path.join(ghDir, "hosts.yml"),
        [
          `${HOST}:`,
          `    oauth_token: ${CELL_GH_TOKEN_PLACEHOLDER}`,
          '    user: "automata-ai-bot[bot]"',
          "    git_protocol: https",
          "",
        ].join("\n"),
      );
      // Test transport only: a cell reaches the broker over HTTPS instead.
      fs.writeFileSync(
        path.join(ghDir, "config.yml"),
        `version: 1\nhttp_unix_socket: ${socketPath}\n`,
      );
      try {
        server = await startRouteServer(
          (request) => {
            const url = new URL(request.url);
            const seen = request.headers.get("authorization");
            brokerSaw.push({
              method: request.method,
              path: url.pathname,
              auth: seen,
            });
            // The vault stand-in: one Authorization, the bearer, whatever gh sent.
            const headers = new Headers(request.headers);
            headers.set("authorization", `Bearer ${bearer}`);
            const swapped = new Request(request, { headers });
            return handler(
              swapped,
              url.pathname.startsWith("/api/graphql") ? "graphql" : "rest",
            );
          },
          { socketPath },
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "EPERM" && code !== "EACCES") throw error;
      }
    });
    afterAll(async () => {
      await server?.close();
      if (home) fs.rmSync(home, { recursive: true, force: true });
    });

    const ghAt = (host: string, args: string[]) =>
      execFileAsync("gh", args, {
        timeout: 30_000,
        cwd: home,
        // Exactly the cell's env, nothing inherited (no token in it).
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          HOME: home,
          // The settings env block the bootstrap writes (cellGhSetup).
          GH_HOST: host,
          GH_REPO: `${host}/o/r`,
          GH_CONFIG_DIR: path.join(home, ".config", "gh"),
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
      });
    const gh = (...args: string[]) => ghAt(HOST, args);
    const refused = (...args: string[]) =>
      gh(...args).then(
        () => null,
        (error: { stderr?: string; stdout?: string }) =>
          `${error.stdout ?? ""}${error.stderr ?? ""}`,
      );

    it("AC-5 `gh issue view`, `gh pr view` and `gh api repos/o/r/issues/N` work with no -R or --hostname", async (ctx) => {
      if (!server) return ctx.skip();
      const issue = await gh(
        "issue",
        "view",
        "7",
        "--json",
        "number,title,body",
      );
      expect(JSON.parse(issue.stdout)).toEqual({
        number: 7,
        title: ISSUE.title,
        body: ISSUE.body,
      });
      const pr = await gh("pr", "view", "9", "--json", "number,title,body");
      expect(JSON.parse(pr.stdout)).toEqual({
        number: 9,
        title: PR.title,
        body: PR.body,
      });
      const api = await gh("api", "repos/o/r/issues/7");
      expect(JSON.parse(api.stdout)).toMatchObject({ number: 7 });
      for (const out of [issue, pr, api]) {
        expect(out.stdout + out.stderr).not.toContain(SENTINEL);
      }
      // gh sent the placeholder; GitHub only ever saw the read token.
      expect(
        brokerSaw.every((c) => c.auth === `token ${CELL_GH_TOKEN_PLACEHOLDER}`),
      ).toBe(true);
      expect(upstreamSaw.length).toBeGreaterThanOrEqual(3);
      expect(upstreamSaw.every((c) => c.auth === `token ${SENTINEL}`)).toBe(
        true,
      );
      expect(
        upstreamSaw.some(
          (c) => c.url === "https://api.github.com/repos/o/r/issues/7",
        ),
      ).toBe(true);
    }, 90_000);

    // card: protects=#727 OD-3 x gh --paginate: page 2 (GitHub links it by repo id) is still served, so the agent can read a long comment thread; fails_when=gh stops at a 403 on /repositories/<id>; no_claim=GitHub's real Link format (unit test pins the rewrite)
    it("AC-5 `gh api --paginate` follows page 2 inside the repo", async (ctx) => {
      if (!server) return ctx.skip();
      const out = await gh(
        "api",
        "--paginate",
        "repos/{owner}/{repo}/issues/7/comments",
        "--jq",
        ".[].body",
      );
      expect(out.stdout.trim().split("\n")).toEqual(["first", "second"]);
      expect(
        upstreamSaw.some(
          (c) =>
            c.url ===
            "https://api.github.com/repos/o/r/issues/7/comments?page=2",
        ),
      ).toBe(true);
    }, 90_000);

    // card: protects=#727 B: a broker host with a port (dev) works as the hosts.yml key, GH_HOST and GH_REPO's host; fails_when=gh misparses `host:port/o/r` or does not find the placeholder login; no_claim=TLS to that port. Keyed on `host:port`, gh sent no Authorization at all
    it("AC-5 a broker host with a port: hosts.yml, GH_HOST and GH_REPO agree", async (ctx) => {
      if (!server) return ctx.skip();
      const before = brokerSaw.length;
      const issue = await ghAt(PORT_HOST, [
        "issue",
        "view",
        "7",
        "--json",
        "number",
      ]);
      expect(JSON.parse(issue.stdout)).toEqual({ number: 7 });
      const api = await ghAt(PORT_HOST, [
        "api",
        "repos/{owner}/{repo}/issues/7",
      ]);
      expect(JSON.parse(api.stdout)).toMatchObject({ number: 7 });
      const seen = brokerSaw.slice(before);
      expect(seen.map((c) => c.path)).toEqual([
        "/api/graphql",
        "/api/v3/repos/o/r/issues/7",
      ]);
      expect(
        seen.every((c) => c.auth === `token ${CELL_GH_TOKEN_PLACEHOLDER}`),
      ).toBe(true);
    }, 90_000);

    it("AC-6 writes and reads outside the repo are 403, and never reach GitHub", async (ctx) => {
      if (!server) return ctx.skip();
      const before = upstreamSaw.length;
      const post = await refused(
        "api",
        "-X",
        "POST",
        "repos/o/r/issues",
        "-f",
        "title=x",
      );
      expect(post).toMatch(/403/);
      const other = await refused("api", "repos/acme/other");
      expect(other).toMatch(/403/);
      const user = await refused("api", "user");
      expect(user).toMatch(/403/);
      const mutation = await refused(
        "api",
        "graphql",
        "-f",
        'query=mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }',
      );
      expect(mutation).toMatch(/403/);
      expect(upstreamSaw).toHaveLength(before);
    }, 90_000);

    it("AC-7 no file gh wrote holds the bearer or the read token", async (ctx) => {
      if (!server) return ctx.skip();
      const walk = (dir: string): string[] =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((e) =>
            e.isDirectory()
              ? walk(path.join(dir, e.name))
              : e.isSocket()
                ? []
                : [path.join(dir, e.name)],
          );
      for (const file of walk(home)) {
        const text = fs.readFileSync(file, "utf8");
        expect(text, file).not.toContain(bearer);
        expect(text, file).not.toContain(SENTINEL);
      }
    });
  },
);
