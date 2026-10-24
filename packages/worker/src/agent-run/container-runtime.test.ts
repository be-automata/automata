import { describe, expect, it, vi } from "vitest";

import { containerRunsBoot } from "./container-boot";
import { parsePinnedImage } from "./container-image";
import {
  ContainerRuntime,
  ContainerRuntimeError,
  removeOrphanContainers,
  type DockerExec,
  type ExecResult,
} from "./container-runtime";

const SOCK = "/run/automata-docker/docker.sock";

function fakeExec(respond: (args: string[]) => Partial<ExecResult>): {
  exec: DockerExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "", ...respond(args) };
    },
  };
}

describe("ContainerRuntime: the CLI against ONE configured socket", () => {
  // card: protects=every invocation targets the configured rootless socket explicitly (-H unix://…), never the ambient DOCKER_HOST/context; fails_when=a call omits -H or names another socket; no_claim=which daemon listens there
  it("prefixes every call with -H unix://<socket>", async () => {
    const { exec, calls } = fakeExec((a) =>
      a.includes("create") ? { stdout: `${"c".repeat(64)}\n` } : {},
    );
    const rt = new ContainerRuntime({ socketPath: SOCK, exec });
    await rt.ping();
    await rt.create(["create", "--name", "x", "img@sha256:0"]);
    await rt.copyIn("c1", "/runs/r/home", "/home/agent");
    await rt.remove("c1");
    for (const c of calls)
      expect(c.slice(0, 2)).toEqual(["-H", `unix://${SOCK}`]);
    expect(calls[2]?.slice(2)).toEqual([
      "cp",
      "-a",
      "/runs/r/home/.",
      "c1:/home/agent",
    ]);
    expect(calls[3]?.slice(2)).toEqual(["rm", "-f", "-v", "c1"]);
  });

  // card: protects=removal is idempotent (an absent container is success) but any other failure throws, so a slot is never released over a container the daemon refused to remove; fails_when=`No such container` throws or a daemon error is swallowed; no_claim=daemon semantics of rm -f
  // card: protects=exec runs `docker exec <id> <argv>` on the configured socket as the container's own user (no --user override) and returns a failure instead of throwing; fails_when=exec targets another socket, adds a user/privilege flag, or throws on a non-zero exit; no_claim=what the command does inside the container
  it("exec: docker exec on the socket, container's own user, result returned", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 1, stderr: "nope" }));
    const rt = new ContainerRuntime({ socketPath: SOCK, exec });
    const r = await rt.exec(
      "c1",
      ["chmod", "-R", "g+rwX", "/workspace"],
      5_000,
    );
    expect(r.code).toBe(1);
    expect(calls[0]).toEqual([
      "-H",
      `unix://${SOCK}`,
      "exec",
      "c1",
      "chmod",
      "-R",
      "g+rwX",
      "/workspace",
    ]);
  });

  // card: protects=#437 Part B in a container: spawnExec's env crosses as bare `-e NAME` (the value rides the CLI's own env, never its argv, which `ps` shows to every account), PATH/HOME cross literally so the CLI keeps its own, and the exec runs in the given workdir as the container's own user; fails_when=a secret value appears in the argv, the CLI runs with the container's HOME, a --user flag appears, or a non-identifier name is accepted; no_claim=docker's own `-e NAME` lookup (box/IT proof)
  it("spawnExec: env by name only, values in the CLI's env, never in its argv", () => {
    const spawned: Array<{
      file: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
      stdio: unknown;
    }> = [];
    const spawnFn = vi.fn((file: string, args: readonly string[], o) => {
      spawned.push({ file, args, env: o.env, stdio: o.stdio });
      return {} as never;
    });
    const rt = new ContainerRuntime({
      socketPath: SOCK,
      dockerBin: "/usr/bin/docker",
      exec: fakeExec(() => ({})).exec,
      spawnFn: spawnFn as never,
    });
    const header = "Authorization: Bearer SECRET_BEARER_1";
    rt.spawnExec("c1", ["/bin/sh", "-c", "exec git add -A", "sh"], {
      workdir: "/workspace",
      env: {
        HOME: "/dev/null",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.http://127.0.0.1:3139/.extraheader",
        GIT_CONFIG_VALUE_0: header,
      },
    });
    const s = spawned[0]!;
    expect(s.file).toBe("/usr/bin/docker");
    expect(s.args).toEqual([
      "-H",
      `unix://${SOCK}`,
      "exec",
      "-w",
      "/workspace",
      "-e",
      "HOME=/dev/null",
      "-e",
      "GIT_CONFIG_COUNT",
      "-e",
      "GIT_CONFIG_KEY_0",
      "-e",
      "GIT_CONFIG_VALUE_0",
      "c1",
      "/bin/sh",
      "-c",
      "exec git add -A",
      "sh",
    ]);
    expect(s.args.join(" ")).not.toContain("SECRET_BEARER_1");
    expect(s.env.GIT_CONFIG_VALUE_0).toBe(header);
    expect(s.env.HOME).toBe(process.env.HOME);
    expect(s.stdio).toEqual(["ignore", "pipe", "ignore"]);
    expect(() =>
      rt.spawnExec("c1", ["true"], {
        workdir: "/workspace",
        env: { "BAD NAME": "x" },
      }),
    ).toThrow(ContainerRuntimeError);
  });

  it("remove: absent is fine, any other failure throws", async () => {
    const absent = new ContainerRuntime({
      socketPath: SOCK,
      exec: fakeExec(() => ({
        code: 1,
        stderr: "Error response from daemon: No such container: x",
      })).exec,
    });
    await expect(absent.remove("x")).resolves.toBe(false);
    const broken = new ContainerRuntime({
      socketPath: SOCK,
      exec: fakeExec(() => ({
        code: 1,
        stderr: "Cannot connect to the Docker daemon",
      })).exec,
    });
    await expect(broken.remove("x")).rejects.toThrow(ContainerRuntimeError);
  });

  // card: protects=create refuses anything that is not a `create` argv and anything that does not print a container id; fails_when=a non-create argv is executed or garbage is taken as an id; no_claim=argv hardening (container-argv.test.ts)
  it("create: only a create argv, and only a real id back", async () => {
    const rt = new ContainerRuntime({
      socketPath: SOCK,
      exec: fakeExec(() => ({ stdout: "WARNING: something\n" })).exec,
    });
    await expect(rt.create(["run", "img"])).rejects.toThrow(/`create` argv/);
    await expect(rt.create(["create", "img"])).rejects.toThrow(
      /no container id/,
    );
  });

  // card: protects=inspect maps .State (OOMKilled, ExitCode, Running) and reports an absent container as null; fails_when=OOMKilled is misread or absence throws; no_claim=when Docker sets OOMKilled (integration suite)
  it("inspectState maps the fields, absent is null", async () => {
    const rt = new ContainerRuntime({
      socketPath: SOCK,
      exec: fakeExec((a) =>
        a.includes("gone")
          ? { code: 1, stderr: "Error: No such object: gone" }
          : {
              stdout: JSON.stringify({
                Status: "exited",
                Running: false,
                ExitCode: 137,
                OOMKilled: true,
              }),
            },
      ).exec,
    });
    await expect(rt.inspectState("c1")).resolves.toEqual({
      status: "exited",
      running: false,
      exitCode: 137,
      oomKilled: true,
    });
    await expect(rt.inspectState("gone")).resolves.toBeNull();
  });

  // card: protects=copyOut reports an absent source as false (the image may lack settings.batteries.json) and any other failure throws; fails_when=absence throws or a daemon error reads as absence; no_claim=nothing
  it("copyOut: absent source is false", async () => {
    const rt = new ContainerRuntime({
      socketPath: SOCK,
      exec: fakeExec(() => ({
        code: 1,
        stderr: "Error: Could not find the file /x in container c",
      })).exec,
    });
    await expect(rt.copyOut("c", "/x", "/tmp/o")).resolves.toBe(false);
  });
});

