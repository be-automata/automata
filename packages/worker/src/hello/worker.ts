import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hatchet } from "../hatchet-client";
import {
  assertAuthEnabledFromEnv,
  loadAuthProbeConfig,
} from "../agent-run/assert-auth";
import {
  assertBoxLockHelperAvailable,
  boxLockPath,
} from "../agent-run/box-lock";
import { loadWorkerConfig } from "../agent-run/config";
import {
  LIVENESS_PROBE_TIMEOUT_CAP_MS,
  probeEngineLiveness,
  resolveProbeWorkerName,
  startEngineLivenessWatchdog,
} from "../agent-run/engine-liveness";
import { assertNodeBinSupportsEnvProxy } from "../agent-run/node-floor";
import { reclaimDeadWorkerRuns } from "../agent-run/reclaim";
import { bootUidScan } from "../agent-run/uid-reaper";
import {
  bootTimeSlotReclaim,
  startMaintenanceLoop,
} from "../agent-run/scheduling-maintenance";
import {
  claimRunNamespace,
  getProcessWorkerId,
} from "../agent-run/run-namespace";
import {
  assessCgroupSupport,
  prepareDelegatedRoot,
} from "../agent-run/run-cgroup";
import { workflows } from "../registry";

const execFileAsync = promisify(execFile);

/**
 * Claim this worker process's namespaced run dir and reap orphans left by DEAD
 * sibling workers (Phase 0.2b). Order matters: write our OWN worker.lock FIRST so a
 * concurrently-booting sibling never mistakes our fresh dir for an orphan, THEN scan
 * siblings. Reclaim only ever group-SIGKILLs daemons under a dir whose worker pid is
 * confirmed dead — a live worker's daemons are never touched (safe for ≥2 workers).
 */
async function claimNamespaceAndReclaim(): Promise<void> {
  const root = loadWorkerConfig().runNamespaceRoot;
  const workerId = getProcessWorkerId();
  try {
    // #108 F2: this ALSO applies the cross-uid ACEs, on the empty dir, before
    // anything is created inside it. macOS applies ACE inheritance at create
    // time, so a grant added later (per-run, inside DaemonProcess.start())
    // never reaches the gh-broker socket workflow.ts already bound.
    await claimRunNamespace({
      root,
      workerId,
      agentUser: loadWorkerConfig().agentUser,
    });
  } catch (err) {
    // A worker that can't claim its dir would leak every run's resources — fail loud.
    console.error("worker: failed to claim run namespace", err);
    throw err;
  }
  reclaimDeadWorkerRuns({
    root,
    selfWorkerId: workerId,
    // #108: empty (the default) ⇒ process.kill(-pgid), exactly as before.
    agentUser: loadWorkerConfig().agentUser,
    log: (message) => console.log(`[worker-boot] ${message}`),
  });
}

/**
 * #204 boot step: vacate the delegated cgroup root and enable the controllers.
 *
 * A box that did NOT ask for a ceiling (`memoryMaxBytes <= 0`) returns immediately
 * and boots exactly as it does today — that is the whole of the default-off path.
 *
 * A box that DID ask and cannot deliver refuses to boot. The earlier version logged
 * "ceiling OFF" and carried on, which was the worst of both: every subsequent run
 * still built a cgroup and then died writing `memory.max`, so the box failed every
 * run while its boot log claimed the feature was simply disabled. Same rule as the
 * per-run path — a ceiling that cannot be applied must never quietly become no
 * ceiling — and refusing at boot is the cheapest place to say so.
 */
