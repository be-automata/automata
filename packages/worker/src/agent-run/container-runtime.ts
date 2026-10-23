import { type ChildProcess, execFile, spawn } from "node:child_process";

import {
  LABEL_BOX,
  LABEL_RUN,
  LABEL_WORKER,
  LABEL_WORKER_PID,
} from "./container-argv";

/**
 * The container runtime adapter (ADR-013 "Run path" 3-7): create → copy in →
 * start (attached) → inspect → remove, against ONE configurable Docker socket —
 * the dedicated rootless daemon, never the root daemon that runs the engine
 * stack. It drives the `docker` CLI with an explicit `-H unix://<socket>` and
 * a scrubbed env (no DOCKER_HOST, no operator context or credential helper),
 * so the socket it talks to is exactly the configured one.
 *
 * The CLI rather than the engine API: the worker already shells out for git,
 * gh and the box-lock helper, `docker cp -a` handles the tar ownership the
 * copy-in needs, and `docker start --attach` gives the worker one child
 * process per run — the same shape as the host path's daemon child — whose
 * exit is the container's exit.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one docker CLI invocation; never throws for a non-zero exit. */
export type DockerExec = (
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<ExecResult>;

export interface ContainerState {
  status: string;
  running: boolean;
  exitCode: number;
  oomKilled: boolean;
}

/** A failed runtime operation, with the docker CLI's own stderr (no secret ever rides it). */
export class ContainerRuntimeError extends Error {
  constructor(
    message: string,
    readonly result?: ExecResult,
  ) {
    super(message);
    this.name = "ContainerRuntimeError";
  }
}

const NO_SUCH = /no such (container|object)/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ContainerRuntimeOptions {
  /** The rootless daemon's socket. */
  socketPath: string;
  /** The docker CLI (default `docker` on PATH). */
  dockerBin?: string;
  /** Injectable for unit tests; production runs the real CLI. */
  exec?: DockerExec;
  /** Injectable for unit tests; production spawns the real CLI. */
  spawnFn?: typeof spawn;
}

/** The env the docker CLI runs with: PATH and HOME only (no DOCKER_HOST/CONTEXT leak). */
function cliEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };
}

export class ContainerRuntime {
  readonly socketPath: string;
  private readonly dockerBin: string;
  private readonly execFn: DockerExec;
  private readonly spawnFn: typeof spawn;

  constructor(opts: ContainerRuntimeOptions) {
    this.socketPath = opts.socketPath;
    this.dockerBin = opts.dockerBin ?? "docker";
    this.spawnFn = opts.spawnFn ?? spawn;
    this.execFn =
      opts.exec ??
      ((args, o) =>
        new Promise<ExecResult>((resolve) => {
          execFile(
            this.dockerBin,
            args,
            {
              env: cliEnv(),
              timeout: o?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              maxBuffer: 16 * 1024 * 1024,
            },
            (err, stdout, stderr) => {
              const code =
                err && typeof (err as { code?: unknown }).code === "number"
                  ? (err as { code: number }).code
                  : err
                    ? 1
                    : 0;
              resolve({
                code,
                stdout: String(stdout),
                // A spawn failure (ENOENT: no docker CLI) has no stderr of
                // its own; its message is the only diagnostic.
                stderr: String(stderr) || (err ? err.message : ""),
              });
            },
          );
        }));
  }

  /** The global flags every invocation starts with. */
  hostArgs(): string[] {
    return ["-H", `unix://${this.socketPath}`];
  }

  private run(args: string[], timeoutMs?: number): Promise<ExecResult> {
    return this.execFn([...this.hostArgs(), ...args], { timeoutMs });
  }

