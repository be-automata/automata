import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireBoxLock,
  acquireBoxSlot,
  assertBoxLockHelperAvailable,
  BoxLockUnavailableError,
  boxLockHelper,
  boxLockPath,
  boxLockTryHelper,
  rotationStart,
  tryAcquireAllBoxSlots,
  tryAcquireBoxLock,
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

/** Poll `cond` every 20ms until true or `ms` elapsed. */
async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: timed out");
    await sleep(20);
  }
}

/** Non-blocking try-lock probe: 0 when free, HELD_EXIT when held (F10). */
async function tryLock(root: string, slot = 0): Promise<number | null> {
  const { file, args } = boxLockHelper();
  const probe = spawn(
    file,
    [...args, ...TRY_FLAGS, boxLockPath(root, slot), "/usr/bin/true"],
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

/**
 * Start an acquire on `root` that is aborted after `abortAfterMs` and assert it
 * rejects with the AbortError contract. Returns the error and the abort time
 * so timing-sensitive cases can measure latency.
 */
async function expectAbortedAcquire(
  root: string,
  holder: string,
  abortAfterMs: number,
): Promise<{ err: Error; abortedAt: number }> {
  const ac = new AbortController();
  let abortedAt = 0;
  setTimeout(() => {
    abortedAt = Date.now();
    ac.abort();
  }, abortAfterMs);
  const err = await rejection(
    acquireBoxLock({ root, holder, signal: ac.signal }),
  );
  expect(err.name).toBe("AbortError");
  expect(err.message).toMatch(/aborted/);
  return { err, abortedAt };
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
    const { abortedAt } = await expectAbortedAcquire(root, "B", 100);
    const latencyMs = Date.now() - abortedAt;
    expect(abortedAt).toBeGreaterThan(0);
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
    await expectAbortedAcquire(root, "probe", 150);
    await b.release();
    expect(await tryLock(root)).toBe(0);
  }, 10_000);

  it("AC5: the lock file's mtime means nothing — an ancient mtime under a live holder is never reclaimed", async () => {
    const holder = startHolder(root);
    await holder.out.waitFor("held");
    await utimes(boxLockPath(root), 0, 0);
    await expectAbortedAcquire(root, "waiter", 300);
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
    // The old scheme's knob must not survive anywhere else in the directory.
    const staleKnob = forbidden[0];
    const others = readdirSync(agentRunDir)
      .filter((f) => f.endsWith(".ts"))
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
    await expectAbortedAcquire(root, "parent", 150);
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
    // The fixture holds with `setTimeout(holdMs)` between two Date.now()
    // readings (__fixtures__/box-lock-holder.ts:48-50). Neither end of that is
    // exact: a timer may fire a hair early relative to Date.now(), and each
    // reading truncates to whole milliseconds, so a correct 300ms hold can
    // measure 299. CI hit exactly that — "expected 299 to be greater than or
    // equal to 300" — on a PR that touched no worker code.
    //
    // This pair of bounds only proves each holder did not exit immediately, so
    // it takes the slack. The invariants the lock actually guarantees are
    // disjointness and ordering, and those are integer comparisons between
    // readings rather than durations, so they stay exact below.
    const HOLD_SLACK_MS = 5;
    expect(aEnd - aStart).toBeGreaterThanOrEqual(300 - HOLD_SLACK_MS);
    expect(bEnd - bStart).toBeGreaterThanOrEqual(300 - HOLD_SLACK_MS);
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

  it.skipIf(process.getuid?.() === 0)(
    "F6: a helper that exits before the ack rejects with BoxLockUnavailableError carrying the exit and stderr — never hangs",
    async () => {
      // The lock file exists but is unreadable and unwritable (mode 000): the
      // helper cannot open it and exits before ever printing `ok`. (A
      // DIRECTORY would not do: util-linux flock locks directories happily,
      // so that variant passes on darwin and fails on the linux CI runner.)
      // Root bypasses mode bits, hence the skip.
      await writeFile(boxLockPath(root), "", { mode: 0o000 });
      const err = await rejection(acquireBoxLock({ root, holder: "doomed" }));
      expect(err).toBeInstanceOf(BoxLockUnavailableError);
      if (err instanceof BoxLockUnavailableError) {
        expect(err.helper).toBe(boxLockHelper().file);
        expect(err.detail).toMatch(/^exit \d+\/null/);
        expect(err.detail).toMatch(/denied/i);
      }
    },
    10_000,
  );

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

  it("lost: a helper SIGKILLed after the ack flips lock.lost within 1s and logs the LOST line; release() still resolves", async () => {
    const lines: string[] = [];
    const lock = await acquire({
      root,
      holder: "thread-lost",
      log: (l) => lines.push(l),
    });
    expect(lock.lost).toBe(false);
    const acquired = lines.find((l) => l.startsWith("box lock acquired by"));
    const helperPid = Number(
      /\(helper pid (\d+)\)$/.exec(acquired ?? "")?.[1] ?? NaN,
    );
    expect(Number.isInteger(helperPid)).toBe(true);
    // Kill the helper only (not this process): the kernel drops the lock and
    // the run still believes it holds it — the LOST state.
    process.kill(helperPid, "SIGKILL");
    const deadline = Date.now() + 1000;
    while (!lock.lost && Date.now() < deadline) await sleep(10);
    expect(lock.lost).toBe(true);
    expect(
      lines.some((l) => l.startsWith("box lock LOST by thread-lost:")),
    ).toBe(true);
    expect(await tryLock(root)).toBe(0);
    await expect(lock.release()).resolves.toBeUndefined();
    expect(lock.lost).toBe(true);
  }, 10_000);

  it("lost: stays false across a normal release", async () => {
    const lock = await acquire({ root, holder: "thread-ok" });
    await lock.release();
    expect(lock.lost).toBe(false);
  }, 10_000);

  describe("tryAcquireBoxLock (#184)", () => {
    it("returns null within 500ms while another PROCESS holds the lock, leaving no waiter behind", async () => {
      const holder = startHolder(root);
      await holder.out.waitFor("held");
      const childrenBefore = children.length;
      const lines: string[] = [];
      const t0 = Date.now();
      const lock = await tryAcquireBoxLock({
        root,
        holder: "boot",
        log: (l) => lines.push(l),
      });
      const elapsedMs = Date.now() - t0;
      expect(lock).toBeNull();
      expect(elapsedMs).toBeLessThan(500);
      expect(lines).toEqual(["box lock busy — boot did not wait"]);
      // The fixture still holds it: the try never stole or queued.
      expect(await tryLock(root)).toBe(HELD_EXIT);
      expect(children.length).toBe(childrenBefore);
      const exit = holder.exit;
      holder.child.kill("SIGKILL");
      await exit;
      expect(await tryLock(root)).toBe(0);
      console.log(`[box-lock try] busy → null: ${elapsedMs}ms`);
    }, 10_000);

    it("acquires a free lock — the probe sees it held — and release() frees it", async () => {
      const lines: string[] = [];
      const lock = await tryAcquireBoxLock({
        root,
        holder: "boot",
        log: (l) => lines.push(l),
      });
      expect(lock).not.toBeNull();
      if (!lock) return;
      locks.push(lock);
      expect(await tryLock(root)).toBe(HELD_EXIT);
      // A second try on the same root from this process is busy too.
      expect(await tryAcquireBoxLock({ root, holder: "again" })).toBeNull();
      await lock.release();
      expect(await tryLock(root)).toBe(0);
      expect(lines[0]).toMatch(
        /^box lock acquired by boot \(helper pid \d+\)$/,
      );
      expect(lines[1]).toMatch(
        /^box lock released by boot \(helper pid \d+\)$/,
      );
    }, 10_000);

    it("helper argv per platform: base flags plus the non-waiting flags, busy exit normalised to 75", () => {
      expect(boxLockTryHelper("darwin")).toEqual({
        file: "/usr/bin/lockf",
        args: ["-k", "-s", "-w", "-t", "0"],
      });
      expect(boxLockTryHelper("linux")).toEqual({
        file: "/usr/bin/flock",
        args: ["-x", "-o", "-n", "-E", "75"],
      });
      expect(() => boxLockTryHelper("win32")).toThrow(BoxLockUnavailableError);
    }, 10_000);

    it("a bogus helper binary surfaces as BoxLockUnavailableError (spawn failure is never 'busy')", async () => {
      const bogus = path.join(root, "no-such-lockf");
      const err = await rejection(
        tryAcquireBoxLock({
          root,
          holder: "boot",
          helper: { file: bogus, args: boxLockTryHelper().args },
        }),
      );
      expect(err).toBeInstanceOf(BoxLockUnavailableError);
      if (err instanceof BoxLockUnavailableError) {
        expect(err.helper).toBe(bogus);
        expect(err.detail).toMatch(/^spawn failed: /);
        expect(err.detail).toMatch(/ENOENT/);
      }
      expect(await tryLock(root)).toBe(0);
    }, 10_000);

    it("release() is idempotent and a stale release never frees a successor's hold", async () => {
      const a = await tryAcquireBoxLock({ root, holder: "A" });
      expect(a).not.toBeNull();
      if (!a) return;
      locks.push(a);
      await a.release();
      await a.release();
      expect(await tryLock(root)).toBe(0);
      const b = await tryAcquireBoxLock({ root, holder: "B" });
      expect(b).not.toBeNull();
      if (!b) return;
      locks.push(b);
      await a.release();
      expect(await tryLock(root)).toBe(HELD_EXIT);
      await b.release();
      expect(await tryLock(root)).toBe(0);
    }, 10_000);
  });

  describe("counting slots (#205 — N slot files, one uid per slot)", () => {
    it("slot 0 is `box.lock` (byte-identical to the exclusive lock); slot i is `box.lock.<i>`", () => {
      expect(boxLockPath(root)).toBe(path.join(root, "box.lock"));
      expect(boxLockPath(root, 0)).toBe(boxLockPath(root));
      expect(boxLockPath(root, 2)).toBe(path.join(root, "box.lock.2"));
      expect(() => boxLockPath(root, -1)).toThrow(/slot/);
      expect(() => boxLockPath(root, 1.5)).toThrow(/slot/);
    });

    it("rotationStart is deterministic, in range, and not always slot 0", () => {
      const starts = new Set<number>();
      for (let i = 0; i < 64; i++) {
        const s = rotationStart(`thread-${i}-${i * 7919}`, 3);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(3);
        expect(rotationStart(`thread-${i}-${i * 7919}`, 3)).toBe(s);
        starts.add(s);
      }
      expect(starts.size).toBeGreaterThan(1);
      expect(rotationStart("anything", 1)).toBe(0);
      expect(() => rotationStart("x", 0)).toThrow(/slots/);
    });

    it("slots = 1 is exactly the exclusive lock: box.lock held, no slot suffix in the log", async () => {
      const lines: string[] = [];
      const lock = await acquireBoxSlot({
        root,
        slots: 1,
        holder: "one",
        log: (l) => lines.push(l),
      });
      locks.push(lock);
      expect(lock.slot).toBe(0);
      expect(await tryLock(root)).toBe(HELD_EXIT);
      expect(lines).toEqual([
        expect.stringMatching(/^box lock acquired by one \(helper pid \d+\)$/),
      ]);
      await lock.release();
      expect(await tryLock(root)).toBe(0);
    }, 10_000);

    it("slots = 2: two holders take DISTINCT slots at once; the third parks and is admitted on WHICHEVER slot frees first (in-process wake-up)", async () => {
      const lines: string[] = [];
      const log = (l: string) => lines.push(l);
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A", log });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B", log });
      locks.push(a, b);
      expect(new Set([a.slot, b.slot])).toEqual(new Set([0, 1]));
      expect(await tryLock(root, 0)).toBe(HELD_EXIT);
      expect(await tryLock(root, 1)).toBe(HELD_EXIT);
      expect(lines.filter((l) => l.startsWith("box lock acquired"))).toEqual([
        expect.stringMatching(
          /^box lock acquired by A \(helper pid \d+, slot [01]\/2\)$/,
        ),
        expect.stringMatching(
          /^box lock acquired by B \(helper pid \d+, slot [01]\/2\)$/,
        ),
      ]);

      const wanted = rotationStart("C", 2);
      let cHeld: BoxLock | null = null;
      const c = acquireBoxSlot({ root, slots: 2, holder: "C", log }).then(
        (l) => {
          cHeld = l;
          locks.push(l);
          return l;
        },
      );
      await sleep(300);
      expect(cHeld).toBeNull();
      // Both slots are occupied by in-process runs, so there is no kernel lock
      // worth waiting on: C waits for a release wake-up.
      expect(lines).toContain(
        "box budget full (2 slots held) — C waits on a release",
      );
      // Freeing the OTHER slot admits C THERE: the release wakes the parked
      // waiter, which re-sweeps instead of idling on its rotated slot while a
      // slot sits free (the supersede/cancel teardown case).
      const other = wanted === a.slot ? b : a;
      const mine = wanted === a.slot ? a : b;
      await other.release();
      const held = await c;
      expect(held.slot).toBe(other.slot);
      expect(await tryLock(root, other.slot)).toBe(HELD_EXIT);
      expect(await tryLock(root, mine.slot)).toBe(HELD_EXIT);
      // The wait on the rotated slot was torn down: freeing it leaves it free.
      await mine.release();
      expect(await tryLock(root, mine.slot)).toBe(0);
      await held.release();
      expect(await tryLock(root, 0)).toBe(0);
      expect(await tryLock(root, 1)).toBe(0);
    }, 15_000);

    it("an abort that lands during the lock-file preparation (before the helper spawns) still rejects with AbortError and leaves the slot free", async () => {
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A" });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B" });
      locks.push(a, b);
      // Abort on the next tick: inside acquireBoxLock's open/chmod awaits (or
      // right after). Either way: AbortError, no helper left blocked.
      const ac = new AbortController();
      const c = acquireBoxLock({
        root,
        holder: "C",
        signal: ac.signal,
        slot: 0,
        slots: 2,
      });
      await new Promise<void>((r) => setImmediate(r));
      ac.abort();
      await expect(c).rejects.toMatchObject({ name: "AbortError" });
      await a.release();
      await b.release();
      await sleep(100);
      expect(await tryLock(root, 0)).toBe(0);
      expect(await tryLock(root, 1)).toBe(0);
    }, 15_000);

    it("a LOST slot (helper killed, kernel lock gone, run still live) is never re-admitted: the next acquire takes another slot or waits until the run releases", async () => {
      const lines: string[] = [];
      const log = (l: string) => lines.push(l);
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A", log });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B", log });
      locks.push(a, b);
      const pidOf = (holder: string) =>
        Number(
          lines
            .find((l) => l.startsWith(`box lock acquired by ${holder} `))
            ?.match(/helper pid (\d+)/)?.[1],
        );
      process.kill(pidOf("A"), "SIGKILL");
      await waitFor(() => a.lost, 3_000);
      // The kernel has freed A's slot file...
      expect(await tryLock(root, a.slot)).toBe(0);
      // ...but C must not take it: B still holds the other, so C waits.
      let cHeld: BoxLock | null = null;
      const c = acquireBoxSlot({ root, slots: 2, holder: "C", log }).then(
        (l) => {
          cHeld = l;
          locks.push(l);
          return l;
        },
      );
      await sleep(400);
      expect(cHeld).toBeNull();
      await b.release();
      const held = await c;
      expect(held.slot).toBe(b.slot);
      // A's run ends: its release frees the occupancy; the slot is usable again.
      await a.release();
      const d = await acquireBoxSlot({ root, slots: 2, holder: "D", log });
      locks.push(d);
      expect(d.slot).toBe(a.slot);
      await held.release();
      await d.release();
    }, 20_000);

    it("a kernel grant on a LOST slot is refused at the ack: the try-path returns null and the waiting path re-sweeps — until the live run releases", async () => {
      const lines: string[] = [];
      const log = (l: string) => lines.push(l);
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A", log });
      locks.push(a);
      const pid = Number(
        lines
          .find((l) => l.startsWith("box lock acquired by A "))
          ?.match(/helper pid (\d+)/)?.[1],
      );
      process.kill(pid, "SIGKILL");
      await waitFor(() => a.lost, 3_000);
      expect(await tryLock(root, a.slot)).toBe(0); // the kernel would grant it
      // Direct try on A's slot (as a parked waiter's kernel wait would be
      // granted): refused, nothing held, the kernel lock is free again.
      expect(
        await tryAcquireBoxLock({
          root,
          holder: "T",
          log,
          slot: a.slot,
          slots: 2,
        }),
      ).toBeNull();
      expect(lines).toContainEqual(
        expect.stringContaining(
          `box slot ${a.slot} is occupied by a live run whose lock was LOST — T did not take it`,
        ),
      );
      expect(await tryLock(root, a.slot)).toBe(0);
      // The waiting acquire on that slot throws SlotOccupiedError instead of
      // returning a lock shared with A's live run.
      await expect(
        acquireBoxLock({ root, holder: "W", log, slot: a.slot, slots: 2 }),
      ).rejects.toMatchObject({ name: "SlotOccupiedError", slot: a.slot });
      // A's own release clears the reservation; now the slot is grantable.
      await a.release();
      const t = await tryAcquireBoxLock({
        root,
        holder: "T2",
        log,
        slot: a.slot,
        slots: 2,
      });
      expect(t).not.toBeNull();
      if (t) {
        locks.push(t);
        await t.release();
      }
    }, 20_000);

    it("every slot lock file is the worker's alone: mode 0600 (flock(2) on a read-only fd would otherwise let a sibling slot's agent take the slot)", async () => {
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A" });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B" });
      locks.push(a, b);
      for (const slot of [0, 1]) {
        expect(statSync(boxLockPath(root, slot)).mode & 0o777).toBe(0o600);
      }
      await a.release();
      await b.release();
    }, 15_000);

    it("slots = 2: a release that lands WHILE the waiter's sweep is still in flight is not missed — the waiter lands on that slot", async () => {
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A" });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B" });
      locks.push(a, b);
      const wanted = rotationStart("C", 2);
      const other = wanted === a.slot ? b : a;
      const mine = wanted === a.slot ? a : b;
      // No sleep: the release races the sweep's helper spawns. Whether it
      // lands before the try of that slot, between the tries, or after the
      // sweep, C must end up on it — never parked beside a free slot.
      const c = acquireBoxSlot({ root, slots: 2, holder: "C" });
      await other.release();
      const held = await c;
      locks.push(held);
      expect(held.slot).toBe(other.slot);
      expect(await tryLock(root, other.slot)).toBe(HELD_EXIT);
      await mine.release();
      await held.release();
    }, 15_000);

    it("slots = 2: a signal already aborted when the budget is full ⇒ AbortError at once, no park, nothing held", async () => {
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A" });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B" });
      locks.push(a, b);
      const ac = new AbortController();
      ac.abort();
      await expect(
        acquireBoxSlot({ root, slots: 2, holder: "C", signal: ac.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await a.release();
      await b.release();
      expect(await tryLock(root, 0)).toBe(0);
      expect(await tryLock(root, 1)).toBe(0);
    }, 15_000);

    it("slots = 2: a parked waiter's own abort still wins (AbortError, nothing held) even with a release wake-up racing it", async () => {
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A" });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B" });
      locks.push(a, b);
      const ac = new AbortController();
      const c = acquireBoxSlot({
        root,
        slots: 2,
        holder: "C",
        signal: ac.signal,
      });
      await sleep(300);
      ac.abort();
      await expect(c).rejects.toMatchObject({ name: "AbortError" });
      await a.release();
      await b.release();
      await sleep(100);
      expect(await tryLock(root, 0)).toBe(0);
      expect(await tryLock(root, 1)).toBe(0);
    }, 15_000);

    it("a waiting acquireBoxSlot honours the AbortSignal (AC2 at N > 1)", async () => {
      const a = await acquireBoxSlot({ root, slots: 2, holder: "A" });
      const b = await acquireBoxSlot({ root, slots: 2, holder: "B" });
      locks.push(a, b);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 100);
      const err = await rejection(
        acquireBoxSlot({ root, slots: 2, holder: "C", signal: ac.signal }),
      );
      expect(err.name).toBe("AbortError");
      expect(await tryLock(root, 0)).toBe(HELD_EXIT);
      expect(await tryLock(root, 1)).toBe(HELD_EXIT);
    }, 10_000);

    it("a cross-process holder on slot 1 leaves slot 0 free; the try path sees exactly that", async () => {
      const holder = startHolder(root, ["--slot=1"]);
      expect(await holder.out.waitFor("held")).toBe("held 1");
      expect(await tryLock(root, 1)).toBe(HELD_EXIT);
      expect(await tryLock(root, 0)).toBe(0);
      const got = await acquireBoxSlot({ root, slots: 2, holder: "me" });
      locks.push(got);
      expect(got.slot).toBe(0);
      await got.release();
      const exit = holder.exit;
      holder.child.kill("SIGKILL");
      await exit;
      // Kernel-released on the holder's death: no staleness, no reclaim.
      expect(await tryLock(root, 1)).toBe(0);
    }, 10_000);

    it("tryAcquireAllBoxSlots: every slot or nothing — a busy slot releases the partial set", async () => {
      const holder = startHolder(root, ["--slot=1"]);
      await holder.out.waitFor("held");
      const lines: string[] = [];
      const none = await tryAcquireAllBoxSlots({
        root,
        slots: 2,
        holder: "boot",
        log: (l) => lines.push(l),
      });
      expect(none).toBeNull();
      // Slot 0 was taken and then given back: nothing is left held by us.
      expect(await tryLock(root, 0)).toBe(0);
      expect(lines).toEqual([
        expect.stringMatching(
          /^box lock acquired by boot \(helper pid \d+, slot 0\/2\)$/,
        ),
        "box lock busy — boot did not wait, slot 1/2",
        expect.stringMatching(
          /^box lock released by boot \(helper pid \d+, slot 0\/2\)$/,
        ),
      ]);
      const exit = holder.exit;
      holder.child.kill("SIGKILL");
      await exit;

      const all = await tryAcquireAllBoxSlots({
        root,
        slots: 2,
        holder: "boot",
      });
      expect(all).not.toBeNull();
      if (!all) return;
      locks.push(...all);
      expect(all.map((l) => l.slot)).toEqual([0, 1]);
      expect(await tryLock(root, 0)).toBe(HELD_EXIT);
      expect(await tryLock(root, 1)).toBe(HELD_EXIT);
      for (const l of all) await l.release();
      expect(await tryLock(root, 0)).toBe(0);
      expect(await tryLock(root, 1)).toBe(0);
    }, 10_000);
  });
});
