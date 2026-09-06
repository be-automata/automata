import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoxLockUnavailableError, type BoxLock } from "./box-lock";
import type { Invocation } from "./spawn-as-user";
import {
  _resetEscapeesSinceBootForTests,
  BOX_BUDGET_FILENAME,
  bootUidScan,
  listProcessesViaPs,
  MACOS_PER_USER_HELPERS,
  parsePsOutput,
  reapAgentUidEscapees,
  selectAgentRows,
  type BootUidScanOpts,
  type BoxBudgetSnapshot,
  type ProcRow,
} from "./uid-reaper";

type TryAcquireFn = NonNullable<BootUidScanOpts["tryAcquire"]>;
type ReapFn = NonNullable<BootUidScanOpts["reap"]>;

/**
 * SAFETY: this box runs a production worker under the agent uid. No case here
 * passes a non-empty `agentUser` together with the default `spawnKill`; every
 * reap injects `spawnKill` and `resolveUid`. The only real-process case (AC8)
 * uses the real `ps` for COUNTING and a `vi.fn()` kill — it never reaches
 * sudo. Snapshot roots are mkdtemp'd, never the production namespace root.
 */

const agentRunDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(agentRunDir, "__fixtures__", name), "utf8");

const DARWIN_ROWS = parsePsOutput(fixture("ps-darwin.txt"));
const LINUX_ROWS = parsePsOutput(fixture("ps-linux.txt"));
const AGENT = "_automata-agent";
const EXPECTED_KILL_ARGV = [
  "-n",
  "-u",
  AGENT,
  "--",
  "/bin/kill",
  "-9",
  "--",
  "-1",
];

/** Parse the JSON payload after the first space of a `box.* {…}` line. */
function payloadOf(line: string): Record<string, unknown> {
  const idx = line.indexOf(" ");
  return JSON.parse(line.slice(idx + 1)) as Record<string, unknown>;
}

function eventLines(lines: string[], event: string): string[] {
  return lines.filter((l) => l.startsWith(`${event} `));
}

/** `listProcesses` that returns each scripted result in turn, then the last one forever. */
function scriptedList(...results: ProcRow[][]) {
  let i = 0;
  return vi.fn(async (): Promise<ProcRow[]> => {
    const r = results[Math.min(i, results.length - 1)] ?? [];
    i += 1;
    return r;
  });
}

const resolve450 = vi.fn(async () => 450);
const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "uid-reaper-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  _resetEscapeesSinceBootForTests();
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

describe("parsePsOutput (AC2)", () => {
  it("darwin fixture: header, malformed and blank rows dropped; full-path comm kept", () => {
    expect(DARWIN_ROWS).toHaveLength(11);
    expect(DARWIN_ROWS[0]).toEqual({
      pid: 1,
      pgid: 1,
      uid: 0,
      comm: "/sbin/launchd",
    });
    expect(DARWIN_ROWS.find((r) => r.pid === 36921)?.comm).toMatch(
      /csnameddatad\.xpc\/Contents\/MacOS\/csnameddatad$/,
    );
    expect(DARWIN_ROWS.some((r) => Number.isNaN(r.pid))).toBe(false);
  });

  it("linux fixture: procps header dropped, pgid-0 kernel rows parsed as-is", () => {
    expect(LINUX_ROWS).toHaveLength(8);
    expect(LINUX_ROWS[1]).toEqual({
      pid: 2,
      pgid: 0,
      uid: 0,
      comm: "kthreadd",
    });
    expect(LINUX_ROWS.find((r) => r.pid === 15)?.comm).toBe(
      "kworker/0:1-events",
    );
  });

  it("a comm with spaces is joined back", () => {
    expect(parsePsOutput("12 12 450 /Applications/My App/bin/x")).toEqual([
      { pid: 12, pgid: 12, uid: 450, comm: "/Applications/My App/bin/x" },
    ]);
  });
});

