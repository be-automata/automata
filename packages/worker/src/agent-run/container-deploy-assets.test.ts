import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
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
    expect(unit).toContain("--group=automata-docker");
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
    expect(script).toMatch(/usermod -aG "\$GROUP" "\$u"/);
    expect(script).toMatch(/d \$SOCK_DIR 0750 \$RUNNER \$GROUP -/);
  });
});
