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
import { teardownCellRun } from "./cell-teardown";

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
