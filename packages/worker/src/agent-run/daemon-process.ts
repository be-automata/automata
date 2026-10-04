import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { redactSecrets } from "@terragon/utils/redact";
import { reapplyPathGrant, type AceExec } from "./agent-uid-fs";
import { buildDaemonEnv, type BrokerHandoff } from "./daemon-env";
import { ghBrokerConfigYaml } from "./gh-broker";
import {
  getProcessWorkerId,
  runPidPath,
  runSocketPath,
  workerRunDir,
} from "./run-namespace";
import {
  assessCgroupSupport,
  createRunCgroup,
  killAndRemoveRunCgroup,
  moveIntoCgroup,
  readOomKillCount,
} from "./run-cgroup";
import { classifyAgentExit } from "./retry-classification";
import { buildKillInvocation, buildSpawnInvocation } from "./spawn-as-user";
import { verifyGhAuth } from "./verify-gh-auth";
import type { WorkerConfig } from "./config";
import type { AgentRunInput, PulledDaemonMessage } from "./types";

/**
 * Spawns and controls the chassis daemon bundle (packages/daemon/dist/index.js) as
 * a subprocess for one agent run (ADR-003 run step). The daemon is a unix-socket
 * server that spawns the agent CLI and streams events to www /api/daemon-event;
 * the worker writes ONE DaemonMessage to its socket, then polls www for terminal.
 *
 * The daemon SIGKILLs its own process group on teardown (it is designed to be the
 * process-group leader of a sandbox), so it is spawned `detached` in its OWN
 * process group and torn down by signalling that group — never embedded in-process.
 *
 * Per-run socket + pidfile (Phase 0.2b): the daemon `--socket-path` flag lets each
 * run bind a DISTINCT socket under `<runNamespaceRoot>/<workerId>/<threadId>.sock`,
 * so N daemons no longer collide on the fixed default socket. The matching
 * `<threadId>.pid` records the daemon's process-group pid; boot-time reclaim (see
 * reclaim.ts) — NOT this class — reaps daemons orphaned by a worker-process death.
 * start() only cleans THIS run's own stale socket/pid (e.g. a same-threadId retry).
 */

/**
 * #204 log line. Goes to stderr like the rest of this module's diagnostics, and
 * is deliberately noisy about a DECLINED ceiling: silence would make a
 * misconfigured box indistinguishable from a protected one.
 */
function logCgroup(message: string): void {
  console.error(`[agent-run] ${message}`);
}

export class DaemonProcess {
  private child: ChildProcess | null = null;
  /**
   * The process GROUP to signal at teardown. In default mode this is
   * `child.pid` (spawn is `detached`, so the child leads its own group). In
   * agent-uid mode it is the value the sudo wrapper wrote for itself — see
   * spawn-as-user.ts for why a pre-sudo pid is not usable.
   */
  private pgid: number | null = null;
  /** Bounded, redacted tail of the child's stderr, for start() diagnostics. */
  private stderrTail = "";
  private ghConfigDir: string | null = null;
  private env: NodeJS.ProcessEnv | null = null;
  private readonly runDir: string;
  private readonly socketPath: string;
  // PID of the daemon's process group, persisted under this worker's namespaced dir
  // so boot-reclaim can reap it if this worker process dies without running teardown.
  private readonly pidFilePath: string;

