/**
 * Canary stub of www's daemon endpoints for the ADR-013 throwaway box.
 * DEV ONLY — see ./README.md. Binds loopback only; the container daemon
 * reaches it through a public tunnel (README §Reachability).
 *
 *   CANARY_STATE_DIR           spec dir dispatch.mts writes (default /var/lib/automata-canary)
 *   CANARY_ANTHROPIC_KEY_FILE  root-only file holding the Anthropic API key or a
 *                              `claude setup-token` token, sk-ant-oat… (required)
 *   CANARY_STUB_PORT           loopback port (default 8787)
 *   CANARY_LOG_FILE            JSON-lines evidence log (default <state>/requests.jsonl)
 */
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { readGuardedFile } from "../../src/agent-run/guarded-file";
import {
  createStubHandler,
  createThreadStore,
  makeScrubber,
} from "./stub-core";
import { readThreadSpecs } from "./thread-spec";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

const stateDir = process.env.CANARY_STATE_DIR ?? "/var/lib/automata-canary";
const keyFile = process.env.CANARY_ANTHROPIC_KEY_FILE;
const port = Number(process.env.CANARY_STUB_PORT ?? "8787");
const logFile =
  process.env.CANARY_LOG_FILE ?? path.join(stateDir, "requests.jsonl");

if (!keyFile) {
  console.error("canary stub: CANARY_ANTHROPIC_KEY_FILE is required");
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("canary stub: CANARY_STUB_PORT is not a port");
  process.exit(2);
}

/** Owner-only, no symlink, small: the same guard the worker uses for its secret files. */
function readAnthropicKey(): string {
  const key = readGuardedFile(keyFile as string, {
    ownerOnly: true,
    maxBytes: 4096,
  }).trim();
  if (key === "") throw new Error("canary stub: Anthropic key file is empty");
  return key;
}
// Fail fast at boot rather than on the first run.
readAnthropicKey();

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const store = createThreadStore(() =>
  readThreadSpecs(stateDir, (file, reason) =>
    console.warn(`canary stub: skipped spec ${file}: ${reason}`),
  ),
);
const scrub = makeScrubber(() => [
  readAnthropicKey(),
  ...store
    .all()
    .flatMap((e) => [e.spec.daemonToken, e.spec.selfHealToken ?? ""]),
]);
const logFd = fs.openSync(logFile, "a", 0o600);

function record(entry: Record<string, unknown>): void {
  const line = scrub(
    JSON.stringify({ ts: new Date().toISOString(), ...entry }),
  );
  fs.writeSync(logFd, `${line}\n`);
  // One short line to the journal per request (no bodies).
  const {
    ts: _ts,
    messages: _m,
    events: _e,
    report: _r,
    result,
    ...brief
  } = JSON.parse(line) as Record<string, unknown>;
  console.log(
    `canary stub: ${JSON.stringify(brief)}${result !== undefined ? " (result recorded)" : ""}`,
  );
}

const handle = createStubHandler({ store, readAnthropicKey, record });

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) return;
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
    const out = handle({
      method: req.method ?? "GET",
      path: (req.url ?? "/").split("?")[0] ?? "/",
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (out.json !== undefined) {
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    } else {
      res.writeHead(out.status, { "content-type": "text/plain" });
      res.end(out.text ?? "");
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `canary stub: listening on http://127.0.0.1:${port} (state ${stateDir}, log ${logFile})`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    fs.closeSync(logFd);
    process.exit(0);
  });
}
