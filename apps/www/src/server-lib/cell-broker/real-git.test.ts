import { execFile, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  startRouteServer,
  type RouteServer,
} from "@/test-helpers/route-http-server";
import { cellEffect, cellStep, thread } from "@terragon/shared/db/schema";
import { mintBearer, openStep } from "@terragon/shared/model/cell-authority";
import {
  createTestOrg,
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { createGitBrokerHandler } from "./git";

const execFileAsync = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;
const SENTINEL = "ghs_SENTINEL_real_git";
const STEP_TIMEOUT = 30 * 60_000;
const TEST_TIMEOUT = 90_000;

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(res.status, `git ${args.join(" ")}: ${res.stderr}`).toBe(0);
  return res.stdout.trim();
}

const COMMIT = [
  "-c",
  "user.email=t@t",
  "-c",
  "user.name=t",
  "-c",
  "commit.gpgsign=false",
];

// No user or system git config, no prompts: only what the test passes in.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

interface Call {
  url: string;
  method: string;
  auth: string | null;
  bodyBytes: number;
  bodyIsProbe: boolean;
}

type Handler = (request: Request) => Promise<Response>;

describe.skipIf(!hasGit)("real git through the cell git broker", () => {
  let server: RouteServer | null = null;
  let active: Handler = async () => new Response("no handler", { status: 500 });

  beforeAll(async () => {
    try {
      server = await startRouteServer((request) => active(request));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EPERM" && code !== "EACCES") throw error;
    }
  });
  afterAll(async () => {
    await server?.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A bare upstream with one commit on main, served as GitHub would. */
  function upstream() {
    const bare = tmp("real-git-bare-");
    const seed = tmp("real-git-seed-");
    git(bare, "init", "--bare", "-b", "main", ".");
    git(seed, "init", "-b", "main", ".");
    fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
    git(seed, "add", ".");
    git(seed, ...COMMIT, "commit", "-m", "seed");
    git(seed, "push", bare, "HEAD:refs/heads/main");

    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const u = new URL(String(input));
      const raw = Buffer.from(await new Response(init?.body).arrayBuffer());
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        auth: headers.get("authorization"),
        bodyBytes: raw.length,
        bodyIsProbe: raw.toString("latin1") === "0000",
      });
      const env = {
        ...process.env,
        ...(headers.get("git-protocol")
          ? { GIT_PROTOCOL: headers.get("git-protocol")! }
          : {}),
      };
      const service = u.searchParams.get("service");
      const endpoint = u.pathname.endsWith("/info/refs")
        ? "info/refs"
        : u.pathname.split("/").pop();
      if (endpoint === "info/refs" && service) {
        const adv = spawnSync(
          "git",
          [service.slice(4), "--stateless-rpc", "--advertise-refs", bare],
          { env },
        ).stdout;
        const announce = Buffer.from(`# service=${service}\n`);
        return new Response(
          Buffer.concat([
            Buffer.from((announce.length + 4).toString(16).padStart(4, "0")),
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
      const stdin =
        headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
      const out = spawnSync(
        "git",
        [endpoint!.slice(4), "--stateless-rpc", bare],
        { input: stdin, env, maxBuffer: 64 * 1024 * 1024 },
      ).stdout;
      return new Response(out, {
        status: 200,
        headers: { "content-type": `application/x-${endpoint}-result` },
      });
    }) as unknown as typeof fetch;
    return { bare, calls, fetchImpl };
  }

  async function step() {
    const organizationId = await createTestOrg({ db });
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { githubRepoFullName: "org/repo" },
    });
    await db
      .update(thread)
      .set({ organizationId })
      .where(eq(thread.id, threadId));
    const stepKey = `run-${randomUUID()}/agent`;
    const opened = await openStep({
      db,
      step: {
        stepKey,
        organizationId,
        threadId,
        attempt: 1,
        stepTimeoutMs: STEP_TIMEOUT,
        effectBudget: 10,
      },
    });
    expect(opened.ok).toBe(true);
    const minted = await mintBearer({
      db,
      stepKey,
      attempt: 1,
      ttlMs: STEP_TIMEOUT,
    });
    if (!minted.ok) throw new Error(minted.reason);
    return { stepKey, bearer: minted.token };
  }

  async function setup(maxPushBytes?: number) {
    const up = upstream();
    const s = await step();
    active = createGitBrokerHandler({
      db,
      fetchImpl: up.fetchImpl,
      mintReadToken: async () => ({ token: SENTINEL }),
      mintWriteToken: async () => ({ token: SENTINEL }),
      sideEffectsEnabled: () => true,
      enabled: () => true,
      maxPushBytes,
    });
    const remote = `${server!.url}/api/cell/git/org/repo.git`;
    const header = `http.extraHeader=Authorization: Bearer ${s.bearer}`;
    const run = (cwd: string, ...args: string[]) =>
      execFileAsync("git", ["-c", header, ...args], {
        cwd,
        env: gitEnv,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    return { ...up, ...s, remote, run, header };
  }

  async function effects(stepKey: string) {
    const rows = await db
      .select({ result: cellEffect.result })
      .from(cellEffect)
      .where(eq(cellEffect.stepKey, stepKey));
    const used = await db
      .select({ used: cellStep.effectsUsed })
      .from(cellStep)
      .where(eq(cellStep.stepKey, stepKey));
    return { rows, used: used[0]?.used };
  }

  it(
    "AC1 clone and fetch succeed, and GitHub only ever sees the injected installation token",
    async (ctx) => {
      if (!server) return ctx.skip();
      const t = await setup();
      const work = tmp("real-git-work-");
      await t.run(work, "clone", t.remote, "clone");
      const clone = path.join(work, "clone");
      expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toBe(
        "seed\n",
      );
      // A new upstream commit arrives through a fetch.
      const seed2 = tmp("real-git-seed2-");
      git(seed2, "clone", t.bare, ".");
      fs.writeFileSync(path.join(seed2, "two.txt"), "two\n");
      git(seed2, "add", ".");
      git(seed2, ...COMMIT, "commit", "-m", "two");
      git(seed2, "push", "origin", "HEAD:refs/heads/main");
      await t.run(clone, "fetch", "origin");
      expect(git(clone, "rev-parse", "origin/main")).toBe(
        git(t.bare, "rev-parse", "refs/heads/main"),
      );
      const expected = `Basic ${Buffer.from(`x-access-token:${SENTINEL}`).toString("base64")}`;
      expect(t.calls.length).toBeGreaterThan(0);
      for (const call of t.calls) {
        expect(call.url).toContain("https://github.com/org/repo.git/");
        expect(call.auth).toBe(expected);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "push of a small commit lands in the bare repo with one completed effect",
    async (ctx) => {
      if (!server) return ctx.skip();
      const t = await setup();
      const work = tmp("real-git-work-");
      await t.run(work, "clone", t.remote, "clone");
      const clone = path.join(work, "clone");
      fs.writeFileSync(path.join(clone, "feature.txt"), "feature\n");
      git(clone, "add", ".");
      git(clone, ...COMMIT, "commit", "-m", "feature");
      await t.run(clone, "push", "origin", "HEAD:refs/heads/feat/x");
      expect(git(t.bare, "rev-parse", "refs/heads/feat/x")).toBe(
        git(clone, "rev-parse", "HEAD"),
      );
      const e = await effects(t.stepKey);
      expect(e.rows).toHaveLength(1);
      expect(e.rows[0]?.result).not.toBeNull();
      expect(e.used).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "push of a >1 MiB commit sends git's 0000 probe first: it lands, and the probe is not an effect",
    async (ctx) => {
      if (!server) return ctx.skip();
      const t = await setup();
      const work = tmp("real-git-work-");
      await t.run(work, "clone", t.remote, "clone");
      const clone = path.join(work, "clone");
      fs.writeFileSync(path.join(clone, "big.bin"), randomBytes(1_200_000));
      git(clone, "add", ".");
      git(clone, ...COMMIT, "commit", "-m", "big");
      await t.run(
        clone,
        "-c",
        "http.postBuffer=1048576",
        "push",
        "origin",
        "HEAD:refs/heads/feat/big",
      );
      expect(git(t.bare, "rev-parse", "refs/heads/feat/big")).toBe(
        git(clone, "rev-parse", "HEAD"),
      );
      expect(t.calls.some((c) => c.method === "POST" && c.bodyIsProbe)).toBe(
        true,
      );
      const e = await effects(t.stepKey);
      expect(e.rows).toHaveLength(1);
      expect(e.used).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "the Basic credential flow works: 401 challenge, then the bearer as the password",
    async (ctx) => {
      if (!server) return ctx.skip();
      const t = await setup();
      const work = tmp("real-git-work-");
      const helper = `credential.helper=!f() { echo username=x; echo password=${t.bearer}; }; f`;
      await execFileAsync("git", ["-c", helper, "clone", t.remote, "clone"], {
        cwd: work,
        env: gitEnv,
        timeout: 60_000,
      });
      expect(
        fs.readFileSync(path.join(work, "clone", "README.md"), "utf8"),
      ).toBe("seed\n");
    },
    TEST_TIMEOUT,
  );

  it(
    "AC10 end to end: a push over the cap fails, nothing lands, the claim is released",
    async (ctx) => {
      if (!server) return ctx.skip();
      const t = await setup(200 * 1024);
      const work = tmp("real-git-work-");
      await t.run(work, "clone", t.remote, "clone");
      const clone = path.join(work, "clone");
      fs.writeFileSync(path.join(clone, "big.bin"), randomBytes(1_200_000));
      git(clone, "add", ".");
      git(clone, ...COMMIT, "commit", "-m", "big");
      await expect(
        t.run(
          clone,
          "-c",
          "http.postBuffer=1048576",
          "push",
          "origin",
          "HEAD:refs/heads/feat/over",
        ),
      ).rejects.toThrow();
      const refs = spawnSync(
        "git",
        ["-C", t.bare, "rev-parse", "--verify", "refs/heads/feat/over"],
        { encoding: "utf8" },
      );
      expect(refs.status).not.toBe(0);
      const e = await effects(t.stepKey);
      expect(e.rows).toHaveLength(0);
      expect(e.used).toBe(1);
    },
    TEST_TIMEOUT,
  );
});
