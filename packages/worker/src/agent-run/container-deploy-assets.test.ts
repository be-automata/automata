import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONTAINER_DOCKER_SOCKET } from "./container-config";

/**
 * The ADR-013 C2 box assets (packages/worker/deploy/linux): the rootless
 * daemon installer, its user unit and the limits proof. Static checks only:
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

const SCRIPTS = [
  linux("install-rootless-docker.sh"),
  linux("prove-container-limits.sh"),
];

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

  // card: protects=the installer never turns the dev-only path on and never touches the worker unit, its env or the rootful daemon (production must not change); fails_when=it writes WORKER_DEV_CONTAINER_RUNS, edits automata-worker.service, or restarts docker.service; no_claim=what an operator does by hand
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