describe("selectAgentRows (AC2, AC5)", () => {
  it("darwin fixture, uid 450, selfPid 70001: 3 targets in 2 groups, 5 helpers", () => {
    const { targets, helpers } = selectAgentRows(DARWIN_ROWS, 450, 70001);
    expect(targets.map((r) => r.pid).sort()).toEqual([66912, 66916, 68883]);
    expect(new Set(targets.map((r) => r.pgid)).size).toBe(2);
    expect(helpers).toHaveLength(5);
    expect(helpers.map((r) => path.basename(r.comm)).sort()).toEqual(
      [...MACOS_PER_USER_HELPERS].sort(),
    );
  });

  it("linux fixture, uid 999, selfPid 5000: 3 targets in 2 groups, pgid-0 row excluded", () => {
    const { targets, helpers } = selectAgentRows(LINUX_ROWS, 999, 5000);
    expect(targets.map((r) => r.pid).sort()).toEqual([4242, 4300, 4301]);
    expect(new Set(targets.map((r) => r.pgid)).size).toBe(2);
    expect(targets.some((r) => r.pid === 77)).toBe(false);
    expect(helpers).toHaveLength(0);
  });

  it("excludes other uids, selfPid, pid 1 and pgid <= 0", () => {
    const rows: ProcRow[] = [
      { pid: 1, pgid: 1, uid: 450, comm: "launchd-as-agent" },
      { pid: 10, pgid: 10, uid: 450, comm: "self" },
      { pid: 11, pgid: 0, uid: 450, comm: "kthread" },
      { pid: 12, pgid: -1, uid: 450, comm: "weird" },
      { pid: 13, pgid: 13, uid: 501, comm: "operator" },
      { pid: 14, pgid: 14, uid: 450, comm: "escapee" },
    ];
    const { targets, helpers } = selectAgentRows(rows, 450, 10);
    expect(targets.map((r) => r.pid)).toEqual([14]);
    expect(helpers).toEqual([]);
  });
});

