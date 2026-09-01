import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INHERITABLE_ACE_RIGHTS, TRAVERSE_ACE_RIGHTS } from "./agent-uid-fs";
import {
  claimRunNamespace,
  workerLockPath,
  workerRunDir,
} from "./run-namespace";

/**
 * #108 F2: the cross-uid ACEs belong to worker BOOT, not to a run.
 *
 * macOS applies ACE inheritance at CREATE time, and workflow.ts binds the
 * gh-broker socket in this dir BEFORE DaemonProcess.start() runs — so a
 * per-run grant reached the daemon socket but never the gh socket, and the
 * agent's `gh` could not connect. These tests fence the boot ordering.
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
