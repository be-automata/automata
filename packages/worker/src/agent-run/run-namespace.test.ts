import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimRunNamespace,
  ensureRunNamespace,
  ensureSlotNamespace,
  runGhSocketPath,
  slotIndexOfDir,
  slotFor,
  slotRunDir,
  workerLockPath,
  workerRunDir,
} from "./run-namespace";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-ns-"));
  roots.push(root);
  return root;
}

describe("claimRunNamespace", () => {
  // card: protects=the boot claim creates this worker's dir and stakes its own pid in worker.lock (what makes a sibling's reclaim leave it alone); fails_when=the lock is missing or names another pid; no_claim=the sibling reclaim itself (reclaim tests)
  it("creates the worker dir and writes this process's pid into worker.lock", async () => {
    const root = mkRoot();
    const dir = await claimRunNamespace({ root, workerId: "w-3" });
    expect(dir).toBe(workerRunDir(root, "w-3"));
    expect(fs.readFileSync(workerLockPath(root, "w-3"), "utf8")).toBe(
      String(process.pid),
    );
  });
});

/**
 * The reaped-/tmp regression (production 2026-09-28): a run whose namespace dir
 * had been removed under a live worker could not bind its sockets. The dir is
 * re-created at every admission.
 */
describe("ensureRunNamespace — survives the dir being reaped", () => {
  // card: protects=a namespace dir removed under a live worker (a /tmp cleaner) is re-created at the next admission; fails_when=the second call leaves the dir missing; no_claim=the gh broker bind that follows
  it("recreates a removed dir", async () => {
    const root = mkRoot();
    const opts = { root, workerId: "w-1" };
    await ensureRunNamespace(opts);
    const dir = workerRunDir(root, "w-1");
    fs.rmSync(dir, { recursive: true, force: true });
    await ensureRunNamespace(opts);
    expect(fs.existsSync(dir)).toBe(true);
  });

  // card: protects=the worker lock stays a boot-time claim (a run never re-stakes a dead worker's claim); fails_when=ensureRunNamespace writes worker.lock; no_claim=claimRunNamespace's own write
  it("does not write the worker lock — that stays a boot-time claim", async () => {
    const root = mkRoot();
    await ensureRunNamespace({ root, workerId: "w-1" });
    expect(fs.existsSync(workerLockPath(root, "w-1"))).toBe(false);
  });
});

describe("#205: slot layout — one subdir per slot", () => {
  it("the flat layout is unchanged when no slot is given (N = 1)", () => {
    const root = "/tmp/automata-agent-run";
    expect(slotRunDir(root, "w-1")).toBe(workerRunDir(root, "w-1"));
    expect(runGhSocketPath(root, "w-1", "thr_1")).toBe(
      `${root}/w-1/thr_1-gh.sock`,
    );
  });

  it("slot i puts the run's gh broker socket under s<i>/ and stays under the sun_path limit", () => {
    const root = "/tmp/automata-agent-run";
    const threadId = "fc4eff11-fb76-49c4-af74-128c7b1200f0";
    expect(slotRunDir(root, "w-12345-abcdef12", 2)).toBe(
      `${root}/w-12345-abcdef12/s2`,
    );
    const gh = runGhSocketPath(root, "w-12345-abcdef12", threadId, 15);
    expect(gh).toBe(`${root}/w-12345-abcdef12/s15/${threadId}-gh.sock`);
    expect(Buffer.byteLength(gh)).toBeLessThan(104);
    expect(() => slotRunDir(root, "w-1", -1)).toThrow(/slot/);
  });

  it("slotIndexOfDir trusts only names the worker would create: s<i> with i < BOX_SLOTS_MAX — never Infinity, never a throw", () => {
    expect(slotIndexOfDir("s0")).toBe(0);
    expect(slotIndexOfDir("s15")).toBe(15);
    for (const hostile of [
      "s16",
      "s99",
      "s00",
      "s01",
      "s-1",
      "s1.5",
      "s",
      "S1",
      "s1 ",
      `s${"9".repeat(400)}`,
      "socks",
    ]) {
      expect(slotIndexOfDir(hostile)).toBeNull();
    }
  });

  it("slotFor: undefined at N = 1; the run's boxSlot at N > 1; a missing override is an invariant violation", () => {
    expect(slotFor({ boxSlots: 1 })).toBeUndefined();
    expect(slotFor({ boxSlots: 1, boxSlot: 0 })).toBeUndefined();
    expect(slotFor({ boxSlots: 3, boxSlot: 2 })).toBe(2);
    expect(() => slotFor({ boxSlots: 3 })).toThrow(/invariant.*boxSlot/);
  });

  // card: protects=a slot's subdir is created worker-private (0750) and the call is idempotent across admissions; fails_when=the dir is missing, wider than 0750, or a second call throws; no_claim=what binds inside it
  it("ensureSlotNamespace creates s<i>/ worker-private and is idempotent", async () => {
    const root = mkRoot();
    const dir = await ensureSlotNamespace({ root, workerId: "w-1", slot: 1 });
    expect(dir).toBe(path.join(workerRunDir(root, "w-1"), "s1"));
    expect(fs.statSync(dir).mode & 0o777 & ~0o750).toBe(0);
    await expect(
      ensureSlotNamespace({ root, workerId: "w-1", slot: 1 }),
    ).resolves.toBe(dir);
  });
});
