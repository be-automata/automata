import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createOpenSandboxCellProvider,
  type CellProviderError,
} from "@terragon/sandbox/opensandbox-cell";
import {
  CELL_DAEMON_TOKEN_HEADER,
  CELL_DAEMON_TOKEN_PLACEHOLDER,
  type ICellProvider,
  type OpenSandboxCellCreatePlan,
} from "@terragon/types/cell";

import {
  CELL_MESSAGE_DIR,
  CELL_SELF_CHECK_ARGV,
  CELL_WRITE_MESSAGE_SH,
  cellEntrypoint,
} from "./cell-image";
import { cellRepoEnv } from "./cell-repo-env";
import { CELL_SETUP_STAMP_MS } from "./cell-run";
import { teardownCellRun } from "./cell-teardown";
import {
  CELL_PG_BIN,
  CELL_TEST_DB_DIR,
  CELL_TEST_DB_MKDIR_ARGV,
  CELL_TEST_DB_PASSWORD_FILE,
  CELL_TEST_DB_READY_ARGV,
  CELL_TEST_DB_ROLE_SH,
  CELL_TEST_DB_START_SH,
  cellTestDbUrl,
} from "./cell-test-db";
import { containerLanePolicy } from "./container-argv";
import { composeContainerSettings } from "./container-policy";

/**
 * IT-E1 (#656 PR-E): the cell executor's pieces against a REAL OpenSandbox
 * 1.2.1 in the sandbox package's throwaway dind. Opt-in, outside the Claude
 * sandbox (Docker and the public internet):
 *
 *   OPENSANDBOX_IT=1 OPENSANDBOX_IT_CELL_IMAGE=<automata-cell@sha256:...> \
 *     pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
 *     src/agent-run/cell-run.integration.test.ts
 *
 * It runs `packages/sandbox/opensandbox-it/up.sh` as a SCRIPT (a child process,
 * never an import: the sandbox package must not import the worker, nor this
 * test its harness). OPENSANDBOX_IT_REUSE=1 skips up.sh, OPENSANDBOX_IT_KEEP=1
 * skips down.sh. The key is read from $OPENSANDBOX_IT_STATE/api_key and never
 * printed. The cell image is about 8.3 GB: skipped when the image is unset.
 */

const IT = process.env.OPENSANDBOX_IT === "1";
const IMAGE = process.env.OPENSANDBOX_IT_CELL_IMAGE ?? "";
const run = promisify(execFile);
const IT_DIR = join(__dirname, "..", "..", "..", "sandbox", "opensandbox-it");
const DEFAULT_BASE_URL = "http://127.0.0.1:18091";
const DEPLOYMENT = "httpbin.org";
const DAEMON_PATH = "/anything/daemon-event";
const CANARY = `cell-canary-${randomBytes(8).toString("hex")}`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function stateDir(): string {
  return (
    process.env.OPENSANDBOX_IT_STATE ??
    join(process.env.TMPDIR ?? "/tmp", "osbit")
  );
}

