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

const execFileAsync = promisify(execFile);
const hasGh = spawnSync("gh", ["--version"]).status === 0;
const SENTINEL = "ghs_SENTINEL_real_gh";
const HOST = "cell.test";

/**
 * gh speaks HTTPS to an Enterprise host, and a self-signed certificate cannot
 * be trusted portably (Go on macOS ignores SSL_CERT_FILE). gh's
 * `http_unix_socket` config key dials a unix socket and speaks plain HTTP over
 * it, so the broker is reached that way: gh still builds the real
 * `https://cell.test/api/v3/...` request, with `GH_HOST` and
 * `GH_ENTERPRISE_TOKEN`, exactly as a cell would.
 */
describe.skipIf(!hasGh)("real gh through the cell gh broker", () => {
  let server: RouteServer | null = null;
  let configDir = "";
  let bearer = "";
  const handlerSeen: Array<{
    method: string;
    path: string;
    auth: string | null;
  }> = [];
  const upstreamSeen: Array<{ url: string; auth: string | null }> = [];

  beforeAll(async () => {
    bearer = (await createTestCellStep({ db, repoFullName: "o/r" })).token;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      upstreamSeen.push({
        url: String(input),
        auth: headers.get("authorization"),
      });
      const u = new URL(String(input));
      const body =
        u.pathname === "/graphql"
          ? { data: { viewer: { login: "cell-user" } } }
          : { login: "cell-user" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const handler = createGhBrokerHandler({
      db,
      fetchImpl,
      mintReadToken: async () => ({ token: SENTINEL }),
      enabled: () => true,
    });

    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-"));
    const socketPath = path.join(configDir, "g.sock");
    fs.writeFileSync(
      path.join(configDir, "config.yml"),
      `version: 1\nhttp_unix_socket: ${socketPath}\n`,
    );
    try {
      server = await startRouteServer(
        (request) => {
          const url = new URL(request.url);
          handlerSeen.push({
            method: request.method,
            path: url.pathname,
            auth: request.headers.get("authorization"),
          });
          return handler(
            request,
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
    if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
  });

  const gh = (...args: string[]) =>
    execFileAsync("gh", args, {
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: configDir,
        GH_CONFIG_DIR: configDir,
        GH_HOST: HOST,
        GH_ENTERPRISE_TOKEN: bearer,
        // gh must authenticate with the cell bearer only.
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
      },
    });

  it("AC6 `gh api user` reaches /api/v3/user with `token <bearer>` and returns the canned login", async (ctx) => {
    if (!server) return ctx.skip();
    const out = await gh("api", "user");
    expect(JSON.parse(out.stdout)).toEqual({ login: "cell-user" });
    const call = handlerSeen.find((c) => c.path === "/api/v3/user");
    expect(call?.method).toBe("GET");
    expect(call?.auth).toBe(`token ${bearer}`);
    const up = upstreamSeen.find(
      (c) => c.url === "https://api.github.com/user",
    );
    expect(up?.auth).toBe(`token ${SENTINEL}`);
    expect(out.stdout + out.stderr).not.toContain(SENTINEL);
  }, 60_000);

  it("AC6 `gh api graphql` of a read query works", async (ctx) => {
    if (!server) return ctx.skip();
    const out = await gh("api", "graphql", "-f", "query={viewer{login}}");
    expect(JSON.parse(out.stdout)).toEqual({
      data: { viewer: { login: "cell-user" } },
    });
    const call = handlerSeen.find((c) => c.path === "/api/graphql");
    expect(call?.method).toBe("POST");
    expect(call?.auth).toBe(`token ${bearer}`);
  }, 60_000);

  it("AC6 `gh api -X POST repos/o/r/issues` is refused with a 403 and never reaches GitHub", async (ctx) => {
    if (!server) return ctx.skip();
    const before = upstreamSeen.length;
    const failure = await gh(
      "api",
      "-X",
      "POST",
      "repos/o/r/issues",
      "-f",
      "title=x",
    ).then(
      () => null,
      (error: { stderr?: string; stdout?: string }) => error,
    );
    expect(failure).not.toBeNull();
    expect(`${failure?.stdout}${failure?.stderr}`).toMatch(/403/);
    expect(upstreamSeen).toHaveLength(before);
  }, 60_000);
});
