import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessCgroupSupport,
  createRunCgroup,
  killAndRemoveRunCgroup,
  moveIntoCgroup,
  parseCgroupPath,
  parseControllers,
  prepareDelegatedRoot,
  readOomKillCount,
  REQUIRED_CONTROLLERS,
  runCgroupPath,
  SUPERVISOR_CGROUP,
  type CgroupFs,
} from "./run-cgroup";

/**
 * #204: the per-run memory ceiling.
 *
 * Every mutation here was proven against the real kernel on the Linux box
 * before it was written; these tests fence the SHAPE so a later edit cannot
 * quietly lose a step whose absence only shows up as EBUSY on a live box, or —
 * worse — as a ceiling that silently is not applied.
 */

/** Recording fake for the whole filesystem surface. */
function fakeFs(seed: Record<string, string> = {}) {
  const files: Record<string, string> = { ...seed };
  const dirs: string[] = [];
  const writes: [string, string][] = [];

  const removed: string[] = [];
  const fsi: CgroupFs = {
    mkdir: (d) => void dirs.push(d),
    write: (f, v) => {
      writes.push([f, v]);
      files[f] = v;
    },
    read: (f) => {
      const v = files[f];
      if (v === undefined) throw new Error(`ENOENT ${f}`);
      return v;
    },
    rmdir: (d) => void removed.push(d),
  };
  return { fsi, files, dirs, writes, removed };
}

describe("parseCgroupPath", () => {
  it("takes the v2 line, which is the one with no controller", () => {
    // A hybrid host lists v1 controllers too; only `0::` is the unified path.
    expect(
      parseCgroupPath(
        "12:pids:/system.slice/x\n1:name=systemd:/system.slice/x\n0::/system.slice/automata-worker.service\n",
      ),
    ).toBe("/system.slice/automata-worker.service");
  });

  it("returns null on a v1-only host — a supported off state, not an error", () => {
    expect(parseCgroupPath("12:pids:/system.slice/x\n")).toBeNull();
    expect(parseCgroupPath("")).toBeNull();
  });

  it("rejects a non-absolute path rather than joining it blindly", () => {
    // A relative value would path.join into somewhere unintended.
    expect(parseCgroupPath("0::relative/path")).toBeNull();
  });
});

describe("parseControllers", () => {
  it("splits on whitespace and tolerates an empty file", () => {
    expect(parseControllers(" memory  pids \n")).toEqual(["memory", "pids"]);
    expect(parseControllers("\n")).toEqual([]);
    expect(parseControllers("")).toEqual([]);
  });
});

describe("assessCgroupSupport", () => {
  const procV2 = "0::/system.slice/automata-worker.service\n";

  it("is off, with a reason, on a non-Linux platform", () => {
    const r = assessCgroupSupport({
      platform: "darwin",
      procSelfCgroup: procV2,
    });
    expect(r.supported).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining("darwin") });
  });

  it("names Delegate= when subtree_control is not writable", () => {
    // This is the misconfiguration an operator will actually make, so the
    // message has to say what to fix rather than just refusing.
    const r = assessCgroupSupport({
      platform: "linux",
      procSelfCgroup: procV2,
      access: () => false,
      readFile: () => "memory pids",
    });
    expect(r.supported).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining("Delegate=") });
  });

  it("names the missing controller when Delegate= is too narrow", () => {
    const r = assessCgroupSupport({
      platform: "linux",
      procSelfCgroup: procV2,
      access: () => true,
      readFile: () => "pids",
    });
    expect(r.supported).toBe(false);
    expect(r).toMatchObject({ reason: expect.stringContaining("memory") });
  });

  it("is supported when both controllers are delegated, and reports the root", () => {
    const r = assessCgroupSupport({
      platform: "linux",
      procSelfCgroup: procV2,
      mountPoint: "/sys/fs/cgroup",
      access: () => true,
      readFile: () => "cpuset cpu io memory hugetlb pids rdma misc",
    });
    expect(r).toMatchObject({
      supported: true,
      root: "/sys/fs/cgroup/system.slice/automata-worker.service",
    });
  });

  it("requires exactly the controllers the feature uses", () => {
    expect([...REQUIRED_CONTROLLERS]).toEqual(["memory", "pids"]);
  });
});

