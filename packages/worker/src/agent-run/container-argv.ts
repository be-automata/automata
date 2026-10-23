import path from "node:path";

import type { PinnedImage } from "./container-image";
import type { RunLane } from "./run-lane";

/**
 * The pure `docker create` argv for one agent-run container (ADR-013
 * Decision 3, "Run path" step 3). No I/O: every input is a value, the output
 * is an argv array, and a spec that would break an ADR-013 invariant throws
 * instead of producing an argv. The runtime adapter (container-runtime.ts)
 * only ever executes what this returns.
 *
 * The hardening baseline, on EVERY lane:
 *   --network none · --cap-drop ALL · --security-opt no-new-privileges ·
 *   --init · --read-only · Docker's default seccomp (no override flag) ·
 *   --pull never (I5: never pull on the run path) · a non-root --user ·
 *   --memory = --memory-swap (no swap) · --pids-limit · --cpus ·
 *   a size-capped /tmp tmpfs · --shm-size · --log-driver none (agent output
 *   never lands in the daemon's log store; the worker attaches instead).
 *
 * Writable: /workspace (the host clone, bind) and the per-run anonymous
 * volumes HOME, /opt/flutter and the Somnio adapters dir (populated from the
 * image at create, removed with the container). Read-only: the daemon bundle. The run's socket dir is
 * bind-mounted at /run/automata. Nothing else from the host (I2).
 */

/** Where the run's clone is mounted (the agent's cwd). */
export const CONTAINER_WORKSPACE = "/workspace";
/** Where the run's socket dir is mounted (daemon socket + the C3 forwards). */
export const CONTAINER_SOCKET_DIR = "/run/automata";
/** The daemon socket inside the container. */
export const CONTAINER_DAEMON_SOCKET = `${CONTAINER_SOCKET_DIR}/daemon.sock`;
/** The image's runtime account and its HOME (deploy/images/batteries/Dockerfile). */
export const CONTAINER_USER = "10001:10001";
export const CONTAINER_HOME = "/home/agent";
/** Flutter writes stamps under bin/cache on every call, so it is a per-run volume. */
export const CONTAINER_FLUTTER_ROOT = "/opt/flutter";
/**
 * The Somnio CLI regenerates its Claude adapter files here on EVERY
 * `rules install` (generate.py `clean_adapter`), so on the read-only rootfs the
 * install exits 70 and writes nothing (measured on the published digest,
 * 2026-10-21). Same remedy as Flutter: a per-run volume populated from the image.
 */
export const CONTAINER_SOMNIO_ADAPTERS =
  "/opt/somnio-ai-tools/agent-rules/adapters";
/** The daemon bundle, bind-mounted read-only from the worker's own deploy. */
export const CONTAINER_DAEMON_BUNDLE = "/opt/automata-daemon/index.js";

/** Labels every run container carries; boot and admission remove by them. */
export const LABEL_WORKER = "automata.worker";
export const LABEL_WORKER_PID = "automata.worker-pid";
export const LABEL_BOX = "automata.box";
export const LABEL_RUN = "automata.run";
export const LABEL_LANE = "automata.lane";
export const LABEL_THREAD = "automata.thread";
export const LABEL_SLOT = "automata.slot";

/**
 * Env names allowed on the `docker create` argv. Argv env is visible in
 * `docker inspect` to anyone who can drive the daemon, so ONLY structural,
 * non-secret values go here; everything else (model credential, repo env,
 * broker bearer) travels in the run env file the worker copies into the
 * container's HOME before start (container-daemon-process.ts).
 */
export const CONTAINER_ARGV_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "FORCE_COLOR",
  "AUTOMATA_RUN_LANE",
  "AUTOMATA_THREAD_ID",
  "AUTOMATA_SOMNIO_STACKS",
]);

/**
 * What a lane gets inside its container — the review lane's ADR-004 fence as
 * RUN-TIME inputs, not install hiding (ADR-013 "Review-lane fence"). The image
 * holds every battery for every lane; the policy is what the worker mounts,
 * copies in and puts in the env.
 *
 * The permission mode itself (`--permission-mode default` + the
 * `reviewPolicyArgs` allow/deny lists for a review, skip-permissions
 * otherwise) is decided by the daemon from the pulled message, inside the
 * container, exactly as on the host path.
 */
