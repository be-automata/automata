import { describe, expect, it } from "vitest";
import {
  assertAgentUser,
  buildKillInvocation,
  buildSpawnInvocation,
  KILL_BIN,
  PGID_WRAPPER_SCRIPT,
  SH_BIN,
  SUDO_BIN,
} from "./spawn-as-user";

const DAEMON_ARGS = [
  "/usr/local/automata/daemon/index.js",
  "--url",
  "https://www.example.com",
  "--socket-path",
  "/tmp/automata-agent-run/w-1/thr_1.sock",
];

describe("default-off contract", () => {
  it("returns the spawn command completely unchanged when agentUser is empty", () => {
    expect(
      buildSpawnInvocation({
        agentUser: "",
        file: "/usr/bin/node",
        args: DAEMON_ARGS,
        pidFilePath: "/tmp/x.pid",
      }),
    ).toEqual({ file: "/usr/bin/node", args: DAEMON_ARGS, env: {} });
  });

  it("returns null for the kill path when agentUser is empty", () => {
    expect(buildKillInvocation({ agentUser: "", pgid: 5 })).toBeNull();
  });
});

describe("buildSpawnInvocation in agent-uid mode", () => {
  const inv = buildSpawnInvocation({
    agentUser: "_automata-agent",
    file: "/usr/local/automata/bin/node",
    args: DAEMON_ARGS,
    pidFilePath: "/usr/local/automata/runs/w-1/thr_1.pid",
  });

  it("wraps in sudo -n -u <user> -E -- with the wrapper shell after the --", () => {
    expect(inv.file).toBe(SUDO_BIN);
    expect(inv.args.slice(0, 7)).toEqual([
      "-n",
      "-u",
      "_automata-agent",
      "-E",
      "--",
      SH_BIN,
      "-c",
    ]);
  });

  it("passes the daemon flags as POSITIONAL args, never interpolated into the script", () => {
    expect(inv.args[7]).toBe(PGID_WRAPPER_SCRIPT);
    // args[8] is $0; the daemon argv follows verbatim.
    expect(inv.args.slice(9)).toEqual(DAEMON_ARGS);
    for (const arg of DAEMON_ARGS) {
      expect(PGID_WRAPPER_SCRIPT).not.toContain(arg);
    }
  });

  it("hands the pidfile and node path in through the environment, not the script", () => {
    expect(inv.env).toEqual({
      AUTOMATA_PIDFILE: "/usr/local/automata/runs/w-1/thr_1.pid",
      AUTOMATA_NODE: "/usr/local/automata/bin/node",
    });
    expect(PGID_WRAPPER_SCRIPT).not.toContain("/usr/local/automata/bin/node");
    expect(PGID_WRAPPER_SCRIPT).not.toContain("thr_1.pid");
  });

  it("makes the wrapper record its OWN pgid before exec (sudo may fork a monitor)", () => {
    // `$$` survives the exec and is the group leader under BOTH sudo shapes;
    // a pre-sudo child.pid reaches neither when use_pty is on.
    expect(PGID_WRAPPER_SCRIPT).toContain('printf %s "$$"');
  });

  it("aborts BEFORE exec when the pidfile write fails (no unreapable orphan)", () => {
    // The whole pgid mechanism rests on this: if printf falls through to exec
    // on failure, a live agent runs under the agent uid with its process group
    // recorded NOWHERE — teardown signals sudo's group instead and boot-reclaim
    // has no pidfile to find. The `||` must sit between the write and the exec.
    const [write, rest] = PGID_WRAPPER_SCRIPT.split(";");
    expect(write).toContain("|| exit 97");
    expect(rest).toContain("exec ");
    expect(PGID_WRAPPER_SCRIPT.indexOf("|| exit 97")).toBeLessThan(
      PGID_WRAPPER_SCRIPT.indexOf("exec "),
    );
    expect(PGID_WRAPPER_SCRIPT).toContain("exec ");
  });
});

describe("buildKillInvocation in agent-uid mode", () => {
  const inv = buildKillInvocation({ agentUser: "_automata-agent", pgid: 4242 });

  it("runs /bin/kill AS the agent account so kill(2) bounds it to that uid", () => {
    expect(inv).not.toBeNull();
    expect(inv?.file).toBe(SUDO_BIN);
    expect(inv?.args).toEqual([
      "-n",
      "-u",
      "_automata-agent",
      "--",
      KILL_BIN,
      "-9",
      "--",
      "-4242",
    ]);
  });

  it("never passes -E on the kill path (no environment, so no SETENV grant)", () => {
    expect(inv?.args).not.toContain("-E");
  });

  it("builds a NEGATIVE pgid, guarded by -- so kill does not read it as a flag", () => {
    const args = inv?.args ?? [];
    expect(args[args.length - 1]).toBe("-4242");
    expect(args[args.length - 2]).toBe("--");
  });

  it("rejects a non-positive pgid rather than signalling every process", () => {
    expect(() =>
      buildKillInvocation({ agentUser: "_automata-agent", pgid: 0 }),
    ).toThrow(/positive integer/);
    expect(() =>
      buildKillInvocation({ agentUser: "_automata-agent", pgid: -1 }),
    ).toThrow(/positive integer/);
  });
});

describe("assertAgentUser", () => {
  it("accepts a plain role-account login", () => {
    expect(() => assertAgentUser("_automata-agent")).not.toThrow();
    expect(() => assertAgentUser("agent1")).not.toThrow();
  });

  it("rejects a login name starting with a dash (sudo would read it as a flag)", () => {
    expect(() => assertAgentUser("-u")).toThrow(/WORKER_AGENT_USER/);
  });

  it("rejects whitespace, semicolons, slashes and uppercase", () => {
    for (const bad of ["a b", "a;b", "/usr/bin/x", "Agent", "", "a".repeat(40)]) {
      expect(() => assertAgentUser(bad), bad).toThrow(/WORKER_AGENT_USER/);
    }
  });

  it("is enforced by both builders, not only by the config loader", () => {
    expect(() =>
      buildSpawnInvocation({
        agentUser: "-u",
        file: "/n",
        args: [],
        pidFilePath: "/p",
      }),
    ).toThrow(/WORKER_AGENT_USER/);
    expect(() => buildKillInvocation({ agentUser: "root;rm", pgid: 1 })).toThrow(
      /WORKER_AGENT_USER/,
    );
  });
});