describe("prepareDelegatedRoot", () => {
  const root = "/sys/fs/cgroup/system.slice/w.service";

  it("vacates EVERY member of the root, not just this process", () => {
    // The no-internal-process rule counts all members, and the worker is not
    // alone: run-worker.sh rebuilds the daemon bundle and esbuild leaves a
    // service process in the cgroup. Moving only process.pid passed a drill and
    // then failed a real deploy with EBUSY — the kernel refusing the enable
    // while a sibling was still in the root.
    const f = fakeFs({
      [`${root}/cgroup.subtree_control`]: "",
      [`${root}/cgroup.procs`]: "111\n222\n",
    });
    prepareDelegatedRoot({ root, pid: 111, fsi: f.fsi });
    const moved = f.writes
      .filter(([file]) => file === `${root}/${SUPERVISOR_CGROUP}/cgroup.procs`)
      .map(([, v]) => v);
    expect(moved).toEqual(["111", "222"]);
  });

  it("still moves itself when the root's member list is unreadable", () => {
    // Moving nothing would guarantee the EBUSY; moving ourselves is strictly
    // better than that.
    const f = fakeFs({ [`${root}/cgroup.subtree_control`]: "" });
    prepareDelegatedRoot({ root, pid: 777, fsi: f.fsi });
    expect(f.writes[0]).toEqual([
      `${root}/${SUPERVISOR_CGROUP}/cgroup.procs`,
      "777",
    ]);
  });

  it("moves the worker into the supervisor leaf BEFORE enabling controllers", () => {
    // Load-bearing ordering, and a kernel rule rather than a preference: cgroup
    // v2 refuses `+memory` on a cgroup that still holds processes, with EBUSY
    // ("Device or resource busy") and nothing naming the cause. Reversing these
    // two writes is the mistake this test exists to catch.
    const f = fakeFs({
      [`${root}/cgroup.subtree_control`]: "",
      [`${root}/cgroup.procs`]: "4242\n",
    });
    prepareDelegatedRoot({ root, pid: 4242, fsi: f.fsi });

    expect(f.dirs).toContain(`${root}/${SUPERVISOR_CGROUP}`);
    const order = f.writes.map(([file]) => file);
    expect(order.indexOf(`${root}/${SUPERVISOR_CGROUP}/cgroup.procs`)).toBe(0);
    expect(order.indexOf(`${root}/cgroup.subtree_control`)).toBe(1);
    expect(f.writes[0]?.[1]).toBe("4242");
    expect(f.writes[1]?.[1]).toBe("+memory +pids");
  });

  it("is idempotent: an already-delegated subtree gets no second enable", () => {
    // A worker restart must not need the box reset.
    const f = fakeFs({
      [`${root}/cgroup.subtree_control`]: "memory pids",
      [`${root}/cgroup.procs`]: "1\n",
    });
    prepareDelegatedRoot({ root, pid: 1, fsi: f.fsi });
    expect(
      f.writes.filter(([file]) => file.endsWith("cgroup.subtree_control")),
    ).toEqual([]);
    // It still (re-)parks itself, which the kernel accepts for a present pid.
    expect(f.writes.map(([file]) => file)).toEqual([
      `${root}/${SUPERVISOR_CGROUP}/cgroup.procs`,
    ]);
  });

  it("enables only what is missing", () => {
    const f = fakeFs({
      [`${root}/cgroup.subtree_control`]: "pids",
      [`${root}/cgroup.procs`]: "1\n",
    });
    prepareDelegatedRoot({ root, pid: 1, fsi: f.fsi });
    expect(f.writes[1]?.[1]).toBe("+memory");
  });
});

