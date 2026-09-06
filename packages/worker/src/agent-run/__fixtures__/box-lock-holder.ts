import { spawn } from "node:child_process";

import { acquireBoxLock } from "../box-lock";

/**
 * Cross-process holder for box-lock.test.ts. Takes the box lock under
 * `<root>` and reports on stdout, one line per event:
 *
 *   held                 the lock is ours
 *   grandchild <pid>     (--spawn-grandchild) a detached `sleep 3600` we own
 *   start <epoch-ms>     (--hold-ms=<n>) the hold interval opens
 *   end <epoch-ms>       (--hold-ms=<n>) the hold interval closes; then release, exit 0
 *
 * Without --hold-ms it stays alive until killed, which is how the tests
 * prove the kernel releases the lock when the holder dies (AC6, AC8).
 */

const [root, ...flags] = process.argv.slice(2);
if (!root) {
  console.error(
    "usage: box-lock-holder <root> [--spawn-grandchild] [--hold-ms=<n>]",
  );
  process.exit(2);
}

/** stdout is a pipe: asynchronous on macOS, so flush before exiting. */
async function writeLine(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

const lock = await acquireBoxLock({ root, holder: "fixture" });
await writeLine("held");

if (flags.includes("--spawn-grandchild")) {
  const grandchild = spawn("/bin/sleep", ["3600"], {
    detached: true,
    stdio: "ignore",
  });
  grandchild.unref();
  await writeLine(`grandchild ${grandchild.pid}`);
}

const holdFlag = flags.find((f) => f.startsWith("--hold-ms="));
if (holdFlag) {
  const holdMs = Number(holdFlag.slice("--hold-ms=".length));
  await writeLine(`start ${Date.now()}`);
  await new Promise((r) => setTimeout(r, holdMs));
  await writeLine(`end ${Date.now()}`);
  await lock.release();
  process.exit(0);
} else {
  setInterval(() => {}, 1000);
}
