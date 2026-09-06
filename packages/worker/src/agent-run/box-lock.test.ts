import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireBoxLock,
  assertBoxLockHelperAvailable,
  BoxLockUnavailableError,
  boxLockHelper,
  boxLockPath,
  withBoxLock,
  type BoxLock,
} from "./box-lock";

/**
 * Every drill here runs the REAL helper (lockf on darwin, flock on linux)
 * against a fresh mkdtemp root — never the production lock root, since
 * production workers run on this box. Cross-process cases spawn the
 * `__fixtures__/box-lock-holder.ts` fixture under `node --import tsx` and
 * wait on its `exit` event (never `close`: a detached grandchild inherits
 * nothing, but `close` would still wait on stdio teardown ordering).
 */

const agentRunDir = path.dirname(fileURLToPath(import.meta.url));
const workerPackageRoot = path.resolve(agentRunDir, "..", "..");
const fixturePath = path.join(
  agentRunDir,
  "__fixtures__",
  "box-lock-holder.ts",
);

/** Exit code of the try-lock probe while the lock is held (F10 / F12). */
const HELD_EXIT = process.platform === "darwin" ? 75 : 1;
const TRY_FLAGS = process.platform === "darwin" ? ["-t", "0"] : ["-n"];

interface HolderExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface LineReader {
  lines: string[];
  waitFor(prefix: string): Promise<string>;
}

interface Holder {
  child: ChildProcess;
  out: LineReader;
  exit: Promise<HolderExit>;
}

const children: ChildProcess[] = [];
const extraPids: number[] = [];
const locks: BoxLock[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function exitOf(child: ChildProcess): Promise<HolderExit> {
  return new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lineReader(stream: Readable): LineReader {
  const lines: string[] = [];
  const waiters: Array<{ prefix: string; resolve: (line: string) => void }> =
    [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lines.push(line);
      for (const waiter of waiters.splice(0)) {
        if (line.startsWith(waiter.prefix)) waiter.resolve(line);
        else waiters.push(waiter);
      }
    }
  });
  return {
    lines,
    waitFor(prefix) {
      const seen = lines.find((l) => l.startsWith(prefix));
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ prefix, resolve }));
    },
  };
}

/** Start the cross-process holder fixture; tracked for afterEach teardown. */
function startHolder(root: string, flags: string[] = []): Holder {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixturePath, root, ...flags],
    { cwd: workerPackageRoot, stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  const exit = exitOf(child);
  if (!child.stdout) throw new Error("holder fixture has no stdout pipe");
  return { child, out: lineReader(child.stdout), exit };
}

/** Non-blocking try-lock probe: 0 when free, HELD_EXIT when held (F10). */
async function tryLock(root: string): Promise<number | null> {
  const { file, args } = boxLockHelper();
  const probe = spawn(
    file,
    [...args, ...TRY_FLAGS, boxLockPath(root), "/usr/bin/true"],
    { stdio: "ignore" },
  );
  return (await exitOf(probe)).code;
}

/** In-process acquire, tracked so afterEach can release a leaked hold. */
async function acquire(
  opts: Parameters<typeof acquireBoxLock>[0],
): Promise<BoxLock> {
  const lock = await acquireBoxLock(opts);
  locks.push(lock);
  return lock;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`rejected with a non-Error: ${String(e)}`);
  }
  throw new Error("expected the promise to reject");
}

