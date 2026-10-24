import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config";
import { DEFAULT_CONTAINER_DOCKER_SOCKET } from "./container-config";

const IMAGE = `ghcr.io/be-automata/automata-batteries@sha256:${"ab".repeat(32)}`;
const SEAL = { WORKER_PAYLOAD_SEAL_KEY_FILE: "/nonexistent/seal.key" };

describe("container run config (ADR-013: the only execution path since P3)", () => {
  // card: protects=the pinned image, socket default, CPU/tmpfs/shm defaults and no hand-over gid are parsed on every box, with no switch; fails_when=a default drifts or a box loads without containerRuns; no_claim=the daemon at that socket existing
  it("parses the knobs with their defaults", () => {
    const cfg = loadWorkerConfig({
      ...SEAL,
      WORKER_BATTERIES_IMAGE: IMAGE,
      WORKER_RUN_MEMORY_MAX: "3G",
    });
    expect(cfg.containerRuns).toEqual({
      image: {
        repository: "ghcr.io/be-automata/automata-batteries",
        digest: `sha256:${"ab".repeat(32)}`,
        reference: IMAGE,
      },
      dockerSocket: DEFAULT_CONTAINER_DOCKER_SOCKET,
      dockerBin: "docker",
      cpus: 2,
      tmpBytes: 512 * 1024 ** 2,
      shmBytes: 256 * 1024 ** 2,
      runGid: null,
    });
    expect(cfg.memoryMaxBytes).toBe(3 * 1024 ** 3);
  });

  // card: protects=the tmpfs defaults fit the shipped 1500M per-run ceiling; fails_when=a default pair reaches it and a box with only the image and the tuple refuses to boot; no_claim=that 768M of tmpfs suits every workload
  it("the tmpfs defaults boot under the shipped 1500M ceiling", () => {
    const cfg = loadWorkerConfig({
      ...SEAL,
      WORKER_BATTERIES_IMAGE: IMAGE,
      WORKER_RUN_MEMORY_MAX: "1500M",
    });
    expect(cfg.containerRuns.tmpBytes).toBe(512 * 1024 ** 2);
    expect(cfg.containerRuns.shmBytes).toBe(256 * 1024 ** 2);
  });

  // card: protects=a missing or tag image, a missing ceiling, a relative socket, bad CPUs, a tmpfs that eats the memory limit or a bad gid refuse to load — at boot and per run, with no switch that could skip the check; fails_when=any of them loads; no_claim=values within range being sensible for a given box
  it.each([
    [{ WORKER_RUN_MEMORY_MAX: "3G" }, /WORKER_BATTERIES_IMAGE is empty/],
    [
      {
        WORKER_BATTERIES_IMAGE: "ghcr.io/be-automata/automata-batteries:latest",
        WORKER_RUN_MEMORY_MAX: "3G",
      },
      /not pinned by digest/,
    ],
    [{ WORKER_BATTERIES_IMAGE: IMAGE }, /WORKER_RUN_MEMORY_MAX is unset/],
    [
      {
        WORKER_BATTERIES_IMAGE: IMAGE,
        WORKER_RUN_MEMORY_MAX: "3G",
        WORKER_CONTAINER_DOCKER_SOCKET: "docker.sock",
      },
      /absolute socket path/,
    ],
    [
      {
        WORKER_BATTERIES_IMAGE: IMAGE,
        WORKER_RUN_MEMORY_MAX: "3G",
        WORKER_CONTAINER_CPUS: "0",
      },
      /WORKER_CONTAINER_CPUS/,
    ],
    [
      {
        WORKER_BATTERIES_IMAGE: IMAGE,
        WORKER_RUN_MEMORY_MAX: "1G",
        WORKER_CONTAINER_TMP_SIZE: "1G",
      },
      /must stay below WORKER_RUN_MEMORY_MAX/,
    ],
    [
      {
        WORKER_BATTERIES_IMAGE: IMAGE,
        WORKER_RUN_MEMORY_MAX: "3G",
        WORKER_CONTAINER_RUN_GID: "-1",
      },
      /WORKER_CONTAINER_RUN_GID/,
    ],
  ] as const)("refuses %j", (env, err) => {
    expect(() => loadWorkerConfig({ ...SEAL, ...env })).toThrow(err);
  });

  // card: protects=the slot tuple (3 slots, ≤2/org, a ceiling) loads with no agent account at all (each slot's run is its own container); fails_when=the tuple needs a slot account or another host-path key; no_claim=engine registration
  it("the 3/2 slot tuple loads without any agent account", () => {
    const cfg = loadWorkerConfig({
      ...SEAL,
      WORKER_BATTERIES_IMAGE: IMAGE,
      WORKER_BOX_SLOTS: "3",
      WORKER_GLOBAL_MAX_RUNS: "3",
      WORKER_PER_ORG_MAX_RUNS: "2",
      WORKER_RUN_MEMORY_MAX: "3G",
    });
    expect(cfg.boxSlots).toBe(3);
    expect(cfg.perOrgMaxRuns).toBe(2);
  });
});
