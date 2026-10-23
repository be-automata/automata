import path from "node:path";

import { parsePinnedImage, type PinnedImage } from "./container-image";

/**
 * The container run path (ADR-013), as the worker configuration sees it.
 * Since the release PR (P3) it is the ONLY execution path: every knob below
 * is read at boot and at every run, and an unusable value refuses both.
 * `WORKER_BATTERIES_IMAGE` (digest-pinned) and `WORKER_RUN_MEMORY_MAX` (the
 * slot tuple's per-run ceiling, which becomes `--memory`) are required.
 */

/**
 * The rootless daemon's API socket. Deliberately NOT `/run/user/<uid>/` (that
 * dir is 0700 to the daemon's own user): the box install
 * (deploy/linux/install-rootless-docker.sh) has the daemon listen here, in a
 * dir group-owned by `automata-docker`, which the worker joins. Reaching this
 * socket is acting as `automata-runner`, never as host root (ADR-013 Decision 2).
 */
export const DEFAULT_CONTAINER_DOCKER_SOCKET =
  "/run/automata-docker/docker.sock";

/** Default CPU quota per run container (`--cpus`). */
export const DEFAULT_CONTAINER_CPUS = 2;
/**
 * Default size cap of the `/tmp` tmpfs (counts against `--memory`). The two
 * tmpfs defaults together (768M) stay under the shipped 1500M per-run
 * ceiling, which refuses any pair whose sum reaches it.
 */
export const DEFAULT_CONTAINER_TMP_BYTES = 512 * 1024 ** 2;
/** Default `/dev/shm` size, for gstack's Chromium (counts against `--memory`). */
export const DEFAULT_CONTAINER_SHM_BYTES = 256 * 1024 ** 2;

export interface ContainerRunsConfig {
  /** The batteries image, digest-pinned (ADR-013 I5). */
  image: PinnedImage;
  /** Absolute path of the rootless daemon's unix socket. */
  dockerSocket: string;
  /** The docker CLI to drive it with (`WORKER_DOCKER_BIN`, default `docker` on PATH). */
  dockerBin: string;
  /** `--cpus` per run. */
  cpus: number;
  /** `/tmp` tmpfs size cap, bytes. */
  tmpBytes: number;
  /** `--shm-size`, bytes. */
  shmBytes: number;
  /**
   * The host gid the run dir is handed over to (ADR-013 "Daemon socket"): the
   * rootless daemon user's primary group, which is gid 0 inside the container.
   * null = no hand-over (a rootful dev daemon, or a host where the bind mounts
   * are already reachable); the container then gets no `--group-add`.
   */
  runGid: number | null;
}

/**
 * The container-run config. Throws on a box whose knobs are unusable — at
 * boot AND at every run, like every other loadWorkerConfig refusal.
 *
 * `memoryMaxBytes` is the slot tuple's per-run ceiling (`WORKER_RUN_MEMORY_MAX`):
 * it becomes `--memory`, so it is REQUIRED here. A run container without a
 * memory limit would break the box budget (ADR-007) the slot tuple exists for.
 */
export function parseContainerRunsConfig(
  env: NodeJS.ProcessEnv,
  memoryMaxBytes: number,
  parseBytes: (
    name: string,
    raw: string | undefined,
    fallback: number,
  ) => number,
): ContainerRunsConfig {
  const image = parsePinnedImage(env.WORKER_BATTERIES_IMAGE);
  if (memoryMaxBytes <= 0) {
    throw new Error(
      `WORKER_RUN_MEMORY_MAX is unset: every run container gets --memory from the slot tuple (ADR-013 Decision 3), so the ceiling is required`,
    );
  }
  const dockerSocket =
    env.WORKER_CONTAINER_DOCKER_SOCKET?.trim() ||
    DEFAULT_CONTAINER_DOCKER_SOCKET;
  if (!path.isAbsolute(dockerSocket)) {
    throw new Error(
      `WORKER_CONTAINER_DOCKER_SOCKET must be an absolute socket path, got ${JSON.stringify(dockerSocket)}`,
    );
  }
  const cpus = parseCpus(env.WORKER_CONTAINER_CPUS);
  const tmpBytes = parseBytes(
    "WORKER_CONTAINER_TMP_SIZE",
    env.WORKER_CONTAINER_TMP_SIZE,
    DEFAULT_CONTAINER_TMP_BYTES,
  );
  const shmBytes = parseBytes(
    "WORKER_CONTAINER_SHM_SIZE",
    env.WORKER_CONTAINER_SHM_SIZE,
    DEFAULT_CONTAINER_SHM_BYTES,
  );
  if (tmpBytes <= 0 || shmBytes <= 0) {
    throw new Error(
      "WORKER_CONTAINER_TMP_SIZE and WORKER_CONTAINER_SHM_SIZE must be positive: an unbounded tmpfs is not a cap",
    );
  }
  if (tmpBytes + shmBytes >= memoryMaxBytes) {
    throw new Error(
      `WORKER_CONTAINER_TMP_SIZE + WORKER_CONTAINER_SHM_SIZE (${tmpBytes + shmBytes} bytes) must stay below WORKER_RUN_MEMORY_MAX (${memoryMaxBytes}): tmpfs pages count against the container's --memory`,
    );
  }
  return {
    image,
    dockerSocket,
    dockerBin: env.WORKER_DOCKER_BIN?.trim() || "docker",
    cpus,
    tmpBytes,
    shmBytes,
    runGid: parseRunGid(env.WORKER_CONTAINER_RUN_GID),
  };
}

function parseCpus(raw: string | undefined): number {
  const v = raw?.trim() ?? "";
  if (!v) {
    return DEFAULT_CONTAINER_CPUS;
  }
  const n = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v) || !(n > 0) || n > 64) {
    throw new Error(
      `WORKER_CONTAINER_CPUS must be a decimal in (0, 64], got ${JSON.stringify(v)}`,
    );
  }
  return n;
}

function parseRunGid(raw: string | undefined): number | null {
  const v = raw?.trim() ?? "";
  if (!v) {
    return null;
  }
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n)) {
    throw new Error(
      `WORKER_CONTAINER_RUN_GID must be a non-negative integer gid, got ${JSON.stringify(v)}`,
    );
  }
  return n;
}
