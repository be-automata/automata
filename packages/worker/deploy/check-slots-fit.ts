/**
 * #372 pre-deploy check — run ON THE BOX before deploying a worker revision to
 * a box already above N = 1, with the worker's env loaded:
 *
 *   set -a; source /home/automata/.automata/worker-box.env; set +a
 *   cd /opt/automata-platform/packages/worker && pnpm exec tsx deploy/check-slots-fit.ts
 *
 * It runs the SAME two gates the worker runs at boot — loadWorkerConfig (the
 * tuple: WORKER_GLOBAL_MAX_RUNS = WORKER_BOX_SLOTS ≥ WORKER_PER_ORG_MAX_RUNS,
 * the #205 pairings, the #371 knobs) and assertSlotsFitCommitLimit (N × run
 * commit + base against fraction × this box's CommitLimit) — so the check and
 * the boot guard cannot drift apart. Exit 0 = the tuple boots here; exit 1 =
 * the worker would refuse to start, with the same message it would log.
 */
import { assertSlotsFitCommitLimit } from "../src/agent-run/box-slots-boot";
import { loadWorkerConfig } from "../src/agent-run/config";

try {
  const cfg = loadWorkerConfig();
  assertSlotsFitCommitLimit(cfg);
  console.log(
    `fits: WORKER_BOX_SLOTS=${cfg.boxSlots} WORKER_GLOBAL_MAX_RUNS=${cfg.globalMaxRuns} WORKER_PER_ORG_MAX_RUNS=${cfg.perOrgMaxRuns} run commit=${cfg.headroomRunCommitBytes} fraction=${cfg.headroomCommitFraction} (platform ${process.platform}${cfg.boxSlots <= 1 ? "; N = 1 — the commit budget is not checked" : ""})`,
  );
} catch (e) {
  console.error(`REFUSED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