function prepareCeilingSubtreeAtBoot(): void {
  const cfg = loadWorkerConfig();
  if (cfg.memoryMaxBytes <= 0) {
    return;
  }
  let procSelfCgroup: string;
  try {
    procSelfCgroup = readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    throw new Error(
      "memory ceiling requested (WORKER_RUN_MEMORY_MAX) but /proc/self/cgroup is unreadable",
    );
  }
  // requireEnabled:false — this call runs immediately before the line that does
  // the enabling. Asking for it here would refuse every boot.
  const support = assessCgroupSupport({
    procSelfCgroup,
    requireEnabled: false,
  });
  if (!support.supported) {
    throw new Error(
      `memory ceiling requested (WORKER_RUN_MEMORY_MAX) but unavailable: ${support.reason}`,
    );
  }
  try {
    prepareDelegatedRoot({ root: support.root, pid: process.pid });
    console.log(
      `[worker-boot] memory ceiling armed: ${support.root} (memory.max=${cfg.memoryMaxBytes} per run, pids.max=${cfg.tasksMax})`,
    );
  } catch (e) {
    throw new Error(
      `memory ceiling requested (WORKER_RUN_MEMORY_MAX) but subtree preparation failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Starts a worker that registers every workflow in the registry and long-polls the
 * engine over outbound gRPC for work. On a real customer box this is the process the
 * installer runs and keeps alive. Run locally with `pnpm --filter @terragon/worker worker`.
 */
async function main() {
  // #5 fail-closed gate: refuse to boot against an auth-DISABLED engine (a
  // -dev/auth-off hatchet-lite embeds a public signing key → tenancy void). Runs
  // BEFORE anything else so a misconfigured box never registers a worker.
  try {
    await assertAuthEnabledFromEnv();
    console.log("[worker-boot] auth-enabled probe OK");
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: auth-enabled probe failed — refusing to start",
      err,
    );
    process.exit(1);
  }

  // #108 A5: agent-uid mode leans on node's built-in env-proxy support for the
  // agent CLI child. Node 20 has none, and a box on it would turn every fenced
  // run into a silent 90s stall with zero output rather than an error. Probe the
  // configured node ONCE at boot and refuse to start below the floor.
  try {
    const cfg = loadWorkerConfig();
    if (cfg.agentUser) {
      await assertNodeBinSupportsEnvProxy({
        nodeBin: cfg.nodeBin,
        exec: (file, args) => execFileAsync(file, args),
      });
      console.log(
        `[worker-boot] agent-uid mode: ${cfg.agentUser}; node env-proxy floor OK`,
      );
    }
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: agent-uid configuration is unusable — refusing to start",
      err,
    );
    process.exit(1);
  }

  // #183 (#152 Stage B1): the box's one agent-run lock is a kernel flock(2)
  // taken through a helper binary (lockf on darwin, flock on linux). Probe it
  // ONCE at boot, unconditionally, and refuse to start without it — a worker
  // that cannot take the lock would admit runs with no box-wide budget at all.
  try {
    const { file } = await assertBoxLockHelperAvailable();
    console.log(
      `[worker-boot] box lock helper OK: ${file}; lock file ${boxLockPath(loadWorkerConfig().runNamespaceRoot)}`,
    );
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: box lock helper unavailable — refusing to start",
      err,
    );
    process.exit(1);
  }

  await claimNamespaceAndReclaim();

  // #184 (#152 Stage B2): reclaim agent-uid escapees left by a dead worker,
  // under a NON-blocking take of the box lock. Busy ⇒ a live run owns the box
  // and its own teardown scan reclaims; never block or kill without the lock.
  // Never throws: fail-open on the scan (the box is still single-flight
  // without it); the helper assert above stays fail-closed.
  const bootUidScanConfig = loadWorkerConfig();
  await bootUidScan({
    root: bootUidScanConfig.runNamespaceRoot,
    agentUser: bootUidScanConfig.agentUser,
    log: (m) => console.log(`[worker-boot] ${m}`),
  });

  // #69 §3.2.4 item 2 — boot-time (secondary) engine-DB slot reclaim, BEFORE
  // registration so this registration's own fresh strategy rows are never
  // scanned as if they were the leak. Master-gated on
  // HATCHET_ENGINE_DATABASE_URL and fully try/catch-guarded internally: an
  // unconfigured or unreachable engine DB must never block boot.
  await bootTimeSlotReclaim(loadWorkerConfig());

  // #192 P5: the registered name carries the box, so two execution boxes are
  // two rows in the engine instead of one ambiguous one. Nothing queries this
  // name — the reapers key on getProcessWorkerId(), a separate per-process uuid
  // — so changing it costs an extra stale row after the first restart and
  // nothing else.
  const boxId = loadWorkerConfig().boxId;
  console.log(`[worker-boot] box id: ${boxId}`);

  // #204: prepare the delegated cgroup subtree once, at boot, before any run.
  //
  // Two reasons it cannot be per-run. The worker must move ITSELF out of the
  // delegated root (cgroup v2 refuses to enable controllers for the children of
  // a cgroup that holds processes), and doing that repeatedly is pointless; and
  // `cgroup.subtree_control` is a property of the root, not of a run.
  //
  // FAIL-CLOSED, and only for a box that asked. With `WORKER_RUN_MEMORY_MAX`
  // unset this returns immediately and the boot is what it has always been. With
  // it set and unarmable — no delegation, a mistyped `Delegate=`, not Linux — the
  // worker refuses to start and names the precondition that failed. The earlier
  // "log it and carry on" was the worst of both: the box then failed every run
  // while its boot log said the feature was simply off.
  try {
    prepareCeilingSubtreeAtBoot();
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: the per-run memory ceiling is configured but cannot be armed — refusing to start",
      err,
    );
    process.exit(1);
  }
  // ONE source for the name the engine knows this worker by: the #215 watchdog
  // probes for a row with exactly this name (namespaced), so a second literal
  // here could drift from it and leave the box silently unguarded.
  const workerName = `automata-worker-${boxId}`;
  const worker = await hatchet.worker(workerName, {
    workflows,
    // #125 C4 / #183: ONE slot per worker process and ONE unit per box:
    // `slots: 1` is the engine-native cross-workflow cap (the engine's global
    // concurrency key is per workflow — docs/uat/hatchet-lite-v0.94.10-observed.md
    // §5); the kernel box lock (box-lock.ts) covers the crash-relaunch overlap.
    // Everything else stays QUEUED on the engine, where a cancel/supersede is
    // free and no timeout clock is running.
    slots: 1,
  });

  // #215: in-process engine-liveness watchdog. OFF unless WORKER_LIVENESS_STALE_S is
  // set, in which case this is the only thing that turns a wedged-but-alive worker back
  // into a running one — the unit's Restart=always cannot fire on a process that never
  // exits. Armed here because `worker.start()` below never returns; note that the
  // engine Worker row does not exist yet either — `hatchet.worker()` only registers
  // workflows, and the row is minted by the gRPC Register inside `start()`. The
  // watchdog's own boot grace covers that window (see startEngineLivenessWatchdog).
  try {
    const cfg = loadWorkerConfig();
    if (cfg.livenessStaleAfterS <= 0) {
      console.log(
        "[worker-boot] engine-liveness watchdog: OFF (WORKER_LIVENESS_STALE_S unset)",
      );
    } else {
      // Resolved ONCE at arm time and closed over — never re-derived per tick (§17).
      const probeConfig = loadAuthProbeConfig();
      const probeWorkerName = resolveProbeWorkerName(
        workerName,
        hatchet.config.namespace,
      );
      const pollIntervalMs = cfg.livenessPollS * 1000;
      // §17: the abort budget must sit well below the tick period so a hung request
      // cannot stack ticks. Half a period, capped at LIVENESS_PROBE_TIMEOUT_CAP_MS.
      const timeoutMs = Math.min(
        LIVENESS_PROBE_TIMEOUT_CAP_MS,
        Math.floor(pollIntervalMs / 2),
      );
      startEngineLivenessWatchdog({
        staleAfterMs: cfg.livenessStaleAfterS * 1000,
        pollIntervalMs,
        probeWorkerName,
        probe: () =>
          probeEngineLiveness({
            apiUrl: probeConfig.apiUrl,
            tenantId: probeConfig.tenantId,
            token: probeConfig.realToken,
            probeWorkerName,
            timeoutMs,
          }),
        now: () => Date.now(),
        onWedged: (message) => {
          console.error(message);
          process.exit(1);
        },
        log: (m) => console.log(`[worker-liveness] ${m}`),
      });
      console.log(
        `[worker-liveness] armed: worker "${probeWorkerName}", stale after ${cfg.livenessStaleAfterS}s, poll ${cfg.livenessPollS}s`,
      );
    }
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: the engine-liveness watchdog is configured but cannot be armed — refusing to start",
      err,
    );
    process.exit(1);
  }

  // #69 §3.2.4 item 1 (PRIMARY path) + §3.1 rot repair + §3.3 stuck-QUEUED
  // detection. Runs AFTER registration so it observes the strategy rows THIS
  // registration just minted (§3.1.4 ordering note). Master-gated the same
  // way; starts nothing when HATCHET_ENGINE_DATABASE_URL is unset.
  startMaintenanceLoop(loadWorkerConfig(), getProcessWorkerId());

  // Graceful-drain semantics (Phase 3.1 / plan amendment 8). We deliberately install
  // NO custom SIGTERM/SIGINT handler: the Hatchet SDK already registers
  // `process.on('SIGTERM'|'SIGINT') → exitGracefully()`, which PAUSES task assignment
  // on the engine (stops picking up new runs) and then awaits the in-flight run to
  // completion before the process exits. A second handler of ours would RACE the
  // SDK's and risk tearing the daemon down mid-run — the exact drop we're preventing.
  // The operator restart procedure MUST therefore be SIGTERM + wait (never
  // `launchctl kickstart -k`, which is SIGKILL) — see packages/worker/deploy/README.md.
  // This log line lets an operator confirm the drain contract from worker.log.
  console.log(
    "[worker-boot] SIGTERM/SIGINT → SDK graceful drain (in-flight agent-run completes before exit; no custom handler by design)",
  );

  await worker.start();
}

main().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
