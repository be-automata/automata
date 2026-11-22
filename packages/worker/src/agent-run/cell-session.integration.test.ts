import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOpenSandboxCellProvider } from "@terragon/sandbox/opensandbox-cell";
import {
  CELL_DAEMON_TOKEN_HEADER,
  CELL_DAEMON_TOKEN_PLACEHOLDER,
  type ICellProvider,
  type OpenSandboxCellCreatePlan,
} from "@terragon/types/cell";
import type { CellSessionManifest } from "@terragon/types/cell-session-checkpoint";

import { cellEntrypoint, CELL_SELF_CHECK_ARGV } from "./cell-image";
import {
  fetchSessionCheckpoint,
  prepareCheckpoint,
} from "./cell-session-checkpoint";
import { createSessionRedactor } from "./cell-session-redact";
import { teardownCellRun } from "./cell-teardown";

/**
 * #743 phase 8 (spike 048 parts B and C, on the real adapter): a session
 * checkpointed from one cell is restored into a SECOND cell after the first is
 * deleted, and a stub agent resumes it, running only the step that was left.
 * Opt-in, outside the Claude sandbox (Docker and the public internet), and it
 * skips cleanly when OPENSANDBOX_IT is not "1" or the cell image is unset:
 *
 *   OPENSANDBOX_IT=1 OPENSANDBOX_IT_CELL_IMAGE=<automata-cell@sha256:... | a local tag> \
 *     pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
 *     src/agent-run/cell-session.integration.test.ts
 *
 * OPENSANDBOX_IT_REUSE=1 skips up.sh, OPENSANDBOX_IT_KEEP=1 skips down.sh.
 * The real `claude --resume` on a redacted file is spike 048 c1/c4 and AC-8.
 */

const IT = process.env.OPENSANDBOX_IT === "1";
const IMAGE = process.env.OPENSANDBOX_IT_CELL_IMAGE ?? "";
const run = promisify(execFile);
const IT_DIR = join(__dirname, "..", "..", "..", "sandbox", "opensandbox-it");
const DEFAULT_BASE_URL = "http://127.0.0.1:18091";
const DEPLOYMENT = "httpbin.org";
const DAEMON_PATH = "/anything/daemon-event";
const CANARY = `sk-ant-api03-CANARY${randomBytes(8).toString("hex")}`;
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
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
  const ttlMs = 30 * 60 * 1000;
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
        // Package registries for case (g) (#724): pub, npm, PyPI.
        { action: "allow", target: "pub.dev" },
        { action: "allow", target: "pub.dartlang.org" },
        { action: "allow", target: "registry.npmjs.org" },
        { action: "allow", target: "pypi.org" },
        { action: "allow", target: "files.pythonhosted.org" },
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

/**
 * A stub agent in Claude's JSONL shape. `run` does steps 1-3 and leaves step 4
 * pending behind an open tool_use. `resume <id>` finds the file the way the
 * daemon does (`find ~/.claude/projects -name <id>.jsonl`), closes the open
 * tool call (as maybeFixLogsForSessionId would) and runs step 4 only. Every
 * executed step is appended to ~/steps.log.
 */
const STUB_AGENT = `
const fs = require("fs");
const cp = require("child_process");
const home = process.env.HOME;
const log = (n) => fs.appendFileSync(home + "/steps.log", "step " + n + "\\n");
const line = (o) => JSON.stringify(o) + "\\n";
const [mode, id] = process.argv.slice(2);
const dir = home + "/.claude/projects/-workspace";
if (mode === "run") {
  fs.mkdirSync(dir, { recursive: true });
  let t = "";
  for (let n = 1; n <= 3; n++) {
    const text = n === 2 ? "step 2 done, key ${CANARY}" : "step " + n + " done";
    t += line({ type: "assistant", uuid: "u" + n, message: { id: "msg_" + n, content: [{ type: "text", text }] } });
    log(n);
  }
  t += line({ type: "assistant", uuid: "u4", message: { id: "msg_4", content: [{ type: "tool_use", id: "tu4", name: "Bash", input: {} }] } });
  fs.writeFileSync(dir + "/" + id + ".jsonl", t);
} else {
  const found = cp.execFileSync("find", [home + "/.claude/projects", "-name", id + ".jsonl"]).toString().trim();
  if (!found) { console.error("session not found"); process.exit(3); }
  fs.appendFileSync(found, line({ type: "user", uuid: "ur4", message: { content: [{ type: "tool_result", tool_use_id: "tu4", content: "interrupted" }] } }));
  const done = fs.readFileSync(found, "utf8").split("\\n").filter((l) => l.includes("step 3 done")).length;
  if (done !== 1) { console.error("step 3 missing"); process.exit(4); }
  fs.appendFileSync(found, line({ type: "assistant", uuid: "u5", message: { id: "msg_5", content: [{ type: "text", text: "step 4 done" }] } }));
  log(4);
}
`;

const OWN = { mode: 600, owner: "agent", group: "agent" } as const;
const STUB_PATH = "/home/agent/stub-agent.js";
const NODE = "/usr/local/bin/node";

