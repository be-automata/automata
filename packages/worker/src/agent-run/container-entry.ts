import fs from "node:fs";
import path from "node:path";

import { CONTAINER_HOME, CONTAINER_WORKSPACE } from "./container-argv";

/**
 * The container's entry step (ADR-013 "Run path" step 5), run by
 * `/bin/bash -c` as the image's `agent` user before it execs the daemon:
 *
 *   1. read the run env file the worker copied into HOME (the secrets that
 *      must not ride the docker argv), then delete it;
 *   2. start the socat bridges for the sockets that are present (C3, #430):
 *      the worker forwards only the exits this run is entitled to;
 *   3. install the Somnio agent rules into the checkout for the stacks the
 *      worker detected, restore every tracked path the installer rewrote and
 *      git-exclude every path it added, so `git status` is unchanged;
 *   4. exec the daemon (`"$@"`).
 *
 * Pure: the script is a constant shaped by nothing but this module, and the
 * stack list it reads is detected on the host by `detectSomnioStacks`.
 */

/** Where the worker copies the run env file (container-daemon-process.ts). */
export const CONTAINER_RUN_ENV_FILE = `${CONTAINER_HOME}/.automata-run/run.env`;

/**
 * The socket names the worker forwards under /run/automata (C3, #430) and the
 * entry bridges to loopback TCP ports (egress proxy → 3128, git broker → 3129,
 * test Postgres → 25432). One table for the entry's bridge loop and the
 * worker's forwards (container-daemon-process.ts). The gh broker socket is
 * not here: gh speaks HTTP over a unix socket itself.
 */
export const CONTAINER_BRIDGES: ReadonlyArray<{
  socket: string;
  port: number;
}> = [
  { socket: "egress-proxy.sock", port: 3128 },
  { socket: "git-broker.sock", port: 3129 },
  { socket: "test-postgres.sock", port: 25432 },
];

/**
 * The entry script. Kept free of any value from the run: everything
 * run-specific arrives as env (`AUTOMATA_SOMNIO_STACKS` on the argv, secrets
 * in the env file) or as the exec'd argv.
 */
export function buildEntryScript(): string {
  const bridges = CONTAINER_BRIDGES.map((b) => `${b.socket}:${b.port}`).join(
    " ",
  );
  return [
    "set -euo pipefail",
    // Files the run creates in the handed-over dirs stay group-writable for
    // the worker (the run dir is setgid to the rootless daemon user's group).
    "umask 0002",
    // 1. The run env: secrets that must never be in `docker inspect`.
    `env_file=${CONTAINER_RUN_ENV_FILE}`,
    'if [ -f "$env_file" ]; then set -a; . "$env_file"; set +a; rm -f -- "$env_file"; fi',
    // 2. Bridges (C3): only for sockets the worker forwarded.
    `for pair in ${bridges}; do`,
    '  sock="/run/automata/${pair%%:*}"; port="${pair##*:}"',
    '  if [ -S "$sock" ]; then',
    '    socat "TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork" "UNIX-CONNECT:${sock}" &',
    "  fi",
    "done",
    // 3. Somnio agent rules, every lane, only for detected stacks. A failure
    // here never fails the run: the rules are guidance, and the step ends by
    // reporting a checkout that is not clean.
    `ws=${CONTAINER_WORKSPACE}`,
    'g() { git -C "$ws" -c safe.directory="$ws" -c core.hooksPath=/dev/null "$@"; }',
    "somnio_rules() {",
    // The snapshot lives in the checkout's own .git (always writable, never
    // tracked), so the step does not depend on TMPDIR.
    '  local before="$ws/.git/automata-untracked-before"',
    // -z then NUL→newline: unquoted paths (git quotes non-ASCII without -z).
    "  g ls-files -z --others --exclude-standard | tr '\\0' '\\n' | LC_ALL=C sort >\"$before\"",
    '  if ! (cd "$ws" && somnio -q rules install --agent claude --project --stacks "$AUTOMATA_SOMNIO_STACKS" </dev/null >/dev/null 2>&1); then',
    '    echo "automata-entry: somnio rules install failed for stacks ${AUTOMATA_SOMNIO_STACKS}" >&2',
    "  fi",
    // The repo's own files win: restore every tracked path the installer touched.
    '  g diff --name-only -z | xargs -0r git -C "$ws" -c safe.directory="$ws" checkout --',
    // Exclude exactly what the installer added (glob metacharacters escaped).
    "  g ls-files -z --others --exclude-standard | tr '\\0' '\\n' | LC_ALL=C sort | LC_ALL=C comm -13 \"$before\" - \\",
    "    | sed -e 's/[][*?!#\\\\]/\\\\&/g' -e 's|^|/|' >>\"$ws/.git/info/exclude\"",
    '  rm -f -- "$before"',
    "}",
    'if [ -n "${AUTOMATA_SOMNIO_STACKS:-}" ] && [ -d "$ws/.git" ]; then',
    '  somnio_rules || echo "automata-entry: somnio rules step failed" >&2',
    "  dirty=$(g status --porcelain | wc -l)",
    '  if [ "$dirty" -ne 0 ]; then echo "automata-entry: checkout not clean after the rules install ($dirty paths)" >&2; fi',
    "fi",
    // 4. The daemon.
    'exec "$@"',
  ].join("\n");
}