describe("reapAgentUidEscapees", () => {
  it("AC1: empty agentUser skips without listing; logs 'disabled' only at boot", async () => {
    const listProcesses = vi.fn(async () => DARWIN_ROWS);
    const spawnKill = vi.fn(async () => {});
    for (const phase of ["boot", "admission", "teardown"] as const) {
      const lines: string[] = [];
      const result = await reapAgentUidEscapees({
        agentUser: "",
        phase,
        log: (l) => lines.push(l),
        listProcesses,
        resolveUid: resolve450,
        spawnKill,
      });
      expect(result).toEqual({
        skipped: true,
        scanned: 0,
        groups: 0,
        helpers: 0,
        killed: 0,
        residual: 0,
        failed: 0,
        durationMs: 0,
      });
      if (phase === "boot") {
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("disabled");
      } else {
        expect(lines).toEqual([]);
      }
    }
    expect(listProcesses).not.toHaveBeenCalled();
    expect(spawnKill).not.toHaveBeenCalled();
  });

  it("AC3: one uid-wide kill with the exact sudo argv; counts from the darwin fixture", async () => {
    const lines: string[] = [];
    const spawnKill = vi.fn(async (_inv: Invocation) => {});
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      threadId: "t-1",
      log: (l) => lines.push(l),
      listProcesses: scriptedList(DARWIN_ROWS, []),
      resolveUid: resolve450,
      spawnKill,
      selfPid: 70001,
    });
    expect(spawnKill).toHaveBeenCalledTimes(1);
    const inv = spawnKill.mock.calls[0]?.[0];
    expect(inv?.file).toBe("/usr/bin/sudo");
    expect(inv?.args).toEqual(EXPECTED_KILL_ARGV);
    expect(inv?.env).toEqual({});
    expect(result).toMatchObject({
      skipped: false,
      scanned: 3,
      groups: 2,
      helpers: 5,
      killed: 3,
      residual: 0,
      failed: 0,
    });
  });

  it("AC3: linux fixture — setsid'd pgid==pid escapees count as their own groups", async () => {
    const spawnKill = vi.fn(async () => {});
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "boot",
      log: () => {},
      listProcesses: scriptedList(LINUX_ROWS, []),
      resolveUid: vi.fn(async () => 999),
      spawnKill,
      selfPid: 5000,
    });
    expect(result).toMatchObject({
      scanned: 3,
      groups: 2,
      helpers: 0,
      killed: 3,
    });
  });

  it("AC6: box.escapees_reaped is JSON after the first space with every key", async () => {
    const lines: string[] = [];
    await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "teardown",
      threadId: "t-6",
      log: (l) => lines.push(l),
      listProcesses: scriptedList(DARWIN_ROWS, []),
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      selfPid: 70001,
      settleMs: 0,
    });
    const reaped = eventLines(lines, "box.escapees_reaped");
    expect(reaped).toHaveLength(1);
    const payload = payloadOf(reaped[0] ?? "");
    expect(Object.keys(payload).sort()).toEqual(
      [
        "phase",
        "threadId",
        "uid",
        "scanned",
        "groups",
        "helpers",
        "killed",
        "residual",
        "failed",
        "durationMs",
      ].sort(),
    );
    expect(payload).toMatchObject({
      phase: "teardown",
      threadId: "t-6",
      uid: 450,
      scanned: 3,
      groups: 2,
      helpers: 5,
      killed: 3,
      residual: 0,
      failed: 0,
    });
    expect(typeof payload.durationMs).toBe("number");
    expect(eventLines(lines, "box.escapees_residual")).toEqual([]);
  });

  it("AC6: a zero-target scan still logs scanned 0 and issues no kill", async () => {
    const lines: string[] = [];
    const spawnKill = vi.fn(async () => {});
    const helpersOnly = DARWIN_ROWS.filter(
      (r) => r.uid !== 450 || MACOS_PER_USER_HELPERS.has(path.basename(r.comm)),
    );
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: (l) => lines.push(l),
      listProcesses: scriptedList(helpersOnly),
      resolveUid: resolve450,
      spawnKill,
      selfPid: 70001,
    });
    expect(spawnKill).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scanned: 0,
      groups: 0,
      helpers: 5,
      killed: 0,
    });
    const payload = payloadOf(
      eventLines(lines, "box.escapees_reaped")[0] ?? "",
    );
    expect(payload).toMatchObject({ scanned: 0, helpers: 5, threadId: null });
  });

  it("AC7: listProcesses rejection ⇒ error result, no kill, box.escapees_scan_failed", async () => {
    const lines: string[] = [];
    const spawnKill = vi.fn(async () => {});
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: (l) => lines.push(l),
      listProcesses: vi.fn(async () => {
        throw new Error("ps exploded");
      }),
      resolveUid: resolve450,
      spawnKill,
    });
    expect(result).toMatchObject({
      skipped: false,
      scanned: 0,
      killed: 0,
      error: "ps exploded",
    });
    expect(spawnKill).not.toHaveBeenCalled();
    const failed = eventLines(lines, "box.escapees_scan_failed");
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0] ?? "")).toMatchObject({ error: "ps exploded" });
    expect(eventLines(lines, "box.escapees_reaped")).toEqual([]);
  });

  it("AC7: resolveUid rejection is a scan failure too", async () => {
    const listProcesses = vi.fn(async () => DARWIN_ROWS);
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "boot",
      log: () => {},
      listProcesses,
      resolveUid: vi.fn(async () => {
        throw new Error("no such user");
      }),
      spawnKill: vi.fn(async () => {}),
    });
    expect(result.error).toBe("no such user");
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("AC7: spawnKill throws ⇒ failed 1, result returned, killed = scanned − residual", async () => {
    const lines: string[] = [];
    const oneLeft = DARWIN_ROWS.filter(
      (r) => r.pid !== 66912 && r.pid !== 66916,
    );
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: (l) => lines.push(l),
      listProcesses: scriptedList(DARWIN_ROWS, oneLeft),
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {
        throw new Error("spawn sudo ENOENT");
      }),
      selfPid: 70001,
      residualBoundMs: 150,
    });
    expect(result).toMatchObject({
      scanned: 3,
      residual: 1,
      killed: 2,
      failed: 1,
    });
    expect(result.error).toBeUndefined();
    expect(
      payloadOf(eventLines(lines, "box.escapees_reaped")[0] ?? ""),
    ).toMatchObject({
      failed: 1,
      killed: 2,
    });
  });

  it("AC7: residual poll re-scans every 100 ms until the set is empty", async () => {
    const listProcesses = scriptedList(DARWIN_ROWS, DARWIN_ROWS, []);
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: () => {},
      listProcesses,
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      selfPid: 70001,
    });
    expect(listProcesses.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result).toMatchObject({ residual: 0, killed: 3 });
  });

  it("AC7: residual bound ⇒ residual === scanned, killed 0, box.escapees_residual with a sample ≤ 5", async () => {
    const lines: string[] = [];
    const manyEscapees: ProcRow[] = [
      ...DARWIN_ROWS,
      { pid: 80001, pgid: 80001, uid: 450, comm: "/usr/bin/python3" },
      { pid: 80002, pgid: 80001, uid: 450, comm: "/opt/x/trustd" },
      { pid: 80003, pgid: 80003, uid: 450, comm: "tccd" },
      { pid: 80004, pgid: 80003, uid: 450, comm: "cfprefsd" },
    ];
    const listProcesses = vi.fn(async () => manyEscapees);
    const started = Date.now();
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "teardown",
      threadId: "t-7",
      log: (l) => lines.push(l),
      listProcesses,
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      selfPid: 70001,
      settleMs: 0,
      residualBoundMs: 300,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(result.scanned).toBe(7);
    expect(result.residual).toBe(7);
    expect(result.killed).toBe(0);
    expect(listProcesses.mock.calls.length).toBeGreaterThanOrEqual(3);
    const residual = eventLines(lines, "box.escapees_residual");
    expect(residual).toHaveLength(1);
    const payload = payloadOf(residual[0] ?? "");
    expect(payload).toMatchObject({
      phase: "teardown",
      threadId: "t-7",
      uid: 450,
      residual: 7,
    });
    const sample = payload.sample as string[];
    expect(sample.length).toBeLessThanOrEqual(5);
    expect(sample).toEqual(["bash", "claude", "node", "python3", "trustd"]);
  }, 5000);

  it("AC7: helpers are excluded symmetrically — a respawned helper never inflates residual", async () => {
    const respawned: ProcRow[] = [
      { pid: 99001, pgid: 99001, uid: 450, comm: "/usr/sbin/distnoted" },
      {
        pid: 99002,
        pgid: 99002,
        uid: 450,
        comm: "/System/Library/Frameworks/Contacts.framework/Support/contactsd",
      },
    ];
    const listProcesses = scriptedList(DARWIN_ROWS, respawned);
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: () => {},
      listProcesses,
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      selfPid: 70001,
      residualBoundMs: 300,
    });
    expect(result).toMatchObject({
      scanned: 3,
      helpers: 5,
      residual: 0,
      killed: 3,
    });
    // The residual set was empty on the first re-scan: no poll beyond it.
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });

  it("AC8: the real `ps` lists this process with a numeric pgid; counting only, injected kill", async () => {
    const rows = await listProcessesViaPs();
    const self = rows.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
    expect(Number.isInteger(self?.pgid)).toBe(true);
    expect(self?.pgid).toBeGreaterThan(0);
    expect(self?.uid).toBe(process.getuid?.() ?? -1);

    const spawnKill = vi.fn(async (_inv: Invocation) => {});
    const lines: string[] = [];
    const result = await reapAgentUidEscapees({
      agentUser: "it-does-not-exist",
      phase: "admission",
      log: (l) => lines.push(l),
      // default listProcesses: the real ps
      resolveUid: vi.fn(async () => process.getuid?.() ?? -1),
      spawnKill,
      residualBoundMs: 200,
    });
    expect(result.error).toBeUndefined();
    expect(result.failed).toBe(0);
    // Our own uid has other processes (the vitest parent at least), so the
    // kill path is exercised — through the injected fn, never sudo.
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(spawnKill).toHaveBeenCalledTimes(1);
    expect(spawnKill.mock.calls[0]?.[0]?.args).toEqual([
      "-n",
      "-u",
      "it-does-not-exist",
      "--",
      "/bin/kill",
      "-9",
      "--",
      "-1",
    ]);
    expect(eventLines(lines, "box.escapees_reaped")).toHaveLength(1);
  }, 10_000);

  it("AC10: box-budget.json has the contract shape and escapeesSinceBoot accumulates", async () => {
    const root = await tmpRoot();
    const common = {
      agentUser: AGENT,
      log: () => {},
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      selfPid: 70001,
      runNamespaceRoot: root,
    };
    await reapAgentUidEscapees({
      ...common,
      phase: "boot",
      listProcesses: scriptedList(DARWIN_ROWS, []),
    });
    const first = JSON.parse(
      await readFile(path.join(root, BOX_BUDGET_FILENAME), "utf8"),
    ) as BoxBudgetSnapshot;
    expect(Object.keys(first).sort()).toEqual(
      [
        "ts",
        "phase",
        "scanned",
        "killed",
        "residual",
        "failed",
        "escapeesSinceBoot",
      ].sort(),
    );
    expect(first).toMatchObject({
      phase: "boot",
      scanned: 3,
      killed: 3,
      residual: 0,
      failed: 0,
      escapeesSinceBoot: 3,
    });
    expect(Number.isNaN(Date.parse(first.ts))).toBe(false);

    await reapAgentUidEscapees({
      ...common,
      phase: "teardown",
      threadId: "t-10",
      settleMs: 0,
      listProcesses: scriptedList(
        LINUX_ROWS.map((r) => ({ ...r, uid: r.uid === 999 ? 450 : r.uid })),
        [],
      ),
    });
    const second = JSON.parse(
      await readFile(path.join(root, BOX_BUDGET_FILENAME), "utf8"),
    ) as BoxBudgetSnapshot;
    expect(second).toMatchObject({
      phase: "teardown",
      threadId: "t-10",
      scanned: 3,
      killed: 3,
      escapeesSinceBoot: 6,
    });
  });

  it("AC10: a zero-target scan still refreshes the snapshot", async () => {
    const root = await tmpRoot();
    await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: () => {},
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      listProcesses: scriptedList([]),
      runNamespaceRoot: root,
    });
    const snap = JSON.parse(
      await readFile(path.join(root, BOX_BUDGET_FILENAME), "utf8"),
    ) as BoxBudgetSnapshot;
    expect(snap).toMatchObject({
      phase: "admission",
      scanned: 0,
      killed: 0,
      escapeesSinceBoot: 0,
    });
  });

  it("AC10: a snapshot write failure is swallowed and logged as box.budget_write_failed", async () => {
    const dir = await tmpRoot();
    const notADir = path.join(dir, "file-not-dir");
    await writeFile(notADir, "x");
    const lines: string[] = [];
    const result = await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: (l) => lines.push(l),
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      listProcesses: scriptedList(DARWIN_ROWS, []),
      selfPid: 70001,
      runNamespaceRoot: notADir,
    });
    expect(result).toMatchObject({ scanned: 3, killed: 3, failed: 0 });
    expect(result.error).toBeUndefined();
    const failed = eventLines(lines, "box.budget_write_failed");
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0] ?? "")).toMatchObject({
      phase: "admission",
      root: notADir,
    });
    expect(typeof payloadOf(failed[0] ?? "").error).toBe("string");
  });

  it("no snapshot is written without runNamespaceRoot", async () => {
    const root = await tmpRoot();
    await reapAgentUidEscapees({
      agentUser: AGENT,
      phase: "admission",
      log: () => {},
      resolveUid: resolve450,
      spawnKill: vi.fn(async () => {}),
      listProcesses: scriptedList(DARWIN_ROWS, []),
      selfPid: 70001,
    });
    await expect(
      readFile(path.join(root, BOX_BUDGET_FILENAME)),
    ).rejects.toThrow();
  });
});