describe.skipIf(!IT || IMAGE === "")(
  "cell session restore against a real OpenSandbox (#743 phase 8, OPENSANDBOX_IT)",
  () => {
    let provider: ICellProvider;
    let baseUrl = DEFAULT_BASE_URL;
    const cells: { id: string; stepKey: string }[] = [];

    const newCell = async (): Promise<string> => {
      const cellPlan = plan();
      const { cellId } = await provider.create(cellPlan);
      cells.push({ id: cellId, stepKey: cellPlan.tags.stepKey });
      await provider.copyIn(
        cellId,
        STUB_PATH,
        new TextEncoder().encode(STUB_AGENT),
        OWN,
      );
      return cellId;
    };
    const exec = (id: string, argv: string[]) =>
      provider.exec(id, argv, { timeoutMs: 60_000 });

    beforeAll(async () => {
      if (process.env.OPENSANDBOX_IT_REUSE !== "1") {
        const out = await runScript("up.sh");
        baseUrl =
          /^OPENSANDBOX_IT_BASE_URL=(\S+)$/m.exec(out)?.[1] ?? DEFAULT_BASE_URL;
      }
      const immutable = IMAGE.includes("@sha256:") || !IMAGE.includes("/");
      const pull = () => dind(["docker", "pull", "-q", IMAGE]);
      await (immutable
        ? dind(["docker", "image", "inspect", IMAGE]).catch(pull)
        : pull());
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
    }, 30 * 60_000);

    afterAll(async () => {
      try {
        for (const cell of cells) {
          await teardownCellRun(
            {
              stepKey: cell.stepKey,
              attempt: 1,
              deployment: DEPLOYMENT,
              cellId: cell.id,
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
          ).catch(() => undefined);
        }
      } finally {
        if (process.env.OPENSANDBOX_IT_KEEP !== "1") {
          await runScript("down.sh").catch(() => undefined);
        }
      }
    }, 5 * 60_000);

    // card: protects=#743 AC-1 on the real adapter: a session captured from cell A (killed) is restored into cell B where the daemon's own find locates it, and the stub resumes to run step 4 only, every step once across both cells; AC-5: no canary in the bytes bound for R2; fails_when=the restored file is missing or differs, a step runs twice, step 4 is skipped, or the canary reaches a stored blob; no_claim=a real claude --resume (AC-8) or the www route
    it("restores a killed cell's session into a new cell and resumes only the pending step", async () => {
      // Cell A: steps 1-3 done, step 4 pending behind an open tool_use.
      const a = await newCell();
      const ran = await exec(a, [NODE, STUB_PATH, "run", SESSION_ID]);
      expect(ran.exitCode, ran.stderr.slice(-200)).toBe(0);
      const fileA = `/home/agent/.claude/projects/-workspace/${SESSION_ID}.jsonl`;
      const raw = await provider.copyOut(a, fileA);
      const stepsA = new TextDecoder().decode(
        await provider.copyOut(a, "/home/agent/steps.log"),
      );

      // The worker's writer redacts and stores into an in-memory store (C5 rules).
      const store = new Map<string, Uint8Array>();
      let head: { manifest: CellSessionManifest; version: number } | null =
        null;
      const prepared = prepareCheckpoint({
        previous: null,
        newBytes: raw,
        context: {
          threadId: "thr_it",
          threadChatId: "tc_it",
          sessionId: SESSION_ID,
          runExternalId: "run-it",
          projectDir: "-workspace",
          git: null,
        },
        redactor: createSessionRedactor({ values: [CANARY] }),
      });
      expect(prepared.kind).toBe("write");
      if (prepared.kind !== "write") return;
      for (const blob of prepared.blobs) {
        expect(sha256(blob.body)).toBe(blob.sha256);
        store.set(blob.sha256, blob.body);
      }
      head = { manifest: prepared.manifest, version: 1 };
      for (const body of store.values()) {
        expect(new TextDecoder().decode(body)).not.toContain(CANARY);
      }

      // Kill cell A and prove it is gone.
      await provider.delete(a);
      const alive = await provider.listByTags({
        automata: "cell",
        stepKey: cells[0]!.stepKey,
      });
      expect(JSON.stringify(alive)).not.toContain(a);

      // Cell B: restore through the same verification the run uses, then copy in.
      const b = await newCell();
      const restored = await fetchSessionCheckpoint({
        sessionId: SESSION_ID,
        signal: new AbortController().signal,
        readHead: async () => ({
          ok: true as const,
          head: head
            ? { found: true as const, ...head }
            : { found: false as const, reason: "none" as const },
        }),
        readBlob: async (sha) => {
          const bytes = store.get(sha);
          return bytes
            ? { ok: true as const, bytes }
            : { ok: false as const, code: "not_found", status: 404 };
        },
      });
      expect(restored.kind).toBe("restored");
      if (restored.kind !== "restored") return;
      const dir = `/home/agent/.claude/projects/${restored.manifest.projectDir}`;
      expect(
        (await exec(b, ["/bin/mkdir", "-p", "-m", "700", dir])).exitCode,
      ).toBe(0);
      const fileB = `${dir}/${SESSION_ID}.jsonl`;
      await provider.copyIn(b, fileB, restored.native, OWN);
      const stat = await exec(b, ["/usr/bin/stat", "-c", "%a %U", fileB]);
      expect(stat.stdout.trim()).toBe("600 agent");
      expect(sha256(await provider.copyOut(b, fileB))).toBe(
        sha256(restored.native),
      );

      // The daemon's own search finds it, and the stub resumes step 4 only.
      const found = await exec(b, [
        "/usr/bin/find",
        "/home/agent/.claude/projects",
        "-name",
        `${SESSION_ID}.jsonl`,
      ]);
      expect(found.stdout.trim()).toBe(fileB);
      const resumed = await exec(b, [NODE, STUB_PATH, "resume", SESSION_ID]);
      expect(resumed.exitCode, resumed.stderr.slice(-200)).toBe(0);
      const stepsB = new TextDecoder().decode(
        await provider.copyOut(b, "/home/agent/steps.log"),
      );
      expect(stepsA + stepsB).toBe("step 1\nstep 2\nstep 3\nstep 4\n");
      const after = new TextDecoder().decode(await provider.copyOut(b, fileB));
      expect(after).toContain("step 4 done");
    });
  },
);
