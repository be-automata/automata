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
import { harnessDoctorLine } from "../agent-run/batteries-seed";
import { loadPlaneKeysAtBoot } from "../agent-run/payload-seal-keys";
import { assertNodeBinSupportsEnvProxy } from "../agent-run/node-floor";
import {
  EGRESS_FENCE_UIDS_FILE,
  assertFenceCoversSlotUids,
  assertProcHidepid,
  assertSlotAccountsExist,
  assertSlotAccountsOutsideGroup,
  assertSlotSudoGrants,
  assertSlotWorkdirTraverse,
  assertSlotsFitCommitLimit,
  hidepidDropinLeftAtOneSlot,
  retiredSlotAccounts,
  warnIfSlotsExceedMemory,
} from "../agent-run/box-slots-boot";
import { sweepStaleRunDirs } from "../agent-run/provision";
import { reclaimDeadWorkerRuns } from "../agent-run/reclaim";
import { runTerminalRootBootLines } from "../agent-run/run-terminal-ledger";
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
import { containerRunsBoot } from "../agent-run/container-boot";
import { buildWorkflows } from "../registry";
import { headroomBootLine, headroomBootWarning } from "../agent-run/workflow";

const execFileAsync = promisify(execFile);

/**
 * Claim this worker process's namespaced run dir and reap orphans left by DEAD
 * sibling workers (Phase 0.2b). Order matters: write our OWN worker.lock FIRST so a
 * concurrently-booting sibling never mistakes our fresh dir for an orphan, THEN scan
 * siblings. Reclaim only ever group-SIGKILLs daemons under a dir whose worker pid is
 * confirmed dead — a live worker's daemons are never touched (safe for ≥2 workers).
 */
