import semver from "semver";

import { detectFlutterPinFrom, type CheckoutProbe } from "./container-entry";

/**
 * #742 OD-3: which Flutter SDK a CELL run uses. The batteries image bakes extra
 * SDKs under `/opt/flutter-sdks/<version>` (sha256-pinned, warmed, verified
 * offline); the default stays `/opt/flutter`. This module is the PURE decision
 * (requirement from the checkout, selection against what the image has, the
 * journal line, the wrapper script); cell-run.ts does the reads and the exec.
 *
 * Reading a `pubspec.yaml` constraint is CELL-ONLY. The box container path keeps
 * `detectFlutterPinFrom` (exact `.fvmrc` / `fvm_config.json` pins, exit-69
 * notice shims) unchanged.
 */

export const FLUTTER_SDKS_DIR = "/opt/flutter-sdks";
/** The shim dir the cell image puts first on PATH (cell Dockerfile, cell-entry.sh). */
export const FLUTTER_SHIM_DIR = "/home/agent/.automata-run/flutter-pin";
/** The checkout-root files the requirement is read from, in precedence order. */
export const FLUTTER_MARKER_FILES = [
  ".fvmrc",
  ".fvm/fvm_config.json",
  "pubspec.yaml",
] as const;

/** An exact release version: the same shape the box path accepts (it rides an argv). */
const SAFE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.]{1,32})?$/;
/** Characters a Dart version constraint may use; anything else is not parsed. */
const SAFE_RANGE = /^[0-9A-Za-z.<>=^~| *+-]{1,64}$/;

/** Is `v` a version text safe to log and to pass as an argv? */
export function isSafeFlutterVersion(v: string): boolean {
  return SAFE_VERSION.test(v);
}

export type FlutterRequirement =
  | {
      kind: "pin";
      version: string;
      source: ".fvmrc" | "fvm_config.json" | "pubspec";
    }
  | { kind: "constraint"; range: string }
  | { kind: "none" };

