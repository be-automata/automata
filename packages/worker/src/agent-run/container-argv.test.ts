import { describe, expect, it } from "vitest";

import {
  assertHardenedArgv,
  buildContainerCreateArgv,
  CONTAINER_ARGV_ENV_ALLOWLIST,
  containerLanePolicy,
  containerNameForSlot,
  ContainerSpecError,
  REVIEW_LANE_DENIED_SKILLS,
  type ContainerRunSpec,
} from "./container-argv";
import { parsePinnedImage } from "./container-image";
import type { RunLane } from "./run-lane";

const IMAGE = parsePinnedImage(
  `ghcr.io/be-automata/automata-batteries@sha256:${"0f".repeat(32)}`,
);
const RUN_DIR = "/var/lib/automata/runs/thr_abc";

function spec(over: Partial<ContainerRunSpec> = {}): ContainerRunSpec {
  return {
    image: IMAGE,
    name: "automata-run-w-1-abcd-0",
    lane: "task",
    runDir: RUN_DIR,
    workspaceHostPath: `${RUN_DIR}/repo`,
    socketDirHostPath: `${RUN_DIR}/sock`,
    daemonBundleHostPath: "/usr/local/automata/daemon/index.js",
    labels: {
      workerId: "w-1-abcd",
      workerPid: 4242,
      boxId: "box-1",
      runId: "thr_abc",
      threadId: "thr_abc",
      slot: 0,
    },
    limits: {
      memoryBytes: 3 * 1024 ** 3,
      pidsLimit: 4096,
      cpus: 2,
      tmpBytes: 1024 ** 3,
      shmBytes: 512 * 1024 ** 2,
    },
    runGid: null,
    env: { HOME: "/home/agent", AUTOMATA_RUN_LANE: "task" },
    entryScript: 'exec "$@"',
    command: ["node", "/opt/automata-daemon/index.js"],
    ...over,
  };
}

/** The values a flag carries in the option section (before the image). */
function values(argv: string[], flag: string): string[] {
  const opts = argv.slice(0, argv.indexOf(IMAGE.reference));
  return opts.flatMap((a, i) => (a === flag ? [opts[i + 1] ?? ""] : []));
}

const LANES: RunLane[] = ["review", "pr", "task"];