  constructor(
    private readonly config: WorkerConfig,
    private readonly input: AgentRunInput,
    private readonly workdir: string,
    /**
     * The run's own agent credential, already written to a per-run HOME (D1).
     * Null/omitted → this run has no delivered credential and the caller forces
     * it through the control-plane proxy instead.
     */
    private readonly credentials: {
      home: string;
      delivered: boolean;
      env: Record<string, string>;
    } | null = null,
    /**
     * The per-run egress filtering proxy's base url (#66 slice 2), when this
     * run carries an egress policy. Null → no proxy vars are injected and the
     * child's egress is unfiltered on this plane (today's behavior).
     */
    private readonly egressProxyUrl: string | null = null,
    /**
     * Per-run credential brokers (#81), when the workflow started them. Null →
     * legacy raw-token env (WORKER_CREDENTIAL_BROKER=legacy-direct rollback).
     * When set, ensureEnv() additionally writes `http_unix_socket` into the
     * isolated gh config dir so the agent's gh dials the gh broker.
     */
    private readonly broker: BrokerHandoff | null = null,
    /**
     * Run options decided by the workflow, plus injectable side-effects for
     * tests (production passes no side-effect and gets the real /bin/chmod).
     * Keeping this last preserves every existing call site unchanged.
     */
    private readonly deps: {
      /**
       * Phase 7: set ONLY when readTokenForRun returned a token (brokered
       * non-review run, seeded requiring pack, unexpired token); never read
       * from the input here. Secret: never logged.
       */
      githubReadToken?: string;
      aceExec?: AceExec;
      spawnFn?: typeof spawn;
      platform?: NodeJS.Platform;
      /** Injectable so the suite never SIGKILLs a real process group. */
      killFn?: (pid: number, signal: NodeJS.Signals) => void;
    } = {},
  ) {
    const workerId = getProcessWorkerId();
    this.runDir = workerRunDir(config.runNamespaceRoot, workerId);
    this.socketPath = runSocketPath(
      config.runNamespaceRoot,
      workerId,
      input.threadId,
    );
    this.pidFilePath = runPidPath(
      config.runNamespaceRoot,
      workerId,
      input.threadId,
    );
  }

  /**
   * #204: this run's cgroup, when the ceiling is on. Null in every other case —
   * feature off, not Linux, agent-uid mode off, or the subtree not delegated.
   */
  private cgroupDir: string | null = null;

  /**
   * #204: the OOM count observed at teardown.
   *
   * Cached because teardown REMOVES the cgroup, and the caller classifies the
   * exit afterwards — a live read at that point would find nothing and report 0,
   * so the ceiling would never be reported as the cause. Without this the whole
   * `resource-limit` classification is dead code.
   */
  private observedOomKills = 0;

  /**
   * The marker the wrapper blocks on. Lives beside the pidfile — the same dir the
   * agent can already read — so the handshake needs no new grant.
   */
  private cgroupReadyPath(): string {
    return `${this.pidFilePath}.cgroup-ready`;
  }

