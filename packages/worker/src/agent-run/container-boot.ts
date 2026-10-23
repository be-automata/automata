import { ContainerRuntime, removeOrphanContainers } from "./container-runtime";
import type { WorkerConfig } from "./config";

/**
 * Container-run boot (ADR-013), FAIL-CLOSED, before registration — every
 * agent run is a container, so a box that fails any step cannot run anything:
 *
 *   1. the rootless daemon answers on the configured socket;
 *   2. the pinned digest is already in THAT daemon's store (I5: the run path
 *      never pulls; the provisioning pulls by digest ahead of time);
 *   3. every run container a dead worker of this box left behind is removed
 *      by label (ADR-013 Run path 7).
 */
export async function containerRunsBoot(opts: {
  config: Pick<WorkerConfig, "containerRuns" | "boxId">;
  workerId: string;
  log: (line: string) => void;
  runtime?: Pick<
    ContainerRuntime,
    "ping" | "imagePresent" | "listByLabel" | "remove"
  >;
}): Promise<{ serverVersion: string; removed: string[] }> {
  const cr = opts.config.containerRuns;
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
