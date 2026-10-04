import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { runAsAgent, type SpawnLike } from "./agent-command";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: NodeJS.Signals | null = null;
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? "SIGTERM";
    // A killed child closes with a null exit code.
    setImmediate(() => this.emit("close", null, this.killed));
    return true;
  }
}

function fakeSpawn(child: FakeChild) {
  const spawn = vi.fn(() => child);
  return spawn as unknown as SpawnLike & typeof spawn;
}

const BASE = {
  cwd: "/run/wd",
  script: 'cat -- "$1"',
  env: { PATH: "/usr/bin" },
  timeoutMs: 1000,
};

describe("runAsAgent", () => {
  it("builds the exact sudo argv for a named agent user", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const p = runAsAgent({
      ...BASE,
      agentUser: "automata-agent",
      args: ["a.txt"],
      spawn,
    });
    child.stdout.emit("data", Buffer.from("hi"));
    child.emit("close", 0, null);
    const result = await p;
    const calls = spawn.mock.calls as unknown as Array<
      [string, string[], { cwd: string }]
    >;
    expect(calls[0]![0]).toBe("/usr/bin/sudo");
    expect(calls[0]![1]).toEqual([
      "-n",
      "-u",
      "automata-agent",
      "-E",
      "--",
      "/bin/sh",
      "-c",
      'cat -- "$1"',
      "sh",
      "a.txt",
    ]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "hi",
      timedOut: false,
      truncated: false,
    });
  });

  it("runs /bin/sh directly when the agent user is empty (dev)", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const p = runAsAgent({ ...BASE, agentUser: "", args: ["x"], spawn });
    child.emit("close", 1, null);
    await p;
    const calls = spawn.mock.calls as unknown as Array<[string, string[]]>;
    expect(calls[0]![0]).toBe("/bin/sh");
    expect(calls[0]![1]).toEqual(["-c", 'cat -- "$1"', "sh", "x"]);
  });

  it("keeps a hostile subject as one positional argument", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const p = runAsAgent({
      ...BASE,
      agentUser: "automata-agent",
      args: ["; rm -rf /"],
      spawn,
    });
    child.emit("close", 0, null);
    await p;
    const calls = spawn.mock.calls as unknown as Array<[string, string[]]>;
    const argv = calls[0]![1];
    expect(argv.slice(-1)).toEqual(["; rm -rf /"]);
    expect(argv[7]).toBe('cat -- "$1"');
  });

  it("kills on timeout and reports timedOut with a null exit code", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const result = await runAsAgent({
      ...BASE,
      agentUser: "",
      args: [],
      timeoutMs: 5,
      spawn,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(child.killed).toBe("SIGKILL");
  });

  it("truncates stdout beyond maxStdoutBytes", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const p = runAsAgent({
      ...BASE,
      agentUser: "",
      args: [],
      maxStdoutBytes: 4,
      spawn,
    });
    child.stdout.emit("data", Buffer.from("abcdefgh"));
    child.emit("close", 0, null);
    const result = await p;
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("abcd");
  });

  it("throws on an invalid agent user before spawning", async () => {
    const spawn = fakeSpawn(new FakeChild());
    await expect(
      runAsAgent({ ...BASE, agentUser: "-bad", args: [], spawn }),
    ).rejects.toThrow(/plain unix login name/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills the child when the signal aborts", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const ac = new AbortController();
    const p = runAsAgent({
      ...BASE,
      agentUser: "",
      args: [],
      signal: ac.signal,
      spawn,
    });
    ac.abort();
    const result = await p;
    expect(child.killed).toBe("SIGKILL");
    expect(result.exitCode).toBeNull();
  });

  it("resolves with a null exit code when spawn emits an error", async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const p = runAsAgent({ ...BASE, agentUser: "", args: [], spawn });
    child.emit("error", new Error("ENOENT"));
    const result = await p;
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});