describe("createRunCgroup", () => {
  const root = "/sys/fs/cgroup/system.slice/w.service";

  it("sets the ceiling, and pins swap to zero", () => {
    // MemorySwapMax=0 is the ADR-002 §6 decision: swap is the box-wide
    // CommitLimit cushion, not per-run headroom. A run allowed to swap drags
    // the whole box toward the ENOMEM that takes worker, engine and Postgres
    // together — which is the failure this ticket exists to prevent, so a
    // loosened value here would defeat the feature while looking enabled.
    const f = fakeFs();
    const dir = createRunCgroup({
      root,
      threadId: "thr-1",
      memoryMaxBytes: 1_400_000_000,
      tasksMax: 512,
      fsi: f.fsi,
    });
    expect(dir).toBe(`${root}/run-thr-1`);
    expect(f.writes).toEqual([
      [`${dir}/memory.max`, "1400000000"],
      [`${dir}/memory.swap.max`, "0"],
      [`${dir}/pids.max`, "512"],
    ]);
  });

  it("hands NOTHING to the agent — every file stays worker-owned", () => {
    // An earlier shape chowned cgroup.procs to the agent so the wrapper could
    // join itself. That is EPERM (an unprivileged user cannot give a file away)
    // and unnecessary: measured on the box, the WORKER may move an agent-uid
    // process in, while the agent may not move itself in even at 0666. Leaving
    // every file worker-owned is also what stops the agent raising its own
    // ceiling.
    const f = fakeFs();
    createRunCgroup({
      root,
      threadId: "thr-1",
      memoryMaxBytes: 1,
      tasksMax: 1,
      fsi: f.fsi,
    });
    expect(f.writes.map(([file]) => file)).toEqual([
      `${root}/run-thr-1/memory.max`,
      `${root}/run-thr-1/memory.swap.max`,
      `${root}/run-thr-1/pids.max`,
    ]);
  });

  it("sanitises the threadId, because it becomes a path", () => {
    expect(runCgroupPath(root, "../../escape")).toBe(
      `${root}/run-______escape`,
    );
    expect(runCgroupPath(root, "a/b")).toBe(`${root}/run-a_b`);
  });
});

describe("readOomKillCount", () => {
  it("reads the counter, which is what distinguishes an OOM from our own kill", () => {
    // Every SIGKILL exits 137, including teardown's. Without this counter a
    // superseded run would be reported as `resource-limit` — a wrong cause,
    // which is the class of report this ticket removes.
    const f = fakeFs({
      "/cg/memory.events": "low 0\nhigh 0\nmax 12\noom 1\noom_kill 3\n",
    });
    expect(readOomKillCount({ cgroupDir: "/cg", fsi: f.fsi })).toBe(3);
  });

  it("returns 0 — never a false OOM — when the file is gone", () => {
    const f = fakeFs();
    expect(readOomKillCount({ cgroupDir: "/cg", fsi: f.fsi })).toBe(0);
  });

  it("returns 0 on a malformed counter rather than NaN", () => {
    const f = fakeFs({ "/cg/memory.events": "oom_kill abc\n" });
    expect(readOomKillCount({ cgroupDir: "/cg", fsi: f.fsi })).toBe(0);
  });
});

describe("killAndRemoveRunCgroup", () => {
  it("kills via cgroup.kill BEFORE rmdir, which fails while members remain", () => {
    const f = fakeFs();
    killAndRemoveRunCgroup({ cgroupDir: "/cg/run-1", fsi: f.fsi });
    expect(f.writes).toEqual([["/cg/run-1/cgroup.kill", "1"]]);
    expect(f.removed).toEqual(["/cg/run-1"]);
  });

  it("retries the rmdir, because cgroup.kill only QUEUES the signals", () => {
    // Observed on the first production run: the kill worked and the rmdir lost
    // the race with the kernel reaping, so the directory stayed behind and every
    // run leaked one. Retrying turns a guaranteed leak into a rare one.
    let attempts = 0;
    const slept: number[] = [];
    const flaky: CgroupFs = {
      mkdir: () => {},
      write: () => {},
      read: () => "",
      rmdir: () => {
        attempts += 1;
        if (attempts < 3) throw new Error("EBUSY");
      },
      sleep: (ms) => void slept.push(ms),
    };
    const logs: string[] = [];
    killAndRemoveRunCgroup({
      cgroupDir: "/cg/run-1",
      fsi: flaky,
      log: (m) => logs.push(m),
    });
    expect(attempts).toBe(3);
    expect(slept).toEqual([50, 50]);
    // A retry that eventually succeeds is not worth an alarm.
    expect(logs.filter((l) => l.includes("rmdir failed"))).toEqual([]);
  });

  it("gives up after a bounded number of retries and says so", () => {
    // A process that refuses to die must not hold teardown open.
    const stuck: CgroupFs = {
      mkdir: () => {},
      write: () => {},
      read: () => "",
      rmdir: () => {
        throw new Error("EBUSY");
      },
      sleep: () => {},
    };
    const logs: string[] = [];
    expect(() =>
      killAndRemoveRunCgroup({
        cgroupDir: "/cg/run-1",
        fsi: stuck,
        log: (m) => logs.push(m),
      }),
    ).not.toThrow();
    expect(logs.join("\n")).toMatch(/rmdir failed/);
  });

  it("never throws — a teardown failure must not fail a finished run", () => {
    const logs: string[] = [];
    const throwing: CgroupFs = {
      mkdir: () => {},
      write: () => {
        throw new Error("EACCES");
      },
      read: () => "",
      rmdir: () => {
        throw new Error("EBUSY");
      },
    };
    expect(() =>
      killAndRemoveRunCgroup({
        cgroupDir: "/cg/run-1",
        fsi: throwing,
        log: (m) => logs.push(m),
      }),
    ).not.toThrow();
    // ...but it must SAY so, or residue accumulates invisibly.
    expect(logs.join("\n")).toMatch(/cgroup\.kill failed/);
    expect(logs.join("\n")).toMatch(/rmdir failed/);
  });
});