  /**
   * Build the sanitized child env once (idempotent). Creates the isolated EMPTY gh
   * config dir so the agent's `gh` can't read the operator's stored OAuth (hosts.yml)
   * and post as the human — it must use the installation token → the App bot. The dir
   * is cleaned up in teardown.
   */
  private async ensureEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.env) {
      return this.env;
    }
    this.ghConfigDir = await this.createGhConfigDir();
    this.env = buildDaemonEnv({
      baseEnv: process.env,
      anthropicApiKey: this.config.anthropicApiKey,
      claudeBinDir: this.config.claudeBinDir,
      installationToken: this.input.installationToken,
      ghConfigDir: this.ghConfigDir,
      botLogin: this.config.botLogin,
      runHome: this.credentials?.home ?? null,
      credentialDelivered: this.credentials?.delivered ?? false,
      credentialEnv: this.credentials?.env ?? {},
      egressProxyUrl: this.egressProxyUrl,
      broker: this.broker,
      githubReadToken: this.deps.githubReadToken ?? null,
      agentUser: this.config.agentUser,
      // Inside the workdir, so it inherits the run's ACE. Provisioning created
      // it in the same `if (agentUser)` branch that applied that ACE.
      runTmpDir: this.config.agentUser ? path.join(this.workdir, "tmp") : null,
      // THE CALL SITE IS HALF THE FIX. `buildDaemonEnv` adds the
      // `safe.directory` entry only when it is given the workdir, so without
      // this line the option defaults to null, the `agentUser && workdir` guard
      // is always false, and the #108 fix is dead code — which its own unit
      // tests still pass, because they call buildDaemonEnv directly and supply
      // the workdir themselves.
      workdir: this.workdir,
    });
    return this.env;
  }

  /**
   * The run's isolated gh config dir, plus the #81 broker route when brokered.
   * `http_unix_socket` has NO env-var equivalent — it is a config.yml key only,
   * so writing it here is what routes every gh API call through the gh broker.
   *
   * WHERE IT LIVES DEPENDS ON THE UID SPLIT. Default mode: a private 0700
   * mkdtemp under the worker's tmpdir — the agent IS the worker uid, so it can
   * read it. Agent-uid mode: that same dir is owned by the worker and closed to
   * the agent, so every agent `gh` call failed `open .../config.yml: permission
   * denied` (observed live on the execution box). There it goes INSIDE the run
   * workdir instead, like the run's TMPDIR, so it inherits the per-run grant
   * provisioning put on the workdir — scoped to this run, never another's.
   *
   * The agent CAN edit config.yml to drop the socket — then gh dials
   * api.github.com directly with the bearer, which GitHub rejects.
   * Self-inflicted breakage, never a credential leak. The worker runs `gh` with
   * this dir only in preflightGhAuth, which completes before the agent is
   * spawned, so nothing the agent writes here can redirect the worker's gh.
   */
  private async createGhConfigDir(): Promise<string> {
    const agentUser = this.config.agentUser;
    if (!agentUser) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-gh-"));
      if (this.broker) {
        fs.writeFileSync(
          path.join(dir, "config.yml"),
          ghBrokerConfigYaml(this.broker.ghSocketPath),
        );
      }
      return dir;
    }

    const dir = path.join(this.workdir, "gh-config");
    // Fresh every time: a retry into the same workdir must not inherit whatever
    // a previous attempt's agent left here (e.g. a planted hosts.yml).
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { mode: 0o700 });
    const grant = {
      users: [agentUser],
      exec: this.deps.aceExec,
      platform: this.deps.platform,
    };
    // LINUX: the 0700 creation mode zeroes the POSIX ACL mask on this dir, so
    // the inherited grant is born dead and the agent cannot even traverse it.
    // Same trap, same remedy as the run HOME (agent-credentials.ts). No-op on
    // macOS, where the inherited ACE survives the mode.
    await reapplyPathGrant({ ...grant, target: dir, kind: "directory" });
    if (this.broker) {
      const file = path.join(dir, "config.yml");
      // Not a secret — a socket path — so no 0600. Re-granted regardless: the
      // agent's read must not hinge on the creation mode staying what it is.
      fs.writeFileSync(file, ghBrokerConfigYaml(this.broker.ghSocketPath), {
        mode: 0o644,
      });
      await reapplyPathGrant({ ...grant, target: file, kind: "file" });
    }
    return dir;
  }

  /**
   * Fail-closed gh-auth precondition (ADR-002 F3). Run BEFORE start(): confirm `gh`
   * authenticates (as the bot, via the injected token + isolated config) inside the
   * workdir with the sanitized env. Throws if it can't — the run is blocked rather
   * than spawning an agent that would post as the wrong identity or fail to push.
   */
  async preflightGhAuth(
    exec?: Parameters<typeof verifyGhAuth>[0]["exec"],
  ): Promise<void> {
    const result = await verifyGhAuth({
      workdir: this.workdir,
      env: await this.ensureEnv(),
      exec,
    });
    if (!result.ok) {
      throw new Error(
        `gh auth precondition failed — blocking run (agent would post as the wrong identity): ${result.detail}`,
      );
    }
  }

  /** Spawn the daemon (own process group) and wait until its socket accepts. */
  async start(): Promise<void> {
    // Ensure this worker's namespaced run dir exists, then clean only THIS run's
    // own stale socket/pid (a prior crashed run of the SAME threadId under this
    // worker). Cross-worker orphans are handled by boot-reclaim (reclaim.ts), never
    // here — this method must never touch another run's or worker's resources.
    fs.mkdirSync(this.runDir, { recursive: true });
    this.cleanOwnStaleFiles();

    // #108 F2: the cross-uid ACEs are NOT applied here. macOS applies ACE
    // inheritance at CREATE time, and workflow.ts binds the gh-broker socket in
    // this same dir BEFORE start() runs — a grant added here would never reach
    // it, and the agent's `gh` would fail to connect (Darwin enforces
    // unix-socket permissions). They are applied ONCE at worker boot, on the
    // empty dir, by claimRunNamespace() (run-namespace.ts).

    const env = await this.ensureEnv();

    // #108: with agentUser empty this returns the command UNCHANGED and an empty
    // env — byte-for-byte today's spawn.
    // #204: the per-run memory ceiling. Everything here is skipped unless the
    // ceiling is configured AND agent-uid mode is on (without the uid drop there
    // is no separate process to cap) AND the subtree is delegated. The support
    // check reports a REASON when it declines, because an operator who meant to
    // enable this and mistyped `Delegate=` should be told which precondition
    // failed rather than silently getting no ceiling.
    this.cgroupDir = this.prepareRunCgroup();

    const invocation = buildSpawnInvocation({
      agentUser: this.config.agentUser,
      file: this.config.nodeBin,
      args: [
        this.config.daemonDist,
        "--url",
        this.input.daemonCallbackUrl,
        "--socket-path",
        this.socketPath,
      ],
      pidFilePath: this.pidFilePath,
      ...(this.cgroupDir ? { cgroupReadyPath: this.cgroupReadyPath() } : {}),
    });

    this.child = (this.deps.spawnFn ?? spawn)(
      invocation.file,
      invocation.args,
      {
        cwd: this.workdir,
        // sudo -E forwards THIS env (spawn's `env` REPLACES the child's), not the
        // operator's ambient one — buildDaemonEnv already whitelisted it.
        env: { ...env, ...invocation.env },
        detached: true, // own process group — see class doc
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Daemon stdout is agent output; it flows to www via events. We do not
    // forward or store it here (H2: keep prompt/agent content off the worker box).
    this.child.stdout?.resume();
    // stderr is kept as a BOUNDED, REDACTED tail only, and only to explain a
    // failed start. Without it a missing SETENV in sudoers ("sorry, you are not
    // allowed to preserve the environment") surfaces as a bare 15s socket
    // timeout naming nothing.
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = redactSecrets(
        (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES),
      );
    });
    this.child.stderr?.resume();

    this.pgid = await this.resolvePgid();

    // #204: the handshake. resolvePgid() has just waited for the wrapper to
    // record its own pid; the wrapper is now BLOCKED before its `exec`. Move it
    // into the run cgroup — which only the worker may do, across the uid split —
    // and then release it. The pid survives `exec`, so the agent starts inside
    // its ceiling rather than being moved mid-flight.
    if (this.cgroupDir) {
      if (this.pgid == null) {
        // INVARIANT, not an expected failure. `cgroupDir` is non-null only when
        // the ceiling is on, which `loadWorkerConfig` only permits with
        // `agentUser` set — and in that mode `resolvePgid()` either returns a
        // positive integer or throws, including on the exitCode break. So this is
        // unreachable. It stays because it is also the narrowing `moveIntoCgroup`
        // needs, and because if resolvePgid's contract ever loosens, the failure
        // it would produce is an agent running uncapped.
        throw new Error(
          "invariant violated: the memory ceiling is on but no pgid was resolved, " +
            "so the wrapper could not be placed in its cgroup; refusing to run " +
            "the agent uncapped",
        );
      }
      moveIntoCgroup({ cgroupDir: this.cgroupDir, pid: this.pgid });
      fs.writeFileSync(this.cgroupReadyPath(), "");
    }

    await this.waitForSocket();
  }

  /**
   * Determine the process group to signal at teardown, and make sure the
   * pidfile holds it (boot-reclaim reads that file).
   *
   * Default mode: `child.pid` IS the group leader (detached spawn); the worker
   * writes the pidfile, exactly as before.
   *
   * Agent-uid mode: the sudo wrapper wrote its own `$$` there before exec'ing,
   * because sudo may fork a monitor that setsid()s and setpgid()s the command
   * into a group the pre-sudo pid names neither of. We WAIT for that value
   * rather than overwrite it.
   */
  private async resolvePgid(): Promise<number | null> {
    if (!this.config.agentUser) {
      const pid = this.child?.pid ?? null;
      if (pid != null) {
        try {
          fs.writeFileSync(this.pidFilePath, String(pid));
        } catch {
          // best-effort — reclaim just won't fire if we can't persist the pid
        }
      }
      return pid;
    }
    const deadline = Date.now() + WRAPPER_PIDFILE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child?.exitCode != null) {
        break; // the spawn already failed; waitForSocket reports why
      }
      try {
        const raw = fs.readFileSync(this.pidFilePath, "utf8").trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      } catch {
        // not written yet
      }
      await delay(50);
    }
    // No pgid means teardown cannot reap the group. Surface it rather than
    // leaking a live agent silently.
    throw new Error(
      `daemon wrapper never recorded its process group in ${this.pidFilePath}` +
        (this.stderrTail ? `: ${this.stderrTail.trim()}` : ""),
    );
  }

  /**
   * Assemble the full DaemonMessage (pulled body + the ids/token the daemon still
   * needs) and write it to the daemon's socket to start the run. Never logs the
   * message (H2 — it carries the prompt).
   */
  async sendMessage(pulled: PulledDaemonMessage): Promise<number> {
    const message = {
      ...pulled,
      token: this.input.daemonToken,
      threadId: this.input.threadId,
      threadChatId: this.input.threadChatId,
    };
    const dataStr = JSON.stringify(message);
    await this.writeToSocket(dataStr);
    return dataStr.length; // byte count for step logging (not the content — H2)
  }

  /**
   * The daemon's process-GROUP pid (undefined before start / after teardown).
   * In default mode this is the spawned child's own pid.
   */
  get pid(): number | undefined {
    return this.pgid ?? this.child?.pid;
  }

  /**
   * SIGKILL the daemon's process group. Best-effort and idempotent.
   *
   * DEGRADED PATH (#108 F3). In agent-uid mode `child.pid` is the pre-sudo
   * pid — sudo's own process, running as root, in a DIFFERENT group from the
   * daemon (the monitor setsid()s and setpgid()s the command). Signalling it
   * as the agent account is a guaranteed EPERM no-op, so a run whose wrapper
   * pgid was never resolved would leak a LIVE agent in complete silence. So:
   * take one last look at the wrapper's pidfile before removing it; if it is
   * still absent, say so LOUDLY and fall back to killing sudo's own group from
   * the worker's uid (which the kernel does permit, since sudo's real uid is
   * ours) rather than issuing a kill that cannot land.
   */
  teardown(): void {
    // #204: kill the run's cgroup FIRST, while it still exists.
    //
    // `cgroup.kill` is a single kernel-side write that reaches every member of
    // this run and NO sibling — no pid races, no reliance on a recorded pgid, and
    // nothing to get wrong in the degraded path below. When the ceiling is on it
    // makes the pgid kill redundant rather than replacing it; both run, because
    // the pgid path is what this method has always been verified on and #205 is
    // where the uid-wide kill actually gets retired.
    //
    // Ordering matters twice over: the OOM counter lives inside the cgroup, so it
    // must be read before the directory goes, and `rmdir` fails while members
    // remain, so the kill must precede it.
    if (this.cgroupDir) {
      // Reads through oomKills(), which caches — the classification happens
      // after this method has removed the cgroup.
      const oom = this.oomKills();
      if (oom > 0) {
        logCgroup(
          `run ${this.input.threadId} was OOM-killed ${oom} time(s) inside its cgroup (memory.max=${this.config.memoryMaxBytes})`,
        );
      }
      killAndRemoveRunCgroup({ cgroupDir: this.cgroupDir, log: logCgroup });
      this.cgroupDir = null;
    }

    let pid = this.pgid;
    let degraded = false;
    // `child == null` ⇒ nothing was ever spawned, or teardown already ran.
    // teardown() is idempotent by contract, so the alarm below must not fire
    // on the second call.
    if (pid == null && this.child != null && this.config.agentUser) {
      pid = this.readWrapperPgid();
      if (pid == null) {
        degraded = true;
        console.error(
          `[agent-run] daemon teardown for ${this.input.threadId}: the sudo ` +
            `wrapper never recorded a process group in ${this.pidFilePath}. ` +
            `Killing sudo's own group as the worker instead; an agent process ` +
            `under ${this.config.agentUser} may survive this teardown and must ` +
            `be reaped by boot-reclaim or by hand.`,
        );
      }
    }
    if (pid == null) {
      pid = this.child?.pid ?? null;
    }
    this.child = null;
    this.pgid = null;
    // Clear this run's own pid + socket file first so a later reclaim doesn't target
    // a recycled pid and the next same-threadId run binds clean.
    try {
      fs.rmSync(this.pidFilePath, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(this.cgroupReadyPath(), { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      // ignore
    }
    if (this.ghConfigDir) {
      try {
        fs.rmSync(this.ghConfigDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this.ghConfigDir = null;
    }
    this.env = null;
    if (pid == null) {
      return;
    }
    // In the degraded path the target is sudo's group, not the agent's: it is
    // OURS to signal and NOT the agent account's, so the sudo hop is skipped.
    const killInvocation = degraded
      ? null
      : buildKillInvocation({
          agentUser: this.config.agentUser,
          pgid: pid,
        });
    if (killInvocation) {
      // Cross-uid: process.kill(-pid) from the worker's uid is EPERM. Shell out
      // as the agent account so the kernel's own kill(2) check permits it.
      // Fire-and-forget — teardown() is sync and best-effort by contract.
      try {
        (this.deps.spawnFn ?? spawn)(killInvocation.file, killInvocation.args, {
          stdio: "ignore",
        }).unref();
      } catch {
        // already gone
      }
      return;
    }
    try {
      // negative pid → the whole process group
      (this.deps.killFn ?? process.kill.bind(process))(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  /**
   * Last-chance read of the wrapper's pidfile. The wrapper writes `$$` before
   * `exec`, so a value can land AFTER resolvePgid()'s bounded wait gave up —
   * e.g. a slow sudo/PAM hop. Returns null when there is nothing usable.
   */
  private readWrapperPgid(): number | null {
    try {
      const pid = Number(fs.readFileSync(this.pidFilePath, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * Remove only THIS run's own stale socket/pid before spawning — e.g. a prior
   * crashed run of the SAME threadId under this worker left files behind. It must
   * NOT touch any other run's or worker's resources; cross-worker orphan reaping is
   * boot-reclaim's job (reclaim.ts, which group-SIGKILLs a dead worker's daemons).
   */
  private cleanOwnStaleFiles(): void {
    try {
      fs.rmSync(this.pidFilePath, { force: true });
    } catch {
      // ignore
    }
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      // the daemon unlinks/rebinds the socket itself; this is belt-and-suspenders
    }
    try {
      // #204 THE MARKER IS A SAFETY INTERLOCK, SO A STALE ONE IS A SAFETY FAILURE.
      // The wrapper execs as soon as this file exists. If a crashed run of the same
      // threadId left one behind, the next wrapper stops waiting IMMEDIATELY — before
      // the worker has moved it into the cgroup — and the agent runs uncapped while
      // every log says it is capped. That is precisely the silent downgrade this
      // whole mechanism exists to prevent, so the marker is cleared here as well as
      // in teardown: teardown covers the run that ends, this covers the run that
      // never got to.
      fs.rmSync(this.cgroupReadyPath(), { force: true });
    } catch {
      // ignore
    }
  }

  /**
   * #204: create this run's capped cgroup, or return null when there is no
   * ceiling to apply.
   *
   * `null` means ONE thing: `WORKER_RUN_MEMORY_MAX` is unset, so this box never
   * asked for a ceiling and must behave exactly as it does today.
   *
   * Every other path throws. A box that asked for a ceiling and cannot apply it
   * must not run the agent uncapped — that fail-open is the failure mode this
   * whole feature argues against, and a per-run `skipped` log line is not a
   * mitigation: it appears once per run in a stream nobody reads while every
   * agent runs without a limit. Boot has already proved the subtree is delegated
   * and the controllers enabled, so losing that at run time is an anomaly, not a
   * degraded mode.
   */
  private prepareRunCgroup(): string | null {
    const { memoryMaxBytes, tasksMax } = this.config;
    if (memoryMaxBytes <= 0) {
      return null;
    }
    // `agentUser` is guaranteed non-empty here: loadWorkerConfig rejects the
    // combination, so the box cannot boot with a ceiling and no uid drop.
    let procSelfCgroup: string;
    try {
      procSelfCgroup = fs.readFileSync("/proc/self/cgroup", "utf8");
    } catch (e) {
      throw new Error(
        `the per-run memory ceiling is configured but /proc/self/cgroup is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const support = assessCgroupSupport({ procSelfCgroup });
    if (!support.supported) {
      throw new Error(
        `the per-run memory ceiling is configured but unavailable at run time: ${support.reason}`,
      );
    }
    try {
      const dir = createRunCgroup({
        root: support.root,
        threadId: this.input.threadId,
        memoryMaxBytes,
        tasksMax,
      });
      logCgroup(
        `run cgroup ${dir}: memory.max=${memoryMaxBytes} memory.swap.max=0 pids.max=${tasksMax}`,
      );
      return dir;
    } catch (e) {
      // A ceiling that cannot be applied must NOT silently become no ceiling.
      // Failing the run here is loud and recoverable; running uncapped while the
      // logs claim a limit is neither.
      throw new Error(
        `could not create this run's cgroup under ${support.root}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * #204: the run's failure cause when the agent process is gone, or null while it
   * is alive. Consumed by the poll loop (`PollContext.agentFailure`).
   *
   * `null` also when nothing was ever spawned, and after teardown — which nulls
   * `child` — so this method never fails a run on a process it already killed.
   *
   * The classification is the same one `waitForSocket` applies at startup, which is
   * the point: whether the kernel kills the agent before its socket appears or two
   * minutes into the run, the run reports the SAME cause. Reads the OOM counter
   * live, since teardown has not run yet here.
   */
  agentFailure(): unknown | null {
    // GATED ON THE CEILING, to keep the default-off promise literally true.
    // Noticing a dead agent mid-run would help every box — today the poll loop
    // spins until Hatchet cancels the task, on a capped box and an uncapped one
    // alike. Turning that on everywhere is a behaviour change this PR does not
    // own, so it exists only where the ceiling does: the case #204 has to
    // classify.
    if (this.config.memoryMaxBytes <= 0) {
      return null;
    }
    const child = this.child;
    if (!child) {
      return null;
    }
    if (child.exitCode == null && child.signalCode == null) {
      return null;
    }
    // A CLEAN EXIT IS NOT A FAILURE, and treating it as one fails runs that
    // succeeded. The daemon exiting 0 means it finished its work; www records the
    // terminal status independently, and it may do so AFTER the exit. The grace
    // below was one poll interval, so a www write slower than that turned a good
    // run into a retryable error — on exactly the boxes this feature is enabled
    // on. An earlier comment here conceded that race and deferred it; deferring
    // it was wrong, because the ceiling is what puts the race in production.
    //
    // What remains covered: a non-zero exit, and any signal — which is how an OOM
    // kill and a supersede both arrive.
    if (child.exitCode === 0 && child.signalCode == null) {
      return null;
    }
    return classifyAgentExit({
      exitCode: child.exitCode,
      signal: child.signalCode,
      oomKills: this.oomKills(),
      memoryMaxBytes: this.config.memoryMaxBytes,
      fallback: new Error(
        `the agent process exited mid-run (code ${child.exitCode}, signal ${child.signalCode ?? "none"}) without the thread reaching a terminal status` +
          (this.stderrTail ? `: ${this.stderrTail.trim()}` : ""),
      ),
    });
  }

  /**
   * #204: did the kernel OOM-kill anything in this run's cgroup?
   *
   * Read BEFORE teardown removes the cgroup, and exposed so the caller can
   * classify the exit. Zero whenever the ceiling was off.
   */
  oomKills(): number {
    if (this.cgroupDir) {
      this.observedOomKills = readOomKillCount({ cgroupDir: this.cgroupDir });
    }
    // After teardown the cgroup is gone; the value observed then is the answer.
    return this.observedOomKills;
  }

  private async waitForSocket(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      // A dead child here is how an OOM actually surfaces: the kernel SIGKILLs
      // the agent inside its cgroup, the socket never appears, and this is the
      // first code to notice. `signalCode` matters as much as `exitCode` —
      // a killed process reports exitCode null.
      //
      // DELIBERATELY NOT GATED ON THE CEILING, unlike `agentFailure()`. This one
      // is not a new failure: a child that died during startup already failed the
      // run on every box. It changes only the CAUSE reported — "daemon exited
      // before its socket was ready (signal SIGKILL)" instead of "socket not
      // ready after 15000ms" fifteen seconds later — and reporting a timeout for
      // a process killed 200ms in was simply wrong. So the precise default-off
      // claim is: the argv, the spawn and which runs fail are unchanged; this one
      // error names its cause sooner.
      if (this.child?.exitCode != null || this.child?.signalCode != null) {
        const generic = new Error(
          `daemon exited before its socket was ready (code ${this.child.exitCode}, signal ${this.child.signalCode ?? "none"})` +
            (this.stderrTail ? `: ${this.stderrTail.trim()}` : ""),
        );
        // #204: name the memory ceiling as the cause ONLY when the kernel says
        // so. Read before teardown removes the cgroup; oomKills() caches it.
        throw classifyAgentExit({
          exitCode: this.child.exitCode,
          signal: this.child.signalCode,
          oomKills: this.oomKills(),
          memoryMaxBytes: this.config.memoryMaxBytes,
          fallback: generic,
        });
      }
      try {
        await this.probeSocket();
        return;
      } catch (err) {
        lastErr = err;
        await delay(200);
      }
    }
    throw new Error(
      `daemon socket not ready after ${timeoutMs}ms: ${String(lastErr)}`,
    );
  }

  private probeSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      sock.once("connect", () => {
        sock.end();
        resolve();
      });
      sock.once("error", (err) => {
        sock.destroy();
        reject(err);
      });
    });
  }

  private writeToSocket(dataStr: string): Promise<void> {
    return writeDaemonMessage(this.socketPath, dataStr);
  }
}

/**
 * Write one DaemonMessage over the daemon's unix-socket protocol and wait for its
 * ACK. The daemon's socket server (DaemonRuntime.listenToUnixSocket) expects a
 * WRAPPED envelope `{ id, data }` where `data` is the STRINGIFIED DaemonMessage —
 * it JSON.parses the frame, hands the inner `data` to the message parser, and
 * replies `{ status: "ACK"|"ERROR", id }`. Writing the raw message instead makes
 * the daemon read `payloadData: undefined` → it never runs the agent and the run
 * idles to the schedule timeout. This mirrors the daemon's own writeToUnixSocket.
 */
export function writeDaemonMessage(
  socketPath: string,
  dataStr: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const msgId = randomUUID();
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      finish(() =>
        reject(new Error(`daemon socket write timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    sock.once("connect", () => {
      sock.write(JSON.stringify({ id: msgId, data: dataStr }));
    });
    sock.on("data", (buffer) => {
      let response: { id?: string; status?: string; error?: string };
      try {
        response = JSON.parse(buffer.toString());
      } catch {
        return; // partial/other frame — keep waiting
      }
      if (response.id !== msgId) {
        return;
      }
      clearTimeout(timer);
      sock.end();
      if (response.status === "ACK") {
        finish(resolve);
      } else {
        // #6: the daemon rejecting the message is a terminal contract error (the
        // message won't parse/run), not a transient blip → NonRetryableError so it
        // routes straight to onFailure instead of burning a retry.
        finish(() =>
          reject(
            new NonRetryableError(
              `daemon rejected the message: ${response.error ?? response.status ?? "unknown"}`,
            ),
          ),
        );
      }
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      sock.destroy();
      finish(() => reject(err));
    });
    sock.once("close", () => {
      clearTimeout(timer);
      finish(() =>
        reject(new Error("daemon socket closed before ACK was received")),
      );
    });
  });
}

/** Cap on the retained stderr tail (bytes). Diagnostics only, never content. */
const STDERR_TAIL_BYTES = 4096;

/** How long the sudo wrapper gets to record its own pgid. */
const WRAPPER_PIDFILE_TIMEOUT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