/** The `environment.flutter` value of a pubspec: line-scoped, no YAML parser. */
function pubspecFlutterValue(text: string): string | null {
  let inEnv = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^environment:\s*(#.*)?$/.test(raw)) {
      inEnv = true;
      continue;
    }
    if (!inEnv || /^\s*(#.*)?$/.test(raw)) continue;
    if (!/^\s/.test(raw)) return null; // the next top-level key: no `flutter:` seen
    const m = /^\s+flutter:\s*(.*?)\s*$/.exec(raw);
    if (m)
      return (m[1] ?? "").replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
  }
  return null;
}

function fromPubspec(text: string | null): FlutterRequirement {
  const value = text === null ? null : pubspecFlutterValue(text);
  if (value === null || value === "" || value === "any")
    return { kind: "none" };
  if (SAFE_VERSION.test(value)) {
    return { kind: "pin", version: value, source: "pubspec" };
  }
  if (SAFE_RANGE.test(value) && semver.validRange(value) !== null) {
    return { kind: "constraint", range: value };
  }
  return { kind: "none" };
}

/** A probe that sees only `rel`: tells which marker file carried the pin. */
function only(probe: CheckoutProbe, rel: string): CheckoutProbe {
  return {
    readFile: (r) => (r === rel ? probe.readFile(r) : null),
    isDir: () => false,
    list: () => [],
  };
}

/** `.fvmrc` wins over `fvm_config.json` wins over the pubspec constraint. */
export function detectFlutterRequirementFrom(
  probe: CheckoutProbe,
): FlutterRequirement {
  const pin = detectFlutterPinFrom(probe);
  if (pin === null) return fromPubspec(probe.readFile("pubspec.yaml"));
  const fromRc = detectFlutterPinFrom(only(probe, ".fvmrc")) !== null;
  return {
    kind: "pin",
    version: pin,
    source: fromRc ? ".fvmrc" : "fvm_config.json",
  };
}

export type FlutterSelection =
  | {
      kind: "default";
      reason: "no-requirement" | "pinned-default" | "default-satisfies";
    }
  | { kind: "use"; version: string; reason: "pinned" | "constraint" }
  | { kind: "miss"; wanted: string };

/** The SDK versions the image has, filtered to the ones safe to select. */
function usable(available: readonly string[]): string[] {
  return available.filter((v) => SAFE_VERSION.test(v) && semver.valid(v));
}

function selectForConstraint(
  range: string,
  available: readonly string[],
  defaultVersion: string,
): FlutterSelection {
  if (semver.satisfies(defaultVersion, range)) {
    return { kind: "default", reason: "default-satisfies" };
  }
  const best = semver.maxSatisfying(usable(available), range);
  return best === null
    ? { kind: "miss", wanted: range }
    : { kind: "use", version: best, reason: "constraint" };
}

/**
 * Pin: that exact version when the image has it (the default is not re-selected),
 * else a miss. Constraint: the default if it satisfies, else the highest SDK the
 * image has that does, else a miss. A miss keeps the default SDK (F9).
 */
export function selectFlutterSdk(
  req: FlutterRequirement,
  available: readonly string[],
  defaultVersion: string,
): FlutterSelection {
  if (req.kind === "none") return { kind: "default", reason: "no-requirement" };
  if (req.kind === "constraint") {
    return selectForConstraint(req.range, available, defaultVersion);
  }
  if (req.version === defaultVersion) {
    return { kind: "default", reason: "pinned-default" };
  }
  return usable(available).includes(req.version)
    ? { kind: "use", version: req.version, reason: "pinned" }
    : { kind: "miss", wanted: req.version };
}

/** What produced the requirement, for the journal line. */
function sourceOf(req: FlutterRequirement): string {
  return req.kind === "pin" ? req.source : "pubspec";
}

/**
 * The one journal line for a decision. `wanted` and versions are validated texts
 * (a safe version or a safe constraint), never raw checkout content.
 */
export function flutterJournalLine(
  sel: FlutterSelection,
  req: FlutterRequirement,
  defaultVersion: string,
): string {
  if (sel.kind === "miss") {
    return `cell: flutter pin ${sel.wanted} not in the image; using ${defaultVersion}`;
  }
  if (sel.kind === "use") {
    return `cell: flutter ${sel.version} (${sel.reason === "pinned" ? `pinned by ${sourceOf(req)}` : `satisfies ${sourceOf(req)}`})`;
  }
  const why =
    sel.reason === "no-requirement"
      ? "no project pin"
      : sel.reason === "pinned-default"
        ? `pinned by ${sourceOf(req)}`
        : `default satisfies ${sourceOf(req)}`;
  return `cell: flutter ${defaultVersion} (${why})`;
}

/**
 * The line the agent's CLAUDE.md note carries, so its report can say which SDK
 * it got. Derived from the same decision as the journal line.
 */
export function flutterAgentNote(
  sel: FlutterSelection,
  defaultVersion: string,
): string | null {
  if (sel.kind === "use") {
    return `Flutter: this run uses SDK ${sel.version} (selected for the project's pin); \`flutter\`, \`dart\` and \`fvm flutter\` resolve to it.`;
  }
  if (sel.kind === "miss") {
    return `Flutter: the project pins ${sel.wanted}, which is NOT in this image; \`flutter\` is the default SDK ${defaultVersion}. Say so in your report if a result depends on the SDK version.`;
  }
  return null;
}

/**
 * The wrapper-writing script, run as `bash -c <script> -- <version> <shimDir>`.
 * Inline from worker source (no file in the image). The version is re-validated
 * and must exist under /opt/flutter-sdks, so a bad argv cannot write a shim to
 * an arbitrary path. `fvm flutter|dart ...` maps to the same SDK; every other
 * fvm subcommand is refused with a notice (exit 69, as the box's notice shims).
 */
export const FLUTTER_WRAPPER_SCRIPT = [
  "set -euo pipefail",
  'v="$1"; d="$2"',
  'case "$v" in ""|*[!0-9A-Za-z.+-]*) exit 64;; esac',
  `sdk="${FLUTTER_SDKS_DIR}/$v"`,
  '[ -x "$sdk/bin/flutter" ] && [ -x "$sdk/bin/dart" ] || exit 65',
  'mkdir -p "$d"',
  "for t in flutter dart; do",
  '  printf \'#!/bin/bash\\nexec env FLUTTER_ROOT=%s %s/bin/%s "$@"\\n\' "$sdk" "$sdk" "$t" >"$d/$t"',
  '  chmod 0755 "$d/$t"',
  "done",
  'cat >"$d/fvm" <<EOF',
  "#!/bin/bash",
  'case "\\${1:-}" in flutter|dart) t="\\$1"; shift; exec "$d/\\$t" "\\$@";; esac',
  "echo \"fvm: only 'fvm flutter' and 'fvm dart' work in this cell (SDK $v)\" >&2",
  "exit 69",
  "EOF",
  'chmod 0755 "$d/fvm"',
].join("\n");

/** The argv that installs the wrappers for `version` (validated by the caller). */
export function flutterWrapperArgv(version: string): string[] {
  return [
    "bash",
    "-c",
    FLUTTER_WRAPPER_SCRIPT,
    "--",
    version,
    FLUTTER_SHIM_DIR,
  ];
}