describe("moveIntoCgroup", () => {
  it("writes the pid into cgroup.procs — the worker's move, not the agent's", () => {
    const f = fakeFs();
    moveIntoCgroup({ cgroupDir: "/cg/run-1", pid: 4242, fsi: f.fsi });
    expect(f.writes).toEqual([["/cg/run-1/cgroup.procs", "4242"]]);
  });

  it("propagates failure rather than running the agent uncapped", () => {
    // A run whose membership did not land would execute with NO ceiling while
    // every log line says one was applied. That silent downgrade is the exact
    // failure this ticket exists to prevent, so this must throw.
    const throwing: CgroupFs = {
      mkdir: () => {},
      write: () => {
        throw new Error("EPERM");
      },
      read: () => "",
      rmdir: () => {},
    };
    expect(() =>
      moveIntoCgroup({ cgroupDir: "/cg/run-1", pid: 1, fsi: throwing }),
    ).toThrow(/EPERM/);
  });
});

/**
 * The classification is only worth anything if something CALLS it. It was built
 * and left unwired once — the on-box drill caught that, reporting "generic
 * failure" for a run the kernel had just OOM-killed.
 */
describe("#204: the dead-daemon path names the ceiling", () => {
  it("daemon-process classifies on signalCode, not only exitCode", () => {
    // A SIGKILLed child reports exitCode null, so a check on exitCode alone
    // never fires — which is exactly how an OOM would go unreported.
    const src = fs.readFileSync(
      path.join(__dirname, "daemon-process.ts"),
      "utf8",
    );
    expect(src).toMatch(/signalCode != null/);
    expect(src).toMatch(/classifyAgentExit\(\{/);
    const call = src.slice(src.indexOf("classifyAgentExit({"));
    expect(call).toMatch(/signal: this\.child\.signalCode/);
    expect(call).toMatch(/oomKills: this\.oomKills\(\)/);
  });
});

describe("assessCgroupSupport — the supervisor leaf is not the root", () => {
  it("climbs out of supervisor/, which is where the worker lives at run time", () => {
    // Read at boot, /proc/self/cgroup reports the delegated root. Read at RUN
    // time it reports `<root>/supervisor`, because prepareDelegatedRoot moved
    // the worker there. Taking the leaf at face value puts every run cgroup
    // under it, where `memory` is not in subtree_control — so `memory.max` does
    // not exist and creation fails EACCES. Production traffic found this on the
    // first real run; the drill had been handed the root explicitly and so
    // never executed this line.
    const r = assessCgroupSupport({
      platform: "linux",
      procSelfCgroup: `0::/system.slice/automata-worker.service/${SUPERVISOR_CGROUP}\n`,
      mountPoint: "/sys/fs/cgroup",
      access: () => true,
      readFile: () => "memory pids",
    });
    expect(r).toMatchObject({
      supported: true,
      root: "/sys/fs/cgroup/system.slice/automata-worker.service",
    });
  });

  it("leaves a non-supervisor path alone (the boot-time read)", () => {
    const r = assessCgroupSupport({
      platform: "linux",
      procSelfCgroup: "0::/system.slice/automata-worker.service\n",
      mountPoint: "/sys/fs/cgroup",
      access: () => true,
      readFile: () => "memory pids",
    });
    expect(r).toMatchObject({
      root: "/sys/fs/cgroup/system.slice/automata-worker.service",
    });
  });
});