describe("bootUidScan (AC14, unit level)", () => {
  const zero = {
    skipped: false,
    scanned: 0,
    groups: 0,
    helpers: 0,
    killed: 0,
    residual: 0,
    failed: 0,
    durationMs: 1,
  };

  it("empty agentUser ⇒ disabled; the lock is never tried", async () => {
    const tryAcquire = vi.fn(async () => null);
    const reap = vi.fn(async () => zero);
    const lines: string[] = [];
    const out = await bootUidScan({
      root: "/nonexistent/never-used",
      agentUser: "",
      log: (l) => lines.push(l),
      tryAcquire,
      reap,
    });
    expect(out).toEqual({ outcome: "disabled" });
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(reap).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("disabled");
  });

  it("lock busy ⇒ skipped-busy; reap not called", async () => {
    const tryAcquire = vi.fn<TryAcquireFn>(async () => null);
    const reap = vi.fn(async () => zero);
    const lines: string[] = [];
    const out = await bootUidScan({
      root: "/nonexistent/never-used",
      agentUser: AGENT,
      log: (l) => lines.push(l),
      tryAcquire,
      reap,
    });
    expect(out).toEqual({ outcome: "skipped-busy" });
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(tryAcquire.mock.calls[0]?.[0]).toMatchObject({
      root: "/nonexistent/never-used",
      holder: expect.stringContaining("boot"),
    });
    expect(reap).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes("boot uid scan skipped"))).toBe(true);
  });

  it("lock free ⇒ reap with phase boot under the lock, then release (order asserted)", async () => {
    const order: string[] = [];
    const lock: BoxLock = {
      release: vi.fn(async () => {
        order.push("release");
      }),
    };
    const tryAcquire = vi.fn<TryAcquireFn>(async () => lock);
    const reap = vi.fn<ReapFn>(async () => {
      order.push("reap");
      return { ...zero, scanned: 2, killed: 2 };
    });
    const out = await bootUidScan({
      root: "/root/x",
      agentUser: AGENT,
      log: () => {},
      tryAcquire,
      reap,
    });
    expect(out.outcome).toBe("scanned");
    expect(out.result).toMatchObject({ scanned: 2, killed: 2 });
    expect(order).toEqual(["reap", "release"]);
    expect(reap.mock.calls[0]?.[0]).toMatchObject({
      agentUser: AGENT,
      phase: "boot",
      runNamespaceRoot: "/root/x",
    });
    // No process.env read anywhere: the agentUser is the one we passed.
    expect(reap.mock.calls[0]?.[0]?.agentUser).toBe(AGENT);
  });

  it("the lock is released even when reap rejects (defensive; reap never throws by contract)", async () => {
    const release = vi.fn(async () => {});
    const tryAcquire = vi.fn(async () => ({ release }) as BoxLock);
    const reap = vi.fn(async () => {
      throw new Error("contract broken");
    });
    await expect(
      bootUidScan({
        root: "/root/x",
        agentUser: AGENT,
        log: () => {},
        tryAcquire,
        reap,
      }),
    ).rejects.toThrow("contract broken");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a reap that reports error ⇒ outcome error, lock still released", async () => {
    const release = vi.fn(async () => {});
    const out = await bootUidScan({
      root: "/root/x",
      agentUser: AGENT,
      log: () => {},
      tryAcquire: vi.fn(async () => ({ release }) as BoxLock),
      reap: vi.fn(async () => ({ ...zero, error: "ps exploded" })),
    });
    expect(out).toMatchObject({ outcome: "error", error: "ps exploded" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("tryAcquire throwing BoxLockUnavailableError ⇒ outcome error, no throw, logged", async () => {
    const reap = vi.fn(async () => zero);
    const lines: string[] = [];
    const out = await bootUidScan({
      root: "/root/x",
      agentUser: AGENT,
      log: (l) => lines.push(l),
      tryAcquire: vi.fn(async () => {
        throw new BoxLockUnavailableError(
          "/usr/bin/lockf",
          "spawn failed: ENOENT",
        );
      }),
      reap,
    });
    expect(out.outcome).toBe("error");
    expect(out.error).toContain("ENOENT");
    expect(reap).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith("boot uid scan failed:"))).toBe(true);
  });
});
