import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INHERITABLE_ACE_RIGHTS, TRAVERSE_ACE_RIGHTS } from "./agent-uid-fs";
import {
  claimRunNamespace,
  ensureRunNamespace,
  workerLockPath,
  workerRunDir,
} from "./run-namespace";

/**
 * #108 F2: the cross-uid ACEs must predate anything created in the dir.
 *
 * macOS applies ACE inheritance at CREATE time, and workflow.ts binds the
 * gh-broker socket in this dir BEFORE DaemonProcess.start() runs — so a grant
 * applied inside start() reached the daemon socket but never the gh socket, and
 * the agent's `gh` could not connect. These tests fence that ordering.
 *
 * What they do NOT fence any more is "boot only". That was the original reading
 * of the same constraint, and it cost a production outage: the grant was applied
 * once, to a /tmp dir that macOS later reaped, and every subsequent run died on
 * an unwritable pidfile. The grant is re-asserted at admission now — still
 * before any broker binds, so the ordering above is untouched.
 */
describe("claimRunNamespace", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  function mkRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claim-ns-"));
    roots.push(root);
    return root;
  }

  it("applies traverse on the root and the inheritable grant on the run dir", async () => {
    const root = mkRoot();
    const calls: string[][] = [];
    await claimRunNamespace({
      root,
      workerId: "w-1",
      agentUser: "_automata-agent",
      workerLogin: "operator",
      exec: async (_f, a) => void calls.push(a),
      platform: "darwin",
    });
    const dir = workerRunDir(root, "w-1");
    expect(calls.map((a) => `${a[1]} @ ${a[2]}`)).toEqual([
      `_automata-agent allow ${TRAVERSE_ACE_RIGHTS} @ ${root}`,
      `_automata-agent allow ${INHERITABLE_ACE_RIGHTS} @ ${dir}`,
      `operator allow ${INHERITABLE_ACE_RIGHTS} @ ${dir}`,
    ]);
  });

  it("applies the ACEs to an EMPTY dir, before the lock file exists", async () => {
    // The whole point: everything created afterwards inherits. If the lock
    // already existed when the grant landed, so would a broker socket.
    const root = mkRoot();
    const seen: boolean[] = [];
    await claimRunNamespace({
      root,
      workerId: "w-2",
      agentUser: "_automata-agent",
      workerLogin: "operator",
      exec: async () => {
        seen.push(fs.existsSync(workerLockPath(root, "w-2")));
      },
      platform: "darwin",
    });
    expect(seen).toEqual([false, false, false]);
    expect(fs.existsSync(workerLockPath(root, "w-2"))).toBe(true);
  });

  it("is a no-op on ACLs when agentUser is empty (default-off contract)", async () => {
    const root = mkRoot();
    const calls: string[][] = [];
    const dir = await claimRunNamespace({
      root,
      workerId: "w-3",
      agentUser: "",
      workerLogin: "operator",
      exec: async (_f, a) => void calls.push(a),
      platform: "darwin",
    });
    expect(calls).toEqual([]);
    expect(dir).toBe(workerRunDir(root, "w-3"));
    expect(fs.readFileSync(workerLockPath(root, "w-3"), "utf8")).toBe(
      String(process.pid),
    );
  });

  it("propagates an ACE failure rather than booting a worker that cannot rendezvous", async () => {
    const root = mkRoot();
    await expect(
      claimRunNamespace({
        root,
        workerId: "w-4",
        agentUser: "_automata-agent",
        workerLogin: "operator",
        exec: async () => {
          throw new Error("chmod: Operation not permitted");
        },
        platform: "darwin",
      }),
    ).rejects.toThrow(/Operation not permitted/);
    expect(fs.existsSync(workerLockPath(root, "w-4"))).toBe(false);
  });
});

/**
 * The reaped-/tmp regression. Production, 2026-09-28: a worker up since Sep 6
 * served a run whose namespace dir was born Sep 28 — macOS's /tmp cleaner had
 * removed it, the run recreated it bare, and the daemon (agent uid) could not
 * write its pidfile:
 *
 *   automata-daemon: /tmp/.../<threadId>.pid: Permission denied
 *
 * The run died ~1s in and surfaced as "Review intent could not be parsed",
 * because the agent produced nothing to parse. Three layers between cause and
 * symptom, and it repeats on every idle box.
 */
describe("ensureRunNamespace — survives the dir being reaped", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  function mkRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-ns-"));
    roots.push(root);
    return root;
  }

  it("recreates a removed dir AND re-applies both grants", async () => {
    const root = mkRoot();
    const calls: string[][] = [];
    const opts = {
      root,
      workerId: "w-1",
      agentUser: "_automata-agent",
      workerLogin: "operator",
      exec: async (_f: string, a: string[]) => void calls.push(a),
      platform: "darwin" as NodeJS.Platform,
    };

    await ensureRunNamespace(opts);
    const dir = workerRunDir(root, "w-1");
    expect(fs.existsSync(dir)).toBe(true);

    // The /tmp cleaner, or a stray rm.
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
    calls.length = 0;

    await ensureRunNamespace(opts);

    // Recreating the dir is not enough on its own: a bare dir is exactly the
    // state that killed the run. The grants must come back with it.
    expect(fs.existsSync(dir)).toBe(true);
    expect(calls.map((a) => `${a[1]} @ ${a[2]}`)).toEqual([
      `_automata-agent allow ${TRAVERSE_ACE_RIGHTS} @ ${root}`,
      `_automata-agent allow ${INHERITABLE_ACE_RIGHTS} @ ${dir}`,
      `operator allow ${INHERITABLE_ACE_RIGHTS} @ ${dir}`,
    ]);
  });

  it("does not write the worker lock — that stays a boot-time claim", () => {
    // A sibling worker reaps orphans under a workerId whose lock pid is dead.
    // If every run rewrote the lock, a run served by a worker that has since
    // died would keep re-staking a dead claim.
    const root = mkRoot();
    return ensureRunNamespace({
      root,
      workerId: "w-1",
      agentUser: "",
      platform: "darwin",
    }).then(() => {
      expect(fs.existsSync(workerLockPath(root, "w-1"))).toBe(false);
    });
  });

  it("touches no ACL when the agent uid is disabled (default-off)", async () => {
    const root = mkRoot();
    const calls: string[][] = [];
    await ensureRunNamespace({
      root,
      workerId: "w-1",
      agentUser: "",
      exec: async (_f, a) => void calls.push(a),
      platform: "darwin",
    });
    expect(calls).toEqual([]);
    expect(fs.existsSync(workerRunDir(root, "w-1"))).toBe(true);
  });
});