/**
 * The Somnio stacks a checkout's marker files call for (ADR-013 Run path
 * 5.2). Empty = install nothing. Reads only the checkout root (plus one level
 * for `*.csproj`), never follows a symlink out of it, and caps every file it
 * reads, so a hostile checkout can neither make the worker read the box nor
 * stall it.
 */
export function detectSomnioStacks(repo: string): string[] {
  return detectSomnioStacksFrom(fsProbe(repo));
}

/** The reads `detectSomnioStacksFrom` needs; a fixture checkout implements it in tests. */
export interface CheckoutProbe {
  /** A regular file at `rel` (relative to the checkout root), or null. */
  readFile(rel: string): string | null;
  /** Is `rel` a directory (not a symlink)? */
  isDir(rel: string): boolean;
  /** Names directly inside `rel` (empty when absent). */
  list(rel: string): string[];
}

const MAX_MARKER_BYTES = 256 * 1024;

function fsProbe(root: string): CheckoutProbe {
  const resolve = (rel: string): string | null => {
    const abs = path.join(root, rel);
    const relBack = path.relative(root, abs);
    return relBack.startsWith("..") || path.isAbsolute(relBack) ? null : abs;
  };
  return {
    readFile(rel) {
      const abs = resolve(rel);
      if (!abs) return null;
      try {
        const st = fs.lstatSync(abs);
        if (!st.isFile() || st.size > MAX_MARKER_BYTES) return null;
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    isDir(rel) {
      const abs = resolve(rel);
      if (!abs) return false;
      try {
        return fs.lstatSync(abs).isDirectory();
      } catch {
        return false;
      }
    },
    list(rel) {
      const abs = resolve(rel);
      if (!abs) return [];
      try {
        return fs.readdirSync(abs);
      } catch {
        return [];
      }
    },
  };
}

function packageDeps(json: string | null): Set<string> {
  if (!json) return new Set();
  try {
    const pkg: unknown = JSON.parse(json);
    if (typeof pkg !== "object" || pkg === null) return new Set();
    const names = new Set<string>();
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
    ]) {
      const deps = (pkg as Record<string, unknown>)[field];
      if (typeof deps === "object" && deps !== null) {
        for (const name of Object.keys(deps)) names.add(name);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

/** Does a Python requirement text name `dist` (PEP 503-normalised, case-insensitive)? */
function pythonDependsOn(text: string, dist: string): boolean {
  const re = new RegExp(`(^|[\\s"'\\[,])${dist}([\\s"'\\]<>=!~;,\\[]|$)`, "im");
  return re.test(text);
}

/** The pure decision over a probe. Stack names are the Somnio CLI's own. */
export function detectSomnioStacksFrom(probe: CheckoutProbe): string[] {
  const stacks = new Set<string>();

  const pubspec = probe.readFile("pubspec.yaml");
  if (pubspec !== null) {
    stacks.add("dart");
    // `sdk: flutter` under a dependency is how a package depends on the SDK.
    if (/^\s+sdk:\s*["']?flutter["']?\s*$/m.test(pubspec)) {
      stacks.add("flutter");
    }
  }

  if (probe.readFile("tsconfig.json") !== null) stacks.add("typescript");
  const deps = packageDeps(probe.readFile("package.json"));
  if (deps.has("react")) stacks.add("react");
  if (deps.has("@nestjs/core")) stacks.add("nestjs");

  const pyTexts = [
    probe.readFile("pyproject.toml"),
    ...probe
      .list(".")
      .filter((n) => /^requirements[\w.-]*\.txt$/.test(n))
      .map((n) => probe.readFile(n)),
  ].filter((t): t is string => t !== null);
  if (pyTexts.length > 0) {
    stacks.add("python");
    for (const fw of ["django", "fastapi", "flask"]) {
      if (pyTexts.some((t) => pythonDependsOn(t, fw))) stacks.add(fw);
    }
  }

  const csproj = (dir: string) =>
    probe.list(dir).some((n) => n.endsWith(".csproj"));
  if (
    csproj(".") ||
    probe
      .list(".")
      .filter((n) => !n.startsWith(".") && probe.isDir(n))
      .some((d) => csproj(d))
  ) {
    stacks.add("dotnet");
  }

  if (probe.readFile("firebase.json") !== null && probe.isDir("functions")) {
    stacks.add("functions");
  }

  return [...stacks].sort();
}