  private async must(
    what: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<ExecResult> {
    const r = await this.run(args, timeoutMs);
    if (r.code !== 0) {
      throw new ContainerRuntimeError(
        `docker ${what} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`,
        r,
      );
    }
    return r;
  }

  /** The daemon's server version; throws when the socket does not answer. */
  async ping(): Promise<string> {
    const r = await this.must(
      "version",
      ["version", "--format", "{{.Server.Version}}"],
      15_000,
    );
    return r.stdout.trim();
  }

  /** Is the image present in THIS daemon's store (never pulls, I5)? */
  async imagePresent(reference: string): Promise<boolean> {
    const r = await this.run(
      ["image", "inspect", "--format", "{{.Id}}", reference],
      15_000,
    );
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /** `docker <argv>` where argv is a built `create` argv; returns the container id. */
  async create(argv: readonly string[]): Promise<string> {
    if (argv[0] !== "create") {
      throw new ContainerRuntimeError("create() takes a `create` argv");
    }
    const r = await this.must("create", [...argv], 120_000);
    const id = r.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!/^[0-9a-f]{12,64}$/.test(id)) {
      throw new ContainerRuntimeError(
        `docker create printed no container id: ${JSON.stringify(r.stdout.slice(0, 200))}`,
        r,
      );
    }
    return id;
  }

  /**
   * Copy the CONTENTS of host dir `srcDir` into `dest` in the container,
   * owned by the container's configured user (`docker cp -a`). Works on a
   * created, not-yet-started container whose rootfs is read-only, because
   * `dest` is on a per-run volume.
   */
  async copyIn(id: string, srcDir: string, dest: string): Promise<void> {
    await this.must("cp (in)", ["cp", "-a", `${srcDir}/.`, `${id}:${dest}`]);
  }

  /** Copy `src` out of the container into host dir `destDir`; false when `src` does not exist. */
  async copyOut(id: string, src: string, destDir: string): Promise<boolean> {
    const r = await this.run(["cp", `${id}:${src}`, destDir]);
    if (r.code === 0) return true;
    if (/could not find the file|no such file/i.test(r.stderr)) return false;
    throw new ContainerRuntimeError(
      `docker cp (out) failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`,
      r,
    );
  }

  /**
   * `docker start --attach`: the child's exit is the container's exit, its
   * stdout/stderr are the container's. The caller owns the child.
   */
  startAttached(id: string): ChildProcess {
    return this.spawnFn(
      this.dockerBin,
      [...this.hostArgs(), "start", "--attach", id],
      { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  /**
   * `docker exec -w <workdir> <id> <argv>` as the container's configured
   * user, as a child the caller drives (stdout piped; stdin and stderr
   * closed): the shape `runAsAgent` spawns. Each `env` entry crosses as a
   * bare `-e NAME`, its value riding the CLI's own environment and never its
   * argv (`ps` shows argv to every account on the box). PATH and HOME, which
   * the CLI itself needs, cross as `-e NAME=value` (never secret). Killing
   * the child ends the CLI only: what the exec still runs dies with the
   * container's removal.
   */
  spawnExec(
    id: string,
    argv: readonly string[],
    opts: { workdir: string; env: Record<string, string> },
  ): ChildProcess {
    const own = cliEnv();
    const envArgs: string[] = [];
    const cli: NodeJS.ProcessEnv = { ...opts.env };
    for (const [name, value] of Object.entries(opts.env)) {
      if (!ENV_NAME.test(name)) {
        throw new ContainerRuntimeError(
          `exec env name ${JSON.stringify(name)} is not an identifier`,
        );
      }
      envArgs.push("-e", name in own ? `${name}=${value}` : name);
    }
    Object.assign(cli, own);
    return this.spawnFn(
      this.dockerBin,
      [...this.hostArgs(), "exec", "-w", opts.workdir, ...envArgs, id, ...argv],
      { env: cli, stdio: ["ignore", "pipe", "ignore"] },
    );
  }

  /**
   * `docker exec <id> <argv>` as the container's configured user, bounded.
   * Returns the result; the caller decides what a non-zero exit means.
   */
  async exec(
    id: string,
    argv: readonly string[],
    timeoutMs: number,
  ): Promise<ExecResult> {
    return this.run(["exec", id, ...argv], timeoutMs);
  }

  /** The container's state, or null when it does not exist. */
  async inspectState(id: string): Promise<ContainerState | null> {
    const r = await this.run(
      ["inspect", "--type", "container", "--format", "{{json .State}}", id],
      15_000,
    );
    if (r.code !== 0) {
      if (NO_SUCH.test(r.stderr)) return null;
      throw new ContainerRuntimeError(
        `docker inspect failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`,
        r,
      );
    }
    const raw: unknown = JSON.parse(r.stdout);
    const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
      string,
      unknown
    >;
    return {
      status: typeof s.Status === "string" ? s.Status : "",
      running: s.Running === true,
      exitCode: typeof s.ExitCode === "number" ? s.ExitCode : -1,
      oomKilled: s.OOMKilled === true,
    };
  }

  /**
   * `docker rm -f -v`: SIGKILL every process in the container's pid
   * namespace, remove it and its anonymous volumes. Idempotent: an absent
   * container is success. Returns whether something was removed.
   */
  async remove(nameOrId: string): Promise<boolean> {
    const r = await this.run(["rm", "-f", "-v", nameOrId], 30_000);
    if (r.code === 0) return r.stdout.trim().length > 0;
    if (NO_SUCH.test(r.stderr)) return false;
    throw new ContainerRuntimeError(
      `docker rm -f -v ${nameOrId} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`,
      r,
    );
  }

  /** Containers carrying `label=value`, with the labels boot needs. */
  async listByLabel(
    label: string,
    value: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      workerId: string;
      workerPid: number | null;
      runId: string;
    }>
  > {
    const r = await this.must("ps", [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${label}=${value}`,
      "--format",
      `{{.ID}}\t{{.Names}}\t{{.Label "${LABEL_WORKER}"}}\t{{.Label "${LABEL_WORKER_PID}"}}\t{{.Label "${LABEL_RUN}"}}`,
    ]);
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [id = "", name = "", workerId = "", pid = "", runId = ""] =
          line.split("\t");
        const n = Number(pid);
        return {
          id,
          name,
          workerId,
          workerPid: Number.isInteger(n) && n > 0 ? n : null,
          runId,
        };
      });
  }
}

/**
 * Boot: remove every run container of this box whose worker is gone (ADR-013
 * Run path 7). A container belongs to a dead worker when its
 * `automata.worker-pid` names no live process, or when it carries THIS
 * worker's id (impossible at boot — no run has started — so it is an orphan
 * by definition). A live sibling worker's containers are left alone, the
 * same rule reclaim.ts applies to sibling run dirs. Never throws: every
 * failure is a log line, and the slot-name removal at admission is the
 * backstop for anything left here.
 */
export async function removeOrphanContainers(opts: {
  runtime: Pick<ContainerRuntime, "listByLabel" | "remove">;
  boxId: string;
  workerId: string;
  isAlive?: (pid: number) => boolean;
  log: (line: string) => void;
}): Promise<{ removed: string[]; kept: string[] }> {
  const isAlive =
    opts.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    });
  const removed: string[] = [];
  const kept: string[] = [];
  let listed: Awaited<ReturnType<ContainerRuntime["listByLabel"]>>;
  try {
    listed = await opts.runtime.listByLabel(LABEL_BOX, opts.boxId);
  } catch (err) {
    opts.log(
      `container.orphans_scan_failed ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}`,
    );
    return { removed, kept };
  }
  for (const c of listed) {
    const orphan =
      c.workerId === opts.workerId ||
      c.workerPid === null ||
      c.workerPid === process.pid ||
      !isAlive(c.workerPid);
    if (!orphan) {
      kept.push(c.name);
      continue;
    }
    try {
      await opts.runtime.remove(c.id);
      removed.push(c.name);
    } catch (err) {
      opts.log(
        `container.orphan_remove_failed ${JSON.stringify({ name: c.name, error: err instanceof Error ? err.message : String(err) })}`,
      );
    }
  }
  opts.log(
    `container.orphans ${JSON.stringify({ removed, keptLiveSibling: kept })}`,
  );
  return { removed, kept };
}
