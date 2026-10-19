/**
 * #372 pre-deploy check — run ON THE BOX before deploying a worker revision to
 * a box already above N = 1, with the worker's env loaded:
 *
 *   set -a; source /home/automata/.automata/worker-box.env; set +a
 *   cd /opt/automata-platform/packages/worker && pnpm exec tsx deploy/check-slots-fit.ts
 *
 * It runs the worker's MEMORY-TUPLE boot gates, imported from the boot code so
 * the check and the guard cannot drift apart: loadWorkerConfig (the tuple:
 * WORKER_GLOBAL_MAX_RUNS = WORKER_BOX_SLOTS ≥ WORKER_PER_ORG_MAX_RUNS, the #205
 * pairings, the #371 knobs), assessHeadroomSupport (the single-run commit
 * refusal and the unreadable-meminfo refusal, #371) and assertSlotsFitCommitLimit
 * (N × run commit + base against fraction × this box's CommitLimit, #372).
 * Exit 0 = those gates pass here; exit 1 = the worker would refuse to start,
 * with the same message it would log. NOT exercised (they need the service
 * user, sudo and the engine): the N > 1 slot-account / sudo Runas / workdir
 * traverse / hidepid checks, the node env-proxy probe and the auth probe.
 */
import { assertSlotsFitCommitLimit } from "../src/agent-run/box-slots-boot";
import { loadWorkerConfig } from "../src/agent-run/config";
import { assessHeadroomSupport } from "../src/agent-run/headroom";

try {
  const cfg = loadWorkerConfig();
  const headroom = assessHeadroomSupport({
    policy: {
      floorBytes: cfg.headroomFloorBytes,
      commitFraction: cfg.headroomCommitFraction,
      runCommitBytes: cfg.headroomRunCommitBytes,
    },
  });
  assertSlotsFitCommitLimit(cfg);
  console.log(
    `fits: WORKER_BOX_SLOTS=${cfg.boxSlots} WORKER_GLOBAL_MAX_RUNS=${cfg.globalMaxRuns} WORKER_PER_ORG_MAX_RUNS=${cfg.perOrgMaxRuns} run commit=${cfg.headroomRunCommitBytes} fraction=${cfg.headroomCommitFraction}; headroom check ${headroom.enabled ? "armed" : `OFF (${headroom.reason})`}${"warning" in headroom && headroom.warning ? `; WARNING ${headroom.warning}` : ""} (platform ${process.platform}; the N > 1 account/sudo/traverse/hidepid gates and the node/auth probes are not exercised here)`,
  );
} catch (e) {
  console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