describe("removeOrphanContainers (boot, ADR-013 Run path 7)", () => {
  const listed = [
    {
      id: "a",
      name: "automata-run-w-1-0",
      workerId: "w-1",
      workerPid: 111,
      runId: "t1",
    },
    {
      id: "b",
      name: "automata-run-w-2-0",
      workerId: "w-2",
      workerPid: 222,
      runId: "t2",
    },
    {
      id: "c",
      name: "automata-run-w-3-1",
      workerId: "w-3",
      workerPid: null,
      runId: "t3",
    },
  ];

  // card: protects=a dead worker's containers (pid gone or unlabelled) are removed and a LIVE sibling worker's are kept; fails_when=a live sibling's run is killed or a dead worker's survives; no_claim=pid reuse across boots beyond the worker-id check
  it("removes dead workers' containers, keeps a live sibling's", async () => {
    const remove = vi.fn(async () => true);
    const out = await removeOrphanContainers({
      runtime: { listByLabel: async () => listed, remove },
      boxId: "box-1",
      workerId: "w-9",
      isAlive: (pid) => pid === 222,
      log: () => {},
    });
    expect(out).toEqual({
      removed: ["automata-run-w-1-0", "automata-run-w-3-1"],
      kept: ["automata-run-w-2-0"],
    });
    expect(remove.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "a",
      "c",
    ]);
  });

  // card: protects=the boot sweep never throws (a listing failure is a log line; admission's slot-name removal is the backstop); fails_when=a daemon error crashes boot here; no_claim=boot's own fail-closed checks (ping/image), tested below
  it("a listing failure is logged, not thrown", async () => {
    const log = vi.fn();
    await expect(
      removeOrphanContainers({
        runtime: {
          listByLabel: async () => {
            throw new Error("daemon down");
          },
          remove: vi.fn(),
        },
        boxId: "b",
        workerId: "w",
        log,
      }),
    ).resolves.toEqual({ removed: [], kept: [] });
    expect(log.mock.calls[0]?.[0]).toMatch(/orphans_scan_failed/);
  });
});

