import { CONTAINER_RUNS_SWITCH } from "./container-config";
import { ContainerRuntime, removeOrphanContainers } from "./container-runtime";
import type { WorkerConfig } from "./config";

/**
 * Boot for the dev-only container run path (ADR-013 P1). A no-op returning
 * null when `WORKER_DEV_CONTAINER_RUNS` is off — the production boot is
 * unchanged. When on, FAIL-CLOSED, before registration:
 *
 *   1. a WARNING that this box runs the dev-only path;
 *   2. the rootless daemon answers on the configured socket;
 *   3. the pinned digest is already in THAT daemon's store (I5: the run path
 *      never pulls; the provisioning pulls by digest ahead of time);
 *   4. every run container a dead worker of this box left behind is removed
 *      by label (ADR-013 Run path 7) — the container-path twin of the uid
 *      reaper's boot scan.
 */
export async function containerRunsBoot(opts: {
  config: Pick<WorkerConfig, "containerRuns" | "boxId">;
  workerId: string;
  log: (line: string) => void;
  warn: (line: string) => void;
  runtime?: Pick<
    ContainerRuntime,
    "ping" | "imagePresent" | "listByLabel" | "remove"
  >;
}): Promise<{ serverVersion: string; removed: string[] } | null> {
  const cr = opts.config.containerRuns;
  if (!cr) return null;
  opts.warn(
    `${CONTAINER_RUNS_SWITCH}=1: agent runs execute in containers from ${cr.image.reference} on the rootless daemon at ${cr.dockerSocket}. DEV/TEST ONLY until the ADR-013 release PR; never set on the production box.`,
  );
  const runtime =
    opts.runtime ??
    new ContainerRuntime({
      socketPath: cr.dockerSocket,
      dockerBin: cr.dockerBin,
    });
  let serverVersion: string;
  try {
    serverVersion = await runtime.ping();
  } catch (err) {
    throw new Error(
      `the container runtime at ${cr.dockerSocket} does not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!(await runtime.imagePresent(cr.image.reference))) {
    throw new Error(
      `the batteries image ${cr.image.reference} is not in the rootless daemon's store; pull it by digest first (the run path never pulls, ADR-013 I5)`,
    );
  }
  const { removed } = await removeOrphanContainers({
    runtime,
    boxId: opts.config.boxId,
    workerId: opts.workerId,
    log: opts.log,
  });
  opts.log(
    `container runs: daemon ${serverVersion} at ${cr.dockerSocket}; image ${cr.image.digest} present; ${removed.length} orphan container(s) removed`,
  );
  return { serverVersion, removed };
}