describe("buildContainerCreateArgv: the hardening baseline (ADR-013 Decision 3)", () => {
  // card: protects=every lane's container gets --network none, --cap-drop ALL, no-new-privileges, --init, --read-only, --pull never, the non-root user and no log store; fails_when=any lane's argv drops or changes one of them; no_claim=that the daemon enforces them (the integration suite inspects a real container)
  it.each(LANES)("the %s lane carries the full baseline", (lane) => {
    const argv = buildContainerCreateArgv(spec({ lane }));
    expect(argv[0]).toBe("create");
    expect(values(argv, "--network")).toEqual(["none"]);
    expect(values(argv, "--cap-drop")).toEqual(["ALL"]);
    expect(values(argv, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(values(argv, "--pull")).toEqual(["never"]);
    expect(values(argv, "--user")).toEqual(["10001:10001"]);
    expect(values(argv, "--log-driver")).toEqual(["none"]);
    expect(argv).toContain("--init");
    expect(argv).toContain("--read-only");
    expect(argv).not.toContain("--privileged");
    expect(argv.some((a) => a.startsWith("--cap-add"))).toBe(false);
    expect(argv.some((a) => /seccomp|apparmor/.test(a))).toBe(false);
  });

  // card: protects=the slot tuple becomes --memory (= --memory-swap, no swap), --pids-limit and --cpus, plus a size-capped /tmp tmpfs and --shm-size; fails_when=a limit is missing, differs from the tuple, or swap is allowed; no_claim=cgroup enforcement (integration suite, and the rootless proof is a box P0 step)
  it("limits come from the slot tuple, with no swap", () => {
    const argv = buildContainerCreateArgv(spec());
    expect(values(argv, "--memory")).toEqual([`${3 * 1024 ** 3}b`]);
    expect(values(argv, "--memory-swap")).toEqual([`${3 * 1024 ** 3}b`]);
    expect(values(argv, "--pids-limit")).toEqual(["4096"]);
    expect(values(argv, "--cpus")).toEqual(["2"]);
    expect(values(argv, "--tmpfs")).toEqual([
      `/tmp:rw,nosuid,nodev,size=${1024 ** 3},mode=1777`,
    ]);
    expect(values(argv, "--shm-size")).toEqual([`${512 * 1024 ** 2}b`]);
  });

  // card: protects=the writable set is exactly /workspace (the clone), /run/automata (the socket dir), HOME, /opt/flutter and the Somnio adapters dir as anonymous volumes, and the daemon bundle read-only; fails_when=a mount is added, dropped, made named, or the bundle is writable; no_claim=volume population from the image (integration suite)
  it("mounts exactly the clone, the socket dir, the read-only bundle and three anonymous volumes", () => {
    const argv = buildContainerCreateArgv(spec());
    expect(values(argv, "--mount")).toEqual([
      `type=bind,src=${RUN_DIR}/repo,dst=/workspace`,
      `type=bind,src=${RUN_DIR}/sock,dst=/run/automata`,
      "type=bind,src=/usr/local/automata/daemon/index.js,dst=/opt/automata-daemon/index.js,readonly",
      "type=volume,dst=/home/agent",
      "type=volume,dst=/opt/flutter",
      "type=volume,dst=/opt/somnio-ai-tools/agent-rules/adapters",
    ]);
    expect(values(argv, "-v")).toEqual([]);
    expect(values(argv, "--volume")).toEqual([]);
  });

  // card: protects=labels name worker, worker pid, box, run, lane, thread and slot so boot/admission can remove by label and by name; fails_when=a label is missing or mislabelled; no_claim=that docker stores them (runtime adapter test)
  it("labels the container for boot and admission removal", () => {
    const argv = buildContainerCreateArgv(spec({ lane: "review" }));
    expect(values(argv, "--label")).toEqual([
      "automata.worker=w-1-abcd",
      "automata.worker-pid=4242",
      "automata.box=box-1",
      "automata.run=thr_abc",
      "automata.lane=review",
      "automata.thread=thr_abc",
      "automata.slot=0",
    ]);
    expect(values(argv, "--name")).toEqual(["automata-run-w-1-abcd-0"]);
  });

  // card: protects=the image is the pinned digest reference, run through `/bin/bash -c <entry> automata-entry <command…>`; fails_when=the image is a tag, the entrypoint differs, or the command is not passed through verbatim; no_claim=the entry script's behaviour (container-entry.test.ts)
  it("runs the entry script over the pinned digest and passes the command through", () => {
    const argv = buildContainerCreateArgv(spec());
    const at = argv.indexOf(IMAGE.reference);
    expect(argv.slice(at - 2, at)).toEqual(["--entrypoint", "/bin/bash"]);
    expect(argv.slice(at)).toEqual([
      IMAGE.reference,
      "-c",
      'exec "$@"',
      "automata-entry",
      "node",
      "/opt/automata-daemon/index.js",
    ]);
  });

  // card: protects=--group-add 0 appears iff the run-dir hand-over gid is configured; fails_when=it is added without a hand-over or missing with one; no_claim=that the hand-over grants the access (box P0 step)
  it("adds the hand-over group only when a run gid is configured", () => {
    expect(values(buildContainerCreateArgv(spec()), "--group-add")).toEqual([]);
    expect(
      values(buildContainerCreateArgv(spec({ runGid: 1001 })), "--group-add"),
    ).toEqual(["0"]);
  });
});

describe("buildContainerCreateArgv: refusals (ADR-013 I1/I2)", () => {
  // card: protects=only allowlisted, non-secret env names may ride the argv (visible in docker inspect); fails_when=ANTHROPIC_API_KEY/GH_TOKEN/any non-allowlisted key reaches the argv; no_claim=where the secrets go instead (container-policy.test.ts)
  it.each([
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "PATH",
  ])("refuses %s on the argv", (key) => {
    expect(() =>
      buildContainerCreateArgv(spec({ env: { [key]: "x" } })),
    ).toThrow(/may not travel on the docker argv/);
  });

  // card: protects=the allowlist holds only structural names; fails_when=a credential-shaped name is added to it; no_claim=the values those names carry
  it("the argv env allowlist holds no credential-shaped name", () => {
    for (const name of CONTAINER_ARGV_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASS|CRED|AUTH/);
    }
  });

  // card: protects=a writable bind mount outside the run dir (or the run dir itself, or a `..` escape) is refused; fails_when=any of them builds; no_claim=symlink resolution on the host (the paths are worker-built)
  it.each([
    { workspaceHostPath: "/home/operator/repo" },
    { socketDirHostPath: "/var/run" },
    { workspaceHostPath: RUN_DIR },
    { workspaceHostPath: `${RUN_DIR}/../other/repo` },
  ])("refuses the out-of-run-dir mount %j", (over) => {
    expect(() => buildContainerCreateArgv(spec(over))).toThrow(
      ContainerSpecError,
    );
  });

  // card: protects=a path with a comma or '=' cannot inject --mount options (e.g. `,readonly=false` or a second src); fails_when=such a path builds; no_claim=other shell quoting (argv is never a shell string)
  it("refuses a path that could inject mount options", () => {
    expect(() =>
      buildContainerCreateArgv(
        spec({ workspaceHostPath: `${RUN_DIR}/repo,dst=/etc` }),
      ),
    ).toThrow(/cannot carry/);
  });

  // card: protects=non-positive or non-integer limits are refused rather than emitted (an empty --memory means unlimited); fails_when=0, NaN or a fraction builds; no_claim=upper bounds (config validates the tuple)
  it.each([
    { memoryBytes: 0 },
    { pidsLimit: 0 },
    { pidsLimit: 1.5 },
    { cpus: 0 },
    { cpus: Number.NaN },
    { tmpBytes: -1 },
  ])("refuses the limit %j", (over) => {
    expect(() =>
      buildContainerCreateArgv(spec({ limits: { ...spec().limits, ...over } })),
    ).toThrow(ContainerSpecError);
  });

  // card: protects=an invalid container name is refused; fails_when=a name with a slash or space builds; no_claim=name uniqueness on the daemon
  it("refuses an invalid container name", () => {
    expect(() => buildContainerCreateArgv(spec({ name: "bad/name" }))).toThrow(
      /not a valid Docker name/,
    );
  });
});

describe("assertHardenedArgv: the post-build check", () => {
  const good = () => buildContainerCreateArgv(spec());
  const insert = (argv: string[], ...extra: string[]) => {
    const at = argv.indexOf(IMAGE.reference);
    return [...argv.slice(0, at), ...extra, ...argv.slice(at)];
  };

  // card: protects=a privileged/capability/host-namespace/docker-socket argv is refused even if something other than the builder produced it; fails_when=any of these passes; no_claim=flags the list does not name
  it.each([
    ["--privileged"],
    ["--cap-add", "SYS_ADMIN"],
    ["--pid", "host"],
    ["--network", "host"],
    ["--security-opt", "seccomp=unconfined"],
    ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
    ["--mount", "type=bind,src=/var/run/docker.sock,dst=/d.sock"],
    ["--mount", "type=bind,src=/etc,dst=/host-etc"],
    ["--mount", "type=volume,src=shared,dst=/shared"],
    ["--device", "/dev/kvm"],
  ])("refuses %j", (...extra) => {
    expect(() => assertHardenedArgv(insert(good(), ...extra), spec())).toThrow(
      /container argv refused/,
    );
  });

  // card: protects=dropping --read-only or --init, or a writable daemon bundle, is caught; fails_when=the stripped argv passes; no_claim=runtime behaviour
  it("refuses an argv missing --read-only, --init or the bundle's readonly", () => {
    const strip = (flag: string) => good().filter((a) => a !== flag);
    expect(() => assertHardenedArgv(strip("--read-only"), spec())).toThrow(
      /missing --read-only/,
    );
    expect(() => assertHardenedArgv(strip("--init"), spec())).toThrow(
      /missing --init/,
    );
    const writableBundle = good().map((a) => a.replace(/,readonly$/, ""));
    expect(() => assertHardenedArgv(writableBundle, spec())).toThrow(
      /read-only/,
    );
  });
});

describe("containerLanePolicy: the review fence as run-time inputs (ADR-004 via ADR-013)", () => {
  // card: protects=a review container gets no broker socket, no GitHub credential, no batteries hooks, no foreground hook, and denies the risky skills; fails_when=any review flag flips or a denied skill is dropped; no_claim=that the daemon applies reviewPolicyArgs (unchanged daemon code)
  it("review: absence of credentials and sockets, risky skills denied", () => {
    expect(containerLanePolicy("review")).toEqual({
      lane: "review",
      brokerSockets: false,
      githubCredential: false,
      denyRules: REVIEW_LANE_DENIED_SKILLS.map((s) => `Skill(${s})`),
      batteriesHooks: false,
      foregroundOnly: false,
    });
    expect(containerLanePolicy("review").denyRules).toContain("Skill(cso)");
  });

  // card: protects=task and pr lanes may receive brokered credentials (C3), get the batteries hooks and the foreground-only guard, and deny nothing; fails_when=a non-review lane is fenced like a review or loses its guard; no_claim=what C3 mounts
  it.each(["task", "pr"] as const)(
    "%s: brokers allowed, hooks + guard on",
    (lane) => {
      expect(containerLanePolicy(lane)).toEqual({
        lane,
        brokerSockets: true,
        githubCredential: true,
        denyRules: [],
        batteriesHooks: true,
        foregroundOnly: true,
      });
    },
  );
});

describe("containerNameForSlot", () => {
  // card: protects=one deterministic name per (worker, slot), so admission removes a crash-redelivered predecessor by name; fails_when=the name varies per run or accepts a negative slot; no_claim=cross-worker uniqueness (worker ids differ per process)
  it("is automata-run-<workerId>-<slot>", () => {
    expect(containerNameForSlot("w-77-1a2b3c4d", 2)).toBe(
      "automata-run-w-77-1a2b3c4d-2",
    );
    expect(() => containerNameForSlot("w-1", -1)).toThrow(ContainerSpecError);
  });
});
