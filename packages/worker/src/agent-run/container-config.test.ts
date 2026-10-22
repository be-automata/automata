import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config";
import {
  containerRunsEnabled,
  DEFAULT_CONTAINER_DOCKER_SOCKET,
} from "./container-config";

const IMAGE = `ghcr.io/be-automata/automata-batteries@sha256:${"ab".repeat(32)}`;
const SEAL = { WORKER_PAYLOAD_SEAL_KEY_FILE: "/nonexistent/seal.key" };

describe("WORKER_DEV_CONTAINER_RUNS (ADR-013 Decision 6: dev-only, default OFF)", () => {
  // card: protects=only the exact value `1` turns the container path on; unset/0/typos leave production on the host path; fails_when=`true`, `yes`, ` 1x` or unset enables it; no_claim=boot behaviour (container-boot.test.ts)
  it.each([undefined, "", "0", "true", "yes", "on", "1x", "01"])(
    "%j leaves it off",
    (v) => {
      expect(containerRunsEnabled({ WORKER_DEV_CONTAINER_RUNS: v })).toBe(
        false,
      );
      expect(
        loadWorkerConfig({ ...SEAL, WORKER_DEV_CONTAINER_RUNS: v })
          .containerRuns,
      ).toBeNull();
    },
  );

  // card: protects=with the switch OFF, container knobs are never read — a stray tag or garbage value cannot stop a host-model box from booting; fails_when=loadWorkerConfig throws on them; no_claim=nothing
  it("off: stray container knobs are ignored", () => {
    expect(
      loadWorkerConfig({
        ...SEAL,
        WORKER_BATTERIES_IMAGE: "ghcr.io/x/y:latest",
        WORKER_CONTAINER_CPUS: "lots",
      }).containerRuns,
    ).toBeNull();
  });

  // card: protects=on: the pinned image, socket default, CPU/tmpfs/shm defaults and no hand-over gid are parsed, and the ceiling is required; fails_when=a default drifts or the tuple can be left unlimited; no_claim=the daemon at that socket existing
  it("on: parses the knobs with their defaults", () => {
    const cfg = loadWorkerConfig({
      ...SEAL,
      WORKER_DEV_CONTAINER_RUNS: "1",
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
      tmpBytes: 1024 ** 3,
      shmBytes: 512 * 1024 ** 2,
      runGid: null,
    });
    expect(cfg.memoryMaxBytes).toBe(3 * 1024 ** 3);
  });

  // card: protects=on: a tag image, a missing ceiling, a relative socket, bad CPUs or a tmpfs that eats the memory limit refuse to load; fails_when=any of them loads; no_claim=values within range being sensible for a given box
  it.each([
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
  ] as const)("on: refuses %j", (env, err) => {
    expect(() =>
      loadWorkerConfig({ ...SEAL, WORKER_DEV_CONTAINER_RUNS: "1", ...env }),
    ).toThrow(err);
  });

  // card: protects=the slot tuple (3 slots, ≤2/org, a ceiling) loads WITHOUT agent accounts when container runs are on (the container is the fence), and still refuses without them when off; fails_when=the relaxation leaks to the host path or the container path needs slot accounts; no_claim=engine registration
  it("on: the 3/2 slot tuple needs no agent uid; off: it still does", () => {
    const tuple = {
      ...SEAL,
      WORKER_BOX_SLOTS: "3",
      WORKER_GLOBAL_MAX_RUNS: "3",
      WORKER_PER_ORG_MAX_RUNS: "2",
      WORKER_RUN_MEMORY_MAX: "3G",
    };
    const on = loadWorkerConfig({
      ...tuple,
      WORKER_DEV_CONTAINER_RUNS: "1",
      WORKER_BATTERIES_IMAGE: IMAGE,
    });
    expect(on.boxSlots).toBe(3);
    expect(on.perOrgMaxRuns).toBe(2);
    expect(on.agentUser).toBe("");
    expect(() => loadWorkerConfig(tuple)).toThrow(/WORKER_AGENT_USER is empty/);
  });
});