async function claimNamespaceAndReclaim(): Promise<void> {
  const cfg = loadWorkerConfig();
  const root = cfg.runNamespaceRoot;
  const workerId = getProcessWorkerId();
  try {
    // #108 F2: this ALSO applies the cross-uid ACEs, on the empty dir, before
    // anything is created inside it. macOS applies ACE inheritance at create
    // time, so a grant added later (per-run, inside DaemonProcess.start())
    // never reaches the gh-broker socket workflow.ts already bound.
    // #205: at N > 1 every slot account gets traverse here; the inheritable
    // grant lands on each slot's own subdir at admission (ensureSlotNamespace).
    await claimRunNamespace({
      root,
      workerId,
      agentUser: cfg.agentUser,
      agentUsers: cfg.agentUsers,
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
  // ADR-013 P1: a container run takes its ceiling as Docker's --memory on the
  // rootless daemon's own delegated subtree; the worker's subtree is unused.
  if (cfg.memoryMaxBytes <= 0 || cfg.containerRuns) {
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

  // #372: the FIRST config load has its own label. loadWorkerConfig validates
  // the whole concurrency tuple (WORKER_GLOBAL_MAX_RUNS = WORKER_BOX_SLOTS ≥
  // WORKER_PER_ORG_MAX_RUNS, the #204/#205 pairings, the #371 knobs) and
  // throws naming the knobs; a box with an inconsistent tuple must refuse to
  // start with THAT message, not one borrowed from the next probe's try block.
  let bootCfg: ReturnType<typeof loadWorkerConfig>;
  try {
    bootCfg = loadWorkerConfig();
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: worker configuration is invalid — refusing to start",
      err,
    );
    process.exit(1);
  }

  // #372: the memory side of the tuple against THIS box, decided BEFORE any
  // boot side effect (namespace claim, reclaim, uid scan, engine-DB repair): a
  // refused tuple under Restart=always must crash-loop on nothing but this
  // message. The config loader
  // checked the knobs against each other; this checks N × ceiling + base
  // against the kernel's commit budget (fail-closed, with the RAM warning
  // beside it), so an oversized tuple refuses to start instead of deferring
  // every run past the first until it fails (#371).
  try {
    assertSlotsFitCommitLimit(bootCfg);
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: the box slots do not fit this box's CommitLimit — refusing to start",
      err,
    );
    process.exit(1);
  }
  warnIfSlotsExceedMemory(bootCfg);

  // #108 A5: agent-uid mode leans on node's built-in env-proxy support for the
  // agent CLI child. Node 20 has none, and a box on it would turn every fenced
  // run into a silent 90s stall with zero output rather than an error. Probe the
  // configured node ONCE at boot and refuse to start below the floor.
  try {
    const cfg = bootCfg;
    if (cfg.agentUser) {
      await assertNodeBinSupportsEnvProxy({
        nodeBin: cfg.nodeBin,
        exec: (file, args) => execFileAsync(file, args),
      });
      console.log(
        `[worker-boot] agent-uid mode: ${cfg.agentUser}; node env-proxy floor OK`,
      );
      // #205, N > 1 only — N = 1 boots exactly as it always has (no new fatal
      // check, no new line; a missing account still surfaces at the first run,
      // as before). Above 1: every slot account must exist with its own
      // non-root, non-worker uid; sudo must let the worker run as each (a
      // Runas list not re-rendered for the new slots); and the kernel fence
      // must provably cover every slot uid (the preflight's marker, written
      // only after a successful `nft -f`). A box that fails any of these would
      // otherwise register N slots of capacity it does not have.
      if (cfg.boxSlots > 1) {
        const slotUids = await assertSlotAccountsExist(cfg.agentUsers);
        await assertSlotSudoGrants(cfg.agentUsers);
        await assertSlotWorkdirTraverse(cfg.agentUsers, cfg.workdirRoot);
        assertFenceCoversSlotUids({ uids: slotUids });
        const exemptGid = assertProcHidepid();
        await assertSlotAccountsOutsideGroup(cfg.agentUsers, exemptGid);
        console.log(
          `[worker-boot] box slots: ${cfg.boxSlots} (${cfg.agentUsers.join(", ")}; uids ${slotUids.join(", ")}); egress fence covers every slot uid (${EGRESS_FENCE_UIDS_FILE})`,
        );
      } else {
        // The drop-in that N > 1 needs relaxes hardening N = 1 does not have
        // to give up; nothing else notices it left behind after a rollback.
        const leftBehind = hidepidDropinLeftAtOneSlot();
        if (leftBehind) console.warn(`[worker-boot] WARNING: ${leftBehind}`);
      }
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
    const lockCfg = loadWorkerConfig();
    console.log(
      `[worker-boot] box lock helper OK: ${file}; lock file ${boxLockPath(lockCfg.runNamespaceRoot)}` +
        (lockCfg.boxSlots > 1
          ? ` (+ ${lockCfg.boxSlots - 1} slot file(s) box.lock.<i>, #205)`
          : ""),
    );
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: box lock helper unavailable — refusing to start",
      err,
    );
    process.exit(1);
  }

  // #380: the plane's seal key ring — MANDATORY since rollout step 4 (PR 2,
  // strict mode). A missing file, an unparseable one, or a key that fails its
  // own seal→unseal probe refuses boot BEFORE registration: every input is
  // sealed and plain-text inputs are refused, so a worker without a usable
  // ring would fail every run at its first step. The kid list printed here is
  // what an operator compares against the kid www logs at dispatch.
  try {
    const { payloadSealKeyFile } = loadWorkerConfig();
    const ring = await loadPlaneKeysAtBoot({ path: payloadSealKeyFile });
    console.log(
      `[worker-boot] payload seal: ${ring.kids.length} key(s) usable (${ring.kids.join(", ")}) from ${payloadSealKeyFile} — strict: sealed inputs only`,
    );
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: payload seal key file is missing or unusable — refusing to start (strict mode; see packages/worker/deploy/README.md › Payload seal key)",
      err,
    );
    process.exit(1);
  }

  await claimNamespaceAndReclaim();

  // ADR-013 P1: the dev-only container run path. Null (and silent) unless
  // WORKER_DEV_CONTAINER_RUNS=1; when on, the rootless daemon, the pinned
  // image and the orphan sweep are checked before registration, fail-closed.
  try {
    await containerRunsBoot({
      config: bootCfg,
      workerId: getProcessWorkerId(),
      log: (m) => console.log(`[worker-boot] ${m}`),
      warn: (m) => console.warn(`[worker-boot] WARNING: ${m}`),
    });
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: container runs are switched on but unusable — refusing to start",
      err,
    );
    process.exit(1);
  }

  // Harness battery packs (gstack, GSD, ruflo): one doctor line, never fatal.
  // A box without the harness install (or on the wrong Node) boots and runs
  // exactly as before; task runs that ask for the packs seed none and say
  // why. Also warms the per-pack tree validation, so the first run does not
  // walk node_modules while holding the box lock.
  console.log(`[worker-boot] ${await harnessDoctorLine()}`);

  // #184 (#152 Stage B2): reclaim agent-uid escapees left by a dead worker,
  // under a NON-blocking take of the box lock. Busy ⇒ a live run owns the box
  // and its own teardown scan reclaims; never block or kill without the lock.
  // Never throws: fail-open on the scan (the box is still single-flight
  // without it); the helper assert above stays fail-closed.
  const bootUidScanConfig = loadWorkerConfig();
  // #205: slot accounts a higher N left behind. No live slot guards them, so
  // the boot scan takes each one's own lock file and reaps it too, and the
  // stale-dir sweep hands back their dirs.
  const retiredSlots = await retiredSlotAccounts(
    bootUidScanConfig.agentUser,
    bootUidScanConfig.boxSlots,
  );
  await bootUidScan({
    root: bootUidScanConfig.runNamespaceRoot,
    agentUser: bootUidScanConfig.agentUser,
    // #205: every slot held, every slot's account scanned — or skipped whole.
    slots: bootUidScanConfig.boxSlots,
    retiredSlots,
    log: (m) => console.log(`[worker-boot] ${m}`),
  });

  // Remove run dirs older than 24h that earlier teardowns could not (every run
  // is hard-capped at 30 min, so a dir that old cannot belong to a live run on
  // any slot). AFTER the uid scan, so no escapee is still writing into them;
  // BEFORE registration, so the hand-back's own agent-uid processes are not
  // mistaken for escapees by a first run's admission scan. Never throws, and the
  // catch is belt and braces: residue must never stop a boot.
  try {
    await sweepStaleRunDirs({
      workdirRoot: bootUidScanConfig.workdirRoot,
      agentUser: bootUidScanConfig.agentUser,
      // #205: a stale dir may belong to any slot's account — including a slot
      // retired by a lower N; each hands back its own.
      agentUsers: [
        ...bootUidScanConfig.agentUsers,
        ...retiredSlots.map((r) => r.account),
      ],
      log: (m) => console.log(`[worker-boot] ${m}`),
    });
  } catch (err) {
    console.error("[worker-boot] stale run dirs sweep failed", err);
  }

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
  // The SAME config the "configuration is invalid" gate validated is what the
  // engine registration below reads — never a second parse of the env.
  const registrationConfig = bootCfg;
  const boxId = registrationConfig.boxId;
  console.log(`[worker-boot] box id: ${boxId}`);
  const ledgerBoot = runTerminalRootBootLines(
    registrationConfig.runTerminalRoot,
  );
  console.log(`[worker-boot] ${ledgerBoot.line}`);
  if (ledgerBoot.warning) {
    console.warn(`[worker-boot] WARNING: ${ledgerBoot.warning}`);
  }

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
  // #371: decide the memory-headroom gate once and say so — armed with its
  // thresholds, or OFF and why (inert rollback values, a platform without
  // /proc/meminfo). FAIL-CLOSED like the ceiling: a configured check whose
  // /proc/meminfo cannot be read at boot refuses to start instead of running
  // every job unguarded while the log says "OFF".
  try {
    const env = process.env;
    console.log(`[worker-boot] ${headroomBootLine(registrationConfig)}`);
    // #372: the caps the engine is about to be told, explicit or defaulted —
    // an unset WORKER_GLOBAL_MAX_RUNS follows the slots, so an N = 2 box's
    // per-variant global cap moves 1 → 2 on upgrade; the journal says so.
    console.log(
      `[worker-boot] engine caps: global=${registrationConfig.globalMaxRuns}${env.WORKER_GLOBAL_MAX_RUNS?.trim() ? "" : " (default = WORKER_BOX_SLOTS)"} per-org=${registrationConfig.perOrgMaxRuns}${env.WORKER_PER_ORG_MAX_RUNS?.trim() ? "" : " (default)"} slots=${registrationConfig.boxSlots} — one tuple, validated by loadWorkerConfig`,
    );
    const loadWarning = headroomBootWarning(registrationConfig);
    if (loadWarning) console.warn(`[worker-boot] WARNING: ${loadWarning}`);
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: the memory headroom check is configured but cannot be armed — refusing to start",
      err,
    );
    process.exit(1);
  }
  // ONE source for the name the engine knows this worker by: the #215 watchdog
  // probes for a row with exactly this name (namespaced), so a second literal
  // here could drift from it and leave the box silently unguarded.
  const workerName = `automata-worker-${boxId}`;
  const boxSlots = registrationConfig.boxSlots;
  const worker = await hatchet.worker(workerName, {
    // #372: the engine caps registered on every variant come from the SAME
    // validated config as `slots` below — loadWorkerConfig refused any tuple
    // where WORKER_GLOBAL_MAX_RUNS ≠ WORKER_BOX_SLOTS or the per-org cap exceeds
    // it, so what the engine admits per variant, what this worker accepts and
    // what the kernel box lock grants are one number.
    workflows: buildWorkflows({
      globalMaxRuns: registrationConfig.globalMaxRuns,
      perOrgMaxRuns: registrationConfig.perOrgMaxRuns,
    }),
    // #125 C4 / #183 / #205: ONE unit per box and `slots` = WORKER_BOX_SLOTS,
    // the engine-native cross-workflow cap (the engine's global concurrency key
    // is per workflow — docs/uat/hatchet-lite-v0.94.10-observed.md §5), equal to
    // the number of kernel slot locks the box holds (box-lock.ts), which cover
    // the crash-relaunch overlap. Everything else stays QUEUED on the engine,
    // where a cancel/supersede is free and no timeout clock is running.
    slots: boxSlots,
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