describe("box lock (#183 — the worker-side one-agent budget, kernel flock(2))", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "box-lock-"));
  });
  afterEach(async () => {
    await Promise.all(locks.splice(0).map((l) => l.release()));
    for (const child of children.splice(0)) {
      if (hasExited(child)) continue;
      const exit = exitOf(child);
      child.kill("SIGKILL");
      await exit;
    }
    for (const pid of extraPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      for (let i = 0; i < 200 && pidAlive(pid); i++) await sleep(10);
    }
    await rm(root, { recursive: true, force: true });
  });

  it("AC1: serialises two concurrent holders — the second starts only after the first releases", async () => {
    const order: string[] = [];
    const a = withBoxLock({ root, holder: "a" }, async () => {
      order.push("a-start");
      await sleep(200);
      order.push("a-end");
    });
    for (let i = 0; i < 100 && !order.includes("a-start"); i++) {
      await sleep(10);
    }
    expect(order).toEqual(["a-start"]);
    const b = withBoxLock({ root, holder: "b" }, async () => {
      order.push("b-start");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  }, 10_000);

  it("AC2: an abort while WAITING rejects within 500ms with AbortError and leaves the holder's lock intact", async () => {
    const a = await acquire({ root, holder: "A" });
    const ac = new AbortController();
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = Date.now();
      ac.abort();
    }, 100);
    const err = await rejection(
      acquireBoxLock({ root, holder: "B", signal: ac.signal }),
    );
    const latencyMs = Date.now() - abortedAt;
    expect(abortedAt).toBeGreaterThan(0);
    expect(err.name).toBe("AbortError");
    expect(err.message).toMatch(/aborted/);
    expect(latencyMs).toBeLessThan(500);
    expect(await tryLock(root)).toBe(HELD_EXIT);
    await a.release();
    expect(await tryLock(root)).toBe(0);
    console.log(
      `[box-lock AC2] abort-to-rejection while waiting: ${latencyMs}ms`,
    );
  }, 10_000);

  it("AC3: an already-aborted signal never holds the lock, even when it is free, and spawns no helper", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await rejection(
      acquireBoxLock({ root, holder: "late", signal: ac.signal }),
    );
    expect(err.name).toBe("AbortError");
    expect(await tryLock(root)).toBe(0);
    const next = await acquire({ root, holder: "next" });
    expect(await tryLock(root)).toBe(HELD_EXIT);
    await next.release();
    expect(await tryLock(root)).toBe(0);
  }, 10_000);

  it("AC4: releases on throw (withBoxLock); release() is idempotent and a stale release never frees a successor's hold", async () => {
    await expect(
      withBoxLock({ root, holder: "x" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await tryLock(root)).toBe(0);

    const a = await acquire({ root, holder: "A" });
    await a.release();
    await a.release();
    expect(await tryLock(root)).toBe(0);
    const b = await acquire({ root, holder: "B" });
    await a.release();
    expect(await tryLock(root)).toBe(HELD_EXIT);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const err = await rejection(
      acquireBoxLock({ root, holder: "probe", signal: ac.signal }),
    );
    expect(err.name).toBe("AbortError");
    await b.release();
    expect(await tryLock(root)).toBe(0);
  }, 10_000);

  it("AC5: the lock file's mtime means nothing — an ancient mtime under a live holder is never reclaimed", async () => {
    const holder = startHolder(root);
    await holder.out.waitFor("held");
    await utimes(boxLockPath(root), 0, 0);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const err = await rejection(
      acquireBoxLock({ root, holder: "waiter", signal: ac.signal }),
    );
    expect(err.name).toBe("AbortError");
    expect(await tryLock(root)).toBe(HELD_EXIT);
    const exit = holder.exit;
    holder.child.kill("SIGKILL");
    await exit;
    expect(await tryLock(root)).toBe(0);
  }, 10_000);

  it("AC5 (source): the lock module carries no staleness, liveness-beat, mtime, reclaim or polling machinery", () => {
    // Spelled out of pieces so this file never matches the P3 gate's grep
    // for the retired owner-file scheme's identifiers.
    const forbidden = [
      ["stale", "Ms"].join(""),
      ["heart", "beat"].join(""),
      ["mtime", "Ms"].join(""),
      ["read", "Owner"].join(""),
      ["poll", "Ms"].join(""),
      ["set", "Interval"].join(""),
    ];
    const moduleFile = path.join(agentRunDir, "box-lock.ts");
    const moduleText = readFileSync(moduleFile, "utf8");
    for (const token of forbidden) {
      expect(moduleText, `${token} in ${moduleFile}`).not.toContain(token);
    }
    // The old scheme's knob must not survive anywhere else in the directory
    // either (box-slot* itself is retired by P3).
    const staleKnob = forbidden[0];
    const others = readdirSync(agentRunDir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("box-slot"))
      .map((f) => path.join(agentRunDir, f))
      .filter((f) => f !== fileURLToPath(import.meta.url));
    for (const file of others) {
      expect(readFileSync(file, "utf8"), file).not.toContain(staleKnob);
    }
  }, 10_000);

  it("AC6: SIGKILL of a holder process releases the lock at once — the next acquire succeeds in < 500ms", async () => {
    const holder = startHolder(root);
    await holder.out.waitFor("held");
    expect(await tryLock(root)).toBe(HELD_EXIT);
    const exit = holder.exit;
    holder.child.kill("SIGKILL");
    await exit;
    const t0 = Date.now();
    const lock = await acquire({ root, holder: "successor" });
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(500);
    expect(await tryLock(root)).toBe(HELD_EXIT);
    await lock.release();
    console.log(`[box-lock AC6] reacquire after SIGKILL: ${elapsedMs}ms`);
  }, 10_000);

  it("AC7: two holder PROCESSES never overlap; a parent waiter aborting while one holds rejects", async () => {
    const a = startHolder(root, ["--hold-ms=300"]);
    await a.out.waitFor("start");
    await sleep(50);
    const b = startHolder(root, ["--hold-ms=300"]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const err = await rejection(
      acquireBoxLock({ root, holder: "parent", signal: ac.signal }),
    );
    expect(err.name).toBe("AbortError");
    const [aExit, bExit] = await Promise.all([a.exit, b.exit]);
    expect(aExit.code).toBe(0);
    expect(bExit.code).toBe(0);
    const epoch = (holder: Holder, prefix: string): number => {
      const line = holder.out.lines.find((l) => l.startsWith(prefix));
      if (!line) throw new Error(`fixture never printed "${prefix}"`);
      return Number(line.slice(prefix.length + 1));
    };
    const aStart = epoch(a, "start");
    const aEnd = epoch(a, "end");
    const bStart = epoch(b, "start");
    const bEnd = epoch(b, "end");
    expect(aEnd - aStart).toBeGreaterThanOrEqual(300);
    expect(bEnd - bStart).toBeGreaterThanOrEqual(300);
    const disjoint = aEnd <= bStart || bEnd <= aStart;
    expect(disjoint, `a=[${aStart},${aEnd}] b=[${bStart},${bEnd}]`).toBe(true);
    // A was holding when B launched, so B's interval follows A's.
    expect(bStart).toBeGreaterThanOrEqual(aEnd);
  }, 10_000);

  it("AC8: SIGKILL of a holder whose detached grandchild survives still releases the lock — the lock follows the helper, not the process tree", async () => {
    const holder = startHolder(root, ["--spawn-grandchild"]);
    await holder.out.waitFor("held");
    const grandchildLine = await holder.out.waitFor("grandchild ");
    const grandchildPid = Number(grandchildLine.split(" ")[1]);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    extraPids.push(grandchildPid);
    expect(await tryLock(root)).toBe(HELD_EXIT);
    const exit = holder.exit;
    holder.child.kill("SIGKILL");
    await exit;
    expect(pidAlive(grandchildPid)).toBe(true);
    const t0 = Date.now();
    const lock = await acquire({ root, holder: "successor" });
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(500);
    expect(pidAlive(grandchildPid)).toBe(true);
    await lock.release();
    console.log(
      `[box-lock AC8] reacquire after SIGKILL with live grandchild: ${elapsedMs}ms`,
    );
  }, 10_000);

  it("AC9: helper argv per platform; unsupported platforms and a missing binary surface as BoxLockUnavailableError", async () => {
    expect(boxLockHelper("darwin")).toEqual({
      file: "/usr/bin/lockf",
      args: ["-k", "-s", "-w"],
    });
    expect(boxLockHelper("linux")).toEqual({
      file: "/usr/bin/flock",
      args: ["-x", "-o"],
    });
    expect(() => boxLockHelper("win32")).toThrow(BoxLockUnavailableError);
    await expect(
      assertBoxLockHelperAvailable({
        access: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(BoxLockUnavailableError);
    const err = await rejection(
      assertBoxLockHelperAvailable({
        platform: "darwin",
        access: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(err).toBeInstanceOf(BoxLockUnavailableError);
    if (err instanceof BoxLockUnavailableError) {
      expect(err.helper).toBe("/usr/bin/lockf");
      expect(err.detail).toBe("ENOENT");
    }
    await expect(
      assertBoxLockHelperAvailable({ platform: "win32" }),
    ).rejects.toThrow(BoxLockUnavailableError);
    // The real probe on this box.
    const { file } = await assertBoxLockHelperAvailable();
    expect(file).toBe(boxLockHelper().file);
  }, 10_000);

  it("F6: a helper that exits before the ack rejects with BoxLockUnavailableError carrying the exit and stderr — never hangs", async () => {
    // The lock path is a directory: the helper cannot open it and exits
    // before ever printing `ok`.
    await mkdir(boxLockPath(root));
    const err = await rejection(acquireBoxLock({ root, holder: "doomed" }));
    expect(err).toBeInstanceOf(BoxLockUnavailableError);
    if (err instanceof BoxLockUnavailableError) {
      expect(err.helper).toBe(boxLockHelper().file);
      expect(err.detail).toMatch(/^exit \d+\/null/);
      expect(err.detail).toMatch(/directory/i);
    }
  }, 10_000);

  it("log: acquisition and release lines go to the injected logger, naming the holder", async () => {
    const lines: string[] = [];
    const lock = await acquire({
      root,
      holder: "thread-1",
      log: (l) => lines.push(l),
    });
    await lock.release();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^box lock acquired by thread-1 \(helper pid \d+\)$/,
    );
    expect(lines[1]).toMatch(
      /^box lock released by thread-1 \(helper pid \d+\)$/,
    );
  }, 10_000);
});