export interface ContainerLanePolicy {
  lane: RunLane;
  /**
   * May the run's git/gh broker sockets be mounted (C3)? Never for a review:
   * ABSENCE, not denial (ADR-013 Run path 3).
   */
  brokerSockets: boolean;
  /** May any GitHub credential (bearer or token) reach the container's env? */
  githubCredential: boolean;
  /** Claude `permissions.deny` rules the copied-in settings carry. */
  denyRules: readonly string[];
  /** Merge the hooks gstack/GSD registered (`settings.batteries.json`)? */
  batteriesHooks: boolean;
  /** Install the foreground-only PreToolUse guard (every headless non-review run)? */
  foregroundOnly: boolean;
}

/**
 * Skills a review container may not invoke. `cso` replaces the battery the
 * host model DROPPED for the review lane (gstack cso can fall back to running
 * a PR-supplied script from the checkout; deploy/batteries.json `dropped`);
 * the rest publish or deploy, which a review never does and has no credential
 * for. Deny, not hide: the image ships them for the other lanes.
 */
export const REVIEW_LANE_DENIED_SKILLS: readonly string[] = [
  "cso",
  "ship",
  "land-and-deploy",
  "setup-deploy",
  "canary",
  "release",
];

export function containerLanePolicy(lane: RunLane): ContainerLanePolicy {
  if (lane === "review") {
    return {
      lane,
      brokerSockets: false,
      githubCredential: false,
      denyRules: REVIEW_LANE_DENIED_SKILLS.map((s) => `Skill(${s})`),
      batteriesHooks: false,
      foregroundOnly: false,
    };
  }
  return {
    lane,
    brokerSockets: true,
    githubCredential: true,
    denyRules: [],
    batteriesHooks: true,
    foregroundOnly: true,
  };
}

/** Everything one container's argv is built from. All host paths absolute. */
export interface ContainerRunSpec {
  image: PinnedImage;
  /** `automata-run-<workerId>-<slot>`: one per slot, so admission can remove a predecessor by name. */
  name: string;
  lane: RunLane;
  /** The run dir (`<workdirRoot>/<runId>`): every writable bind mount must sit inside it (I2). */
  runDir: string;
  /** `<runDir>/repo`, mounted at /workspace. */
  workspaceHostPath: string;
  /** `<runDir>/sock`, mounted at /run/automata. */
  socketDirHostPath: string;
  /** The daemon bundle file (WORKER_DAEMON_DIST), mounted read-only. */
  daemonBundleHostPath: string;
  labels: {
    workerId: string;
    workerPid: number;
    boxId: string;
    runId: string;
    threadId: string;
    slot: number;
  };
  limits: {
    /** WORKER_RUN_MEMORY_MAX: `--memory` and `--memory-swap` (no swap). */
    memoryBytes: number;
    /** WORKER_RUN_TASKS_MAX: `--pids-limit`. */
    pidsLimit: number;
    cpus: number;
    tmpBytes: number;
    shmBytes: number;
  };
  /** The run-dir hand-over gid (container gid 0); null = no `--group-add`. */
  runGid: number | null;
  /** Argv env; every key must be in CONTAINER_ARGV_ENV_ALLOWLIST. */
  env: Record<string, string>;
  /** The entry script (container-entry.ts) run by `/bin/bash -c`. */
  entryScript: string;
  /** What the entry execs once it is done (the daemon). */
  command: readonly string[];
}

/** A spec that would break an ADR-013 invariant. */
export class ContainerSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerSpecError";
  }
}

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The slot's one container name: `automata-run-<workerId>-<slot>`. */
export function containerNameForSlot(workerId: string, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new ContainerSpecError(`slot ${slot} is not a slot index`);
  }
  const name = `automata-run-${workerId}-${slot}`;
  if (!CONTAINER_NAME.test(name)) {
    throw new ContainerSpecError(
      `container name ${JSON.stringify(name)} is not a valid Docker name`,
    );
  }
  return name;
}