function runScript(name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn("bash", [join(IT_DIR, name)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${name} exited ${code}`)),
    );
  });
}

const dind = (args: string[]) =>
  run("docker", ["exec", "osbit-dind", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

function plan(): OpenSandboxCellCreatePlan {
  const ttlMs = 15 * 60 * 1000;
  return {
    provider: "opensandbox",
    runtime: "runc",
    tags: {
      automata: "cell",
      worker: "w-it",
      epoch: "1",
      deployment: DEPLOYMENT,
      stepKey: `cell-it-${randomBytes(4).toString("hex")}`,
      attempt: "1",
      expiresAt: String(Date.now() + ttlMs),
    },
    networkPolicy: {
      defaultAction: "deny",
      egress: [
        { action: "allow", target: "httpbin.org" },
        { action: "allow", target: "github.com" },
        { action: "allow", target: "*.github.com" },
        { action: "deny", ports: [80] },
      ],
    },
    vault: [
      {
        name: "daemon",
        hosts: ["httpbin.org"],
        paths: [DAEMON_PATH],
        auth: "apiKey",
        header: CELL_DAEMON_TOKEN_HEADER,
        credential: CANARY,
        placeholder: CELL_DAEMON_TOKEN_PLACEHOLDER,
      },
    ],
    resources: { cpu: 1, memoryMiB: 1024 },
    ttlMs,
    egressDigest: "cell-it",
    profileId: "opensandbox/runc",
  };
}

describe.skipIf(!IT || IMAGE === "")(
  "IT-E1: the cell executor against a real OpenSandbox (OPENSANDBOX_IT)",
  () => {
    let provider: ICellProvider;
    const cellPlan = plan();
    let cellId = "";

    beforeAll(async () => {
      let baseUrl = DEFAULT_BASE_URL;
      if (process.env.OPENSANDBOX_IT_REUSE !== "1") {
        const out = await runScript("up.sh");
        baseUrl =
          /^OPENSANDBOX_IT_BASE_URL=(\S+)$/m.exec(out)?.[1] ?? DEFAULT_BASE_URL;
      }
      // Pre-pull, as the box's runbook does (PR-G): a cold multi-GB pull inside
      // `create` outlasts the adapter's create budget (seen live: ~2 min).
      await dind(["docker", "pull", "-q", IMAGE]);
      const apiKey = readFileSync(join(stateDir(), "api_key"), "utf8").trim();
      provider = createOpenSandboxCellProvider(
        {
          baseUrl,
          apiKey,
          image: IMAGE,
          entrypoint: cellEntrypoint(DEPLOYMENT),
          selfCheck: { argv: CELL_SELF_CHECK_ARGV },
          readyTimeoutMs: 5 * 60_000,
        },
        {
          fetch,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
          logger: { info: () => {}, warn: () => {} },
        },
      );
      ({ cellId } = await provider.create(cellPlan));
    }, 30 * 60_000);

    afterAll(async () => {
      try {
        if (cellId) {
          await teardownCellRun(
            {
              stepKey: cellPlan.tags.stepKey,
              attempt: 1,
              deployment: DEPLOYMENT,
              cellId,
              skipWww: true,
            },
            {
              revoke: async () => ({ result: "ok" }),
              report: async () => "ok",
              provider,
              postAbnormal: async () => {},
              now: () => Date.now(),
              log: () => {},
            },
          );
        }
      } finally {
        if (process.env.OPENSANDBOX_IT_KEEP !== "1") {
          await runScript("down.sh").catch(() => undefined);
        }
      }
    }, 5 * 60_000);

    // card: protects=copyIn's decimal-as-octal mode and explicit owner on the live server, and a 1 MiB round trip; fails_when=the file is not 600 agent, uid is not 10001 or the bytes differ; no_claim=the message write through the daemon
    it("(c) copyIn of 1 MiB with mode 600 round-trips as agent (uid 10001)", async () => {
      const bytes = new Uint8Array(1024 * 1024);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
      const path = `${CELL_MESSAGE_DIR}/it.bin`;
      await provider.copyIn(cellId, path, bytes, {
        mode: 600,
        owner: "agent",
        group: "agent",
      });
      expect(sha256(await provider.copyOut(cellId, path))).toBe(sha256(bytes));
      const id = await provider.exec(cellId, ["/usr/bin/id", "-u"]);
      expect(id.stdout.trim()).toBe("10001");
      const stat = await provider.exec(cellId, [
        "/usr/bin/stat",
        "-c",
        "%a %U",
        path,
      ]);
      expect(stat.stdout.trim()).toBe("600 agent");
    });

    // card: protects=a staged ping message reaches the daemon through CELL_WRITE_MESSAGE_SH with only the path in argv; fails_when=the write exits non-zero or the file is left behind; no_claim=the daemon acting on it
    it("writes a staged message through the daemon and removes it", async () => {
      const path = `${CELL_MESSAGE_DIR}/ping.json`;
      await provider.copyIn(
        cellId,
        path,
        new TextEncoder().encode(JSON.stringify({ type: "ping" })),
        { mode: 600, owner: "agent", group: "agent" },
      );
      const out = await provider.exec(cellId, [
        "/bin/bash",
        "-c",
        CELL_WRITE_MESSAGE_SH,
        "cell-write",
        path,
      ]);
      expect(out.exitCode, out.stderr.slice(-200)).toBe(0);
      const gone = await provider.exec(cellId, ["/usr/bin/test", "-e", path]);
      expect(gone.exitCode).not.toBe(0);
    });

    // card: protects=TLS works as uid 10001 for node and git through the sidecar; fails_when=either exits non-zero; no_claim=claude (UAT, needs the model vault)
    it("(b) node and git reach their hosts as uid 10001", async () => {
      const node = await provider.exec(
        cellId,
        [
          "/usr/local/bin/node",
          "-e",
          'fetch("https://httpbin.org/anything").then(r=>process.exit(r.ok?0:1),()=>process.exit(2))',
        ],
        { timeoutMs: 60_000 },
      );
      expect(node.exitCode).toBe(0);
      const git = await provider.exec(
        cellId,
        ["/usr/bin/git", "ls-remote", "https://github.com/git/git", "HEAD"],
        { timeoutMs: 120_000 },
      );
      expect(git.exitCode).toBe(0);
    });

    // card: protects=AC-13's canary half: the vault credential appears nowhere in the guest, docker inspect or the logs; fails_when=any search finds the canary; no_claim=www reach (UAT)
    it("(a) the vault canary is nowhere in the guest, docker inspect or the logs", async () => {
      // The canary never travels whole in argv: execd logs exec argv, so a scan
      // that passed it as one argument would plant it in the very logs it checks
      // (seen live on the first amd64 run). The scan joins two halves in the shell.
      // It reads only files written after the cell started (`-newer /proc/1`):
      // the image's own layers cannot hold a runtime secret, and PR-F's layer
      // scan covers them in CI. A full `grep /` of the batteries image took ~300 s.
      const half = Math.floor(CANARY.length / 2);
      const guest = await provider.exec(
        cellId,
        [
          "/bin/bash",
          "-c",
          `c="$1$2"; find / -xdev \\( -path /proc -o -path /sys \\) -prune -o -type f -newer /proc/1 -print0 2>/dev/null | xargs -0 -r grep -lF -- "$c" 2>/dev/null; for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do grep -aqF -- "$c" "$f" 2>/dev/null && echo "$f"; done; true`,
          "scan",
          CANARY.slice(0, half),
          CANARY.slice(half),
        ],
        { timeoutMs: 5 * 60_000 },
      );
      expect(guest.stdout).toBe("");
      const ids = (await dind(["docker", "ps", "-aq"])).stdout
        .split("\n")
        .filter(Boolean);
      for (const id of ids) {
        const inspect = await dind(["docker", "inspect", id]);
        expect(inspect.stdout).not.toContain(CANARY);
        const logs = await dind(["sh", "-c", `docker logs ${id} 2>&1 || true`]);
        expect(logs.stdout).not.toContain(CANARY);
      }
    });

    // card: protects=AC 2 of #706: a repo env value in a settings env block built by the same helpers cell-run.ts uses (cellRepoEnv, composeContainerSettings) and copied in is in that file and nowhere in docker inspect or the logs of the server, the egress sidecar or the cell; fails_when=the file lacks it or any inspect or log holds it; no_claim=bootstrap's own call order (cell-run.test.ts) or the CLI applying the block (UAT)
    it("(e) a repo env value is in the agent's settings only, never in inspect or logs (#706)", async () => {
      const value = `repo-env-canary-${randomBytes(8).toString("hex")}`;
      const { env } = cellRepoEnv({ FOO_TOKEN: value });
      const path = "/home/agent/.claude/settings.json";
      await provider.exec(cellId, [
        "/bin/mkdir",
        "-p",
        "-m",
        "700",
        "/home/agent/.claude",
      ]);
      await provider.copyIn(
        cellId,
        path,
        new TextEncoder().encode(
          JSON.stringify(
            composeContainerSettings(containerLanePolicy("task"), null, env),
          ),
        ),
        { mode: 600, owner: "agent", group: "agent" },
      );
      const back = JSON.parse(
        new TextDecoder().decode(await provider.copyOut(cellId, path)),
      ) as { env?: Record<string, string> };
      expect(back.env?.FOO_TOKEN).toBe(value);
      const stat = await provider.exec(cellId, [
        "/usr/bin/stat",
        "-c",
        "%a %U",
        path,
      ]);
      expect(stat.stdout.trim()).toBe("600 agent");
      // execd's own records in the guest (a log file, a process env): the same
      // split-canary scan as (a), with the settings file itself left out. No
      // CLI runs here, so no process may hold it.
      const half = Math.floor(value.length / 2);
      const guest = await provider.exec(
        cellId,
        [
          "/bin/bash",
          "-c",
          `c="$1$2"; find / -xdev \\( -path /proc -o -path /sys \\) -prune -o -type f -newer /proc/1 ! -path "$3" -print0 2>/dev/null | xargs -0 -r grep -lF -- "$c" 2>/dev/null; for f in /proc/[0-9]*/environ /proc/[0-9]*/cmdline; do grep -aqF -- "$c" "$f" 2>/dev/null && echo "$f"; done; true`,
          "scan",
          value.slice(0, half),
          value.slice(half),
          path,
        ],
        { timeoutMs: 5 * 60_000 },
      );
      expect(guest.stdout).toBe("");
      const ids = (await dind(["docker", "ps", "-aq"])).stdout
        .split("\n")
        .filter(Boolean);
      // The server, the egress sidecar and the cell, at least.
      expect(ids.length).toBeGreaterThanOrEqual(3);
      for (const id of ids) {
        const inspect = await dind(["docker", "inspect", id]);
        expect(inspect.stdout).not.toContain(value);
        const logs = await dind(["sh", "-c", `docker logs ${id} 2>&1 || true`]);
        expect(logs.stdout).not.toContain(value);
      }
    });

    // card: protects=AC 1, 4 and 5 of #707: the worker's own test-db steps (cell-test-db.ts) start Postgres in a live cell within one setup stamp, a client with the URL creates and drops a database, and the password is in no docker inspect, no container log and no guest log; fails_when=a step fails, the start outlasts CELL_SETUP_STAMP_MS, the create/drop fails, or the password shows up; no_claim=the Claude CLI applying the settings env (UAT)
    it("(f) the cell's test database starts, and a client creates and drops a database (#707)", async () => {
      const password = randomBytes(24).toString("hex");
      const url = cellTestDbUrl(password);
      const started = Date.now();
      const ok = async (argv: string[], timeoutMs = 60_000) => {
        const out = await provider.exec(cellId, argv, { timeoutMs });
        expect(out.exitCode, argv.slice(0, 3).join(" ")).toBe(0);
        return out;
      };
      await ok([...CELL_TEST_DB_MKDIR_ARGV]);
      await provider.copyIn(
        cellId,
        CELL_TEST_DB_PASSWORD_FILE,
        new TextEncoder().encode(password),
        { mode: 600, owner: "agent", group: "agent" },
      );
      await ok(["/bin/bash", "-c", CELL_TEST_DB_START_SH, "cell-test-db"]);
      for (let i = 0; ; i++) {
        const probe = await provider.exec(cellId, [...CELL_TEST_DB_READY_ARGV]);
        if (probe.exitCode === 0) break;
        expect(i).toBeLessThan(60);
        await new Promise((r) => setTimeout(r, 500));
      }
      await ok(["/bin/bash", "-c", CELL_TEST_DB_ROLE_SH, "cell-test-db"]);
      const elapsed = Date.now() - started;
      console.info(`[IT-E1 f] test database ready in ${elapsed}ms`);
      expect(elapsed).toBeLessThan(CELL_SETUP_STAMP_MS);
      // The client reads the URL from a 0600 file, as the agent's env would
      // hold it: never in an exec argv (execd logs argv).
      const urlFile = `${CELL_MESSAGE_DIR}/it-test-db-url`;
      await provider.copyIn(cellId, urlFile, new TextEncoder().encode(url), {
        mode: 600,
        owner: "agent",
        group: "agent",
      });
      await ok([
        "/bin/bash",
        "-c",
        `${CELL_PG_BIN}/psql "$(cat "$1")" -X -q -v ON_ERROR_STOP=1 -c 'create database t1' -c 'drop database t1' && rm -f -- "$1"`,
        "it-client",
        urlFile,
      ]);
      const role = await ok([
        "/bin/bash",
        "-c",
        `${CELL_PG_BIN}/psql -X -At -h ${CELL_TEST_DB_DIR} -p 25432 -U agent -d postgres -c "select rolcreatedb, rolsuper from pg_roles where rolname = 'automata_test'"`,
      ]);
      expect(role.stdout.trim()).toBe("t|f");
      const guest = await provider.exec(cellId, [
        "/bin/bash",
        "-c",
        `c="$1$2"; test ! -e ${CELL_TEST_DB_PASSWORD_FILE} || echo pwfile; grep -rlF -- "$c" ${CELL_TEST_DB_DIR}/server.log ${CELL_TEST_DB_DIR}/initdb.log 2>/dev/null; true`,
        "scan",
        password.slice(0, 24),
        password.slice(24),
      ]);
      expect(guest.stdout).toBe("");
      const ids = (await dind(["docker", "ps", "-aq"])).stdout
        .split("\n")
        .filter(Boolean);
      expect(ids.length).toBeGreaterThanOrEqual(3);
      for (const id of ids) {
        const inspect = await dind(["docker", "inspect", id]);
        expect(inspect.stdout).not.toContain(password);
        const logs = await dind(["sh", "-c", `docker logs ${id} 2>&1 || true`]);
        expect(logs.stdout).not.toContain(password);
      }
    });

    // card: protects=the step-by-step teardown leaves the attempt's readback empty; fails_when=a survivor remains or a step is reported failed; no_claim=the www half
    it("(d) the step-by-step teardown leaves listByTags empty", async () => {
      const out = await teardownCellRun(
        {
          stepKey: cellPlan.tags.stepKey,
          attempt: 1,
          deployment: DEPLOYMENT,
          cellId,
          skipWww: true,
        },
        {
          revoke: async () => ({ result: "ok" }),
          report: async () => "ok",
          provider,
          postAbnormal: async () => {},
          now: () => Date.now(),
          log: () => {},
        },
      );
      expect(out.failedSteps).toEqual([]);
      const left = await provider.listByTags({
        automata: "cell",
        stepKey: cellPlan.tags.stepKey,
        attempt: "1",
        deployment: DEPLOYMENT,
      });
      expect(left).toHaveLength(0);
      cellId = "";
    });
  },
  30 * 60_000,
);

// A type-level reference so the error class import stays checked.
export type _ProviderError = CellProviderError;
