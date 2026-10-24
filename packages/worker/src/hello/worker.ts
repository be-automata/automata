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
import { armGrowthTriggers } from "../agent-run/growth-triggers-io";
import { loadPlaneKeysAtBoot } from "../agent-run/payload-seal-keys";
import {
  assertSlotsFitCommitLimit,
  warnIfSlotsExceedMemory,
} from "../agent-run/box-slots-boot";
import { sweepStaleRunDirs } from "../agent-run/provision";
import { reclaimDeadWorkerRuns } from "../agent-run/reclaim";
import { runTerminalRootBootLines } from "../agent-run/run-terminal-ledger";
import {
  bootTimeSlotReclaim,
  startMaintenanceLoop,
} from "../agent-run/scheduling-maintenance";
import {
  claimRunNamespace,
  getProcessWorkerId,
} from "../agent-run/run-namespace";
import { containerRunsBoot } from "../agent-run/container-boot";
import { buildWorkflows } from "../registry";
import { headroomBootLine, headroomBootWarning } from "../agent-run/workflow";

/**
 * Claim this worker process's namespaced run dir and remove the dirs left by DEAD
 * sibling workers (Phase 0.2b). Order matters: write our OWN worker.lock FIRST so a
 * concurrently-booting sibling never mistakes our fresh dir for an orphan, THEN scan
 * siblings. Reclaim only ever removes a dir whose worker pid is confirmed dead — a
 * live worker's dir is never touched (safe for ≥2 workers).
 */
async function claimNamespaceAndReclaim(): Promise<void> {
  const cfg = loadWorkerConfig();
  const root = cfg.runNamespaceRoot;
  const workerId = getProcessWorkerId();
  try {
    await claimRunNamespace({ root, workerId });
  } catch (err) {
    // A worker that can't claim its dir would leak every run's resources — fail loud.
    console.error("worker: failed to claim run namespace", err);
    throw err;
  }
  reclaimDeadWorkerRuns({
    root,
    selfWorkerId: workerId,
    log: (message) => console.log(`[worker-boot] ${message}`),
  });
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
  // boot side effect (namespace claim, reclaim, engine-DB repair): a
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

  // ADR-013: every agent run is a container, so the rootless daemon, the
  // pinned image and the orphan sweep are checked before registration,
  // fail-closed: a box that fails here could run nothing.
  try {
    await containerRunsBoot({
      config: bootCfg,
      workerId: getProcessWorkerId(),
      log: (m) => console.log(`[worker-boot] ${m}`),
    });
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: the container runtime is unusable — refusing to start",
      err,
    );
    process.exit(1);
  }

  // Remove run dirs older than 24h that earlier teardowns could not (every run
  // is hard-capped at 30 min, so a dir that old cannot belong to a live run on
  // any slot). AFTER the orphan containers are removed, so nothing is still
  // writing into them. Never throws, and the catch is belt and braces: residue
  // must never stop a boot.
  try {
    await sweepStaleRunDirs({
      workdirRoot: bootCfg.workdirRoot,
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

  // #371: decide the memory-headroom gate once and say so — armed with its
  // thresholds, or OFF and why (inert rollback values, a platform without
  // /proc/meminfo). FAIL-CLOSED: a configured check whose
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

  // #373: growth-trigger evaluator. OFF unless WORKER_ALERT_WEBHOOK_URL is set — and
  // then SILENT: unlike #215 there is no OFF line, so an unconfigured box's boot log
  // stays byte-identical (AC 1). Configured but un-armable (a bad knob, an engine we
  // cannot resolve) refuses to start, exactly like #215: an operator who set the URL
  // expects alerts, and a box that boots without them is a silent gap. The webhook URL
  // is a secret and is never logged here.
  try {
    armGrowthTriggers(process.env, {
      resolveEngine: () => {
        const c = loadAuthProbeConfig();
        return { apiUrl: c.apiUrl, tenantId: c.tenantId, token: c.realToken };
      },
      snapshotDir: registrationConfig.runNamespaceRoot,
      boxId: registrationConfig.boxId,
    });
  } catch (err) {
    console.error(
      "[worker-boot] FATAL: growth triggers are configured but cannot be armed — refusing to start",
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