describe("containerRunsBoot", () => {
  const image = parsePinnedImage(
    `ghcr.io/be-automata/automata-batteries@sha256:${"cd".repeat(32)}`,
  );
  const cr = {
    image,
    dockerSocket: SOCK,
    dockerBin: "docker",
    cpus: 2,
    tmpBytes: 1,
    shmBytes: 1,
    runGid: null,
  };
  const runtime = (
    over: Partial<Record<"ping" | "imagePresent", unknown>> = {},
  ) => ({
    ping: vi.fn(async () => "29.8.1"),
    imagePresent: vi.fn(async () => true),
    listByLabel: vi.fn(async () => []),
    remove: vi.fn(async () => true),
    ...over,
  });

  // card: protects=every boot (the container path is the only one, ADR-013 P3) refuses a dead rootless daemon or an image missing from its store (never a pull), sweeps orphans by label, and logs no dev-only warning; fails_when=boot proceeds without the daemon/image, skips the sweep, or still warns; no_claim=that the digest matches the published attestation (box step)
  it("refuses a dead daemon or a missing image and sweeps orphans", async () => {
    const log = vi.fn();
    const ok = runtime();
    await expect(
      containerRunsBoot({
        config: { containerRuns: cr, boxId: "b" },
        workerId: "w",
        log,
        runtime: ok as never,
      }),
    ).resolves.toEqual({ serverVersion: "29.8.1", removed: [] });
    expect(log.mock.calls.flat().join("\n")).not.toMatch(/DEV|ONLY/);
    expect(ok.listByLabel).toHaveBeenCalledWith("automata.box", "b");

    const dead = runtime({
      ping: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(
      containerRunsBoot({
        config: { containerRuns: cr, boxId: "b" },
        workerId: "w",
        log: vi.fn(),
        runtime: dead as never,
      }),
    ).rejects.toThrow(/does not answer/);

    const noImage = runtime({ imagePresent: vi.fn(async () => false) });
    await expect(
      containerRunsBoot({
        config: { containerRuns: cr, boxId: "b" },
        workerId: "w",
        log: vi.fn(),
        runtime: noImage as never,
      }),
    ).rejects.toThrow(/never pulls/);
  });
});
