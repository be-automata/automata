import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONTAINER_DAEMON_SOCKET,
  CONTAINER_FLUTTER_ROOT,
  CONTAINER_HOME,
  CONTAINER_SOCKET_DIR,
  CONTAINER_WORKSPACE,
} from "./container-argv";
import { DEFAULT_CONTAINER_DOCKER_SOCKET } from "./container-config";
import { CONTAINER_BRIDGES } from "./container-entry";
import { parsePinnedImage } from "./container-image";
import { CONTAINER_GH_BROKER_SOCKET } from "./container-policy";

/**
 * The ADR-013 box assets: the rootless daemon installer, its user unit, the
 * limits proof (C2), the provisioning script (P2, #431) and the in-container
 * security probes (P2, #433). Static checks and fake-environment runs only:
 * nothing here runs as root or touches a daemon.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const linux = (f: string) => `packages/worker/deploy/linux/${f}`;
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const PROVISION = "deploy/provision-execution-box.sh";
const PROBES = linux("container-security-probes.sh");

const SCRIPTS = [
  linux("install-rootless-docker.sh"),
  linux("prove-container-limits.sh"),
  PROVISION,
  PROBES,
];

/** A script's code lines: its comments state guarantees in prose. */
const codeOf = (script: string) =>
  script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/** `name() {` … `}` bodies of a script's top-level functions. */
function functionBodies(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of script.matchAll(/^([a-z_]+)\(\) \{\n([\s\S]*?)\n\}$/gm)) {
    out.set(m[1] ?? "", m[2] ?? "");
  }
  return out;
}