/** `true` iff `child` is `parent` or strictly inside it (no `..` escape). */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertHostPath(name: string, p: string): void {
  if (!path.isAbsolute(p) || path.normalize(p) !== p.replace(/\/+$/, "")) {
    throw new ContainerSpecError(
      `${name} must be an absolute, normalised host path, got ${JSON.stringify(p)}`,
    );
  }
  // `--mount` is comma-separated key=value: a comma or '=' in a path would
  // inject mount options.
  if (/[,=\n\r\0]/.test(p)) {
    throw new ContainerSpecError(
      `${name} ${JSON.stringify(p)} contains a character --mount cannot carry`,
    );
  }
}

function positiveInt(name: string, n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ContainerSpecError(
      `${name} must be a positive integer, got ${n}`,
    );
  }
}

/** The labels as `key=value` pairs, in a fixed order. */
export function containerLabels(
  spec: Pick<ContainerRunSpec, "labels" | "lane">,
): Array<[string, string]> {
  const l = spec.labels;
  return [
    [LABEL_WORKER, l.workerId],
    [LABEL_WORKER_PID, String(l.workerPid)],
    [LABEL_BOX, l.boxId],
    [LABEL_RUN, l.runId],
    [LABEL_LANE, spec.lane],
    [LABEL_THREAD, l.threadId],
    [LABEL_SLOT, String(l.slot)],
  ];
}

/**
 * The `docker create` argv (without the `docker` binary and the `-H` global
 * flag, which the runtime adapter adds). Throws ContainerSpecError on any
 * spec that breaks the baseline; the result is also re-checked by
 * `assertHardenedArgv` before it is returned, so a future edit that drops a
 * flag fails here, not on a box.
 */