describe.each(SCRIPTS)("%s: bash script hygiene", (rel) => {
  // card: protects=the script is tracked executable, bash in strict mode, parses and is shellcheck clean; fails_when=it loses +x, strict mode, parses wrong or regresses shellcheck; no_claim=its behaviour on a box
  it("is tracked executable, strict, parses and is shellcheck clean", (ctx) => {
    const mode = execFileSync("git", ["ls-files", "-s", rel], {
      cwd: repoRoot,
      encoding: "utf8",
    }).slice(0, 6);
    expect(mode).toBe("100755");
    const lines = read(rel).split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toBe("set -euo pipefail");
    expect(() =>
      execFileSync("bash", ["-n", path.join(repoRoot, rel)], { stdio: "pipe" }),
    ).not.toThrow();
    if (
      spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status !== 0
    ) {
      ctx.skip();
    }
    const r = spawnSync(
      "shellcheck",
      ["-s", "bash", path.join(repoRoot, rel)],
      {
        encoding: "utf8",
      },
    );
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("install-rootless-docker.sh + automata-runner-docker.service (ADR-013 Decision 2)", () => {
  const script = read(linux("install-rootless-docker.sh"));
  const unit = read(linux("automata-runner-docker.service"));

  // card: protects=the installer never names the deleted dev-only switch (ADR-013 I7) and never touches the worker unit, its env or the rootful daemon (production must not change); fails_when=it writes WORKER_DEV_CONTAINER_RUNS, edits automata-worker.service, or restarts docker.service; no_claim=what an operator does by hand
  it("never switches container runs on or touches the worker / rootful daemon", () => {
    // Code only: the header comment states these guarantees in prose.
    const code = script
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/WORKER_DEV_CONTAINER_RUNS/);
    expect(code).not.toMatch(/automata-worker\.service/);
    expect(code).not.toMatch(
      /systemctl\s+(restart|stop|reload)\s+docker(\.service)?\b/,
    );
    expect(code).not.toMatch(/\bsudoers\b/);
  });

  // card: protects=the daemon's socket path is ONE value across the installer, the unit and the worker's default; fails_when=any of the three drifts (the worker would talk to nothing, or to another daemon); no_claim=the rootlesskit copy-up making the path visible on the host (box P0 step)
  it("one socket path: installer, unit and worker default agree", () => {
    expect(DEFAULT_CONTAINER_DOCKER_SOCKET).toBe(
      "/run/automata-docker/docker.sock",
    );
    expect(script).toContain("SOCK_DIR=/run/automata-docker");
    expect(script).toContain('SOCK="$SOCK_DIR/docker.sock"');
    expect(unit).toContain(`--host=unix://${DEFAULT_CONTAINER_DOCKER_SOCKET}`);
  });

  // card: protects=the socket ends up automata-runner:automata-docker 0660 on the HOST: the group is set by the unit's ExecStartPost (host namespace), never by dockerd's --group, which resolves inside the rootless user namespace and lands on the host as a subordinate gid (987 became 166522, the worker got "permission denied"); fails_when=the unit passes a named --group to dockerd again, drops the host-side chgrp/chmod, or gives the socket a mode with "other" bits; no_claim=that the runner's user manager actually holds automata-docker at chgrp time (box run, and the installer's user-manager restart)
  it("socket group is set host-side, never by dockerd's in-namespace --group", () => {
    const execStart = unit.match(/^ExecStart=(.*)$/m)?.[1] ?? "";
    expect(execStart).toMatch(/ --group= /);
    expect(execStart).not.toMatch(/--group=\S/);
    const post = [...unit.matchAll(/^ExecStartPost=(.*)$/gm)].map((m) => m[1]);
    expect(post).toEqual([
      `/usr/bin/chgrp automata-docker ${DEFAULT_CONTAINER_DOCKER_SOCKET}`,
      `/usr/bin/chmod 0660 ${DEFAULT_CONTAINER_DOCKER_SOCKET}`,
    ]);
    // Type=notify: ExecStartPost runs once dockerd is READY (socket created).
    expect(unit).toMatch(/^Type=notify$/m);
    // The runner itself must be in the group to chgrp to it.
    expect(script).toMatch(/if ! in_group "\$RUNNER" "\$GROUP"; then/);
    expect(script).toMatch(/usermod -aG "\$GROUP" "\$RUNNER"/);
  });

  // card: protects=--check (and every install) fails unless the socket dir is automata-runner:automata-docker 0750 and the socket automata-runner:automata-docker 0660, so a subordinate gid or a world bit cannot pass as healthy; fails_when=either stat check is dropped or loosened (e.g. a 0755 dir or 0666 socket would pass); no_claim=the stat output format on non-GNU coreutils (Ubuntu only)
  it("verify checks the socket dir and socket owner, group and mode", () => {
    expect(script).toMatch(/d \$SOCK_DIR 0750 \$RUNNER \$GROUP -/);
    expect(script).toContain(`stat -c '%U:%G %a' "$SOCK_DIR"`);
    expect(script).toContain('[ "$got" = "$RUNNER:$GROUP 750" ]');
    expect(script).toContain(`stat -c '%U:%G %a' "$SOCK"`);
    expect(script).toContain(
      '[ -S "$SOCK" ] && [ "$got" = "$RUNNER:$GROUP 660" ]',
    );
    expect(script).toMatch(/FAIL socket-dir /);
    expect(script).toMatch(/FAIL socket-perms /);
  });

  // card: protects=the worker account joins automata-runner's PRIMARY group (the run-dir hand-over: setgid <runDir> group-owned by it, WORKER_CONTAINER_RUN_GID, --group-add 0) idempotently, and --check fails when it is missing; fails_when=the installer stops adding it, adds it unconditionally (non-idempotent), or verify stops checking it; no_claim=that a RUNNING worker picks the group up before it restarts
  it("worker joins the runner's primary group; --check verifies it", () => {
    expect(script).toContain('run_group="$(id -gn "$RUNNER")"');
    expect(script).toMatch(
      /for g in "\$GROUP" "\$run_group"; do\n\s+if ! in_group "\$worker_user" "\$g"; then\n(.*\n)?\s+usermod -aG "\$g" "\$worker_user"/,
    );
    const verify = script.slice(
      script.indexOf("verify() {"),
      script.indexOf("\n}\n", script.indexOf("verify() {")),
    );
    expect(verify).toContain('in_group "$worker_user" "$run_group"');
    expect(verify).toMatch(/FAIL worker-run-group /);
  });

  // card: protects=cgroup v2 delegation covers cpu, memory and pids for the runner's user manager, and the unit delegates its own subtree to dockerd; fails_when=a controller is dropped (the limits would be silently unenforced); no_claim=enforcement itself (prove-container-limits.sh on the box)
  it("delegates cpu, memory and pids to the runner and the unit", () => {
    expect(script).toMatch(/Delegate=cpu cpuset io memory pids/);
    expect(script).toContain(
      'dropin_dir="/etc/systemd/system/user@$runner_uid.service.d"',
    );
    expect(script).toContain('dropin="$dropin_dir/10-automata-delegate.conf"');
    expect(unit).toMatch(/^Delegate=yes$/m);
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/dockerd-rootless\.sh /m);
  });

  // card: protects=the runner is an unprivileged no-login system account and the worker reaches the socket by group, never via sudo; fails_when=the runner gets a login shell or the docs route the worker through sudo to dockerd; no_claim=PAM/sudo configuration on the box
  it("runner: no login shell; worker: group grant", () => {
    expect(script).toMatch(
      /useradd --system .*--shell \/usr\/sbin\/nologin "\$RUNNER"/,
    );
    expect(script).toMatch(
      /if ! in_group "\$worker_user" "\$g"; then\n(.*\n)?\s+usermod -aG "\$g" "\$worker_user"/,
    );
    expect(script).toMatch(/d \$SOCK_DIR 0750 \$RUNNER \$GROUP -/);
  });
});

describe("prove-container-limits.sh: each PASS needs its evidence (fake docker)", () => {
  /**
   * A fake `docker` answering each probe as an enforcing daemon would, and a
   * fake `uname` saying Linux, so the rm probe's host-pid check runs here
   * too. `TOP_PIDS` is what `docker top` reports for the rm probe.
   */
  function prove(topPids: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prove-"));
    try {
      fs.writeFileSync(path.join(dir, "uname"), "#!/bin/bash\necho Linux\n", {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(dir, "docker"),
        [
          "#!/bin/bash",
          "shift 2 # -H unix://…",
          'all="$*"',
          'case "$all" in',
          '  "run -d "*) echo cid ;;',
          '  "version "*) echo 27.0.0 ;;',
          '  "info "*) echo "cgroup v2" ;;',
          '  "inspect "*"-mem") echo "true 137" ;;',
          '  "inspect "*) exit 1 ;;',
          '  "run "*"-mem "*) exit 137 ;;',
          '  "run "*"--pids-limit 64 "*) echo 60 ;;',
          '  "run "*"--pids-limit 1024 "*) echo 203 ;;',
          '  "run "*"--cpus 0.5 "*) printf "nr_throttled 9\\nthrottled_usec 900\\n" ;;',
          '  "top "*) echo PID; printf "%s\\n" $TOP_PIDS ;;',
          '  "rm "*) : ;;',
          '  *) echo "fake docker: unexpected $all" >&2; exit 99 ;;',
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
      return spawnSync(
        "bash",
        [
          path.join(repoRoot, linux("prove-container-limits.sh")),
          "/run/fake.sock",
          "img@sha256:00",
        ],
        {
          encoding: "utf8",
          env: { PATH: `${dir}:${process.env.PATH}`, TOP_PIDS: topPids },
          timeout: 30_000,
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // card: protects=an enforcing daemon passes every probe; fails_when=a probe misreads a real limit; no_claim=a real daemon (the box run)
  it("all four probes pass against an enforcing daemon", () => {
    // Two pids no process can have: nothing survives the removal.
    const r = prove("4194301 4194302");
    expect(r.stdout).toMatch(/^PASS memory /m);
    expect(r.stdout).toMatch(/^PASS pids /m);
    expect(r.stdout).toMatch(/^PASS cpus /m);
    expect(r.stdout).toMatch(/^PASS rm /m);
    expect(r.status).toBe(0);
  });

  // card: protects=a container process still alive after `docker rm -f` FAILS the rm probe even when it belongs to another uid (a rootless container's processes are subordinate uids, so `kill -0` from the worker is EPERM for live ones); fails_when=a live pid of another account counts as gone; no_claim=pid reuse within the 1 s settle
  it("rm: a surviving process of another uid is caught", () => {
    // pid 1 is alive and never the test runner's own, like a container's.
    const r = prove(`1 4194302`);
    expect(r.stdout).toMatch(/^FAIL rm .*host pid\(s\) 1 still alive/m);
    expect(r.status).toBe(1);
  });
});

describe("deploy/provision-execution-box.sh (ADR-013 Fleet, P2 #431)", () => {
  const script = read(PROVISION);
  const code = codeOf(script);
  const bodies = functionBodies(script);
  const DIGEST = `sha256:${"ab12".repeat(16)}`;

  /** Run the script unprivileged: it refuses a reference before anything else. */
  function provision(...args: string[]) {
    return spawnSync(
      "bash",
      [
        path.join(repoRoot, PROVISION),
        "--worker-user",
        "automata-test-no-such-account",
        "--dry-run",
        ...args,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
  }

  // card: protects=no mode of the script names the dev-only container switch the release deleted (ADR-013 I7: one execution path, no switch); fails_when=any code line names WORKER_DEV_CONTAINER_RUNS; no_claim=what an operator types into the env file
  it("never names the deleted dev-only container switch", () => {
    expect(code).not.toMatch(/WORKER_DEV_CONTAINER_RUNS/);
    expect(code).not.toMatch(/DEV_CONTAINER/);
  });

  // card: protects=/proc's hidepid (the host-uid fence) is touched only in full mode, which backs up /etc/fstab before dropping the line and remounting; prepare-only reports it and skips image-verify instead of failing; fails_when=prepare-only edits fstab or remounts /proc (a production change before the release), or full mode leaves hidepid (no container can start); no_claim=the kernel's remount behaviour (box-proven 2026-10-23)
  it("removes /proc hidepid only in full mode", () => {
    const fn = code.slice(
      code.indexOf("step_proc_hidepid() {"),
      code.indexOf("step_verify() {"),
    );
    const guard = fn.indexOf('if [ "$mode" != full ]; then');
    expect(guard).toBeGreaterThan(-1);
    expect(fn.indexOf("cp -p /etc/fstab")).toBeGreaterThan(guard);
    expect(fn.indexOf("mount -o remount,hidepid=off /proc")).toBeGreaterThan(
      guard,
    );
    expect(fn).toMatch(/hidepid_blocks=1/);
    expect(code).toMatch(/step_proc_hidepid\nstep_verify/);
  });

  // card: protects=on a box that already runs docker-ce (the engine stack), a Docker package the script or the installer adds is pinned to docker-ce's installed version, so apt never upgrades docker-ce and restarts the root daemon; fails_when=either script passes a bare docker-ce* package to apt-get install; no_claim=apt's resolution itself (simulated on the production box, 2026-10-23: the bare name upgraded docker-ce 29.8.1 -> 29.9.2, the pinned one did not)
  it("pins added Docker packages to the installed docker-ce version", () => {
    const installer = read(
      "packages/worker/deploy/linux/install-rootless-docker.sh",
    );
    for (const src of [code, installer]) {
      expect(src).toMatch(/dpkg-query -W -f='\$\{Version\}' docker-ce\b/);
    }
    expect(code).toMatch(/docker-ce\*\) printf ' %s=%s' "\$pkg" "\$dce_ver"/);
    expect(installer).toMatch(
      /missing\[i\]="docker-ce-rootless-extras=\$dce_ver"/,
    );
  });

  // card: protects=the script accepts exactly the references the worker accepts (parsePinnedImage, ADR-013 I5): a tag, tag+digest, a short or uppercase digest, an uppercase repository or whitespace is refused (exit 2) before any step; a digest reference passes validation; fails_when=the shell check and the worker's parser disagree on any of these; no_claim=a reference the table does not list
  it.skipIf(process.getuid?.() === 0)(
    "refuses exactly the references the worker refuses",
    () => {
      const refs = [
        `ghcr.io/be-automata/automata-batteries@${DIGEST}`,
        `localhost:5000/team/batteries@${DIGEST}`,
        `ubuntu@${DIGEST}`,
        "ghcr.io/be-automata/automata-batteries:latest",
        "ghcr.io/be-automata/automata-batteries",
        `ghcr.io/be-automata/automata-batteries:sha-abc@${DIGEST}`,
        `ghcr.io/be-automata/automata-batteries@sha256:${"AB12".repeat(16)}`,
        "ghcr.io/be-automata/automata-batteries@sha256:abc",
        `ghcr.io/Be-Automata/automata-batteries@${DIGEST}`,
        `ghcr.io/x/y@${DIGEST}@${DIGEST}`,
        `ghcr.io/x/y @${DIGEST}`,
      ];
      for (const ref of refs) {
        let workerAccepts = true;
        try {
          parsePinnedImage(ref);
        } catch {
          workerAccepts = false;
        }
        const r = provision("--image", ref);
        // Accepted: past validation it stops at the root check (or, as root,
        // at the missing worker account): exit 1, never 2.
        expect({ ref, status: r.status }).toEqual({
          ref,
          status: workerAccepts ? 1 : 2,
        });
        if (!workerAccepts) expect(r.stderr).toMatch(/refused:/);
      }
      expect(provision("--image", "x:latest").stderr).toMatch(
        /not pinned by digest/,
      );
      expect(provision().status).toBe(2);
    },
  );

  // card: protects=--prepare-only (the PRODUCTION box before the release) touches no worker unit, launcher or env: every write to them lives in a step_worker_* function, and those are called only from the full-mode branch, the prepare-only branch printing `skip` for each; fails_when=a worker write moves into a shared step or top-level code, or a step_worker_* call escapes the full-mode branch; no_claim=the box run itself (the lead's P2 proof)
  it("--prepare-only never reaches the worker unit, launcher or env", () => {
    const fullAt = code.indexOf('if [ "$mode" = full ]; then');
    const elseAt = code.indexOf("\nelse\n", fullAt);
    const fiAt = code.indexOf("\nfi", elseAt);
    expect(fullAt).toBeGreaterThan(0);
    expect(elseAt).toBeGreaterThan(fullAt);
    const prepareBranch = code.slice(elseAt, fiAt);
    const calls = [...code.matchAll(/^\s*(step_worker_[a-z]+)\s*$/gm)];
    expect(calls.map((m) => m[1])).toEqual([
      "step_worker_runtime",
      "step_worker_launcher",
      "step_worker_unit",
      "step_worker_env",
    ]);
    for (const m of calls) {
      expect(m.index).toBeGreaterThan(fullAt);
      expect(m.index).toBeLessThan(elseAt);
    }
    for (const step of ["runtime", "launcher", "unit", "env"]) {
      expect(prepareBranch).toContain(
        `report skip worker-${step} "prepare-only"`,
      );
    }
    // Every write to the worker's side lives in a step_worker_* body (or the
    // two write helpers those call), never in a step both modes run.
    const WORKER_WRITES =
      /systemctl|worker-box\.env|install_if_changed |ensure_dot_automata |"\$UNIT_PATH"/;
    expect(bodies.size).toBeGreaterThan(10);
    for (const [name, body] of bodies) {
      if (
        name.startsWith("step_worker_") ||
        name === "install_if_changed" ||
        name === "ensure_dot_automata"
      ) {
        continue;
      }
      expect({ name, writes: WORKER_WRITES.test(codeOf(body)) }).toEqual({
        name,
        writes: false,
      });
    }
    let topLevel = code;
    for (const m of script.matchAll(/^[a-z_]+\(\) \{\n[\s\S]*?\n\}$/gm)) {
      topLevel = topLevel.replace(codeOf(m[0]), "");
    }
    expect(topLevel).not.toMatch(WORKER_WRITES);
  });

  // card: protects=nothing host-path is deprovisioned in any mode (that is P4) and no image is ever removed (the previous digest stays pulled for rollback); fails_when=the script deletes accounts, sudoers lines, nft tables, drop-ins or images, or edits subuid/delegation itself instead of calling the installer; no_claim=what the reused installer does (its own tests above)
  it("never deprovisions host-path state or removes an image", () => {
    expect(code).not.toMatch(
      /\buserdel\b|\buseradd\b|\bgroupdel\b|sudoers|\bnft\s|\brmi\b|image (rm|prune)|system prune|\brm -r|service\.d\/|subuid|Delegate=/,
    );
    // The loader line is only ever left out of a NEW render, and only when the
    // fence is not provisioned; a provisioned box keeps it.
    const unit = codeOf(bodies.get("step_worker_unit") ?? "");
    const fenceCheck = unit.indexOf(
      'if [ -r "$LOOPBACK_CONF" ] && [ -x "$LOOPBACK_LOADER" ]; then',
    );
    const elseAt = unit.indexOf("\n  else\n", fenceCheck);
    const dropAt = unit.indexOf("nft-loopback-load");
    expect(fenceCheck).toBeGreaterThan(0);
    expect(dropAt).toBeGreaterThan(elseAt);
    expect(elseAt).toBeGreaterThan(fenceCheck);
    expect(code.match(/nft-loopback-load/g)).toHaveLength(2);
    // The previous digest is pulled back if gone, never pruned, unless the
    // pull would starve the disk the runs need.
    const previous = bodies.get("step_previous") ?? "";
    expect(previous).toContain('step_pull previous-image "$previous"');
    expect(previous.indexOf("! previous_fits")).toBeGreaterThan(0);
    expect(previous.indexOf("! previous_fits")).toBeLessThan(
      previous.indexOf("step_pull previous-image"),
    );
    expect(script).toContain(
      'PREVIOUS_MIN_FREE_GB="${PREVIOUS_MIN_FREE_GB:-10}"',
    );
    expect(code).not.toMatch(
      /docker[^\n]*\b(rmi|image rm|image prune|system prune)\b/,
    );
  });

  // card: protects=the rootless daemon comes from install-rootless-docker.sh (reuse, not a second copy), its --check decides ok vs changed, and the socket is the one the worker defaults to; fails_when=the script stops calling the installer, skips its --check, or names another socket; no_claim=the installer's behaviour on a box
  it("reuses the rootless installer and its socket", () => {
    expect(script).toContain(
      'INSTALLER="$repo/packages/worker/deploy/linux/install-rootless-docker.sh"',
    );
    const rootless = bodies.get("step_rootless") ?? "";
    expect(rootless).toContain(
      '"$INSTALLER" --worker-user "$worker_user" --check',
    );
    expect(rootless).toMatch(/report ok rootless-daemon/);
    expect(rootless).toMatch(/report changed rootless-daemon/);
    expect(script).toContain(`SOCK=${DEFAULT_CONTAINER_DOCKER_SOCKET}`);
    expect(bodies.get("step_worker_env")).toContain(
      '"WORKER_CONTAINER_DOCKER_SOCKET=$SOCK"',
    );
  });

  // card: protects=the image is pulled by digest into the ROOTLESS store, attested against be-automata/automata and smoke-tested with verify.sh before the worker is pointed at it; a missing gh skips attestation only with a loud stderr WARNING, never silently; fails_when=the attestation call, its repo, the WARNING or the verify.sh run is dropped, or the steps run out of order; no_claim=gh's network behaviour or the attestation's content
  it("pull by digest, attestation (loud skip without gh), verify.sh", () => {
    expect(script).toContain("ATTEST_REPO=be-automata/automata");
    const attest = bodies.get("step_attestation") ?? "";
    expect(attest).toContain(
      'gh attestation verify "oci://$image" --repo "$ATTEST_REPO"',
    );
    expect(attest).toMatch(/echo "WARNING [^\n]*NOT"/);
    expect(attest).toMatch(/\} >&2\n\s+report skip image-attestation/);
    expect(bodies.get("step_pull")).toContain('runner_docker pull "$ref"');
    expect(bodies.get("runner_docker")).toContain('docker -H "unix://$SOCK"');
    expect(bodies.get("step_verify")).toContain('"$VERIFY" "$image"');
    expect(script).toContain(
      'VERIFY="$repo/deploy/images/batteries/verify.sh"',
    );
    const order = [
      "step_packages",
      "step_rootless",
      'step_pull image-pull "$image"',
      "step_attestation",
      "step_verify",
      "step_record",
      "step_previous",
    ].map((s) => code.lastIndexOf(`\n${s}\n`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // card: protects=one `ok|changed|skip <step>` line per step and `FAIL <step>` + exit 1 on a failure; fails_when=a step reports with another status word or fail() stops exiting non-zero; no_claim=the wording of each detail
  it("reports one ok|changed|skip line per step; FAIL exits 1", () => {
    const statuses = [...code.matchAll(/\breport (\S+) /g)].map((m) => m[1]);
    expect(statuses.length).toBeGreaterThan(20);
    for (const s of statuses) {
      expect(["ok", "changed", "skip"]).toContain(s);
    }
    expect(bodies.get("fail")).toMatch(
      /printf 'FAIL %s %s\\n' "\$1" "\$2"\n\s+exit 1/,
    );
  });

  // card: protects=the host node floor in step_worker_runtime (22.x >= 22.21, or >= 24) is the one the script documents and fails closed; fails_when=the stated floor and the check drift apart, or a below-floor, 23.x or unparseable node passes; no_claim=the pnpm check or the report wording
  describe("step_worker_runtime node floor", () => {
    it("states the floor it checks", () => {
      expect(script).toContain("# >=22.21.0 on 22.x, or >=24.0.0.");
      expect(bodies.get("step_worker_runtime")).toContain(
        "node >=22.21.0 (22.x) or >=24 is required",
      );
    });

    /** Run the step alone against a stubbed `node` (the script itself needs root). */
    function runStep(nodeOutput: string) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-floor-"));
      try {
        const stub = (name: string, body: string) => {
          const f = path.join(dir, name);
          fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        };
        stub("node", `printf '%s\\n' '${nodeOutput}'`);
        stub("pnpm", "exit 0");
        const harness = [
          `report() { printf '%s %s %s\\n' "$1" "$2" "$3"; }`,
          `fail() { printf 'FAIL %s %s\\n' "$1" "$2"; exit 1; }`,
          `step_worker_runtime() {`,
          bodies.get("step_worker_runtime") ?? "",
          `}`,
          `step_worker_runtime`,
        ].join("\n");
        return spawnSync("bash", ["-c", harness], {
          encoding: "utf8",
          timeout: 30_000,
          env: { PATH: `${dir}:/usr/bin:/bin` },
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    it.each([
      ["22.20.0", false],
      ["22.21.0", true],
      ["22.22.1", true],
      ["23.11.0", false],
      ["24.0.0", true],
      ["25.1.0", true],
      ["20.19.0", false],
      ["garbage", false],
      ["", false],
    ])("node %j accepted=%s", (version, accepted) => {
      const r = runStep(version);
      expect(r.status).toBe(accepted ? 0 : 1);
      expect(r.stdout).toMatch(
        accepted ? /^ok worker-runtime / : /^FAIL worker-runtime /,
      );
    });
  });
});

describe("container-security-probes.sh (ADR-013 Security probes, P2 #433)", () => {
  const script = read(PROBES);

  interface FakeProc {
    comm: string;
    cmdline: string;
    environ?: string;
  }
  interface Fixture {
    uidMap?: string;
    status?: string;
    pid1?: string;
    procs?: Record<string, FakeProc>;
    sockets?: string[];
    selfToken?: string;
    env?: Record<string, string>;
  }

  const GOOD_STATUS = [
    "Name:\tbash",
    "CapInh:\t0000000000000000",
    "CapPrm:\t0000000000000000",
    "CapEff:\t0000000000000000",
    "CapBnd:\t0000000000000000",
    "CapAmb:\t0000000000000000",
    "NoNewPrivs:\t1",
  ].join("\n");

  /** Run the probes against a fake /proc, socket dir, workspace, HOME and /tmp. */
  function probes(args: string[], fx: Fixture = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probes-"));
    try {
      const proc = path.join(dir, "proc");
      const ws = path.join(dir, "workspace");
      const sock = path.join(dir, "sock");
      const home = path.join(dir, "home");
      const tmp = path.join(dir, "tmp");
      for (const d of [
        path.join(proc, "self"),
        path.join(proc, "net"),
        ws,
        sock,
        home,
        tmp,
      ]) {
        fs.mkdirSync(d, { recursive: true });
      }
      fs.writeFileSync(
        path.join(proc, "self", "uid_map"),
        fx.uidMap ??
          "         0       1001          1\n         1     165536      65536\n",
      );
      fs.writeFileSync(
        path.join(proc, "self", "status"),
        fx.status ?? GOOD_STATUS,
      );
      fs.writeFileSync(
        path.join(proc, "self", "mountinfo"),
        `1 0 0:1 / / ro,relatime - overlay overlay ro\n2 1 0:2 /runs/r1/repo ${ws} rw - ext4 /dev/sda rw\n`,
      );
      fs.writeFileSync(
        path.join(proc, "net", "unix"),
        "Num RefCount Protocol\n",
      );
      const procs: Record<string, FakeProc> = {
        "1": {
          comm: fx.pid1 ?? "docker-init",
          cmdline: "/sbin/docker-init\0--\0node\0",
        },
        ...fx.procs,
      };
      for (const [pid, p] of Object.entries(procs)) {
        fs.mkdirSync(path.join(proc, pid));
        fs.writeFileSync(path.join(proc, pid, "comm"), `${p.comm}\n`);
        fs.writeFileSync(path.join(proc, pid, "cmdline"), p.cmdline);
        fs.writeFileSync(
          path.join(proc, pid, "environ"),
          p.environ ?? "HOME=/home/agent\0",
        );
      }
      for (const s of fx.sockets ?? ["daemon.sock", "egress-proxy.sock"]) {
        fs.writeFileSync(path.join(sock, s), "");
      }
      if (fx.selfToken) {
        fs.writeFileSync(path.join(ws, ".automata-probe-token"), fx.selfToken);
      }
      return spawnSync("bash", [path.join(repoRoot, PROBES), ...args], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          PROBE_PROC: proc,
          PROBE_SOCK_DIR: sock,
          PROBE_WORKSPACE: ws,
          PROBE_TMP: tmp,
          ...fx.env,
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // card: protects=the probes judge the container the worker builds: the writable set is container-argv's (/workspace, HOME, /opt/flutter, /tmp, /dev/shm), the socket dir is /run/automata, the proxy is the entry's 127.0.0.1:3128 bridge of egress-proxy.sock, a review may hold only daemon.sock and egress-proxy.sock (never the gh broker), probe 2 dials the engine's 7077 and 8888, and all seven probes run; fails_when=either side drifts (the probe would test a container the worker does not build); no_claim=the probes' behaviour on a box
  it("probes the container the worker builds", () => {
    expect(CONTAINER_WORKSPACE).toBe("/workspace");
    expect(CONTAINER_HOME).toBe("/home/agent");
    expect(CONTAINER_FLUTTER_ROOT).toBe("/opt/flutter");
    expect(CONTAINER_SOCKET_DIR).toBe("/run/automata");
    expect(script).toContain('WORKSPACE="${PROBE_WORKSPACE:-/workspace}"');
    expect(script).toContain('SOCK_DIR="${PROBE_SOCK_DIR:-/run/automata}"');
    expect(script).toContain(
      'local writable="$WORKSPACE ${HOME:-/home/agent} /opt/flutter /tmp /dev/shm"',
    );
    expect(CONTAINER_BRIDGES).toContainEqual({
      socket: "egress-proxy.sock",
      port: 3128,
    });
    expect(script).toContain('"$SOCK_DIR/egress-proxy.sock"');
    expect(script).toContain("http://127.0.0.1:3128");
    expect(path.basename(CONTAINER_DAEMON_SOCKET)).toBe("daemon.sock");
    expect(script).toContain(
      'case "${e##*/}" in daemon.sock | egress-proxy.sock) ;;',
    );
    expect(path.basename(CONTAINER_GH_BROKER_SOCKET)).toBe("gh-broker.sock");
    expect(script).toMatch(/127\.0\.0\.1:7077 127\.0\.0\.1:8888/);
    for (const [n, fn] of [
      [1, "probe_egress"],
      [2, "probe_engine"],
      [3, "probe_userns"],
      [4, "probe_caps"],
      [5, "probe_rofs"],
      [6, "probe_review"],
      [7, "probe_isolation"],
    ] as const) {
      expect(script).toContain(`wanted ${n} && ${fn}`);
    }
    expect(script).toMatch(/^exit "\$failed"$/m);
  });

  // card: protects=the lane is required (argument or the container's AUTOMATA_RUN_LANE) and only review|pr|task is accepted; fails_when=a missing or unknown lane runs the probes (probe 6 would silently judge the wrong lane); no_claim=the lane label being right
  it("requires a known lane", () => {
    expect(probes(["--only", "4"]).status).toBe(2);
    expect(probes(["--lane", "admin", "--only", "4"]).status).toBe(2);
    const fromEnv = probes(["--only", "4"], {
      env: { AUTOMATA_RUN_LANE: "task" },
    });
    expect(fromEnv.stdout).toMatch(/^PASS 4 no-capabilities /m);
    expect(fromEnv.status).toBe(0);
  });

  // card: protects=probe 3 passes only when container root maps to the given runner uid and the probe's uid to a subordinate (>= 100000) id, and fails on the identity map of a rootful daemon, on another root mapping, and without --runner-uid; fails_when=uid_map parsing accepts a rootful or mis-owned mapping; no_claim=the kernel's uid_map format beyond these lines
  it.skipIf(process.getuid?.() === 0)("probe 3: user-namespace mapping", () => {
    const args = ["--lane", "task", "--only", "3"];
    const ok = probes([...args, "--runner-uid", "1001"]);
    expect(ok.stdout).toMatch(/^PASS 3 userns-mapping +root -> host 1001 /m);
    expect(ok.status).toBe(0);
    const rootful = probes([...args, "--runner-uid", "1001"], {
      uidMap: "         0          0 4294967295\n",
    });
    expect(rootful.stdout).toMatch(/^FAIL 3 .*identity uid map/m);
    expect(rootful.status).toBe(1);
    expect(probes([...args, "--runner-uid", "999"]).stdout).toMatch(
      /^FAIL 3 .*not automata-runner \(999\)/m,
    );
    expect(probes(args).stdout).toMatch(/^FAIL 3 .*no --runner-uid given/m);
  });

  // card: protects=probe 4 fails on any non-zero CapEff/CapPrm/CapBnd or a NoNewPrivs other than 1; fails_when=a capability set or the no-new-privileges bit goes unchecked; no_claim=what the capability bits mean
  it("probe 4: capabilities and no-new-privileges", () => {
    expect(probes(["--lane", "task", "--only", "4"]).stdout).toMatch(
      /^PASS 4 no-capabilities /m,
    );
    const caps = probes(["--lane", "task", "--only", "4"], {
      status: GOOD_STATUS.replace(
        "CapBnd:\t0000000000000000",
        "CapBnd:\t00000000a80425fb",
      ).replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
    });
    expect(caps.stdout).toMatch(
      /^FAIL 4 no-capabilities .*CapBnd=00000000a80425fb.*NoNewPrivs=0/m,
    );
    expect(caps.status).toBe(1);
  });

  // card: protects=probe 6 judges ONLY the review lane: a git/gh broker socket in the socket dir or a GitHub token variable fails it, and a checkout it cannot push from is inconclusive (FAIL), never a pass; other lanes SKIP; fails_when=a broker socket or token passes, or a missing checkout counts as "push failed"; no_claim=the push itself against GitHub (box run)
  it("probe 6: a review container holds no write credential", () => {
    const broker = probes(["--lane", "review", "--only", "6"], {
      sockets: [
        "daemon.sock",
        "egress-proxy.sock",
        "gh-broker.sock",
        "git-broker.sock",
      ],
    });
    expect(broker.stdout).toMatch(
      /^FAIL 6 review-no-write .*holds gh-broker\.sock git-broker\.sock/m,
    );
    expect(broker.status).toBe(1);
    expect(
      probes(["--lane", "review", "--only", "6"], { env: { GH_TOKEN: "x" } })
        .stdout,
    ).toMatch(/token variable\(s\) set: GH_TOKEN/);
    const clean = probes(["--lane", "review", "--only", "6"]);
    expect(clean.stdout).toMatch(/^FAIL 6 .*no git checkout at .*unproven/m);
    expect(clean.stdout).not.toMatch(/holds|token/);
    const task = probes(["--lane", "task", "--only", "6"], {
      sockets: ["daemon.sock", "git-broker.sock", "gh-broker.sock"],
    });
    expect(task.stdout).toMatch(/^SKIP 6 review-no-write +lane=task/m);
    expect(task.status).toBe(0);
  });

  // card: protects=probe 7 fails when another run's token is visible in any process, when pid 1 is not the container's init (host pid namespace), when no --peer was given (concurrency unproven) or when the workspace is not this run's; passes when its own token matches and the peer is invisible; fails_when=a visible peer, a host pid 1, a missing peer or a foreign workspace passes; no_claim=the two containers actually running at once (the host driver starts them)
  it("probe 7: concurrent-run isolation", () => {
    const args = ["--lane", "review", "--only", "7"];
    const pair = ["--self", "run-self-0001", "--peer", "run-peer-0002"];
    const ok = probes([...args, ...pair], { selfToken: "run-self-0001" });
    expect(ok.stdout).toMatch(/^PASS 7 run-isolation +pid 1 docker-init/m);
    expect(ok.status).toBe(0);
    const seen = probes([...args, ...pair], {
      selfToken: "run-self-0001",
      procs: {
        "42": {
          comm: "node",
          cmdline: "node\0/opt/automata-daemon/index.js\0run-peer-0002\0",
        },
      },
    });
    expect(seen.stdout).toMatch(
      /^FAIL 7 .*peer 'run-peer-0002' visible: a process/m,
    );
    expect(seen.status).toBe(1);
    const host = probes([...args, ...pair], {
      selfToken: "run-self-0001",
      pid1: "systemd",
    });
    expect(host.stdout).toMatch(
      /^FAIL 7 .*pid 1 is 'systemd'.*host or worker processes visible: 1:systemd/m,
    );
    expect(probes(args).stdout).toMatch(/^FAIL 7 .*no --peer given/m);
    expect(
      probes([...args, ...pair], { selfToken: "run-other-9999" }).stdout,
    ).toMatch(/^FAIL 7 .*not 'run-self-0001'/m);
  });
});