export function buildContainerCreateArgv(spec: ContainerRunSpec): string[] {
  if (!CONTAINER_NAME.test(spec.name)) {
    throw new ContainerSpecError(
      `container name ${JSON.stringify(spec.name)} is not a valid Docker name`,
    );
  }
  assertHostPath("runDir", spec.runDir);
  assertHostPath("workspaceHostPath", spec.workspaceHostPath);
  assertHostPath("socketDirHostPath", spec.socketDirHostPath);
  assertHostPath("daemonBundleHostPath", spec.daemonBundleHostPath);
  for (const [name, p] of [
    ["workspaceHostPath", spec.workspaceHostPath],
    ["socketDirHostPath", spec.socketDirHostPath],
  ] as const) {
    if (p === spec.runDir || !isWithin(spec.runDir, p)) {
      throw new ContainerSpecError(
        `${name} ${JSON.stringify(p)} is not inside the run dir ${JSON.stringify(spec.runDir)}: a writable bind mount outside the run's own directory is forbidden (ADR-013 I2)`,
      );
    }
  }
  const { limits } = spec;
  positiveInt("limits.memoryBytes", limits.memoryBytes);
  positiveInt("limits.pidsLimit", limits.pidsLimit);
  positiveInt("limits.tmpBytes", limits.tmpBytes);
  positiveInt("limits.shmBytes", limits.shmBytes);
  if (!(limits.cpus > 0) || !Number.isFinite(limits.cpus)) {
    throw new ContainerSpecError(
      `limits.cpus must be a positive number, got ${limits.cpus}`,
    );
  }
  if (
    spec.runGid !== null &&
    !(Number.isSafeInteger(spec.runGid) && spec.runGid >= 0)
  ) {
    throw new ContainerSpecError(
      `runGid must be a gid or null, got ${spec.runGid}`,
    );
  }
  if (spec.command.length === 0) {
    throw new ContainerSpecError(
      "command is empty: the entry has nothing to exec",
    );
  }
  if (!spec.entryScript.trim()) {
    throw new ContainerSpecError("entryScript is empty");
  }

  const argv: string[] = ["create", "--name", spec.name, "--pull", "never"];
  for (const [k, v] of containerLabels(spec)) {
    if (/[\n\r\0]/.test(v)) {
      throw new ContainerSpecError(`label ${k} carries a control character`);
    }
    argv.push("--label", `${k}=${v}`);
  }
  argv.push(
    "--init",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    CONTAINER_USER,
    "--workdir",
    CONTAINER_WORKSPACE,
    "--log-driver",
    "none",
    "--memory",
    `${limits.memoryBytes}b`,
    "--memory-swap",
    `${limits.memoryBytes}b`,
    "--pids-limit",
    String(limits.pidsLimit),
    "--cpus",
    String(limits.cpus),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${limits.tmpBytes},mode=1777`,
    "--shm-size",
    `${limits.shmBytes}b`,
    "--mount",
    `type=bind,src=${spec.workspaceHostPath},dst=${CONTAINER_WORKSPACE}`,
    "--mount",
    `type=bind,src=${spec.socketDirHostPath},dst=${CONTAINER_SOCKET_DIR}`,
    "--mount",
    `type=bind,src=${spec.daemonBundleHostPath},dst=${CONTAINER_DAEMON_BUNDLE},readonly`,
    "--mount",
    `type=volume,dst=${CONTAINER_HOME}`,
    "--mount",
    `type=volume,dst=${CONTAINER_FLUTTER_ROOT}`,
    "--mount",
    `type=volume,dst=${CONTAINER_SOMNIO_ADAPTERS}`,
  );
  if (spec.runGid !== null) {
    // Container gid 0 is the rootless daemon user's primary group on the
    // host: the group the run dir was handed over to (ADR-013 "Daemon socket").
    argv.push("--group-add", "0");
  }
  for (const [k, v] of Object.entries(spec.env)) {
    if (!ENV_NAME.test(k) || !CONTAINER_ARGV_ENV_ALLOWLIST.has(k)) {
      throw new ContainerSpecError(
        `env ${JSON.stringify(k)} may not travel on the docker argv (visible in docker inspect); put it in the run env file`,
      );
    }
    if (/[\n\r\0]/.test(v)) {
      throw new ContainerSpecError(`env ${k} carries a control character`);
    }
    argv.push("--env", `${k}=${v}`);
  }
  argv.push(
    "--entrypoint",
    "/bin/bash",
    spec.image.reference,
    "-c",
    spec.entryScript,
    "automata-entry",
    ...spec.command,
  );
  assertHardenedArgv(argv, spec);
  return argv;
}

/**
 * The ONLY options a run container's argv may carry, with their arity (0 = a
 * boolean flag, 1 = takes the next token as its value). An allowlist, not a
 * denylist: Docker has aliases (`--net`), short forms (`-u`, `-e`), the
 * `--flag=value` spelling and new flags every release, and a denylist misses
 * whichever one it did not name. Anything not here — `--privileged`,
 * `--cap-add`, host namespaces, `-v`, `--env-file`, `--runtime`, `--sysctl` —
 * is refused, and so is any `--flag=value` token.
 */
const ALLOWED_OPTIONS: ReadonlyMap<string, 0 | 1> = new Map([
  ["--name", 1],
  ["--pull", 1],
  ["--label", 1],
  ["--init", 0],
  ["--network", 1],
  ["--cap-drop", 1],
  ["--security-opt", 1],
  ["--read-only", 0],
  ["--user", 1],
  ["--workdir", 1],
  ["--log-driver", 1],
  ["--memory", 1],
  ["--memory-swap", 1],
  ["--pids-limit", 1],
  ["--cpus", 1],
  ["--tmpfs", 1],
  ["--shm-size", 1],
  ["--mount", 1],
  ["--group-add", 1],
  ["--env", 1],
  ["--entrypoint", 1],
]);

/** `--mount` keys a run container may use, per mount type. */
const VOLUME_MOUNT_KEYS = new Set(["type", "dst", "destination", "target"]);
const BIND_MOUNT_KEYS = new Set([
  "type",
  "src",
  "source",
  "dst",
  "destination",
  "target",
  "readonly",
  "ro",
]);

/**
 * Re-check a built argv against the baseline. Exported for the tests and for
 * the runtime adapter, which refuses to `create` anything that fails it.
 * Only the option section (before the image reference) is inspected: what
 * follows the image is the entry's own argv.
 */
export function assertHardenedArgv(
  argv: readonly string[],
  spec: Pick<
    ContainerRunSpec,
    "image" | "runDir" | "daemonBundleHostPath" | "limits"
  >,
): void {
  const imageAt = argv.indexOf(spec.image.reference);
  if (argv[0] !== "create" || imageAt < 0) {
    throw new ContainerSpecError(
      "argv is not a `create` of the pinned image reference",
    );
  }
  const fail = (why: string): never => {
    throw new ContainerSpecError(`container argv refused: ${why}`);
  };
  // Tokenise the option section against the allowlist: every token is a
  // known flag or the value right after one.
  const parsed: Array<[string, string | null]> = [];
  for (let i = 1; i < imageAt; i++) {
    const flag = argv[i] ?? "";
    const arity = ALLOWED_OPTIONS.get(flag);
    if (arity === undefined) {
      fail(
        `flag ${JSON.stringify(flag)} is not on the run-container allowlist`,
      );
    }
    if (arity === 1) {
      if (i + 1 >= imageAt) fail(`${flag} has no value`);
      parsed.push([flag, argv[++i] ?? ""]);
    } else {
      parsed.push([flag, null]);
    }
  }
  const has = (flag: string): boolean => parsed.some(([f]) => f === flag);
  const valuesOf = (flag: string): string[] =>
    parsed.flatMap(([f, v]) => (f === flag && v !== null ? [v] : []));
  const one = (flag: string, expected: string) => {
    const vs = valuesOf(flag);
    if (vs.length !== 1 || vs[0] !== expected) {
      fail(`${flag} must be exactly ${expected}, got ${JSON.stringify(vs)}`);
    }
  };
  one("--network", "none");
  one("--cap-drop", "ALL");
  one("--pull", "never");
  one("--user", CONTAINER_USER);
  one("--memory", `${spec.limits.memoryBytes}b`);
  one("--memory-swap", `${spec.limits.memoryBytes}b`);
  one("--pids-limit", String(spec.limits.pidsLimit));
  one("--log-driver", "none");
  one("--entrypoint", "/bin/bash");
  for (const required of ["--init", "--read-only"]) {
    if (!has(required)) fail(`missing ${required}`);
  }
  // Container gid 0 (the run-dir hand-over group) is the only extra group.
  for (const g of valuesOf("--group-add")) {
    if (g !== "0") fail(`--group-add ${JSON.stringify(g)} (only 0 is allowed)`);
  }
  for (const t of valuesOf("--tmpfs")) {
    if (!t.startsWith("/tmp:"))
      fail(`--tmpfs ${JSON.stringify(t)} (only /tmp)`);
  }
  const secOpts = valuesOf("--security-opt");
  if (secOpts.length !== 1 || secOpts[0] !== "no-new-privileges") {
    // Exactly no-new-privileges: any seccomp=/apparmor=/label= override is out.
    fail(
      `--security-opt must be exactly no-new-privileges, got ${JSON.stringify(secOpts)}`,
    );
  }
  for (const mount of valuesOf("--mount")) {
    const fields = new Map(
      mount.split(",").map((kv) => {
        const eq = kv.indexOf("=");
        return eq < 0 ? [kv, ""] : [kv.slice(0, eq), kv.slice(eq + 1)];
      }),
    );
    const type = fields.get("type");
    const allowedKeys =
      type === "volume"
        ? VOLUME_MOUNT_KEYS
        : type === "bind"
          ? BIND_MOUNT_KEYS
          : fail(`mount type ${JSON.stringify(type)} is not allowed`);
    for (const key of fields.keys()) {
      // `src` on a volume names a shared volume; `volume-opt` can make an
      // anonymous one a bind of any host path; propagation leaks mounts.
      if (!allowedKeys.has(key)) {
        fail(`mount option ${JSON.stringify(key)} is not allowed: ${mount}`);
      }
    }
    if (type === "volume") continue;
    const src = fields.get("src") ?? fields.get("source") ?? "";
    if (/docker\.sock|containerd\.sock|\/var\/run\b|^\/run\/user\b/.test(src)) {
      fail(`a daemon socket or runtime dir may never be mounted: ${src}`);
    }
    const readonly = fields.has("readonly") || fields.get("ro") === "true";
    if (src === spec.daemonBundleHostPath) {
      if (!readonly) fail("the daemon bundle must be mounted read-only");
      continue;
    }
    if (src === spec.runDir || !isWithin(spec.runDir, src)) {
      fail(`bind mount ${src} is outside the run dir ${spec.runDir}`);
    }
  }
}
