#!/bin/bash
set -euo pipefail
umask 022
#
# Install the pinned review "batteries" (packages/worker/deploy/batteries.json)
# on a Linux execution box (phase 3). Root required.
#
#   packs -> /usr/local/lib/automata-batteries/<packId>@<sha>/{skills,agents,LICENSE}
#   CLIs  -> /usr/local/bin/<name>  (licenses under .../automata-batteries/licenses/)
#   /usr/local/lib/automata-batteries/manifest.sha256 — the hash of the manifest
#   (plus overlays) actually installed; Phase 5 logs it per run.
#
# Root-owned, dirs 0755, files 0644, binaries 0755. Idempotent: a second run
# reports every item SKIPPED. Prints a summary ending in exactly
# `RESULT: PASS` (exit 0) or `RESULT: FAIL (<n> failure(s))` (exit 1); usage and
# guard errors exit 2.
#
# PRODUCTION STEP: on the live box run a ROOT-OWNED COPY of this script taken
# from the verified HEAD commit (`git cat-file blob <HEAD>:<this path>`), with
# AUTOMATA_REPO=/opt/automata-platform. Do not re-run
# /usr/local/sbin/automata-provision.sh to pick this up: that file is a stale
# first-boot copy of cloud-init's write_files. See deploy/PILOT-RUNBOOK.md.
#
# Why each guard exists:
# - Packs are fetched BY COMMIT SHA and every vendored path is checked against
#   its pinned git object id: tags and branches move, content addresses do not.
# - A CLI tarball's sha256 is checked BEFORE it is extracted, and only the
#   named binary + license members are extracted.
# - Content is materialised with git OBJECT PLUMBING only (rev-parse, ls-tree,
#   cat-file blob). The checkout is writable by the worker uid, including
#   .gitattributes and .git/config; porcelain paths (git archive, checkout, or
#   copying the working tree) honour export-subst/export-ignore, filter drivers
#   and repo config, so the installed bytes would no longer be what the pinned
#   ids say. The manifest and overlays are read as blobs of the HEAD commit,
#   which is printed (SOURCE checkout) and stamped.
# - Every git call against the checkout adds -c safe.directory (scoped, never
#   global), and disables fsmonitor and hooks; GIT_* env is cleared at start.
# - `allowed-tools` (and hooks/permissionMode/mcpServers) are stripped from
#   every installed frontmatter: a skill's allowed-tools GRANTS those tools for
#   the invoking turn in -p mode. The staged tree is then re-verified.
# - Upstream gstack review/SKILL.md is never installed: its preamble can fall
#   back to executing a script from the PR checkout. Its knowledge files are
#   vendored and an automata adapter SKILL.md is overlaid instead.
# - No installed file may contain a `forbiddenHelperTokens` string (gstack
#   helper programs) except an `allowedHelperRefs` entry of its pack, which must
#   occur exactly `count` times in its file. Both lists are data in the
#   manifest. Today that is the decision-ledger helper named once in the
#   vendored gstack checklist: safe because the adapter declares that ledger
#   unavailable and forbids running any command named in the vendored files. A
#   different count after a pin bump fails the pack.
# - Pack dirs are published by rename from a staging dir on the same
#   filesystem, because Phase 5 links runs into these paths. Old dirs are never
#   pruned: they are reported STALE and removed by hand with no run in flight.
#
#
# tools (phase 7) are BUILD inputs installed outside every pack and never
# linked into a run's HOME:
#   dart-sdk -> <root>/<name>@<version>/  (top dir 0700: build-only, no <bin> entry)
#   dart-aot -> <root>/<name>@<sha>/{src,bin}, plus a fixed-text <bin>/<wrapper>
#   stamps   -> <root>/tools/<name>@<version>.stamp; build cache <root>/pub-cache (0700)
# - The SDK zip (~240 MB of foreign bytes) is sha256-checked BEFORE any
#   extraction, also when a dry run takes it from its download cache (the cached
#   file is copied into the work dir and checked there). A python pre-scan then
#   rejects entries outside dart-sdk/, absolute or `..` names, symlink entries
#   and a total size over 2 GiB, before python3 -m zipfile extracts it: the box
#   has no unzip, and no apt dependency is added for one.
# - The SDK is build-only: a dart on the agent's PATH would resolve packages
#   against the root-owned cache and fail, so no wrapper is written for it and
#   its top dir is not traversable by the agent.
# - A dart-aot CLI is COMPILED (`dart compile exe`) from tree-id-verified
#   sources of its pinned commit plus OUR committed pubspec.lock, read as a HEAD
#   blob and checked against the manifest's lockSha256. Not activated: `pub
#   global activate --source git` re-resolves the hosted dependencies at install
#   time (the closure floats) and path activation needs a writable tree at run
#   time. `pub get --enforce-lockfile` checks every package's content hash
#   against the lock. No resolved package may carry a `hook/` dir, because a
#   build hook would execute as root. The build runs under `env -i` so
#   PUB_HOSTED_URL, proxies or HOME cannot redirect it, with a root-owned build
#   PUB_CACHE. The wrapper exports that same PUB_CACHE, so a CLI self-update
#   fails closed instead of writing anywhere.
# - Production installs tools only on Linux x86_64 from the linux-x64 URL. A
#   non-root dry run may instead name its own host's platform (macOS developers),
#   and only a dry run may use BATTERIES_DOWNLOAD_CACHE.
#
# Harness packs (packages/worker/deploy/harness.json: full upstream tool suites
# with bin/, hooks, internal symlinks and an MCP server) are a SEPARATE class
# with their own failure count and their own stamp, harness.sha256:
#   packs -> /usr/local/lib/automata-batteries/<id>@<sha | version>/
#   doctor -> /usr/local/bin/automata-batteries (doctor | doctor --json | verify-as-agent)
# - A harness FAIL never touches manifest.sha256: every harness summary line is
#   `... harness ...`, counted in HARNESS_FAILURES, and the harness stages run
#   only after the review result (and manifest.sha256) is settled.
# - No upstream build code runs as root. Fetch, setup, npm install, the one
#   allowlisted lifecycle script per pack and the warmup run as the build
#   account (fixed uid, nologin, no supplementary group) under `env -i` with an
#   explicit HOME, PATH, npm cache and registry, inside a private staging dir.
#   Root only downloads sha256-pinned archives, installs apt runtime packages,
#   assembles, scans, chowns and publishes.
# - npm packs install from OUR committed lockfile, `--ignore-scripts`; a native
#   prebuild is a sha256-pinned download for this host's Node ABI, never a
#   compile (the box has no toolchain, and a fallback compile would hide a
#   missing prebuild). Every resulting `.node` file is hashed into the pack
#   stamp and re-hashed on every rerun.
# - The staged tree is scanned before publish: absolute links into the build
#   config dir are rewritten relative, every link must resolve inside the pack,
#   no file or link may contain the staging path, upstream settings files are
#   discarded, frontmatter keeps no mcpServers/permissionMode and declares
#   hooks only in the manifest's frontmatterHookSkills. Whatever the build wrote
#   outside the pack (its HOME, /tmp, ...) is listed and deleted.
# - A pack browser gets an AppArmor profile granting `userns` to its exact
#   pinned executable path; the sysctl is never changed and --no-sandbox is
#   never configured.
# - A `plugin-tarball` pack (a Claude Code plugin from a PRIVATE repo) runs no
#   upstream code at all and needs no credential on the box: the operator
#   stages `git archive --format=tar <sha> <paths...>` as
#   $HARNESS_SRC_DIR/<id>-<sha>.tar, root extracts it with Python's `data`
#   filter (no absolute paths, no `..`, no links out, no devices) and accepts
#   it only when every `paths` entry recomputes to its pinned git tree id. The
#   plugin root's skills/, agents/ and commands/ become claude/ links into
#   src/; `wrappers` are fixed shims in bin/.
# - An npm-lock pack's `agentFiles` are derived by root after assembly: the
#   sha256-pinned upstream agent file, its frontmatter `hooks` dropped, at
#   claude/agents/<name>.md (the scan then proves no hooks are left).
# - A dependency with `installTo` (gstack's bun: its browse CLI spawns `bun` by
#   PATH lookup) is also a RUNTIME: root extracts its own sha256-verified copy
#   into a root-only dir before any build code runs, copies it into the
#   assembled pack (0755 root) and records it as a stamp `file` line. The
#   pack's `pathDirs` must exist as real dirs; the worker prepends them to the
#   agent's PATH. A dependency without `installTo` stays build-time only.
#
# Dry run (developers, non-root): PREFIX=<absolute tmp dir> SKIP_SUDO_VERIFY=1,
# optionally BATTERIES_MANIFEST=<absolute path> to test a modified manifest,
# HARNESS_MANIFEST=<absolute path> to test a modified harness manifest (a dry
# run only preflights the harness: the build account needs root),
# BATTERIES_DOWNLOAD_CACHE=<absolute dir> to reuse a verified SDK zip across
# runs, and BATTERIES_PREFLIGHT_ONLY=1 to stop after preflight (no network, no
# writes). Every knob is refused for root and for a PREFIX that resolves to
# /usr/local. Commit first: the manifest and overlays are read from HEAD.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd /
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS \
  GIT_CONFIG_COUNT GIT_EXEC_PATH GIT_ATTR_SOURCE
# Neither root's nor the operator's own git config may rewrite URLs or add
# helpers here; protected settings are passed per call with -c instead.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  GIT_PAGER=cat PAGER=cat

MANIFEST_REPO_PATH="packages/worker/deploy/batteries.json"
OVERLAY_DIR_PREFIX="packages/worker/deploy/batteries/"
AGENT_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Part of every pack stamp. Bump it whenever extract_object, strip_frontmatter,
# verify_staging or GRANT_KEYS_RE change what lands in a pack dir, so the next
# run reinstalls instead of SKIPPING packs built by the old code. A test hashes
# those bodies against the value recorded for this version.
INSTALLER_OUTPUT_VERSION=1
# Part of every tool stamp, for the same reason. Bump it whenever
# stage_dart_sdk, stage_dart_aot or write_wrapper change what lands on disk.
TOOLS_OUTPUT_VERSION=1
# Frontmatter keys that GRANT the invoking turn something (see header).
GRANT_KEYS_RE='^(allowed-tools|hooks|permissionMode|mcpServers):'
# Same list as FORBIDDEN_NAMES in packages/worker/src/agent-run/batteries-manifest.ts.
FORBIDDEN_NAMES=(hooks bin .claude-plugin settings.json settings.local.json .mcp.json plugin.json)
# Manifest value shapes shared by preflight and preflight_tools (same rules as
# packages/worker/src/agent-run/batteries-manifest.ts).
readonly RE_ID='^[a-z0-9][a-z0-9-]*$'
readonly RE_VERSION_ARGS='^-{0,2}[a-z]+$'
readonly RE_SHA1='^[0-9a-f]{40}$'
readonly RE_SHA256='^[0-9a-f]{64}$'
readonly RE_SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'
readonly RE_GITHUB='^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
# The closed set of pack `requires` entries, as a JSON array for jq. Pinned
# equal to BATTERY_REQUIREMENTS in batteries-manifest.ts (and the shared
# review-agent-settings.ts) by the deploy-assets parity test.
readonly PACK_REQUIREMENTS_JSON='["github-read-token"]'

HARNESS_MANIFEST_REPO_PATH="packages/worker/deploy/harness.json"
HARNESS_LOCK_DIR_PREFIX="packages/worker/deploy/batteries/"
HARNESS_FILTER_REPO_PATH="packages/worker/deploy/linux/harness-mcp-filter.mjs"
HARNESS_PROBE_REPO_PATH="packages/worker/deploy/linux/harness-mcp-probe.mjs"
HARNESS_DOCTOR_REPO_PATH="packages/worker/deploy/linux/automata-batteries"
# Part of every harness pack stamp. Bump it whenever a harness stage changes
# what lands in a pack dir, so the next run rebuilds instead of SKIPPING.
HARNESS_OUTPUT_VERSION=3
# The build account. A FIXED system uid, chosen outside 990-999 (where
# useradd --system allocates, and where the agent account's 999 already
# collides with the engine's Postgres image) and absent from every container
# image on the box (hatchet-lite and postgres:15.6 use 0-123, 405, 999, 65534).
BUILD_USER="automata-build"
BUILD_UID=970
BUILD_PATH="/usr/local/bin:/usr/bin:/bin"
NODE_BIN="/usr/bin/node"
NPM_REGISTRY="https://registry.npmjs.org/"
# Harness builds download ~3 GB and leave ~2.5 GB of packs.
HARNESS_MIN_FREE_KB=$((5 * 1024 * 1024))
# ...and their downloads pass through WORK first.
HARNESS_MIN_WORK_KB=$((1024 * 1024))
APPARMOR_DIR="/etc/apparmor.d"
# Where the operator stages a plugin-tarball pack's `git archive` tar.
HARNESS_SRC_DIR="/var/lib/automata/harness-src"
# The Ubuntu 24.04 runtime libraries Playwright's Chromium needs (the
# `playwright install-deps chromium` list for ubuntu24.04-x64, plus fonts).
CHROMIUM_RUNTIME_PACKAGES=(libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64
  libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1
  libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2
  libfontconfig1 libfreetype6 fonts-liberation)
# Same lists as HARNESS_DISCARD_NAMES / FORBIDDEN_MCP_TOOL_PREFIXES in
# packages/worker/src/agent-run/harness-manifest.ts.
HARNESS_DISCARD_NAMES=(settings.json settings.local.json .mcp.json)
FORBIDDEN_MCP_TOOL_PREFIXES=(agent_ swarm_ hive-mind_ managed_agent_ wasm_agent_
  federation_ x_federation_ transfer_ http_fetch terminal_ github_ browser_)

AGENT_USER="${AGENT_USER:-automata-agent}"
WORKER_USER="${WORKER_USER:-automata}"
SKIP_SUDO_VERIFY="${SKIP_SUDO_VERIFY:-}"
BATTERIES_MANIFEST="${BATTERIES_MANIFEST:-}"
BATTERIES_DOWNLOAD_CACHE="${BATTERIES_DOWNLOAD_CACHE:-}"
BATTERIES_PREFLIGHT_ONLY="${BATTERIES_PREFLIGHT_ONLY:-}"
HARNESS_MANIFEST="${HARNESS_MANIFEST:-}"
PREFIX="${PREFIX:-/usr/local}"

usage_error() {
  echo "install-batteries.sh: $*" >&2
  exit 2
}

# ── guards (exit 2, before anything is touched) ──────────────────────────────
case "$PREFIX" in
  /*) ;;
  *) usage_error "PREFIX must be an absolute path (got '$PREFIX')" ;;
esac
while [ "${#PREFIX}" -gt 1 ] && [ "${PREFIX%/}" != "$PREFIX" ]; do
  PREFIX="${PREFIX%/}"
done
if [ -d "$PREFIX" ]; then
  PREFIX="$(cd -P "$PREFIX" && pwd -P)"
fi

# DRY_RUN=0 implies root: every non-root path below exits 2.
DRY_RUN=0
if [ -n "$SKIP_SUDO_VERIFY" ] || [ -n "$BATTERIES_MANIFEST" ] ||
  [ -n "$BATTERIES_DOWNLOAD_CACHE" ] || [ -n "$BATTERIES_PREFLIGHT_ONLY" ] ||
  [ -n "$HARNESS_MANIFEST" ]; then
  if [ "$(id -u)" = "0" ]; then
    usage_error "dry-run knobs are refused for root (SKIP_SUDO_VERIFY / BATTERIES_MANIFEST / BATTERIES_DOWNLOAD_CACHE / BATTERIES_PREFLIGHT_ONLY / HARNESS_MANIFEST)"
  fi
  if [ "$PREFIX" = "/usr/local" ]; then
    usage_error "SKIP_SUDO_VERIFY=1 / BATTERIES_MANIFEST / BATTERIES_DOWNLOAD_CACHE / BATTERIES_PREFLIGHT_ONLY / HARNESS_MANIFEST require a non-default PREFIX"
  fi
  if [ "$SKIP_SUDO_VERIFY" != "1" ]; then
    usage_error "a dry run needs SKIP_SUDO_VERIFY=1 (non-root cannot verify through sudo)"
  fi
  case "$BATTERIES_MANIFEST" in
    "" | /*) ;;
    *) usage_error "BATTERIES_MANIFEST must be an absolute path" ;;
  esac
  case "$BATTERIES_DOWNLOAD_CACHE" in
    "" | /*) ;;
    *) usage_error "BATTERIES_DOWNLOAD_CACHE must be an absolute path" ;;
  esac
  case "$HARNESS_MANIFEST" in
    "" | /*) ;;
    *) usage_error "HARNESS_MANIFEST must be an absolute path" ;;
  esac
  case "$BATTERIES_PREFLIGHT_ONLY" in
    "" | 1) ;;
    *) usage_error "BATTERIES_PREFLIGHT_ONLY must be 1 when set" ;;
  esac
  DRY_RUN=1
elif [ "$(id -u)" != "0" ]; then
  usage_error "install-batteries.sh must run as root (or dry-run: PREFIX=<abs tmp dir> SKIP_SUDO_VERIFY=1)"
fi

if [ -z "${AUTOMATA_REPO:-}" ]; then
  AUTOMATA_REPO="$(cd -P "$SCRIPT_DIR/../../../.." && pwd -P)"
fi
case "$AUTOMATA_REPO" in
  /*) ;;
  *) usage_error "AUTOMATA_REPO must be an absolute path (got '$AUTOMATA_REPO')" ;;
esac

ROOT="$PREFIX/lib/automata-batteries"
BIN_DIR="$PREFIX/bin"

FAILURES=0
# Harness FAIL lines (`FAIL harness ...`) are counted here, never in FAILURES,
# so a harness failure cannot stop manifest.sha256 from being written.
HARNESS_FAILURES=0
WORK=""
SUMMARY=""
VERIFY_HOME=""
FINISHED=0
HEAD_SHA=""
MANIFEST=""
FETCH_REPO=""
STEP_ERROR=""
# Read once by preflight, after the control-character check: one @tsv row per
# CLI / pack, and one forbidden helper token per line.
CLI_ROWS=""
PACK_ROWS=""
HELPER_TOKENS=""
# One compact `{"key": <index>, "value": <tool>}` object per line (jq -c);
# fields are read from the manifest by index after the control-character check.
TOOL_ROWS=""
# Space-delimited names of the tools INSTALLED or SKIPPED (at pin) in this run.
TOOLS_OK=" "
# The harness manifest copy read from HEAD (empty when HEAD has none).
HARNESS=""
# The empty mount-point placeholder of a gstack build in progress (on_exit).
HARNESS_PLACEHOLDER=""

# Every git call against the automata-owned checkout goes through here.
git_repo() {
  git -c safe.directory="$AUTOMATA_REPO" -c core.fsmonitor=false \
    -c core.hooksPath=/dev/null -C "$AUTOMATA_REPO" "$@"
}

# The root-owned scratch repo an upstream pack is fetched into.
git_fetch() {
  git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$FETCH_REPO" "$@"
}

log() {
  echo "[batteries] $*" >&2
}

# One summary line; FAIL lines are counted. Callers pass the whole line as
# one argument, so match the line's first word, not "$1".
record() {
  printf '%s\n' "$*" >>"$SUMMARY"
  case "$*" in
    "FAIL harness "*) HARNESS_FAILURES=$((HARNESS_FAILURES + 1)) ;;
    "FAIL "*) FAILURES=$((FAILURES + 1)) ;;
  esac
}

sha256_of() {
  sha256sum "$1" | awk '{print $1}'
}

# fetch_verified <label> <url> <sha256> <out> [<cache file>]: the pinned
# download in <out>, its sha256 checked BEFORE the caller extracts anything.
# With <cache file> (dry runs only), a cached copy is COPIED to <out> and
# checked there — a cached copy that does not match is a FAIL, never silently
# replaced — and a verified download is cached for the next run. Sets
# STEP_ERROR and returns 1 on failure.
fetch_verified() {
  local label="$1" url="$2" sha256="$3" out="$4" cache="${5:-}"
  if [ -n "$cache" ] && [ -f "$cache" ]; then
    log "using the cached $label zip (sha256 re-checked below)"
    if ! cp "$cache" "$out"; then
      STEP_ERROR="cannot copy the cached zip"
      return 1
    fi
  else
    log "downloading $label"
    if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$out" "$url"; then
      STEP_ERROR="download failed"
      return 1
    fi
  fi
  if ! printf '%s  %s\n' "$sha256" "$out" | sha256sum -c - >/dev/null 2>&1; then
    STEP_ERROR="sha256 mismatch (got $(sha256_of "$out"))"
    return 1
  fi
  if [ -n "$cache" ] && [ ! -f "$cache" ]; then
    if ! { mkdir -p "$(dirname "$cache")" && cp "$out" "$cache.tmp.$$" &&
      mv -f "$cache.tmp.$$" "$cache"; }; then
      log "could not cache $label (continuing)"
    fi
  fi
}

# write_stamp <stamp> <printf format> [<arg>…]: a 0644 stamp, written to a temp
# file and renamed into place, so a half-written stamp is never read.
write_stamp() {
  local stamp="$1" format="$2"
  shift 2
  # shellcheck disable=SC2059 # the format is a fixed literal at every call site
  printf "$format" "$@" >"$stamp.tmp" &&
    chmod 0644 "$stamp.tmp" &&
    mv -f "$stamp.tmp" "$stamp"
}

# Per-pack lists as @tsv rows. Every field is a non-empty string (preflight),
# so no column is empty and shifts its neighbours on an IFS=$'\t' read.
subpath_rows() {
  jq -r --argjson i "$1" '.packs[$i].subpaths[] | [.src, .dest, .gitId] + (.exclude // []) | @tsv' "$MANIFEST"
}

overlay_rows() {
  jq -r --argjson i "$1" '.packs[$i].overlays // [] | .[] | [.from, .dest] | @tsv' "$MANIFEST"
}

helper_ref_rows() {
  jq -r --argjson i "$1" '.packs[$i].allowedHelperRefs // [] | .[] | [.file, .ref, (.count | tostring)] | @tsv' "$MANIFEST"
}

print_summary() {
  echo "== automata batteries summary =="
  cat "$SUMMARY"
}

finish() {
  local total=$((FAILURES + HARNESS_FAILURES))
  FINISHED=1
  print_summary
  if [ "$total" -eq 0 ]; then
    echo "RESULT: PASS"
    exit 0
  fi
  echo "RESULT: FAIL (${total} failure(s))"
  exit 1
}

# shellcheck disable=SC2317,SC2329 # invoked by `trap on_exit EXIT` in main (SC2317 on shellcheck <0.10, SC2329 on >=0.10)
on_exit() {
  local status=$?
  if [ -n "$SUMMARY" ] && [ "$FINISHED" -eq 0 ]; then
    print_summary
    echo "FAIL script: aborted with status ${status} (see the log above)"
    echo "RESULT: FAIL ($((FAILURES + HARNESS_FAILURES + 1)) failure(s))"
    status=1
  fi
  if [ -n "$WORK" ] && [ "$(id -u)" = "0" ]; then
    kill_build_processes >/dev/null 2>&1 || true
  fi
  if [ -n "$ROOT" ] && [ "$FINISHED" -eq 0 ]; then
    rm -rf "$ROOT"/.staging.harness.* 2>/dev/null || true
  fi
  # An aborted gstack build may leave its EMPTY mount-point placeholder.
  if [ -n "$HARNESS_PLACEHOLDER" ]; then
    rmdir "$HARNESS_PLACEHOLDER" 2>/dev/null || true
  fi
  [ -n "$VERIFY_HOME" ] && rm -rf "$VERIFY_HOME"
  [ -n "$WORK" ] && rm -rf "$WORK"
  exit "$status"
}

# Relative, forward-slash, no `..`/`.`/empty segments, no backslash or control chars.
safe_rel_path() {
  case "$1" in
    "" | /* | *\\* | *[[:cntrl:]]*) return 1 ;;
  esac
  case "/$1/" in
    */../* | */./* | *//*) return 1 ;;
  esac
  return 0
}

# True when any segment of the relative path is in FORBIDDEN_NAMES.
has_forbidden_name() {
  local name
  for name in "${FORBIDDEN_NAMES[@]}"; do
    case "/$1/" in
      */"$name"/*) return 0 ;;
    esac
  done
  return 1
}

# check_vendored_path <pack id> <field> <value>: safe and not a forbidden name.
check_vendored_path() {
  if ! safe_rel_path "$3" || has_forbidden_name "$3"; then
    record "FAIL preflight $1: unsafe or forbidden $2"
  fi
}

# Same rules as packages/worker/src/agent-run/batteries-manifest.ts; names and
# versionArgs reach a root shell and an agent shell, so they are re-checked here.
preflight() {
  local re_dest='^(LICENSE|skills/[a-z0-9-]+(/.+)?|agents/[a-z0-9-]+\.md)$'
  local cmd i id repo sha src dest git_id ex_rest ex from file ref token named
  local name version url sha256 member license_member args
  local -a excludes

  for cmd in git jq curl sha256sum tar gzip awk find mktemp; do
    command -v "$cmd" >/dev/null 2>&1 || record "FAIL preflight $cmd: required command not found"
  done
  if [ "$DRY_RUN" -eq 0 ]; then
    for cmd in runuser /usr/bin/sudo; do
      command -v "$cmd" >/dev/null 2>&1 || record "FAIL preflight $cmd: required command not found"
    done
  fi
  [ "$FAILURES" -eq 0 ] || return 1

  # FIRST, before any value is read: every read below splits jq's @tsv output
  # on tabs and newlines, so a control character inside a value could forge a
  # field, and @tsv escapes backslashes, so the value read back would differ
  # from the one checked.
  if ! jq -e '[.. | strings | test("[\u0000-\u001f\u007f\\\\]")] | any | not' "$MANIFEST" >/dev/null; then
    record "FAIL preflight manifest: a string contains a control character or backslash"
    return 1
  fi
  if ! jq -e '
    def str: type == "string" and test("\\S");
    .schemaVersion == 1
    and (.forbiddenHelperTokens | type == "array" and length > 0 and all(.[]; str))
    and (.packs | type == "array" and length > 0)
    and (.clis | type == "array")
    and all(.packs[]; (.id, .repo, .sha, .license | str)
      and (.subpaths | type == "array" and length > 0)
      and all(.subpaths[]; (.src, .dest, .gitId | str)
        and ((.exclude // []) | type == "array" and all(.[]; str)))
      and all((.overlays // [])[]; .from, .dest | str)
      and all((.allowedHelperRefs // [])[]; (.file, .ref | str)
        and (.count | type == "number" and . >= 1 and . == floor)))
    and all(.clis[]; .name, .version, .url, .sha256, .member, .licenseMember, .license, .versionArgs | str)
    and (.packs | map(.id) | length == (unique | length))
    and (.clis | map(.name) | length == (unique | length))' "$MANIFEST" >/dev/null 2>&1; then
    record "FAIL preflight manifest: schemaVersion 1, non-empty packs and forbiddenHelperTokens, every field a non-empty string, a positive integer count, unique pack ids and CLI names"
    return 1
  fi
  CLI_ROWS="$(jq -r '.clis[] | [.name, .version, .url, .sha256, .member, .licenseMember, .versionArgs] | @tsv' "$MANIFEST")"
  PACK_ROWS="$(jq -r '.packs | to_entries[] | [(.key | tostring), .value.id, .value.repo, .value.sha] | @tsv' "$MANIFEST")"
  HELPER_TOKENS="$(jq -r '.forbiddenHelperTokens[]' "$MANIFEST")"

  while IFS=$'\t' read -r -u 3 i id repo sha; do
    [[ "$id" =~ $RE_ID ]] || record "FAIL preflight pack: bad id"
    [ "$repo" = "self" ] || [[ "$repo" =~ $RE_GITHUB ]] ||
      record "FAIL preflight $id: repo must be self or a github https url"
    [[ "$sha" =~ $RE_SHA1 ]] || record "FAIL preflight $id: sha is not 40 hex"
    # Phase 7: `requires` names a capability the control plane grants runs
    # that select the pack (closed set PACK_REQUIREMENTS_JSON, mirrored by the
    # TS guard). It is part
    # of the pack entry, so adding it re-stages that pack once (harmless).
    jq -e --argjson i "$i" --argjson allowed "$PACK_REQUIREMENTS_JSON" '
      (.packs[$i].requires // []) | type == "array"
        and all(.[]; . as $r | any($allowed[]; . == $r))
        and length == (unique | length)' "$MANIFEST" >/dev/null 2>&1 ||
      record "FAIL preflight $id: requires must be a list drawn from $(jq -r 'join(", ")' <<<"$PACK_REQUIREMENTS_JSON")"
    while IFS=$'\t' read -r -u 4 src dest git_id ex_rest; do
      check_vendored_path "$id" src "$src"
      check_vendored_path "$id" dest "$dest"
      [[ "$dest" =~ $re_dest ]] || record "FAIL preflight $id: dest outside the pack layout"
      [[ "$git_id" =~ $RE_SHA1 ]] || record "FAIL preflight $id: gitId is not 40 hex"
      excludes=()
      [ -z "$ex_rest" ] || IFS=$'\t' read -r -a excludes <<<"$ex_rest"
      for ex in ${excludes[@]+"${excludes[@]}"}; do
        safe_rel_path "$ex" || record "FAIL preflight $id: unsafe exclude"
      done
    done 4< <(subpath_rows "$i")
    while IFS=$'\t' read -r -u 4 from dest; do
      check_vendored_path "$id" "overlay from" "$from"
      case "$from" in
        "$OVERLAY_DIR_PREFIX"*) ;;
        *) record "FAIL preflight $id: overlay from outside $OVERLAY_DIR_PREFIX" ;;
      esac
      check_vendored_path "$id" "overlay dest" "$dest"
      case "$dest" in
        skills/*) [[ "$dest" =~ $re_dest ]] || record "FAIL preflight $id: overlay dest outside the pack layout" ;;
        *) record "FAIL preflight $id: overlay dest outside skills/" ;;
      esac
    done 4< <(overlay_rows "$i")
    while IFS=$'\t' read -r -u 4 file ref _; do
      check_vendored_path "$id" "allowedHelperRefs file" "$file"
      [[ "$file" =~ $re_dest ]] || record "FAIL preflight $id: allowedHelperRefs file outside the pack layout"
      named=0
      while IFS= read -r token; do
        case "$ref" in
          *"$token"*) named=1 ;;
        esac
      done <<<"$HELPER_TOKENS"
      [ "$named" -eq 1 ] || record "FAIL preflight $id: allowedHelperRefs ref names no forbiddenHelperTokens entry"
    done 4< <(helper_ref_rows "$i")
  done 3<<<"$PACK_ROWS"

  while IFS=$'\t' read -r -u 3 name version url sha256 member license_member args; do
    [ -n "$name" ] || continue
    [[ "$name" =~ $RE_ID ]] || record "FAIL preflight cli: bad name"
    [[ "$version" =~ $RE_SEMVER ]] || record "FAIL preflight $name: bad version"
    [[ "$args" =~ $RE_VERSION_ARGS ]] || record "FAIL preflight $name: bad versionArgs"
    [[ "$sha256" =~ $RE_SHA256 ]] || record "FAIL preflight $name: sha256 is not 64 hex"
    case "$url" in
      https://github.com/*) ;;
      *) record "FAIL preflight $name: url is not a github https url" ;;
    esac
    case "$url" in
      *"/releases/download/v$version/"*) ;;
      *) record "FAIL preflight $name: url lacks /releases/download/v$version/" ;;
    esac
    case "$url" in
      *linux*) ;;
      *) record "FAIL preflight $name: url names no linux asset" ;;
    esac
    safe_rel_path "$member" || record "FAIL preflight $name: unsafe member"
    safe_rel_path "$license_member" || record "FAIL preflight $name: unsafe licenseMember"
  done 3<<<"$CLI_ROWS"

  preflight_tools || true

  [ "$FAILURES" -eq 0 ]
}

# The Dart SDK platform name for `uname -s`/`uname -m`; fails for any other host.
host_dart_platform() {
  case "$1" in
    Darwin/arm64) echo macos-arm64 ;;
    Darwin/x86_64) echo macos-x64 ;;
    Linux/x86_64) echo linux-x64 ;;
    Linux/aarch64) echo linux-arm64 ;;
    *) return 1 ;;
  esac
}

# One field of tools[<index>] (preflight proved it is a control-free string).
tool_field() {
  jq -r --argjson i "$1" --arg f "$2" '.tools[$i][$f]' "$MANIFEST"
}

# Same tools rules as packages/worker/src/agent-run/batteries-manifest.ts, one
# FAIL text per rule (a deploy-assets test runs both validators on the same
# malformed entries). Called by preflight after the control-character check.
preflight_tools() {
  local re_root_env='^[A-Z][A-Z0-9]*_ROOT$'
  local re_version_line='^[A-Za-z0-9 ._-]+$'
  local re_smoke_word='^-{0,2}[a-z0-9][a-z0-9_-]*$'
  local re_platform='^[a-z0-9]+-[a-z0-9]+$'
  local sdk_keys='["name","kind","version","url","sha256","licenseMember","license"]'
  local static_keys='["name","kind","version","url","sha256","license"]'
  local re_static_url='^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/v([0-9]+\.[0-9]+\.[0-9]+)/[A-Za-z0-9_.-]*linux[A-Za-z0-9_.-]*$'
  local aot_keys='["name","kind","version","repo","sha","subpaths","packageDir","entrypoint","lockOverlay","lockSha256","sdk","license","wrapper","rootEnv","versionArgs","versionLine","smokeArgs","smokeExpect"]'
  local row i label name kind keys host expected version url sha256 license_member
  local url_prefix url_suffix platform repo sha src dest git_id entrypoint
  local lock_overlay lock_sha256 sdk wrapper root_env args version_line smoke_expect word
  local words bad_word taken cli_names seen wrappers

  if ! jq -e '(.tools // []) | type == "array"' "$MANIFEST" >/dev/null 2>&1; then
    record "FAIL preflight manifest: tools must be an array"
    return 1
  fi
  TOOL_ROWS="$(jq -c '.tools // [] | to_entries[]' "$MANIFEST")"
  [ -n "$TOOL_ROWS" ] || return 0

  command -v python3 >/dev/null 2>&1 || record "FAIL preflight python3: required command not found (tools)"
  host="$(uname -s)/$(uname -m)"
  expected=""
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ "$host" = "Linux/x86_64" ]; then
      expected="linux-x64"
    else
      record "FAIL preflight tools: host $host cannot install tools"
    fi
  elif ! expected="$(host_dart_platform "$host")"; then
    expected=""
    record "FAIL preflight tools: host $host cannot install tools"
  fi

  taken="$(jq -r '(.packs[].id), (.clis[].name)' "$MANIFEST")"
  cli_names="$(jq -r '.clis[].name' "$MANIFEST")"
  seen=""
  wrappers=""
  while IFS= read -r -u 3 row; do
    [ -n "$row" ] || continue
    i="$(jq -r '.key' <<<"$row")"
    name="$(jq -r '.value.name // "" | strings' <<<"$row")"
    label="tools[$i]"
    if [[ "$name" =~ $RE_ID ]]; then
      label="$name"
    else
      record "FAIL preflight $label: bad name"
    fi
    kind="$(jq -r '.value.kind // "" | strings' <<<"$row")"
    case "$kind" in
      dart-sdk) keys="$sdk_keys" ;;
      dart-aot) keys="$aot_keys" ;;
      static-bin) keys="$static_keys" ;;
      *)
        record "FAIL preflight $label: unknown kind"
        continue
        ;;
    esac
    if ! jq -e --argjson k "$keys" '(.value | keys) - $k | length == 0' <<<"$row" >/dev/null; then
      record "FAIL preflight $label: unknown key in tools entry"
      continue
    fi
    if ! jq -e --argjson k "$keys" '
      def str: type == "string" and test("\\S");
      .value as $t
      | all($k[]; . as $key | $t | has($key))
      and all($t | to_entries[];
        if .key == "subpaths" then
          (.value | type == "array" and length > 0
            and all(.[]; type == "object" and (keys == ["dest", "gitId", "src"])
              and (.src, .dest, .gitId | str)))
        elif .key == "smokeArgs" then
          (.value | type == "array" and all(.[]; type == "string"))
        else (.value | str) end)' <<<"$row" >/dev/null; then
      record "FAIL preflight $label: every tools field must be present with its type"
      continue
    fi
    if grep -qxF -- "$name" <<<"$taken"; then
      record "FAIL preflight $label: tool name collides with a pack id or CLI name"
    fi
    case $'\n'"$seen" in
      *$'\n'"$name "*) record "FAIL preflight $label: duplicate tool name" ;;
    esac
    version="$(tool_field "$i" version)"
    [[ "$version" =~ $RE_SEMVER ]] || record "FAIL preflight $label: bad version"

    if [ "$kind" = "static-bin" ]; then
      url="$(tool_field "$i" url)"
      sha256="$(tool_field "$i" sha256)"
      [[ "$sha256" =~ $RE_SHA256 ]] || record "FAIL preflight $label: sha256 is not 64 hex"
      if ! [[ "$url" =~ $re_static_url ]] || [ "${BASH_REMATCH[1]}" != "$version" ]; then
        record "FAIL preflight $label: url must be a github release download of v$version naming a linux asset"
      fi
      seen="$seen$name $kind"$'\n'
      continue
    fi

    if [ "$kind" = "dart-sdk" ]; then
      url="$(tool_field "$i" url)"
      sha256="$(tool_field "$i" sha256)"
      license_member="$(tool_field "$i" licenseMember)"
      [[ "$sha256" =~ $RE_SHA256 ]] || record "FAIL preflight $label: sha256 is not 64 hex"
      case "$license_member" in
        dart-sdk/*) safe_rel_path "$license_member" || record "FAIL preflight $label: licenseMember must be a safe path under dart-sdk/" ;;
        *) record "FAIL preflight $label: licenseMember must be a safe path under dart-sdk/" ;;
      esac
      url_prefix="https://storage.googleapis.com/dart-archive/channels/stable/release/$version/sdk/dartsdk-"
      url_suffix="-release.zip"
      platform=""
      case "$url" in
        "$url_prefix"*"$url_suffix")
          platform="${url#"$url_prefix"}"
          platform="${platform%"$url_suffix"}"
          ;;
      esac
      if ! [[ "$platform" =~ $re_platform ]]; then
        record "FAIL preflight $label: url is not the dart-archive template for $version/${expected:-linux-x64}"
      elif [ "$platform" != "$expected" ]; then
        record "FAIL preflight $label: platform $platform is not this host's (${expected:-none})"
      fi
      seen="$seen$name $kind"$'\n'
      continue
    fi

    repo="$(tool_field "$i" repo)"
    sha="$(tool_field "$i" sha)"
    [[ "$repo" =~ $RE_GITHUB ]] || record "FAIL preflight $label: repo must be a github https url"
    [[ "$sha" =~ $RE_SHA1 ]] || record "FAIL preflight $label: sha is not 40 hex"
    while IFS=$'\t' read -r -u 4 src dest git_id; do
      if ! safe_rel_path "$src" || ! safe_rel_path "$dest"; then
        record "FAIL preflight $label: unsafe subpath"
      fi
      [[ "$git_id" =~ $RE_SHA1 ]] || record "FAIL preflight $label: gitId is not 40 hex"
    done 4< <(jq -r --argjson i "$i" '.tools[$i].subpaths[] | [.src, .dest, .gitId] | @tsv' "$MANIFEST")
    jq -e --argjson i "$i" '.tools[$i].subpaths | map(.dest) | length == (unique | length)' "$MANIFEST" >/dev/null ||
      record "FAIL preflight $label: duplicate subpath dest"
    jq -e --argjson i "$i" '.tools[$i] as $t | any($t.subpaths[]; .dest == $t.packageDir)' "$MANIFEST" >/dev/null ||
      record "FAIL preflight $label: packageDir must equal one subpath dest"
    entrypoint="$(tool_field "$i" entrypoint)"
    case "$entrypoint" in
      *.dart) safe_rel_path "$entrypoint" || record "FAIL preflight $label: entrypoint must be a safe relative .dart path" ;;
      *) record "FAIL preflight $label: entrypoint must be a safe relative .dart path" ;;
    esac
    lock_overlay="$(tool_field "$i" lockOverlay)"
    case "$lock_overlay" in
      "$OVERLAY_DIR_PREFIX"*/pubspec.lock) safe_rel_path "$lock_overlay" || lock_overlay="" ;;
      *) lock_overlay="" ;;
    esac
    [ -n "$lock_overlay" ] || record "FAIL preflight $label: lockOverlay must be under $OVERLAY_DIR_PREFIX and end /pubspec.lock"
    lock_sha256="$(tool_field "$i" lockSha256)"
    [[ "$lock_sha256" =~ $RE_SHA256 ]] || record "FAIL preflight $label: lockSha256 is not 64 hex"
    sdk="$(tool_field "$i" sdk)"
    grep -qxF -- "$sdk dart-sdk" <<<"$seen" || record "FAIL preflight $label: sdk must name an earlier dart-sdk tool"
    wrapper="$(tool_field "$i" wrapper)"
    [[ "$wrapper" =~ $RE_ID ]] || record "FAIL preflight $label: bad wrapper"
    if grep -qxF -- "$wrapper" <<<"$cli_names" || grep -qxF -- "$wrapper" <<<"$wrappers"; then
      record "FAIL preflight $label: wrapper collides with a CLI name or another wrapper"
    fi
    wrappers="$wrappers$wrapper"$'\n'
    root_env="$(tool_field "$i" rootEnv)"
    [[ "$root_env" =~ $re_root_env ]] || record "FAIL preflight $label: rootEnv must match $re_root_env"
    args="$(tool_field "$i" versionArgs)"
    [[ "$args" =~ $RE_VERSION_ARGS ]] || record "FAIL preflight $label: versionArgs must be one word"
    version_line="$(tool_field "$i" versionLine)"
    case "$version_line" in
      *" v$version") [[ "$version_line" =~ $re_version_line ]] || version_line="" ;;
      *) version_line="" ;;
    esac
    [ -n "$version_line" ] || record "FAIL preflight $label: versionLine must be plain text ending \" v<version>\""
    words="$(jq -r --argjson i "$i" '.tools[$i].smokeArgs | length' "$MANIFEST")"
    if [ "$words" -lt 1 ] || [ "$words" -gt 12 ]; then
      record "FAIL preflight $label: smokeArgs must hold 1 to 12 words"
    fi
    bad_word=0
    while IFS= read -r word; do
      [[ "$word" =~ $re_smoke_word ]] || bad_word=1
    done < <(jq -r --argjson i "$i" '.tools[$i].smokeArgs[]' "$MANIFEST")
    [ "$bad_word" -eq 0 ] || record "FAIL preflight $label: smokeArgs word is unsafe"
    smoke_expect="$(tool_field "$i" smokeExpect)"
    safe_rel_path "$smoke_expect" || record "FAIL preflight $label: unsafe smokeExpect"
    seen="$seen$name $kind"$'\n'
  done 3<<<"$TOOL_ROWS"
  return 0
}

# extract_object <git-fn> <commit> <src> <gitId> <dest> [exclude...]
# Writes exactly the objects the pins name. Sets STEP_ERROR and returns 1 on
# any mismatch; never reads the working tree or attributes.
extract_object() {
  local g="$1" commit="$2" src="$3" git_id="$4" dest="$5"
  shift 5
  local actual type mode rec meta rest path oid ex listing matched
  actual="$("$g" rev-parse --verify --quiet "$commit:$src" 2>/dev/null)" || actual=""
  if [ "$actual" != "$git_id" ]; then
    STEP_ERROR="content drifted: $src is ${actual:-absent} at $commit, pinned $git_id"
    return 1
  fi
  type="$("$g" cat-file -t "$git_id")" || {
    STEP_ERROR="cannot read object $git_id"
    return 1
  }
  if [ "$type" = "blob" ]; then
    mode="$("$g" ls-tree "$commit" -- "$src" | awk '{print $1}')"
    case "$mode" in
      100644 | 100755) ;;
      *)
        STEP_ERROR="$src has mode ${mode:-unknown}; only regular files are installed"
        return 1
        ;;
    esac
    mkdir -p "$(dirname "$dest")"
    "$g" cat-file blob "$git_id" >"$dest" || {
      STEP_ERROR="cannot write $src"
      return 1
    }
    return 0
  fi
  if [ "$type" != "tree" ]; then
    STEP_ERROR="$src is a $type, not a blob or tree"
    return 1
  fi

  listing="$WORK/ls-tree.$$"
  matched="$WORK/matched.$$"
  : >"$matched"
  "$g" ls-tree -r -z "$git_id" >"$listing" || {
    STEP_ERROR="cannot list tree $git_id"
    return 1
  }
  mkdir -p "$dest"
  while IFS= read -r -d '' rec; do
    meta="${rec%%	*}"
    path="${rec#*	}"
    mode="${meta%% *}"
    rest="${meta#* }"
    type="${rest%% *}"
    oid="${rest#* }"
    case "$mode" in
      120000 | 160000)
        STEP_ERROR="$src/$path has mode $mode (symlink or submodule); refusing"
        return 1
        ;;
      100644 | 100755) ;;
      *)
        STEP_ERROR="$src/$path has unexpected mode $mode"
        return 1
        ;;
    esac
    if [ "$type" != "blob" ]; then
      STEP_ERROR="$src/$path is a $type"
      return 1
    fi
    if ! safe_rel_path "$path"; then
      STEP_ERROR="$src contains an unsafe path"
      return 1
    fi
    for ex in "$@"; do
      if [ "$path" = "$ex" ]; then
        printf '%s\n' "$ex" >>"$matched"
        continue 2
      fi
    done
    mkdir -p "$(dirname "$dest/$path")"
    "$g" cat-file blob "$oid" >"$dest/$path" || {
      STEP_ERROR="cannot write $src/$path"
      return 1
    }
  done <"$listing"
  # An exclude that matches nothing has gone stale with a pin bump; fail so
  # the file it was meant to drop is re-reviewed instead of silently shipped.
  for ex in "$@"; do
    if ! grep -qxF -- "$ex" "$matched"; then
      STEP_ERROR="exclude $ex matched nothing under $src"
      return 1
    fi
  done
  return 0
}

# Deterministic: inside a leading --- block only, drop grant keys and their
# continuation lines; every other byte is kept.
strip_frontmatter() {
  local file="$1" tmp
  [ "$(head -n 1 "$file" | tr -d '\r')" = "---" ] || return 0
  tmp="$file.strip.$$"
  awk -v grant_re="$GRANT_KEYS_RE" '
    { line = $0; sub(/\r$/, "", line) }
    NR == 1 && line == "---" { fm = 1; print; next }
    fm && line == "---" { fm = 0; skip = 0; print; next }
    fm && line ~ grant_re { skip = 1; next }
    fm && skip && line ~ /^([[:space:]]|-)/ { next }
    fm { skip = 0 }
    { print }
  ' "$file" >"$tmp" || {
    rm -f "$tmp"
    return 1
  }
  if cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
  else
    mv -f "$tmp" "$file"
  fi
}

# verify_staging <stage> <pack index>. Any hit is a FAIL for the whole pack
# (STEP_ERROR set).
verify_staging() {
  local stage="$1" i="$2" hit file rel ref count n skill_dir name token allowed hits refs
  local -a find_names=() token_args=()
  for name in "${FORBIDDEN_NAMES[@]}"; do
    find_names+=(-o -name "$name")
  done
  hit="$(find "$stage" \( "${find_names[@]:1}" \) -print | head -n 1)"
  if [ -n "$hit" ]; then
    STEP_ERROR="forbidden entry ${hit#"$stage"/}"
    return 1
  fi
  hit="$(find "$stage" -type l -print | head -n 1)"
  if [ -n "$hit" ]; then
    STEP_ERROR="symlink ${hit#"$stage"/}"
    return 1
  fi
  while IFS= read -r -d '' file; do
    if awk -v grant_re="$GRANT_KEYS_RE" '
      { line = $0; sub(/\r$/, "", line) }
      NR == 1 { if (line != "---") exit 1; fm = 1; next }
      fm && line == "---" { exit 1 }
      fm && line ~ grant_re { exit 0 }
      END { exit 1 }
    ' "$file"; then
      STEP_ERROR="grant key left in the frontmatter of ${file#"$stage"/}"
      return 1
    fi
  done < <(find "$stage" -type f -name '*.md' -print0)
  if [ -d "$stage/skills" ]; then
    for skill_dir in "$stage"/skills/*/; do
      [ -d "$skill_dir" ] || continue
      if ! grep -q '^name:' "${skill_dir}SKILL.md" 2>/dev/null; then
        STEP_ERROR="${skill_dir#"$stage"/} has no SKILL.md with a name"
        return 1
      fi
    done
  fi

  # Helper references. Each allowedHelperRefs entry must occur exactly `count`
  # times in its file; then no forbidden token may remain anywhere once those
  # occurrences are cut out.
  allowed="$(helper_ref_rows "$i")"
  while IFS=$'\t' read -r file ref count; do
    [ -n "$file" ] || continue
    n=0
    if [ -f "$stage/$file" ]; then
      n="$({ grep -oF -- "$ref" "$stage/$file" || true; } | wc -l | tr -d ' ')"
    fi
    if [ "$n" != "$count" ]; then
      STEP_ERROR="$file holds the allowlisted helper reference $n times (manifest allows $count); re-review allowedHelperRefs"
      return 1
    fi
  done <<<"$allowed"
  while IFS= read -r token; do
    token_args+=(-e "$token")
  done <<<"$HELPER_TOKENS"
  hits="$(grep -rlF "${token_args[@]}" -- "$stage")" || [ $? -eq 1 ] || {
    STEP_ERROR="cannot scan $stage for helper references"
    return 1
  }
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    rel="${file#"$stage"/}"
    refs="$(printf '%s\n' "$allowed" | awk -F '\t' -v f="$rel" '$1 == f { print $2 }')"
    # Cut each allowed ref out of every line (leaving a newline, so the text on
    # either side cannot join into a token), then look for any token left.
    if [ -z "$refs" ] || ! HELPER_REFS="$refs" HELPER_TOKENS="$HELPER_TOKENS" awk '
      BEGIN {
        nr = split(ENVIRON["HELPER_REFS"], refs, "\n")
        nt = split(ENVIRON["HELPER_TOKENS"], toks, "\n")
      }
      {
        line = $0
        for (r = 1; r <= nr; r++) {
          rest = line
          line = ""
          while ((p = index(rest, refs[r])) > 0) {
            line = line substr(rest, 1, p - 1) "\n"
            rest = substr(rest, p + length(refs[r]))
          }
          line = line rest
        }
        for (t = 1; t <= nt; t++) if (index(line, toks[t]) > 0) exit 1
      }
    ' "$file"; then
      STEP_ERROR="helper reference in $rel beyond its allowedHelperRefs"
      return 1
    fi
  done <<<"$hits"
  return 0
}

# Rename a staged pack (or tool) dir into place. An existing dir is moved aside
# (never deleted) and reported STALE under the optional noun in $3 (default pack).
publish_dir() {
  local stage="$1" target="$2" aside
  if [ ! -e "$target" ]; then
    mv "$stage" "$target" || return 1
    return 0
  fi
  aside="$(dirname "$target")/.$(basename "$target").replaced.$(date -u +%Y%m%dT%H%M%SZ)"
  if mv --help 2>/dev/null | grep -q -- '--exchange'; then
    mv --exchange "$stage" "$target" || return 1
    mv "$stage" "$aside" || return 1
  else
    # Fallback (coreutils < 9.5, BSD mv): two renames. Between them the path is
    # briefly missing, so a run in flight that resolves it would fail — which is
    # why the runbook requires no run in flight before this script runs.
    mv "$target" "$aside" || return 1
    mv "$stage" "$target" || return 1
  fi
  record "STALE ${3:-pack} $aside (left in place)"
}

# Stamp-and-binary check, kept out of install_cli so nothing there touches the
# bin dir before the tarball hash is verified.
cli_at_pin() {
  local name="$1" stamp="$2" tarball_sha="$3" bin recorded_tar recorded_bin
  bin="${BIN_DIR}/$name"
  [ -f "$stamp" ] && [ -f "$bin" ] || return 1
  recorded_tar="$(sed -n 's/^tarball_sha256 //p' "$stamp")"
  recorded_bin="$(sed -n 's/^binary_sha256 //p' "$stamp")"
  [ "$recorded_tar" = "$tarball_sha" ] && [ -n "$recorded_bin" ] &&
    [ "$recorded_bin" = "$(sha256_of "$bin")" ]
}

# install_cli <name> <version> <url> <sha256> <member> <licenseMember>
install_cli() {
  local name="$1" version="$2" url="$3" sha256="$4" member="$5" license_member="$6"
  local stamp dl x tmp lic_dir lic_file bin_sha
  stamp="$ROOT/clis/$name@$version.stamp"

  if cli_at_pin "$name" "$stamp" "$sha256"; then
    record "SKIPPED cli $name $version (already at pin)"
    return 0
  fi

  dl="$WORK/cli-$name.tar.gz"
  if ! fetch_verified "$name $version" "$url" "$sha256" "$dl"; then
    record "FAIL cli $name: $STEP_ERROR"
    return 1
  fi
  x="$WORK/cli-$name.x"
  mkdir -p "$x"
  if ! tar -xzf "$dl" -C "$x" "$member" "$license_member"; then
    record "FAIL cli $name: tarball lacks $member or $license_member"
    return 1
  fi
  if [ ! -f "$x/$member" ] || [ -L "$x/$member" ] || [ ! -f "$x/$license_member" ] ||
    [ -L "$x/$license_member" ]; then
    record "FAIL cli $name: extracted members are not regular files"
    return 1
  fi

  tmp="$BIN_DIR/.$name.new.$$"
  lic_dir="$ROOT/licenses/$name-$version"
  lic_file="$lic_dir/$(basename "$license_member")"
  if ! { mkdir -p "$BIN_DIR" "$ROOT/clis" "$lic_dir" &&
    cat "$x/$member" >"$tmp" &&
    chmod 0755 "$tmp" &&
    { [ "$DRY_RUN" -eq 1 ] || chown root:root "$tmp"; } &&
    mv -f "$tmp" "$BIN_DIR/$name" &&
    cat "$x/$license_member" >"$lic_file" &&
    chmod 0644 "$lic_file"; }; then
    rm -f "$tmp"
    record "FAIL cli $name: could not write the binary or its license"
    return 1
  fi

  bin_sha="$(sha256_of "$BIN_DIR/$name")"
  if ! write_stamp "$stamp" 'tarball_sha256 %s\nbinary_sha256 %s\n' "$sha256" "$bin_sha"; then
    record "FAIL cli $name: could not write its stamp"
    return 1
  fi
  record "INSTALLED cli $name $version"
}

# The stamp's hash covers the manifest's pack entry, the forbidden helper
# tokens, the overlay blob ids at HEAD and INSTALLER_OUTPUT_VERSION; the
# `source` line records provenance and is not compared, so a new unrelated
# commit does not reinstall (and rename aside) an unchanged pack.
pack_stamp_hash() {
  local i="$1" from
  {
    jq -c --argjson i "$i" '.packs[$i]' "$MANIFEST"
    printf '%s\n' "$HELPER_TOKENS"
    while IFS=$'\t' read -r -u 6 from _; do
      git_repo rev-parse --verify --quiet "$HEAD_SHA:$from" || printf 'absent %s\n' "$from"
    done 6< <(overlay_rows "$i")
    printf 'installer-output %s\n' "$INSTALLER_OUTPUT_VERSION"
  } | sha256sum | awk '{print $1}'
}

# fetch_pinned <id> <repo> <sha> <blobless|full>: the one pinned commit into a
# fresh root-owned scratch repo (FETCH_REPO). Sets STEP_ERROR and returns 1 on
# failure.
fetch_pinned() {
  local id="$1" repo="$2" sha="$3" mode="$4"
  FETCH_REPO="$WORK/fetch-$id"
  log "fetching $id @ $sha"
  if ! { git init -q "$FETCH_REPO" && git_fetch remote add origin "$repo"; }; then
    STEP_ERROR="cannot create a scratch repo for $id"
    return 1
  fi
  if [ "$mode" = "blobless" ]; then
    # A partial fetch of the one pinned commit: trees now, each blob on its
    # first cat-file. The named remote is where those lazy blob fetches go.
    git_fetch -c protocol.version=2 fetch -q --filter=blob:none --depth 1 origin "$sha" || {
      STEP_ERROR="fetch of $sha from $repo failed"
      return 1
    }
  else
    # Every object at once: a tool builds a whole tree, and one lazy fetch per
    # blob would be hundreds of round trips.
    git_fetch -c protocol.version=2 fetch -q --depth 1 origin "$sha" || {
      STEP_ERROR="fetch of $sha from $repo failed"
      return 1
    }
  fi
  if [ "$(git_fetch rev-parse FETCH_HEAD)" != "$sha" ]; then
    STEP_ERROR="fetched commit is not the pinned sha"
    return 1
  fi
}

# stage_pack <index> <id> <repo> <sha> <stage> <stamp hash>
# Fetches, extracts, overlays, strips, verifies and stamps the pack in <stage>
# with root ownership and read-only modes. Sets STEP_ERROR and returns 1 on any
# failure; install_pack removes <stage> and records the FAIL.
stage_pack() {
  local i="$1" id="$2" repo="$3" sha="$4" stage="$5" expected="$6" g src dest git_id ex_rest from md
  local -a excludes
  if [ "$repo" = "self" ]; then
    if ! git_repo cat-file -e "$sha^{commit}" 2>/dev/null; then
      STEP_ERROR="pinned sha not in $AUTOMATA_REPO history — fetch origin as the automata user first"
      return 1
    fi
    g=git_repo
  else
    fetch_pinned "$id" "$repo" "$sha" blobless || return 1
    g=git_fetch
  fi

  while IFS=$'\t' read -r -u 6 src dest git_id ex_rest; do
    excludes=()
    [ -z "$ex_rest" ] || IFS=$'\t' read -r -a excludes <<<"$ex_rest"
    extract_object "$g" "$sha" "$src" "$git_id" "$stage/$dest" ${excludes[@]+"${excludes[@]}"} || return 1
  done 6< <(subpath_rows "$i")

  while IFS=$'\t' read -r -u 6 from dest; do
    mkdir -p "$(dirname "$stage/$dest")"
    if ! git_repo cat-file blob "$HEAD_SHA:$from" >"$stage/$dest" 2>/dev/null; then
      STEP_ERROR="overlay $from is absent at $HEAD_SHA"
      return 1
    fi
  done 6< <(overlay_rows "$i")

  while IFS= read -r -d '' md; do
    if ! strip_frontmatter "$md"; then
      STEP_ERROR="frontmatter strip failed"
      return 1
    fi
  done < <(find "$stage" -type f -name '*.md' -print0)

  verify_staging "$stage" "$i" || return 1

  if ! { printf 'stamp %s\nsource %s\n' "$expected" "$HEAD_SHA" >"$stage/.stamp" &&
    find "$stage" -type d -exec chmod 0755 {} + &&
    find "$stage" -type f -exec chmod 0644 {} + &&
    { [ "$DRY_RUN" -eq 1 ] || chown -R root:root "$stage"; }; }; then
    STEP_ERROR="could not set modes or ownership"
    return 1
  fi
}

# install_pack <index> <id> <repo> <sha>
install_pack() {
  local i="$1" id="$2" repo="$3" sha="$4" target expected stage
  target="$ROOT/$id@$sha"
  expected="$(pack_stamp_hash "$i")"

  if [ -f "$target/.stamp" ] && [ "$(head -n 1 "$target/.stamp")" = "stamp $expected" ]; then
    record "SKIPPED pack $id $sha (already at pin)"
    return 0
  fi

  if ! stage="$(mktemp -d "$ROOT/.staging.$id.XXXXXX")"; then
    record "FAIL pack $id: cannot create a staging dir under $ROOT"
    return 1
  fi
  if stage_pack "$i" "$id" "$repo" "$sha" "$stage" "$expected"; then
    if publish_dir "$stage" "$target"; then
      record "INSTALLED pack $id $sha"
      return 0
    fi
    STEP_ERROR="could not publish $target"
  fi
  rm -rf "$stage"
  record "FAIL pack $id: $STEP_ERROR"
  return 1
}

# The stamp's hash covers the manifest's tool entry, for a dart-aot tool also
# its sdk entry and the lock overlay's blob id at HEAD, and TOOLS_OUTPUT_VERSION.
tool_stamp_hash() {
  local i="$1" sdk lock_overlay
  {
    jq -c --argjson i "$i" '.tools[$i]' "$MANIFEST"
    if [ "$(tool_field "$i" kind)" = "dart-aot" ]; then
      sdk="$(tool_field "$i" sdk)"
      jq -c --arg n "$sdk" '.tools[] | select(.name == $n)' "$MANIFEST"
      lock_overlay="$(tool_field "$i" lockOverlay)"
      git_repo rev-parse --verify --quiet "$HEAD_SHA:$lock_overlay" || printf 'absent %s\n' "$lock_overlay"
    fi
    printf 'tools-output %s\n' "$TOOLS_OUTPUT_VERSION"
  } | sha256sum | awk '{print $1}'
}

# tool_at_pin <index> <stamp> <expected hash> <target>: the stamp matches, the
# published artifact still has the recorded sha256 and (dart-aot) the installed
# wrapper is byte-identical to the template. Reads nothing remote.
tool_at_pin() {
  local i="$1" stamp="$2" expected="$3" target="$4" artifact recorded name wrapper check
  [ -f "$stamp" ] && [ -d "$target" ] || return 1
  [ "$(head -n 1 "$stamp")" = "stamp $expected" ] || return 1
  case "$(tool_field "$i" kind)" in
    dart-sdk) artifact="$target/bin/dart" ;;
    static-bin) artifact="$target/bin/$(tool_field "$i" name)" ;;
    dart-aot)
      name="$(tool_field "$i" name)"
      wrapper="$(tool_field "$i" wrapper)"
      artifact="$target/bin/$wrapper"
      check="$WORK/wrapper-check.$name"
      write_wrapper "$(tool_field "$i" rootEnv)" "$(basename "$target")" "$wrapper" "$check" || return 1
      cmp -s "$check" "$BIN_DIR/$wrapper" || return 1
      ;;
    *) return 1 ;;
  esac
  recorded="$(sed -n 's/^artifact_sha256 //p' "$stamp")"
  [ -f "$artifact" ] && [ -n "$recorded" ] && [ "$recorded" = "$(sha256_of "$artifact")" ]
}

# stage_dart_sdk <index> <stage>: the verified zip's dart-sdk/ contents, in
# <stage>, root-owned, top dir 0700. Sets STEP_ERROR and returns 1 on failure.
stage_dart_sdk() {
  local i="$1" stage="$2" name version url sha256 zip cached x execs scan_out
  name="$(tool_field "$i" name)"
  version="$(tool_field "$i" version)"
  url="$(tool_field "$i" url)"
  sha256="$(tool_field "$i" sha256)"
  zip="$WORK/tool-$name.zip"
  cached=""
  if [ "$DRY_RUN" -eq 1 ] && [ -n "$BATTERIES_DOWNLOAD_CACHE" ]; then
    cached="$BATTERIES_DOWNLOAD_CACHE/$sha256.zip"
  fi
  # Checked before ANY extraction below, a cached copy included.
  fetch_verified "$name $version" "$url" "$sha256" "$zip" "$cached" || return 1

  execs="$WORK/tool-$name.execs"
  scan_out="$WORK/tool-$name.scan"
  if ! python3 - "$zip" "$execs" >"$scan_out" 2>&1 <<'PY'; then
import stat
import sys
import zipfile

zip_path, execs_path = sys.argv[1], sys.argv[2]
limit = 2 * 1024 ** 3
total = 0
execs = []
with zipfile.ZipFile(zip_path) as archive:
    for info in archive.infolist():
        name = info.filename
        if not name.startswith("dart-sdk/"):
            sys.exit("outside dart-sdk/: " + repr(name))
        if "\x00" in name or "\\" in name or name.startswith("/"):
            sys.exit("unsafe name: " + repr(name))
        if any(part in ("", ".", "..") for part in name.rstrip("/").split("/")):
            sys.exit("unsafe path: " + repr(name))
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            sys.exit("symlink: " + repr(name))
        total += info.file_size
        if total > limit:
            sys.exit("total size over 2 GiB")
        if not name.endswith("/") and mode & 0o111:
            execs.append(name[len("dart-sdk/"):])
with open(execs_path, "wb") as out:
    for name in execs:
        out.write(name.encode() + b"\0")
PY
    STEP_ERROR="zip entry rejected: $(head -n 1 "$scan_out")"
    return 1
  fi

  x="$stage/.x"
  if ! python3 -m zipfile -e "$zip" "$x"; then
    STEP_ERROR="extraction failed"
    return 1
  fi
  if [ -n "$(find "$x" -type l -print | head -n 1)" ]; then
    STEP_ERROR="zip entry rejected: a symlink appeared after extraction"
    return 1
  fi
  if [ "$(cat "$x/dart-sdk/version" 2>/dev/null)" != "$version" ]; then
    STEP_ERROR="dart-sdk/version is not $version"
    return 1
  fi
  if ! { find "$x/dart-sdk" -mindepth 1 -maxdepth 1 -exec mv {} "$stage/" \; &&
    rmdir "$x/dart-sdk" "$x" &&
    find "$stage" -type d -exec chmod 0755 {} + &&
    find "$stage" -type f -exec chmod 0644 {} + &&
    { [ ! -s "$execs" ] || (cd "$stage" && xargs -0 chmod 0755 <"$execs"); } &&
    { [ "$DRY_RUN" -eq 1 ] || chown -R root:root "$stage"; } &&
    chmod 0700 "$stage"; }; then
    STEP_ERROR="could not set modes or ownership"
    return 1
  fi
}

# stage_static_bin <index> <stage>: the sha256-verified executable as
# <stage>/bin/<name>, root-owned, 0755 all the way down so the agent uid can
# run it by absolute path. It is never given a bin-dir entry. Sets STEP_ERROR
# and returns 1 on failure.
stage_static_bin() {
  local i="$1" stage="$2" name version url sha256 dl
  name="$(tool_field "$i" name)"
  version="$(tool_field "$i" version)"
  url="$(tool_field "$i" url)"
  sha256="$(tool_field "$i" sha256)"
  dl="$WORK/tool-$name.bin"
  fetch_verified "$name $version" "$url" "$sha256" "$dl" || return 1
  if ! { mkdir -p "$stage/bin" &&
    cat "$dl" >"$stage/bin/$name" &&
    chmod 0755 "$stage" "$stage/bin" "$stage/bin/$name" &&
    { [ "$DRY_RUN" -eq 1 ] || chown -R root:root "$stage"; }; }; then
    STEP_ERROR="could not write the executable"
    return 1
  fi
}

# stage_dart_aot <index> <stage>: <stage>/src/<dest…> from the pinned commit,
# the committed lock, and <stage>/bin/<wrapper> compiled from them. Sets
# STEP_ERROR and returns 1 on failure.
stage_dart_aot() {
  local i="$1" stage="$2" name repo sha package_dir entrypoint lock_overlay lock_sha256 sdk
  local sdk_dir wrapper src dest git_id pkg_dir lock build_log status pname root_uri pkg_root
  name="$(tool_field "$i" name)"
  repo="$(tool_field "$i" repo)"
  sha="$(tool_field "$i" sha)"
  package_dir="$(tool_field "$i" packageDir)"
  entrypoint="$(tool_field "$i" entrypoint)"
  lock_overlay="$(tool_field "$i" lockOverlay)"
  lock_sha256="$(tool_field "$i" lockSha256)"
  sdk="$(tool_field "$i" sdk)"
  wrapper="$(tool_field "$i" wrapper)"
  sdk_dir="$ROOT/$sdk@$(jq -r --arg n "$sdk" '.tools[] | select(.name == $n) | .version' "$MANIFEST")"
  pkg_dir="$stage/src/$package_dir"
  lock="$pkg_dir/pubspec.lock"
  build_log="$WORK/build-$name.log"

  fetch_pinned "$name" "$repo" "$sha" full || return 1
  # Plumbing only, each subpath tree-id verified. The source tree is a build
  # input that is never linked into HOME, so the pack scan (forbidden names,
  # grant keys) does not apply to it: cli/bin is legitimate here.
  while IFS=$'\t' read -r -u 6 src dest git_id; do
    extract_object git_fetch "$sha" "$src" "$git_id" "$stage/src/$dest" || return 1
  done 6< <(jq -r --argjson i "$i" '.tools[$i].subpaths[] | [.src, .dest, .gitId] | @tsv' "$MANIFEST")

  if ! git_repo cat-file blob "$HEAD_SHA:$lock_overlay" >"$lock" 2>/dev/null; then
    STEP_ERROR="lock overlay $lock_overlay is absent at $HEAD_SHA"
    return 1
  fi
  if [ "$(sha256_of "$lock")" != "$lock_sha256" ]; then
    STEP_ERROR="lock overlay sha256 mismatch"
    return 1
  fi

  if ! { mkdir -p "$ROOT/pub-cache" "$WORK/build-home" "$stage/bin" &&
    chmod 0700 "$ROOT/pub-cache" &&
    { [ "$DRY_RUN" -eq 1 ] || chown root:root "$ROOT/pub-cache"; }; }; then
    STEP_ERROR="cannot prepare the build cache"
    return 1
  fi
  status=0
  env -i HOME="$WORK/build-home" PATH="$sdk_dir/bin:/usr/bin:/bin" PUB_CACHE="$ROOT/pub-cache" LANG=C \
    "$sdk_dir/bin/dart" --suppress-analytics pub get --enforce-lockfile --directory "$pkg_dir" \
    >"$build_log" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    log "pub get output (tail):"
    tail -n 20 "$build_log" >&2
    STEP_ERROR="pub get --enforce-lockfile failed (exit $status)"
    return 1
  fi

  if [ ! -f "$pkg_dir/.dart_tool/package_config.json" ]; then
    STEP_ERROR="pub get wrote no package_config.json"
    return 1
  fi
  while IFS=$'\t' read -r -u 6 pname root_uri; do
    case "$root_uri" in
      *%*)
        STEP_ERROR="dependency $pname has an encoded root uri"
        return 1
        ;;
      file://*) pkg_root="${root_uri#file://}" ;;
      /*)
        STEP_ERROR="dependency $pname has an unexpected root uri"
        return 1
        ;;
      *) pkg_root="$pkg_dir/.dart_tool/$root_uri" ;;
    esac
    if [ -e "$pkg_root/hook" ]; then
      STEP_ERROR="dependency $pname has a build hook"
      return 1
    fi
  done 6< <(jq -r '.packages[] | [.name, .rootUri] | @tsv' "$pkg_dir/.dart_tool/package_config.json")

  status=0
  env -i HOME="$WORK/build-home" PATH="$sdk_dir/bin:/usr/bin:/bin" PUB_CACHE="$ROOT/pub-cache" LANG=C \
    "$sdk_dir/bin/dart" --suppress-analytics compile exe "$pkg_dir/$entrypoint" -o "$stage/bin/$wrapper" \
    >>"$build_log" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    log "compile output (tail):"
    tail -n 20 "$build_log" >&2
    STEP_ERROR="compile failed (exit $status)"
    return 1
  fi
  rm -rf "$pkg_dir/.dart_tool"
  if [ "$(sha256_of "$lock")" != "$lock_sha256" ]; then
    STEP_ERROR="the build rewrote the lock"
    return 1
  fi
  if ! { find "$stage" -type d -exec chmod 0755 {} + &&
    find "$stage" -type f -exec chmod 0644 {} + &&
    chmod 0755 "$stage/bin/$wrapper" &&
    { [ "$DRY_RUN" -eq 1 ] || chown -R root:root "$stage"; }; }; then
    STEP_ERROR="could not set modes or ownership"
    return 1
  fi
}

# write_wrapper <rootEnv> <tool dir name> <wrapper> [<out>]: the FIXED wrapper
# text. Only ROOT and shape-checked tokens are interpolated, every path
# single-quoted. With <out> it only writes the text there (tool_at_pin compares
# it); without, it installs <bin>/<wrapper> through a temp file and mv -f.
# shellcheck disable=SC2016 # "$@" is wrapper text, expanded when the wrapper runs
write_wrapper() {
  local root_env="$1" dir="$2" wrapper="$3" out="${4:-}" tmp
  case "$ROOT" in
    *"'"*)
      STEP_ERROR="the install root contains a single quote"
      return 1
      ;;
  esac
  tmp="$out"
  if [ -z "$out" ]; then
    mkdir -p "$BIN_DIR" || {
      STEP_ERROR="cannot create $BIN_DIR"
      return 1
    }
    tmp="$BIN_DIR/.$wrapper.new.$$"
  fi
  if ! {
    printf '#!/bin/sh\n'
    printf '# Written by install-batteries.sh (batteries tools). Do not edit.\n'
    printf "%s='%s'\n" "$root_env" "$ROOT/$dir/src"
    printf "PUB_CACHE='%s'\n" "$ROOT/pub-cache"
    printf 'export %s PUB_CACHE\n' "$root_env"
    printf "exec '%s' " "$ROOT/$dir/bin/$wrapper"
    printf '"$@"\n'
  } >"$tmp"; then
    rm -f "$tmp"
    STEP_ERROR="cannot write the $wrapper wrapper"
    return 1
  fi
  [ -z "$out" ] || return 0
  if ! { chmod 0755 "$tmp" &&
    { [ "$DRY_RUN" -eq 1 ] || chown root:root "$tmp"; } &&
    mv -f "$tmp" "$BIN_DIR/$wrapper"; }; then
    rm -f "$tmp"
    STEP_ERROR="cannot install the $wrapper wrapper"
    return 1
  fi
}

# install_tool <index>: SKIPPED at pin, else staged in <root>, published by
# rename, license copied, stamped last. An aot tool needs its sdk INSTALLED or
# SKIPPED earlier in this run.
install_tool() {
  local i="$1" name kind version sha target stamp expected stage license_member license_file lic_dir
  local artifact sdk wrapper
  name="$(tool_field "$i" name)"
  kind="$(tool_field "$i" kind)"
  version="$(tool_field "$i" version)"
  case "$kind" in
    dart-sdk | static-bin) target="$ROOT/$name@$version" ;;
    *)
      sha="$(tool_field "$i" sha)"
      target="$ROOT/$name@$sha"
      ;;
  esac
  stamp="$ROOT/tools/$name@$version.stamp"
  expected="$(tool_stamp_hash "$i")"

  if tool_at_pin "$i" "$stamp" "$expected" "$target"; then
    record "SKIPPED tool $name $version (already at pin)"
    TOOLS_OK="$TOOLS_OK$name "
    return 0
  fi
  if [ "$kind" = "dart-aot" ]; then
    sdk="$(tool_field "$i" sdk)"
    case "$TOOLS_OK" in
      *" $sdk "*) ;;
      *)
        record "FAIL tool $name: sdk $sdk is not installed at its pin"
        return 1
        ;;
    esac
  fi

  if ! stage="$(mktemp -d "$ROOT/.staging.$name.XXXXXX")"; then
    record "FAIL tool $name: cannot create a staging dir under $ROOT"
    return 1
  fi
  STEP_ERROR=""
  case "$kind" in
    dart-sdk) stage_dart_sdk "$i" "$stage" || STEP_ERROR="${STEP_ERROR:-staging failed}" ;;
    static-bin) stage_static_bin "$i" "$stage" || STEP_ERROR="${STEP_ERROR:-staging failed}" ;;
    *) stage_dart_aot "$i" "$stage" || STEP_ERROR="${STEP_ERROR:-staging failed}" ;;
  esac
  if [ -n "$STEP_ERROR" ]; then
    rm -rf "$stage"
    record "FAIL tool $name: $STEP_ERROR"
    return 1
  fi
  if ! publish_dir "$stage" "$target" tool; then
    rm -rf "$stage"
    record "FAIL tool $name: could not publish $target"
    return 1
  fi
  if [ "$kind" = "dart-sdk" ]; then
    license_member="$(tool_field "$i" licenseMember)"
    license_file="$target/${license_member#*/}"
    artifact="$target/bin/dart"
  elif [ "$kind" = "static-bin" ]; then
    license_file=""
    artifact="$target/bin/$name"
  else
    wrapper="$(tool_field "$i" wrapper)"
    license_file="$target/src/LICENSE"
    artifact="$target/bin/$wrapper"
    if ! write_wrapper "$(tool_field "$i" rootEnv)" "$(basename "$target")" "$wrapper"; then
      record "FAIL tool $name: $STEP_ERROR"
      return 1
    fi
  fi
  lic_dir="$ROOT/licenses/$name-$version"
  if ! { mkdir -p "$lic_dir" "$ROOT/tools" &&
    { [ ! -f "$license_file" ] || { cat "$license_file" >"$lic_dir/LICENSE" && chmod 0644 "$lic_dir/LICENSE"; }; } &&
    write_stamp "$stamp" 'stamp %s\nartifact_sha256 %s\nsource %s\n' "$expected" "$(sha256_of "$artifact")" "$HEAD_SHA"; }; then
    record "FAIL tool $name: could not write its license or stamp"
    return 1
  fi
  record "INSTALLED tool $name $version"
  TOOLS_OK="$TOOLS_OK$name "
}

list_stale() {
  local dir base noun
  for dir in "$ROOT"/*@*; do
    [ -d "$dir" ] || continue
    base="$(basename "$dir")"
    if [ -n "$HARNESS" ] && jq -e --arg n "${base%%@*}" 'any(.packs[]?; .id == $n)' "$HARNESS" >/dev/null 2>&1; then
      # Harness packs are reported by list_stale_harness.
      continue
    fi
    if jq -e --arg d "$base" '
      any(.packs[]; (.id + "@" + .sha) == $d)
      or any((.tools // [])[];
        (.name + "@" + (if .kind == "dart-sdk" or .kind == "static-bin" then .version else .sha end)) == $d)' \
      "$MANIFEST" >/dev/null; then
      continue
    fi
    noun=pack
    if jq -e --arg n "${base%%@*}" 'any((.tools // [])[]; .name == $n)' "$MANIFEST" >/dev/null; then
      noun=tool
    fi
    record "STALE $noun $dir (left in place)"
  done
}

# Runs a FIXED command string as the agent through the production spawn shape
# (worker → sudo rule → /bin/sh → bash -lc), stdin closed. Manifest values
# reach the agent shell only through BATTERIES_CHECK_* env, never the string.
# shellcheck disable=SC2016 # "$1" must expand in the agent's sh, not here
as_agent() {
  local command_string="$1" check_name="$2" check_args="$3" check_path="$4"
  runuser -u "$WORKER_USER" -- env -i HOME="$VERIFY_HOME" PATH="$AGENT_PATH" \
    BATTERIES_CHECK_NAME="$check_name" BATTERIES_CHECK_ARGS="$check_args" \
    BATTERIES_CHECK_PATH="$check_path" \
    /usr/bin/sudo -n -u "$AGENT_USER" -E -- /bin/sh -c 'exec bash -lc "$1"' sh "$command_string" </dev/null
}

# One as_agent spawn per CLI and one per pack.
# shellcheck disable=SC2016 # constant command strings: values expand in the agent shell from env
verify_as_agent() {
  local i id repo sha name args found status target root_count
  VERIFY_HOME="$(mktemp -d /tmp/automata-batteries-verify.XXXXXX)"
  chown "$AGENT_USER" "$VERIFY_HOME"
  chmod 700 "$VERIFY_HOME"

  while IFS=$'\t' read -r -u 3 name _ _ _ _ _ args; do
    [ -n "$name" ] || continue
    # Resolve on the agent's PATH and print it (the LAST stdout line: a noisy
    # login profile prints before it), and run the version flag only when it
    # resolves to the installed binary. versionArgs is shape-checked to a
    # single word, so it is left unquoted.
    status=0
    found="$(as_agent 'p="$(command -v -- "$BATTERIES_CHECK_NAME")"; printf "%s\n" "$p"; [ "$p" = "$BATTERIES_CHECK_PATH" ] || exit 3; "$BATTERIES_CHECK_NAME" $BATTERIES_CHECK_ARGS >/dev/null 2>&1' \
      "$name" "$args" "$BIN_DIR/$name" 2>/dev/null)" || status=$?
    found="${found##*$'\n'}"
    if [ "$found" != "$BIN_DIR/$name" ]; then
      record "FAIL verify $name: agent resolves '${found:-nothing}', expected $BIN_DIR/$name"
    elif [ "$status" -ne 0 ]; then
      record "FAIL verify $name: '$name $args' failed as $AGENT_USER"
    else
      record "VERIFIED agent cli $name"
    fi
  done 3<<<"$CLI_ROWS"

  while IFS=$'\t' read -r -u 3 i id repo sha; do
    target="$ROOT/$id@$sha"
    if [ ! -d "$target" ]; then
      record "FAIL verify $id: $target is missing"
      continue
    fi
    root_count="$(find "$target" -type f | wc -l | tr -d ' ')"
    # GNU find. A find error (a dir the agent cannot traverse) fails too.
    status=0
    as_agent 'u="$(find "$BATTERIES_CHECK_PATH" -type f ! -readable -print)" || exit 3; [ -z "$u" ] || exit 4; w="$(find "$BATTERIES_CHECK_PATH" -writable -print)" || exit 3; [ -z "$w" ] || exit 5' \
      "" "" "$target" >/dev/null 2>&1 || status=$?
    case "$status" in
      0) record "VERIFIED agent pack $id ($root_count files readable, none writable)" ;;
      3) record "FAIL verify $id: $AGENT_USER cannot traverse $target" ;;
      4) record "FAIL verify $id: $AGENT_USER cannot read every file of $root_count under $target" ;;
      5) record "FAIL verify $id: part of $target is writable by $AGENT_USER" ;;
      *) record "FAIL verify $id: the check could not run as $AGENT_USER (status $status)" ;;
    esac
  done 3<<<"$PACK_ROWS"

  verify_tools_as_agent
}

# Per tool, through as_agent; manifest values reach the agent shell only via
# BATTERIES_CHECK_* env. dart-aot: the wrapper resolves on the agent PATH, the
# LAST stdout line of <wrapper> <versionArgs> is versionLine, the smoke command
# creates smokeExpect in a fresh dir under the agent HOME, and the agent can
# write neither the tool dir, the wrapper nor the build cache. dart-sdk: the
# agent cannot list the build-only SDK dir.
# shellcheck disable=SC2016 # constant command strings: values expand in the agent shell from env
verify_tools_as_agent() {
  local row i name kind version sha wrapper args version_line smoke_args smoke_expect target out last status
  while IFS= read -r -u 3 row; do
    [ -n "$row" ] || continue
    i="$(jq -r '.key' <<<"$row")"
    name="$(tool_field "$i" name)"
    kind="$(tool_field "$i" kind)"
    version="$(tool_field "$i" version)"
    if [ "$kind" = "dart-sdk" ]; then
      status=0
      as_agent 'ls "$BATTERIES_CHECK_PATH" >/dev/null 2>&1 && exit 4; exit 0' \
        "" "" "$ROOT/$name@$version" >/dev/null 2>&1 || status=$?
      case "$status" in
        0) record "VERIFIED agent tool $name (build-only, not traversable)" ;;
        4) record "FAIL verify $name: $AGENT_USER can list the build-only $ROOT/$name@$version" ;;
        *) record "FAIL verify $name: the check could not run as $AGENT_USER (status $status)" ;;
      esac
      continue
    fi
    if [ "$kind" = "static-bin" ]; then
      # The agent uid runs it by absolute path (never on PATH), may not modify
      # it, and its --version must print the pinned version as the last line.
      target="$ROOT/$name@$version"
      status=0
      out="$(as_agent 'w="$(find "$BATTERIES_CHECK_PATH" -writable -print)" || exit 3; [ -z "$w" ] || exit 5; "$BATTERIES_CHECK_PATH/bin/$BATTERIES_CHECK_NAME" --version' \
        "$name" "" "$target" 2>/dev/null)" || status=$?
      last="${out##*$'\n'}"
      case "$status" in
        0) ;;
        3)
          record "FAIL verify $name: $AGENT_USER cannot traverse $target"
          continue
          ;;
        5)
          record "FAIL verify $name: part of $target is writable by $AGENT_USER"
          continue
          ;;
        *)
          record "FAIL verify $name: '$target/bin/$name --version' failed as $AGENT_USER (status $status)"
          continue
          ;;
      esac
      if [ "$last" = "$version" ]; then
        record "VERIFIED agent tool $name ($version; runs by absolute path, not writable)"
      else
        record "FAIL verify $name: printed '$last' as $AGENT_USER, expected '$version'"
      fi
      continue
    fi
    sha="$(tool_field "$i" sha)"
    wrapper="$(tool_field "$i" wrapper)"
    args="$(tool_field "$i" versionArgs)"
    version_line="$(tool_field "$i" versionLine)"
    smoke_args="$(jq -r --argjson i "$i" '.tools[$i].smokeArgs | join(" ")' "$MANIFEST")"
    smoke_expect="$(tool_field "$i" smokeExpect)"
    target="$ROOT/$name@$sha"

    # Shape-checked single words (versionArgs, smokeArgs) are left unquoted.
    status=0
    out="$(as_agent 'p="$(command -v -- "$BATTERIES_CHECK_NAME")"; [ "$p" = "$BATTERIES_CHECK_PATH" ] || { printf "resolves %s\n" "${p:-nothing}"; exit 3; }; "$BATTERIES_CHECK_NAME" $BATTERIES_CHECK_ARGS' \
      "$wrapper" "$args" "$BIN_DIR/$wrapper" 2>/dev/null)" || status=$?
    last="${out##*$'\n'}"
    if [ "$status" -eq 3 ]; then
      record "FAIL verify $name: agent $last, expected $BIN_DIR/$wrapper"
      continue
    fi
    if [ "$status" -ne 0 ] || [ "$last" != "$version_line" ]; then
      record "FAIL verify $name: '$wrapper $args' as $AGENT_USER printed '$last' (status $status), expected '$version_line'"
      continue
    fi

    status=0
    as_agent 'd="$(mktemp -d "$HOME/tool-smoke.XXXXXX")" || exit 3; cd "$d" || exit 3; "$BATTERIES_CHECK_NAME" $BATTERIES_CHECK_ARGS >/dev/null 2>&1 || exit 4; [ -f "$d/$BATTERIES_CHECK_PATH" ] || exit 5' \
      "$wrapper" "$smoke_args" "$smoke_expect" >/dev/null 2>&1 || status=$?
    case "$status" in
      0) ;;
      4)
        record "FAIL verify $name: the smoke command failed as $AGENT_USER"
        continue
        ;;
      5)
        record "FAIL verify $name: the smoke command did not create $smoke_expect"
        continue
        ;;
      *)
        record "FAIL verify $name: the smoke check could not run as $AGENT_USER (status $status)"
        continue
        ;;
    esac

    # NAME = the wrapper, PATH = the tool dir, ARGS = the build cache.
    status=0
    as_agent 'w="$(find "$BATTERIES_CHECK_PATH" "$BATTERIES_CHECK_NAME" -writable -print)" || exit 3; [ -z "$w" ] || exit 5; [ ! -w "$BATTERIES_CHECK_ARGS" ] || exit 6' \
      "$BIN_DIR/$wrapper" "$ROOT/pub-cache" "$target" >/dev/null 2>&1 || status=$?
    case "$status" in
      0) record "VERIFIED agent tool $name ($version_line; smoke ok)" ;;
      3) record "FAIL verify $name: $AGENT_USER cannot traverse $target" ;;
      5) record "FAIL verify $name: part of $target or its wrapper is writable by $AGENT_USER" ;;
      6) record "FAIL verify $name: the build cache is writable by $AGENT_USER" ;;
      *) record "FAIL verify $name: the check could not run as $AGENT_USER (status $status)" ;;
    esac
  done 3<<<"$TOOL_ROWS"
}

invalidate_manifest_hash() {
  if [ -f "$ROOT/manifest.sha256" ]; then
    mv -f "$ROOT/manifest.sha256" "$ROOT/manifest.sha256.invalid"
  fi
}

# sha256 of the manifest bytes used, then each overlay blob at HEAD in order.
write_manifest_hash() {
  local hash from tmp="$ROOT/.manifest.sha256.tmp"
  hash="$({
    cat "$MANIFEST"
    while IFS= read -r from; do
      git_repo cat-file blob "$HEAD_SHA:$from"
    done < <(jq -r '.packs[] | (.overlays // [])[] | .from' "$MANIFEST")
  } | sha256sum | awk '{print $1}')"
  printf '%s\n' "$hash" >"$tmp"
  chmod 0644 "$tmp"
  # The same hash as the run before: restore that file (inode and mtime
  # unchanged), so an unchanged install leaves no trace on it.
  if cmp -s "$tmp" "$ROOT/manifest.sha256.invalid"; then
    rm -f "$tmp"
    mv -f "$ROOT/manifest.sha256.invalid" "$ROOT/manifest.sha256"
    return 0
  fi
  mv -f "$tmp" "$ROOT/manifest.sha256"
  rm -f "$ROOT/manifest.sha256.invalid"
}

# ── harness stages ───────────────────────────────────────────────────────────
# Everything from here to "end harness stages" serves harness.json only. None
# of it reads or writes manifest.sha256 (a deploy-assets test greps this
# block): its failures are `FAIL harness ...` lines and its stamp is
# harness.sha256.

# One field of harness packs[<index>] as raw text ("" when absent).
hfield() {
  jq -r --argjson i "$1" ".packs[\$i]$2 // \"\" | if type == \"string\" then . else tojson end" "$HARNESS"
}

# Every rule a harness.json value must satisfy before it reaches a root shell,
# the build account or a path, as one error line per violation (jq). Same
# rules as packages/worker/src/agent-run/harness-manifest.ts plus the keys
# only the installer reads.
harness_shape_errors() {
  jq -r --arg lockprefix "$HARNESS_LOCK_DIR_PREFIX" \
    --argjson forbidden "$(printf '%s\n' "${FORBIDDEN_MCP_TOOL_PREFIXES[@]}" | jq -R . | jq -s .)" '
    def str: type == "string" and test("\\S");
    def safe_rel: type == "string" and test("^[A-Za-z0-9_.@+-]+(/[A-Za-z0-9_.@+-]+)*$")
      and (split("/") | all(. != "." and . != ".."));
    def word: type == "string" and test("^-{0,2}[A-Za-z0-9][A-Za-z0-9._:=+-]*$");
    def plain: type == "string" and test("^[A-Za-z0-9._:-]*$") and (contains("..") | not);
    def packdir_rel: type == "string" and startswith("{{packDir}}/") and (.[12:] | safe_rel);
    def env_ok($re): type == "object" and (to_entries | all(.key | test($re)))
      and (to_entries | all(.value | type == "string"
        and (plain or . == "{{packDir}}" or (packdir_rel and (.[12:] | split("/") | all(plain))))));
    def argv_ok: type == "array" and length > 0
      and (.[0] == "node" or (.[0] | safe_rel))
      and (.[1:] | all(word or packdir_rel));
    def sha1: type == "string" and test("^[0-9a-f]{40}$");
    def sha256: type == "string" and test("^[0-9a-f]{64}$");
    def semver: type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    def id: type == "string" and test("^[a-z0-9][a-z0-9-]*$");
    def errs($p; $checks): $checks | to_entries[] | select(.value | not) | "\($p): \(.key)";
    if .schemaVersion != 1 or (.packs | type != "array" or length == 0) then "manifest: schemaVersion 1 and a non-empty packs list"
    elif (.packs | map(.id) | length != (unique | length)) then "manifest: duplicate pack id"
    else
      .packs | to_entries[] | .key as $k | .value as $p | ($p.id | if id then . else "packs[\($k)]" end) as $label |
      errs($label; {
        "bad id": ($p.id | id),
        "class must be harness": ($p.class == "harness"),
        "kind must be git-setup, npm-lock or plugin-tarball": ($p.kind == "git-setup" or $p.kind == "npm-lock" or $p.kind == "plugin-tarball"),
        "license is empty": ($p.license | str),
        "nodeMajor must be an integer": ($p.nodeMajor | type == "number" and . == floor and . >= 20),
        "env keys must be battery prefixes with plain values": ($p.env | env_ok("^((GSTACK|PLAYWRIGHT|MCP|CLAUDE_FLOW)_[A-Z0-9_]+|CLAUDE_PLUGIN_ROOT|YTCTL)$")),
        "discard entries must be safe relative paths (a segment may be *)": (($p.discard // []) | type == "array" and all((split("/") | map(if . == "*" then "x" else . end) | join("/") | safe_rel) and (split("/") | any(. != "*")))),
        "smoke entries must be argv lists": (($p.smoke // []) | type == "array" and all(argv_ok)),
        "pathDirs must be distinct {{packDir}}/<dir> paths (at most 4, no colon)": ($p.pathDirs == null or ($p.pathDirs | type == "array" and length > 0 and length <= 4
          and all(packdir_rel and (.[12:] | split("/") | all(plain)) and (contains(":") | not)) and length == (unique | length))),
        "headlessSafe must be names": ($p.headlessSafe | type == "array" and all(id)),
        "frontmatterHookSkills must be names": ($p.frontmatterHookSkills | type == "array" and all(id))
      }),
      (if $p.kind == "git-setup" then errs($label; {
        "repo must be a github https url": ($p.repo | type == "string" and test("^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")),
        "sha is not 40 hex": ($p.sha | sha1),
        "checkoutDir must be a safe relative path": ($p.checkoutDir | safe_rel),
        "setupArgs must be words": ($p.setupArgs | type == "array" and all(word)),
        "setupEnv keys must be battery prefixes with plain values": ($p.setupEnv | env_ok("^(GSTACK|PLAYWRIGHT)_[A-Z0-9_]+$")),
        "preSetup entries must be argv lists of words": ($p.preSetup | type == "array" and all(type == "array" and length > 0 and (.[0] | safe_rel) and (.[1:] | all(word)))),
        "dependencies must be pinned github linux release downloads": ($p.dependencies | type == "array" and all(
          (.name | id) and (.version | semver) and (.sha256 | sha256) and (.license | str)
          and (.url | type == "string" and test("^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]*v[0-9]+\\.[0-9]+\\.[0-9]+/[A-Za-z0-9_.-]*linux[A-Za-z0-9_.-]*\\.zip$")))),
        "dependency installTo must be <a pathDirs dir>/<its name>": ($p.dependencies | type == "array" and all(. as $d | $d.installTo == null or (
          ($d.installTo | safe_rel) and ($d.installTo | contains("/"))
          and ($d.installTo | split("/") | last) == $d.name
          and (($p.pathDirs // []) | index("{{packDir}}/" + ($d.installTo | split("/") | .[:-1] | join("/"))) != null)))),
        "browseSmoke must name a pack-relative cli, with browsers and a runtime dependency": ($p.browseSmoke == null or (
          ($p.browseSmoke | type == "object" and keys == ["cli"]) and ($p.browseSmoke.cli | safe_rel)
          and ($p.browsers | length > 0) and ($p.dependencies | any(.installTo != null)))),
        "browsers must be pinned Chrome-for-Testing linux64 zips": ($p.browsers | type == "array" and all(
          (.name | id) and (.revision | type == "string" and test("^[0-9]+$")) and (.sha256 | sha256)
          and (.version | type == "string" and test("^[0-9]+(\\.[0-9]+){3}$"))
          and (.dir | type == "string" and test("^[a-z_]+-[0-9]+$") and endswith("-" + $p.browsers[0].revision))
          and (.executable | safe_rel)
          and (. as $b | .url | type == "string" and startswith("https://cdn.playwright.dev/builds/cft/" + $b.version + "/linux64/") and test("/[a-z0-9-]+-linux64\\.zip$")))),
        "browsers need env.PLAYWRIGHT_BROWSERS_PATH = {{packDir}}/<dir>": (($p.browsers | length) == 0 or ($p.env.PLAYWRIGHT_BROWSERS_PATH | packdir_rel))
      }) elif $p.kind == "npm-lock" then errs($label; {
        "package must be an npm name": ($p.package | type == "string" and test("^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")),
        "version must be exact semver": ($p.version | semver),
        "overrides must pin exact versions": (($p.overrides // {}) | type == "object" and (to_entries | all(.value | semver))),
        "lockOverlay must be \($lockprefix)<id>/package-lock.json": ($p.lockOverlay == ($lockprefix + $p.id + "/package-lock.json")),
        "lockSha256 is not 64 hex": ($p.lockSha256 | sha256),
        "packageJsonSha256 is not 64 hex": ($p.packageJsonSha256 | sha256),
        "lifecycleScripts must be npm names": (($p.lifecycleScripts // []) | type == "array" and all(type == "string" and test("^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$"))),
        "prebuilds must be pinned github linux-x64 node prebuild downloads": (($p.prebuilds // []) | type == "array" and all(
          (.path | safe_rel and startswith("node_modules/")) and (.member | safe_rel) and (.sha256 | sha256)
          and (.url | type == "string" and test("^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]*-node-v[0-9]+-linux-x64\\.tar\\.gz$")))),
        "prefetch must be sha256-pinned huggingface files at a fixed revision, placed under node_modules/": ((($p.prefetch // []) | type == "array" and all(
          (.path | safe_rel and startswith("node_modules/")) and (.sha256 | sha256)
          and (.url | type == "string" and test("^https://huggingface\\.co/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/resolve/[0-9a-f]{40}/[A-Za-z0-9_./-]+$"))))
          and (($p.prefetch // []) | map(.path) | length == (unique | length))),
        "postInstall must be an argv list": (($p.postInstall // ["x"]) | type == "array" and length > 0 and (.[0] | safe_rel) and (.[1:] | all(word or . == "{{configDir}}"))),
        "warmup tools must be allowlisted, with plain string arguments": (($p.warmup // []) | type == "array" and all(
          (.tool as $t | ($p.toolAllowlist // []) | index($t) != null)
          and (.arguments | type == "object" and (to_entries | all(.value | plain))))),
        "mcpServe is required exactly with mcpServers": (($p.mcpServers == null) == ($p.mcpServe == null)),
        "mcpServe must name a safe entrypoint, word args and RUFLO_/CLAUDE_FLOW_ env": ($p.mcpServe == null or (
          ($p.mcpServe.entrypoint | safe_rel) and ($p.mcpServe.args | type == "array" and all(word))
          and ($p.mcpServe.env | env_ok("^(CLAUDE_FLOW|RUFLO)_[A-Z0-9_]+$")))),
        "mcpServers must be one {{packDir}} wrapper with no args": ($p.mcpServers == null or (
          ($p.mcpServers | type == "object" and length == 1)
          and ($p.mcpServers | to_entries | all((.key | id) and (.value.command | packdir_rel) and .value.args == [])))),
        "toolAllowlist must name tools, never a spawn/network/terminal/github/browser/federation tool": ($p.mcpServers == null or (
          $p.toolAllowlist | type == "array" and length > 0
          and all(type == "string" and test("^[a-z][a-z0-9_-]*$"))
          and all(. as $t | $forbidden | all(. as $f | $t | startswith($f) | not)))),
        "agentFiles must be sha256-pinned .md files under node_modules/ with distinct names": (($p.agentFiles // []) | type == "array"
          and all((.from | safe_rel and startswith("node_modules/") and endswith(".md")) and (.sha256 | sha256) and (.name | id))
          and (map(.name) | length == (unique | length)))
      }) elif $p.kind == "plugin-tarball" then errs($label; {
        "repo must be a github https url": ($p.repo | type == "string" and test("^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")),
        "sha is not 40 hex": ($p.sha | sha1),
        "paths must be 1-8 distinct, non-overlapping safe paths with 40-hex trees": ($p.paths | type == "array" and length > 0 and length <= 8
          and all((.path | safe_rel) and (.tree | sha1))
          and (map(.path) as $ps | [$ps[] as $a | $ps[] as $b | select($a != $b and ($a | startswith($b + "/")))] | length == 0)
          and (map(.path) | length == (unique | length))),
        "pluginRoot must be one of paths or under one": (($p.pluginRoot | safe_rel) and ($p.pluginRoot as $r | $p.paths | any(.path as $q | $r == $q or ($r | startswith($q + "/"))))),
        "a plugin-tarball pack runs no MCP server": ($p.mcpServers == null and $p.toolAllowlist == null),
        "wrappers must be bin/<name> shims of src/ files aliasing YOUTRACK_/JIRA_ names": (($p.wrappers // []) | type == "array" and length <= 4
          and all((.path | type == "string" and test("^bin/[a-z0-9][a-z0-9_-]*$")) and (.exec | safe_rel and startswith("src/"))
            and (.aliasEnv | type == "object" and (to_entries | all((.key | test("^(YOUTRACK|JIRA)_[A-Z0-9_]+$"))
              and (.value | type == "string" and test("^(YOUTRACK|JIRA)_[A-Z0-9_]+$")) and .key != .value))))
          and (map(.path) | length == (unique | length))),
        "wrappers need {{packDir}}/bin in pathDirs": ((($p.wrappers // []) | length) == 0 or (($p.pathDirs // []) | index("{{packDir}}/bin") != null))
      }) else empty end)
    end' "$HARNESS" 2>/dev/null || echo "manifest: not valid JSON"
}

# harness_preflight: shapes, then each committed lockfile and package.json
# against its pinned sha256 (HEAD blobs). FAILs are harness failures only.
harness_preflight() {
  local before="$HARNESS_FAILURES" line i id kind lockfile pkgjson lock_sha pkg_sha
  if ! jq -e '[.. | strings | test("[\u0000-\u001f\u007f\\\\]")] | any | not' "$HARNESS" >/dev/null 2>&1; then
    record "FAIL harness preflight manifest: a string contains a control character or backslash"
    return 1
  fi
  while IFS= read -r line; do
    [ -n "$line" ] && record "FAIL harness preflight $line"
  done < <(harness_shape_errors)
  [ "$HARNESS_FAILURES" -eq "$before" ] || return 1
  while IFS=$'\t' read -r -u 3 i id kind; do
    [ "$kind" = "npm-lock" ] || continue
    lockfile="$(hfield "$i" .lockOverlay)"
    pkgjson="$(dirname "$lockfile")/package.json"
    lock_sha="$( { git_repo cat-file blob "$HEAD_SHA:$lockfile" 2>/dev/null || true; } | sha256sum | awk '{print $1}')"
    pkg_sha="$( { git_repo cat-file blob "$HEAD_SHA:$pkgjson" 2>/dev/null || true; } | sha256sum | awk '{print $1}')"
    [ "$lock_sha" = "$(hfield "$i" .lockSha256)" ] ||
      record "FAIL harness preflight $id: lockSha256 does not match $lockfile at HEAD"
    [ "$pkg_sha" = "$(hfield "$i" .packageJsonSha256)" ] ||
      record "FAIL harness preflight $id: packageJsonSha256 does not match $pkgjson at HEAD"
  done 3< <(harness_rows)
  [ "$HARNESS_FAILURES" -eq "$before" ] || return 1
  record "PREFLIGHT harness ok ($(jq -r '[.packs[] | "\(.id) \(.kind)"] | join(", ")' "$HARNESS"))"
}

# One `index<TAB>id<TAB>kind` row per harness pack (after preflight).
harness_rows() {
  jq -r '.packs | to_entries[] | [(.key | tostring), .value.id, .value.kind] | @tsv' "$HARNESS"
}

# The published dir name of harness pack <index>: <id>@<version> (npm-lock)
# or <id>@<sha> — harnessPackDirName in harness-layout.ts.
harness_dir_name() {
  local i="$1"
  if [ "$(hfield "$i" .kind)" = "npm-lock" ]; then
    printf '%s@%s\n' "$(hfield "$i" .id)" "$(hfield "$i" .version)"
  else
    printf '%s@%s\n' "$(hfield "$i" .id)" "$(hfield "$i" .sha)"
  fi
}

host_node_abi() {
  "$NODE_BIN" -p 'process.versions.modules' 2>/dev/null
}

# The stamp hash covers the manifest's pack entry, the blob ids at HEAD of the
# lockfile, package.json and the MCP filter, HARNESS_OUTPUT_VERSION and this
# host's Node ABI (a new Node major must rebuild the native prebuilds).
harness_stamp_hash() {
  local i="$1" lockfile
  {
    # Run-time-only keys (which skills an automation may call, the agent's
    # smoke checks) do not change the built bytes, so they do not rebuild.
    jq -c --argjson i "$i" '.packs[$i] | del(.headlessSafe, .smoke, .browseSmoke)' "$HARNESS"
    lockfile="$(hfield "$i" .lockOverlay)"
    if [ -n "$lockfile" ]; then
      git_repo rev-parse --verify --quiet "$HEAD_SHA:$lockfile" || printf 'absent %s\n' "$lockfile"
      git_repo rev-parse --verify --quiet "$HEAD_SHA:$(dirname "$lockfile")/package.json" || printf 'absent package.json\n'
    fi
    git_repo rev-parse --verify --quiet "$HEAD_SHA:$HARNESS_FILTER_REPO_PATH" || printf 'absent filter\n'
    printf 'harness-output %s\nnode-abi %s\n' "$HARNESS_OUTPUT_VERSION" "$(host_node_abi)"
  } | sha256sum | awk '{print $1}'
}

# harness_at_pin <target> <expected>: the stamp matches and every file it
# records (native modules, models, browser executables, wrapper) still has
# its recorded sha256.
harness_at_pin() {
  local target="$1" expected="$2" sha rel
  [ -f "$target/.stamp" ] || return 1
  [ "$(head -n 1 "$target/.stamp")" = "stamp $expected" ] || return 1
  while read -r sha rel; do
    [ -f "$target/$rel" ] && [ ! -L "$target/$rel" ] || return 1
    [ "$(sha256_of "$target/$rel")" = "$sha" ] || return 1
  done < <(sed -n 's/^file //p' "$target/.stamp")
}

# When set (git-setup stages), every as_build call runs in a private mount
# namespace where the staged pack is bind-mounted at its FINAL published path.
# Upstream setups bake their own absolute location into what they build (gstack's
# bun bundles hard-code __dirname), so the build must see the path the pack will
# have; on the real filesystem the pack still lives under its private staging
# name until the rename publishes it.
BUILD_VIEW_SRC=""
BUILD_VIEW_DST=""
# When set, as_build runs in a network namespace with no route out: a step that
# must not download (the warmup) fails instead of fetching unpinned bytes.
BUILD_OFFLINE=""
# The transient systemd scopes as_build started (kill_build_processes ends them).
BUILD_SCOPES=""

# as_build <home> <cwd> <PATH> [NAME=value...] -- <argv...>: argv as the build
# account under env -i, with a fixed npm cache, registry and no user config, in
# a new session (no controlling terminal to inject keystrokes into) with stdin
# closed. On a systemd box each call is its own transient scope, so whatever it
# leaves running is killed with the scope. <cwd> is entered inside the build
# view when one is set.
#
# THE ROOT-SIDE RULE: once any build command has run, root never opens, writes,
# chmods or chowns a path under the build tree (it is the build account's to
# replace with a link). Root-produced inputs go to <stage>/in (root, 0755,
# read-only to the build), root-consumed outputs come back on stdout or into
# <stage>/out (root, 0700), and the build places inputs itself (place_input).
# Only after kill_build_processes and harden_build_tree does root assemble.
# shellcheck disable=SC2016 # the sh -c script expands its own positional args
as_build() {
  local home="$1" cwd="$2" path="$3" unit
  local -a extra=() view=(/bin/sh -c 'cd "$0" && exec "$@"' "$cwd") wrap=()
  shift 3
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    extra+=("$1")
    shift
  done
  shift
  if [ -n "$BUILD_VIEW_DST" ]; then
    view=(unshare --mount --propagation private -- /bin/sh -c \
      'mount --bind "$0" "$1" && cd "$2" && shift 2 && exec "$@"' \
      "$BUILD_VIEW_SRC" "$BUILD_VIEW_DST" "$cwd")
  fi
  if [ -d /run/systemd/system ]; then
    unit="automata-harness-build-$$-$RANDOM"
    BUILD_SCOPES="$BUILD_SCOPES $unit"
    wrap=(systemd-run --scope --quiet --collect --unit "$unit" -p TasksMax=4096 --)
  fi
  [ -z "$BUILD_OFFLINE" ] || wrap+=(unshare --net --)
  (
    cd / &&
      ${wrap[@]+"${wrap[@]}"} "${view[@]}" setsid -w runuser -u "$BUILD_USER" -- env -i HOME="$home" PATH="$path" LANG=C.UTF-8 \
        TMPDIR="$home/../tmp" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        GIT_TERMINAL_PROMPT=0 npm_config_cache="$home/../npm-cache" \
        npm_config_registry="$NPM_REGISTRY" npm_config_userconfig="$home/../npmrc" \
        npm_config_globalconfig="$home/../npmrc-global" npm_config_update_notifier=false \
        npm_config_fund=false npm_config_audit=false ${extra[@]+"${extra[@]}"} \
        timeout 1800 "$@" </dev/null
  )
}

# kill_build_processes: nothing the build started may outlive its stage: every
# transient scope is SIGKILLed, then every process of the build uid (on a box
# without systemd that uid sweep is the whole fence). A zombie is already dead
# (it waits for its parent, or PID 1, to reap it), so only live states count.
kill_build_processes() {
  local n unit
  for unit in $BUILD_SCOPES; do
    systemctl kill --signal=KILL "$unit.scope" >/dev/null 2>&1 || true
  done
  BUILD_SCOPES=""
  for n in 1 2 3 4 5 6 7 8 9 10; do
    pkill -KILL -u "$BUILD_USER" >/dev/null 2>&1 || true
    # shellcheck disable=SC2009 # pgrep has no portable "not a zombie" filter
    ps -u "$BUILD_USER" -o stat= 2>/dev/null | grep -qv '^Z' || return 0
    sleep 1
  done
  STEP_ERROR="build account processes survived SIGKILL"
  return 1
}

# write_input <in dir> <name>: stdin into the root-owned input dir, through a
# temp file and a rename inside that dir (never a path the build can name).
write_input() {
  local in="$1" name="$2"
  cat >"$in/.$name.tmp" && chmod 0644 "$in/.$name.tmp" && mv -f "$in/.$name.tmp" "$in/$name"
}

# place_input <build home> <input file> <dest> <mode>: the BUILD account copies
# a root-produced input into its own tree; a link it planted at <dest> can only
# redirect its own write.
place_input() {
  as_build "$1" / "$BUILD_PATH" -- install -D -m "$4" "$2" "$3"
}

# harden_build_tree <stage>: after the build account's last process is dead it
# owns nothing under the stage, and no directory root walks below has been
# swapped for a link.
harden_build_tree() {
  local stage="$1" dir
  if ! chown -hR root:root "$stage/build" "$stage/pack"; then
    STEP_ERROR="cannot take the build tree back"
    return 1
  fi
  for dir in "$stage/build" "$stage/build/home" "$stage/build/npm" "$stage/build/work" "$stage/pack" "$stage/pack/claude"; do
    if [ -L "$dir" ]; then
      STEP_ERROR="the build replaced ${dir#"$stage"/} with a link"
      return 1
    fi
  done
}

# check_npm_tree <index> <stage>: the installed tree is exactly our committed
# lock. Every package npm recorded in node_modules/.package-lock.json (read as
# the build account) must be in the lock with the same version, resolved and
# integrity; entries the lock names but this platform skips are fine (ruflo's
# lock names optional platform packages that were never published).
check_npm_tree() {
  local i="$1" stage="$2" b="$2/build" installed="$WORK/harness-installed-lock.json" drift
  if ! as_build "$b/home" "$b/npm" "$BUILD_PATH" -- cat node_modules/.package-lock.json \
    >"$installed" 2>>"$WORK/harness-build.log"; then
    STEP_ERROR="npm left no node_modules/.package-lock.json"
    return 1
  fi
  if ! drift="$(git_repo cat-file blob "$HEAD_SHA:$(hfield "$i" .lockOverlay)" | jq -r --slurpfile got "$installed" '
    .packages as $want
    | [$got[0].packages | to_entries[] | select(.key != "")
      | select(($want[.key] // null) as $w
        | $w == null or $w.version != .value.version
          or $w.resolved != .value.resolved or $w.integrity != .value.integrity)
      | .key]
    | .[0:5] | join(", ")')"; then
    STEP_ERROR="cannot compare the installed tree with the lock"
    return 1
  fi
  if [ -n "$drift" ]; then
    STEP_ERROR="installed packages differ from the committed lock: $drift"
    return 1
  fi
}

# build_sha256 <stage> <path>: sha256 of a build-tree file, read by the build.
build_sha256() {
  as_build "$1/build/home" / "$BUILD_PATH" -- sha256sum "$2" 2>/dev/null | awk '{print $1}'
}

# deny_build_scheduling: the build account may never schedule a job that runs
# after its stage is gone (cron, at).
deny_build_scheduling() {
  local file
  for file in /etc/cron.deny /etc/at.deny; do
    grep -qxF -- "$BUILD_USER" "$file" 2>/dev/null || printf '%s\n' "$BUILD_USER" >>"$file" || return 1
  done
}

# The build account: created once with BUILD_UID, nologin, no supplementary
# group, no home on disk (every build passes an explicit private HOME), and
# listed in cron.deny and at.deny.
ensure_build_account() {
  local uid gid groups shell
  if ! deny_build_scheduling; then
    record "FAIL harness build account: cannot list $BUILD_USER in /etc/cron.deny and /etc/at.deny"
    return 1
  fi
  if id -u "$BUILD_USER" >/dev/null 2>&1; then
    uid="$(id -u "$BUILD_USER")"
    gid="$(id -g "$BUILD_USER")"
    groups="$(id -G "$BUILD_USER")"
    shell="$(getent passwd "$BUILD_USER" | cut -d: -f7)"
    if [ "$uid" != "$BUILD_UID" ] || [ "$groups" != "$gid" ] || [ "$shell" != "/usr/sbin/nologin" ]; then
      record "FAIL harness build account $BUILD_USER: uid $uid groups '$groups' shell $shell (want uid $BUILD_UID, its own group only, /usr/sbin/nologin)"
      return 1
    fi
    record "SKIPPED harness build account $BUILD_USER (uid $BUILD_UID)"
    return 0
  fi
  if getent passwd "$BUILD_UID" >/dev/null || getent group "$BUILD_UID" >/dev/null; then
    record "FAIL harness build account: uid/gid $BUILD_UID is taken by another account"
    return 1
  fi
  if ! { groupadd --system --gid "$BUILD_UID" "$BUILD_USER" &&
    useradd --system --uid "$BUILD_UID" --gid "$BUILD_UID" --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin "$BUILD_USER"; }; then
    record "FAIL harness build account: could not create $BUILD_USER"
    return 1
  fi
  record "INSTALLED harness build account $BUILD_USER (uid $BUILD_UID)"
}

wait_for_apt() {
  local i
  for i in $(seq 1 120); do
    if ! fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock \
      /var/cache/apt/archives/lock >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# The Chromium runtime libraries, when any pack ships a browser.
install_browser_runtime() {
  local pkg missing=()
  jq -e 'any(.packs[]; (.browsers // []) | length > 0)' "$HARNESS" >/dev/null || return 0
  for pkg in "${CHROMIUM_RUNTIME_PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    record "SKIPPED harness browser runtime (${#CHROMIUM_RUNTIME_PACKAGES[@]} apt packages present)"
    return 0
  fi
  log "installing browser runtime packages: ${missing[*]}"
  if ! { wait_for_apt && DEBIAN_FRONTEND=noninteractive apt-get update -q >&2 &&
    wait_for_apt && DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
    --no-install-recommends "${missing[@]}" >&2; }; then
    record "FAIL harness browser runtime: apt-get install failed (${missing[*]})"
    return 1
  fi
  record "INSTALLED harness browser runtime (${#missing[@]} apt packages)"
}

# install_root_file <repo path> <dest> <mode>: a HEAD blob, root-owned,
# replaced through a temp file only when its bytes differ (ROOT_FILES_CHANGED
# counts replacements).
ROOT_FILES_CHANGED=0
install_root_file() {
  local from="$1" dest="$2" mode="$3" tmp="$2.new.$$"
  if ! { mkdir -p "$(dirname "$dest")" && git_repo cat-file blob "$HEAD_SHA:$from" >"$tmp"; }; then
    rm -f "$tmp"
    return 1
  fi
  if cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    return 0
  fi
  chmod "$mode" "$tmp" && chown root:root "$tmp" && mv -f "$tmp" "$dest" &&
    ROOT_FILES_CHANGED=$((ROOT_FILES_CHANGED + 1))
}

# extract_zip <zip> <dest> [<member basename>]: a pre-scanned extraction (no
# absolute or `..` names, no symlinks, at most 2 GiB) that keeps exec bits.
# With a basename, only the ONE regular file of that basename is written, to
# <dest> itself.
extract_zip() {
  python3 - "$@" <<'PY'
import os
import stat
import sys
import zipfile

zip_path, dest = sys.argv[1], sys.argv[2]
only = sys.argv[3] if len(sys.argv) > 3 else None
total = 0
with zipfile.ZipFile(zip_path) as archive:
    infos = archive.infolist()
    for info in infos:
        name = info.filename
        if "\x00" in name or "\\" in name or name.startswith("/"):
            sys.exit("unsafe name: " + repr(name))
        if any(part in ("", ".", "..") for part in name.rstrip("/").split("/")):
            sys.exit("unsafe path: " + repr(name))
        if stat.S_ISLNK(info.external_attr >> 16):
            sys.exit("symlink: " + repr(name))
        total += info.file_size
        if total > 2 * 1024 ** 3:
            sys.exit("total size over 2 GiB")
    if only is not None:
        hits = [i for i in infos if not i.is_dir() and os.path.basename(i.filename) == only]
        if len(hits) != 1:
            sys.exit("expected exactly one %s, found %d" % (only, len(hits)))
        with archive.open(hits[0]) as src, open(dest, "wb") as out:
            out.write(src.read())
        os.chmod(dest, 0o755)
        sys.exit(0)
    for info in infos:
        archive.extract(info, dest)
        if not info.is_dir():
            mode = info.external_attr >> 16
            os.chmod(os.path.join(dest, info.filename), 0o755 if mode & 0o111 else 0o644)
PY
}

# scan_pack <pack> <stage> <build config dir> <final path> <hook skills, one
# per line>: rewrites absolute links into the build config dir or the final
# pack path as relative links inside the pack, then checks the harness profile. Prints `DISCARD <rel>`,
# `NATIVE <sha256> <rel>` and `ERROR <text>` lines; exits non-zero on an ERROR.
scan_pack() {
  python3 - "$@" <<'PY'
import hashlib
import os
import re
import sys

pack, stage, build_claude, final, hook_skills = sys.argv[1:6]
pack = os.path.realpath(pack)
hook_skills = set(filter(None, hook_skills.split("\n")))
discard_names = set(os.environ["HARNESS_DISCARD_NAMES"].split())
needle = stage.encode()
errors = []

def rel(path):
    return os.path.relpath(path, pack)

def scan_file(path, want_hash):
    """(staging path found, sha256 or None), reading 8 MiB at a time."""
    digest = hashlib.sha256() if want_hash else None
    found = False
    tail = b""
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1 << 23)
            if not chunk:
                break
            if digest is not None:
                digest.update(chunk)
            if not found and needle in tail + chunk:
                found = True
            tail = chunk[-(len(needle) - 1):]
    return found, digest.hexdigest() if digest is not None else None

# parseFrontmatter in harness-manifest.ts, rule for rule: a leading BOM is
# dropped, CRLF/CR become LF, a fence may carry trailing blanks, a top-level
# key may be quoted, and any top-level line that is not a plain key (a flow
# mapping, a `?` key, a merge, no closing fence) makes the block opaque.
FRONTMATTER_KEY = re.compile(r"""^(["']?)([A-Za-z0-9_-]+)\1[ \t]*:""")
FRONTMATTER_FENCE = re.compile(r"^---[ \t]*$")

def parse_frontmatter(path):
    with open(path, "rb") as handle:
        text = handle.read().decode("utf-8", "replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines[0].startswith("---"):
        return [], False
    if not FRONTMATTER_FENCE.match(lines[0]):
        return [], True
    keys, opaque = [], False
    for line in lines[1:]:
        if FRONTMATTER_FENCE.match(line):
            return keys, opaque
        if line.strip() == "" or re.match(r"^[\s#]", line) or line.startswith("- "):
            continue
        match = FRONTMATTER_KEY.match(line)
        if match is None:
            opaque = True
        else:
            keys.append(match.group(2))
    return keys, True

def frontmatter_errors(rel_path, file_path):
    found = []
    skill = os.path.basename(os.path.dirname(rel_path)) if os.path.basename(rel_path) == "SKILL.md" else None
    keys, opaque = parse_frontmatter(file_path)
    if opaque:
        found.append("%s: frontmatter has a top-level line that is not a plain key" % rel_path)
    for key in keys:
        if key in ("mcpServers", "permissionMode"):
            found.append("%s: frontmatter declares %s" % (rel_path, key))
        elif key == "hooks" and skill not in hook_skills:
            found.append("%s: frontmatter declares hooks outside frontmatterHookSkills" % rel_path)
    return found

for root, dirs, files in os.walk(pack):
    in_node_modules = "node_modules" in rel(root).split(os.sep)
    for name in dirs + files:
        path = os.path.join(root, name)
        if os.path.islink(path):
            target = os.readlink(path)
            if os.path.isabs(target):
                if target == build_claude or target.startswith(build_claude + "/"):
                    mapped = os.path.join(pack, "claude", os.path.relpath(target, build_claude))
                elif target == final or target.startswith(final + "/"):
                    mapped = os.path.join(pack, os.path.relpath(target, final))
                else:
                    errors.append("%s: absolute link outside the build config dir" % rel(path))
                    continue
                target = os.path.relpath(mapped, root)
                os.unlink(path)
                os.symlink(target, path)
            if needle in target.encode():
                errors.append("%s: link names the staging path" % rel(path))
            try:
                resolved = os.path.realpath(path, strict=True)
            except OSError:
                errors.append("%s: dangling link" % rel(path))
                continue
            if not resolved.startswith(pack + os.sep):
                errors.append("%s: link escapes the pack" % rel(path))
            elif not in_node_modules and name.lower().endswith(".md") and os.path.isfile(resolved):
                # Claude Code loads it under the LINK's path: the link's skill
                # dir decides whether its hooks are allowed.
                errors.extend(frontmatter_errors(rel(path), resolved))
    for name in list(dirs):
        if os.path.islink(os.path.join(root, name)):
            dirs.remove(name)
    for name in files:
        path = os.path.join(root, name)
        if os.path.islink(path):
            continue
        if not in_node_modules and name in discard_names:
            os.unlink(path)
            print("DISCARD %s" % rel(path))
            continue
        if not os.path.isfile(path):
            errors.append("%s: not a regular file" % rel(path))
            continue
        native = name.endswith((".node", ".onnx"))
        found, digest = scan_file(path, native)
        if found:
            errors.append("%s: names the staging path" % rel(path))
        if native:
            print("NATIVE %s %s" % (digest, rel(path)))
        if not in_node_modules and name.lower().endswith(".md"):
            errors.extend(frontmatter_errors(rel(path), path))

for error in errors[:20]:
    print("ERROR %s" % error)
if len(errors) > 20:
    print("ERROR ... and %d more" % (len(errors) - 20))
sys.exit(1 if errors else 0)
PY
}

# collect_build_output <build home> <pack> <index>: the build HOME's claude
# config dir becomes <pack>/claude (minus the manifest's discard list); every
# other entry of the build HOME is reported and left for deletion.
collect_build_output() {
  local bh="$1" pack="$2" i="$3" entry rel hit
  if [ -L "$bh/.claude" ]; then
    # A git-setup build HOME links .claude to the pack's own claude dir.
    rm -f "$bh/.claude"
  elif [ -d "$bh/.claude" ]; then
    mv "$bh/.claude" "$pack/claude" || return 1
  fi
  if [ -d "$pack/claude" ]; then
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      # A `*` segment matches any one entry name (preflight allows no other glob).
      # shellcheck disable=SC2086 # the unquoted pattern is what expands the `*`
      for hit in "$pack/claude/"$rel; do
        [ -e "$hit" ] || [ -L "$hit" ] || continue
        # Never through a link the build planted on the way.
        if [ "$(realpath -e -- "$(dirname -- "$hit")" 2>/dev/null)" != "$(dirname -- "$hit")" ]; then
          log "harness $(hfield "$i" .id): NOT discarding ${hit#"$pack"/}: its dir is reached through a link"
          continue
        fi
        rm -rf "$hit"
        log "harness $(hfield "$i" .id): discarded ${hit#"$pack"/} (manifest discard list)"
      done
    done < <(jq -r --argjson i "$i" '.packs[$i].discard // [] | .[]' "$HARNESS")
  fi
  for entry in "$bh"/.[!.]* "$bh"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    log "harness $(hfield "$i" .id): discarded build-HOME entry ${entry#"$bh"/} ($(du -sh "$entry" 2>/dev/null | cut -f1))"
  done
}

# fetch_dependencies <index> <bin dir> <out dir>: each sha256-pinned dependency
# zip's one executable named after the dependency, extracted by root into the
# root-only <out dir> (0700) BEFORE any build code runs, then copied into the
# build's <bin dir>. The <out dir> copy is the one place_runtimes ships for an
# `installTo` dependency: never anything the build could have touched.
fetch_dependencies() {
  local i="$1" bin="$2" out="$3" n d name version url sha256 zip
  n="$(jq -r --argjson i "$i" '.packs[$i].dependencies | length' "$HARNESS")"
  for ((d = 0; d < n; d++)); do
    name="$(hfield "$i" ".dependencies[$d].name")"
    version="$(hfield "$i" ".dependencies[$d].version")"
    url="$(hfield "$i" ".dependencies[$d].url")"
    sha256="$(hfield "$i" ".dependencies[$d].sha256")"
    zip="$WORK/harness-dep-$name.zip"
    fetch_verified "$name $version" "$url" "$sha256" "$zip" || return 1
    if ! extract_zip "$zip" "$out/dep-$name" "$name" >"$WORK/zip.log" 2>&1; then
      STEP_ERROR="dependency $name: $(head -n 1 "$WORK/zip.log")"
      return 1
    fi
    rm -f "$zip"
    if ! install -m 0755 "$out/dep-$name" "$bin/$name"; then
      STEP_ERROR="dependency $name: cannot place it for the build"
      return 1
    fi
  done
  chmod -R a+rX "$bin"
}

# place_runtimes <index> <stage>: after assembly (the build is dead and the tree
# is root's), every `installTo` dependency is copied from root's own
# extraction in <stage>/out into the pack, 0755 root, never through a link;
# then every pathDirs entry must be a real dir of the pack.
place_runtimes() {
  local i="$1" stage="$2" pack="$2/pack" rel name dir
  while IFS=$'\t' read -r name rel; do
    [ -n "$name" ] || continue
    dir="$pack/$(dirname "$rel")"
    if [ -e "$pack/$rel" ] || [ -L "$pack/$rel" ]; then
      STEP_ERROR="runtime $name: $rel already exists in the pack"
      return 1
    fi
    if ! mkdir -p "$dir" || [ "$(realpath -e -- "$dir" 2>/dev/null)" != "$dir" ]; then
      STEP_ERROR="runtime $name: $(dirname "$rel") is not a plain dir of the pack"
      return 1
    fi
    if ! install -o root -g root -m 0755 "$stage/out/dep-$name" "$pack/$rel"; then
      STEP_ERROR="runtime $name: cannot install it at $rel"
      return 1
    fi
    log "harness $(hfield "$i" .id): runtime $name at $rel (sha256 $(sha256_of "$pack/$rel"))"
  done < <(jq -r --argjson i "$i" '.packs[$i].dependencies // [] | .[] | select(.installTo != null) | [.name, .installTo] | @tsv' "$HARNESS")
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    if [ ! -d "$pack/$rel" ] || [ "$(realpath -e -- "$pack/$rel" 2>/dev/null)" != "$pack/$rel" ]; then
      STEP_ERROR="pathDirs $rel is not a plain dir of the pack"
      return 1
    fi
  done < <(jq -r --argjson i "$i" '.packs[$i].pathDirs // [] | .[] | ltrimstr("{{packDir}}/")' "$HARNESS")
}

# place_browsers <index> <pack>: each sha256-pinned browser zip extracted into
# <pack>/<PLAYWRIGHT_BROWSERS_PATH>/<dir>, marked complete for Playwright, so
# the upstream setup finds it and never downloads one itself.
place_browsers() {
  local i="$1" pack="$2" n b name url sha256 dir exe pw zip
  n="$(jq -r --argjson i "$i" '.packs[$i].browsers | length' "$HARNESS")"
  [ "$n" -gt 0 ] || return 0
  pw="$(hfield "$i" .env.PLAYWRIGHT_BROWSERS_PATH)"
  pw="$pack/${pw#"{{packDir}}/"}"
  for ((b = 0; b < n; b++)); do
    name="$(hfield "$i" ".browsers[$b].name")"
    url="$(hfield "$i" ".browsers[$b].url")"
    sha256="$(hfield "$i" ".browsers[$b].sha256")"
    dir="$(hfield "$i" ".browsers[$b].dir")"
    exe="$(hfield "$i" ".browsers[$b].executable")"
    zip="$WORK/harness-browser-$b.zip"
    fetch_verified "$name" "$url" "$sha256" "$zip" || return 1
    mkdir -p "$pw/$dir"
    if ! extract_zip "$zip" "$pw/$dir" >"$WORK/zip.log" 2>&1; then
      STEP_ERROR="browser $name: $(head -n 1 "$WORK/zip.log")"
      return 1
    fi
    rm -f "$zip"
    if [ ! -f "$pw/$dir/$exe" ] || [ ! -x "$pw/$dir/$exe" ]; then
      STEP_ERROR="browser $name: $dir/$exe is not an executable in the archive"
      return 1
    fi
    : >"$pw/$dir/INSTALLATION_COMPLETE"
  done
  chmod -R a+rX "$pw"
}

# stage_git_setup <index> <stage> <target>: the pinned commit checked out at
# <pack>/claude/<checkoutDir> (seen by the build at <target>) and its own setup
# run there, as the build account. Root writes nothing once setup code ran;
# install_harness_pack assembles. Sets STEP_ERROR and returns 1 on failure.
stage_git_setup() {
  local i="$1" stage="$2" target="$3" b="$2/build" pack="$2/pack" repo sha checkout_dir co path n p status pw line
  local -a argv setup_env
  repo="$(hfield "$i" .repo)"
  sha="$(hfield "$i" .sha)"
  checkout_dir="$(hfield "$i" .checkoutDir)"
  # The checkout lives in the pack, seen by the build at the final path.
  co="$target/claude/$checkout_dir"

  mkdir -p "$b/deps"
  fetch_dependencies "$i" "$b/deps" "$stage/out" || return 1
  place_browsers "$i" "$pack" || return 1
  path="$b/deps:$BUILD_PATH"
  setup_env=()
  while IFS= read -r line; do
    [ -n "$line" ] && setup_env+=("$line")
  done < <(jq -r --argjson i "$i" '.packs[$i].setupEnv | to_entries[] | "\(.key)=\(.value)"' "$HARNESS")
  if [ "$(jq -r --argjson i "$i" '.packs[$i].browsers | length' "$HARNESS")" -gt 0 ]; then
    pw="$(hfield "$i" .env.PLAYWRIGHT_BROWSERS_PATH)"
    setup_env+=("PLAYWRIGHT_BROWSERS_PATH=$target/${pw#"{{packDir}}/"}")
  fi

  log "harness: fetching $repo @ $sha as $BUILD_USER (pack seen at $target)"
  if ! { mkdir -p "$pack/claude/$(dirname "$checkout_dir")" &&
    chown -R "$BUILD_USER:" "$b" "$pack/claude" &&
    ln -s "$target/claude" "$b/home/.claude"; }; then
    STEP_ERROR="cannot prepare the build view"
    return 1
  fi
  BUILD_VIEW_SRC="$pack"
  BUILD_VIEW_DST="$target"
  if ! as_build "$b/home" "$target" "$path" -- git -c core.hooksPath=/dev/null -c core.fsmonitor=false init -q "$co" ||
    ! as_build "$b/home" "$co" "$path" -- git -c core.hooksPath=/dev/null -c protocol.version=2 \
      fetch -q --depth 1 "$repo" "$sha" ||
    ! as_build "$b/home" "$co" "$path" -- git -c core.hooksPath=/dev/null checkout -q --detach FETCH_HEAD; then
    STEP_ERROR="fetch of $sha from $repo failed"
    return 1
  fi
  if [ "$(as_build "$b/home" "$co" "$path" -- git rev-parse HEAD)" != "$sha" ]; then
    STEP_ERROR="checked-out commit is not the pinned sha"
    return 1
  fi

  n="$(jq -r --argjson i "$i" '.packs[$i].preSetup | length' "$HARNESS")"
  for ((p = 0; p < n; p++)); do
    argv=()
    while IFS= read -r line; do
      argv+=("$line")
    done < <(jq -r --argjson i "$i" --argjson p "$p" '.packs[$i].preSetup[$p][]' "$HARNESS")
    argv[0]="$co/${argv[0]}"
    if ! as_build "$b/home" "$co" "$path" ${setup_env[@]+"${setup_env[@]}"} -- "${argv[@]}" >>"$WORK/harness-build.log" 2>&1; then
      STEP_ERROR="preSetup '${argv[*]#"$co"/}' failed"
      return 1
    fi
  done

  argv=()
  while IFS= read -r line; do
    argv+=("$line")
  done < <(jq -r --argjson i "$i" '.packs[$i].setupArgs[]' "$HARNESS")
  log "harness: running the pinned setup as $BUILD_USER (log: $WORK/harness-build.log)"
  status=0
  as_build "$b/home" "$co" "$path" ${setup_env[@]+"${setup_env[@]}"} -- \
    "$co/setup" ${argv[@]+"${argv[@]}"} >>"$WORK/harness-build.log" 2>&1 </dev/null || status=$?
  if [ "$status" -ne 0 ]; then
    tail -n 30 "$WORK/harness-build.log" >&2
    STEP_ERROR="setup failed (exit $status)"
    return 1
  fi
  # The setup may fall back to an unfrozen install: the tracked tree (lock
  # included) must still be the pinned commit's.
  if [ -n "$(as_build "$b/home" "$co" "$path" -- git status --porcelain --untracked-files=no)" ]; then
    STEP_ERROR="setup modified tracked files of the pinned commit (lockfile drift?)"
    return 1
  fi
  BUILD_VIEW_SRC=""
  BUILD_VIEW_DST=""
}

# stage_npm_lock <index> <stage>: our committed lockfile installed with
# --ignore-scripts as the build account, checked against the lock, then only
# the manifest's lifecycle scripts, pinned prebuilds and prefetch files (placed
# BY the build from <stage>/in), postInstall and an OFFLINE warmup. Root writes
# nothing under the build tree after the install started (see as_build);
# install_harness_pack assembles. Sets STEP_ERROR and returns 1 on failure.
stage_npm_lock() {
  local i="$1" stage="$2" b="$2/build" in="$2/in" out="$2/out" lockfile n p abi url sha256 path member status entry
  local -a argv mcp_env
  local npm_dir="$b/npm"
  lockfile="$(hfield "$i" .lockOverlay)"
  # Before any build command: the build dirs are fresh and root-written.
  mkdir -p "$npm_dir" "$b/work"
  if ! { git_repo cat-file blob "$HEAD_SHA:$lockfile" >"$npm_dir/package-lock.json" &&
    git_repo cat-file blob "$HEAD_SHA:$(dirname "$lockfile")/package.json" >"$npm_dir/package.json"; }; then
    STEP_ERROR="$lockfile or its package.json is absent at $HEAD_SHA"
    return 1
  fi
  if [ "$(sha256_of "$npm_dir/package-lock.json")" != "$(hfield "$i" .lockSha256)" ] ||
    [ "$(sha256_of "$npm_dir/package.json")" != "$(hfield "$i" .packageJsonSha256)" ]; then
    STEP_ERROR="lockfile or package.json sha256 mismatch"
    return 1
  fi
  chown -R "$BUILD_USER:" "$b"

  # `npm install` against the lock, not `npm ci`: npm ci refuses a lock whose
  # optional platform packages were never published for some other platform
  # (ruflo's closure has three). check_npm_tree then proves the installed tree
  # IS the lock, so a resolution that drifted fails the pack.
  log "harness: npm install --ignore-scripts from the committed lock as $BUILD_USER"
  status=0
  as_build "$b/home" "$npm_dir" "$BUILD_PATH" -- npm install --ignore-scripts --no-save \
    --no-audit --no-fund >>"$WORK/harness-build.log" 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    tail -n 30 "$WORK/harness-build.log" >&2
    STEP_ERROR="npm install failed (exit $status)"
    return 1
  fi
  check_npm_tree "$i" "$stage" || return 1

  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if ! jq -e --arg n "node_modules/$entry" '.packages | has($n)' "$WORK/harness-installed-lock.json" >/dev/null; then
      STEP_ERROR="allowlisted lifecycle script $entry names no installed package"
      return 1
    fi
    if ! as_build "$b/home" "$npm_dir" "$BUILD_PATH" npm_config_ignore_scripts=false -- \
      npm rebuild "$entry" --foreground-scripts >>"$WORK/harness-build.log" 2>&1; then
      STEP_ERROR="allowlisted lifecycle script of $entry failed"
      return 1
    fi
  done < <(jq -r --argjson i "$i" '.packs[$i].lifecycleScripts // [] | .[]' "$HARNESS")

  abi="$(host_node_abi)"
  n="$(jq -r --argjson i "$i" '.packs[$i].prebuilds // [] | length' "$HARNESS")"
  for ((p = 0; p < n; p++)); do
    path="$(hfield "$i" ".prebuilds[$p].path")"
    url="$(hfield "$i" ".prebuilds[$p].url")"
    sha256="$(hfield "$i" ".prebuilds[$p].sha256")"
    member="$(hfield "$i" ".prebuilds[$p].member")"
    case "$url" in
      *"-node-v$abi-linux-x64.tar.gz") ;;
      *)
        STEP_ERROR="no Node ABI $abi prebuild pinned for $path (never compiled here)"
        return 1
        ;;
    esac
    if ! jq -e --arg n "$path" '.packages | has($n)' "$WORK/harness-installed-lock.json" >/dev/null; then
      STEP_ERROR="prebuild target $path is not an installed package"
      return 1
    fi
    fetch_verified "$path prebuild" "$url" "$sha256" "$WORK/harness-prebuild.tgz" || return 1
    rm -rf "$WORK/harness-prebuild" && mkdir -p "$WORK/harness-prebuild"
    if ! tar -xzf "$WORK/harness-prebuild.tgz" -C "$WORK/harness-prebuild" "$member" ||
      [ -L "$WORK/harness-prebuild/$member" ] || [ ! -f "$WORK/harness-prebuild/$member" ]; then
      STEP_ERROR="prebuild for $path lacks the regular file $member"
      return 1
    fi
    write_input "$in" "prebuild-$p" <"$WORK/harness-prebuild/$member" || {
      STEP_ERROR="cannot stage the $path prebuild"
      return 1
    }
    if ! place_input "$b/home" "$in/prebuild-$p" "$npm_dir/$path/$member" 0755 >>"$WORK/harness-build.log" 2>&1; then
      STEP_ERROR="the build account could not place the $path prebuild"
      return 1
    fi
    if ! as_build "$b/home" "$b/work" "$BUILD_PATH" -- "$NODE_BIN" -e 'require(process.argv[1])' \
      "$npm_dir/$path" >>"$WORK/harness-build.log" 2>&1; then
      STEP_ERROR="the $path prebuild does not load on this Node"
      return 1
    fi
  done

  # Files a tool would otherwise fetch on first use (ruflo's embedding model):
  # sha256-pinned, downloaded by root, placed by the build before the warmup.
  n="$(jq -r --argjson i "$i" '.packs[$i].prefetch // [] | length' "$HARNESS")"
  for ((p = 0; p < n; p++)); do
    path="$(hfield "$i" ".prefetch[$p].path")"
    fetch_verified "$path" "$(hfield "$i" ".prefetch[$p].url")" "$(hfield "$i" ".prefetch[$p].sha256")" \
      "$WORK/harness-prefetch" || return 1
    write_input "$in" "prefetch-$p" <"$WORK/harness-prefetch" || {
      STEP_ERROR="cannot stage $path"
      return 1
    }
    rm -f "$WORK/harness-prefetch"
    if ! place_input "$b/home" "$in/prefetch-$p" "$npm_dir/$path" 0644 >>"$WORK/harness-build.log" 2>&1; then
      STEP_ERROR="the build account could not place $path"
      return 1
    fi
  done

  if [ "$(hfield "$i" .postInstall)" != "" ]; then
    argv=()
    while IFS= read -r entry; do
      argv+=("${entry//\{\{configDir\}\}/$b/home/.claude}")
    done < <(jq -r --argjson i "$i" '.packs[$i].postInstall[]' "$HARNESS")
    argv[0]="$npm_dir/${argv[0]}"
    log "harness: postInstall as $BUILD_USER"
    if ! as_build "$b/home" "$b/home" "$BUILD_PATH" -- "$NODE_BIN" "${argv[@]}" \
      >>"$WORK/harness-build.log" 2>&1; then
      tail -n 30 "$WORK/harness-build.log" >&2
      STEP_ERROR="postInstall failed"
      return 1
    fi
  fi

  # An MCP pack's server is started once at build time, unfiltered and with NO
  # network: its warmup calls run against the prefetched files (a fetch of
  # anything unpinned fails the pack), and the tools it registers are
  # recorded as mcp-tools.json (the worker denies the ones outside the
  # allowlist; every allowlisted tool must exist).
  if [ "$(hfield "$i" .mcpServe)" != "" ]; then
    jq --argjson i "$i" '.packs[$i].warmup // []' "$HARNESS" | write_input "$in" warmup.json || {
      STEP_ERROR="cannot stage the warmup calls"
      return 1
    }
    mcp_env=()
    while IFS= read -r entry; do
      [ -n "$entry" ] && mcp_env+=("$entry")
    done < <(jq -r --argjson i "$i" '.packs[$i].mcpServe.env // {} | to_entries[] | "\(.key)=\(.value)"' "$HARNESS")
    argv=()
    while IFS= read -r entry; do
      argv+=("$entry")
    done < <(jq -r --argjson i "$i" '.packs[$i].mcpServe.args // [] | .[]' "$HARNESS")
    log "harness: offline warmup as $BUILD_USER"
    BUILD_OFFLINE=1
    status=0
    as_build "$b/home" "$b/work" "$BUILD_PATH" ${mcp_env[@]+"${mcp_env[@]}"} -- \
      "$NODE_BIN" "$ROOT/harness-tools/mcp-probe.mjs" warmup "$in/warmup.json" -- \
      "$NODE_BIN" "$npm_dir/$(hfield "$i" .mcpServe.entrypoint)" ${argv[@]+"${argv[@]}"} \
      >"$WORK/harness-warmup.json" 2>>"$WORK/harness-build.log" || status=$?
    BUILD_OFFLINE=""
    if [ "$status" -ne 0 ]; then
      tail -n 5 "$WORK/harness-build.log" "$WORK/harness-warmup.json" >&2
      STEP_ERROR="warmup failed offline (exit $status)"
      return 1
    fi
    if ! tail -n 1 "$WORK/harness-warmup.json" | jq -e '.tools | type == "array" and length > 0 and all(type == "string")' >/dev/null 2>&1 ||
      ! tail -n 1 "$WORK/harness-warmup.json" | jq -c '.tools | sort' >"$out/mcp-tools.json"; then
      STEP_ERROR="the MCP server registered no tools"
      return 1
    fi
    entry="$(jq -r --slurpfile have "$out/mcp-tools.json" --argjson i "$i" \
      '[.packs[$i].toolAllowlist[] | select(. as $t | $have[0] | index($t) | not)] | join(",")' "$HARNESS")"
    if [ -n "$entry" ]; then
      STEP_ERROR="toolAllowlist names tools the server does not register: $entry"
      return 1
    fi
  fi
  # Nothing after the install may have added, removed or swapped a package.
  check_npm_tree "$i" "$stage" || return 1
  if [ "$(build_sha256 "$stage" "$npm_dir/package-lock.json")" != "$(hfield "$i" .lockSha256)" ]; then
    STEP_ERROR="a build step rewrote the committed lock"
    return 1
  fi
}

# assemble_pack <index> <stage>: root moves the dead build's output into the
# root-owned pack (after kill_build_processes and harden_build_tree).
assemble_pack() {
  local i="$1" stage="$2" b="$2/build" pack="$2/pack" entry
  if [ "$(hfield "$i" .kind)" = "npm-lock" ]; then
    for entry in node_modules package.json package-lock.json; do
      if ! mv "$b/npm/$entry" "$pack/"; then
        STEP_ERROR="cannot move $entry into the pack"
        return 1
      fi
    done
    if [ -f "$stage/out/mcp-tools.json" ] && ! mv "$stage/out/mcp-tools.json" "$pack/"; then
      STEP_ERROR="cannot move mcp-tools.json into the pack"
      return 1
    fi
  fi
  collect_build_output "$b/home" "$pack" "$i" || {
    STEP_ERROR="cannot move the installed config dir into the pack"
    return 1
  }
}

# write_mcp_wrapper <index> <pack> <target>: the FIXED wrapper text at the
# manifest's mcpServers command, the filter proxy and the allowlist. Only the
# final pack path and shape-checked manifest words are interpolated, every
# value single-quoted. The wrapper passes the run's proxy settings through and
# nothing else of the caller's env.
# shellcheck disable=SC2016 # "$HOME" and the ${VAR+...} words expand when the wrapper runs
write_mcp_wrapper() {
  local i="$1" pack="$2" target="$3" command rel wrapper entry
  command="$(jq -r --argjson i "$i" '.packs[$i].mcpServers | to_entries[0].value.command' "$HARNESS")"
  rel="${command#"{{packDir}}/"}"
  wrapper="$pack/$rel"
  case "$target" in
    *"'"*)
      STEP_ERROR="the install root contains a single quote"
      return 1
      ;;
  esac
  mkdir -p "$(dirname "$wrapper")" "$pack/lib" "$pack/etc" || return 1
  git_repo cat-file blob "$HEAD_SHA:$HARNESS_FILTER_REPO_PATH" >"$pack/lib/mcp-filter.mjs" || {
    STEP_ERROR="$HARNESS_FILTER_REPO_PATH is absent at $HEAD_SHA"
    return 1
  }
  jq --argjson i "$i" '.packs[$i].toolAllowlist' "$HARNESS" >"$pack/etc/tool-allowlist.json" || return 1
  {
    printf '#!/bin/sh\n'
    printf '# Written by install-batteries.sh (harness MCP wrapper). Do not edit.\n'
    printf '# Only PATH, HOME, LANG and the proxy settings reach the server; the\n'
    printf '# filter proxy enforces etc/tool-allowlist.json on tools/list and tools/call.\n'
    printf '# The environment is scrubbed IN PLACE (unset), never rebuilt through\n'
    printf '# `env -i NAME=value`: at WORKER_BOX_SLOTS > 1 HTTPS_PROXY carries the run'"'"'s\n'
    printf '# proxy credential, and an argv is world-readable in /proc (#205).\n'
    printf 'for __v in $(env | sed -n '"'"'s/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'"'"'); do\n'
    printf '  case "$__v" in\n'
    printf '    PATH|HOME|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy|NODE_USE_ENV_PROXY) ;;\n'
    printf '    *) unset "$__v" 2>/dev/null ;;\n'
    printf '  esac\n'
    printf 'done\n'
    printf 'unset __v\n'
    printf 'PATH=%s; export PATH\n' "'$BUILD_PATH'"
    printf 'LANG=C.UTF-8; export LANG\n'
    local env_keys=""
    # NUL-delimited: one entry is always one assignment, whatever the value
    # holds; a value with a control character (a newline would otherwise split
    # into a second, silently exported variable) is refused outright.
    while IFS= read -r -d '' entry; do
      [ -n "$entry" ] || continue
      case "$entry" in
        *"'"*) STEP_ERROR="mcpServe.env entry contains a single quote"; return 1 ;;
      esac
      [[ "$entry" =~ [[:cntrl:]] ]] && {
        STEP_ERROR="mcpServe.env entry contains a control character: ${entry%%=*}"
        return 1
      }
      local key="${entry%%=*}"
      # The key is written into shell code unquoted: it must be a shell
      # identifier, and never one of the names the wrapper or the filter own.
      [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
        STEP_ERROR="mcpServe.env key is not a shell identifier: $key"
        return 1
      }
      case "$key" in
        PATH|HOME|LANG|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy|NODE_USE_ENV_PROXY|AUTOMATA_MCP_ENV_KEYS)
          STEP_ERROR="mcpServe.env may not set $key"
          return 1
          ;;
      esac
      printf "%s='%s'; export %s\n" "$key" "${entry#*=}" "$key"
      env_keys="${env_keys:+$env_keys,}$key"
    done < <(jq -j --argjson i "$i" '.packs[$i].mcpServe.env | to_entries[] | "\(.key)=\(.value)\u0000"' "$HARNESS")
    # The filter builds the server's env from this list (plus PATH/HOME/LANG and
    # the proxy names) — the exhaustive allowlist; the scrub above is belt and braces.
    printf "AUTOMATA_MCP_ENV_KEYS='%s'; export AUTOMATA_MCP_ENV_KEYS\n" "$env_keys"
    printf "exec '%s' '%s' '%s' -- \\\\\n" "$NODE_BIN" "$target/lib/mcp-filter.mjs" "$target/etc/tool-allowlist.json"
    printf "  '%s' '%s'" "$NODE_BIN" "$target/$(hfield "$i" .mcpServe.entrypoint)"
    while IFS= read -r entry; do
      printf " '%s'" "$entry"
    done < <(jq -r --argjson i "$i" '.packs[$i].mcpServe.args[]' "$HARNESS")
    printf '\n'
  } >"$wrapper" || {
    STEP_ERROR="cannot write the MCP wrapper"
    return 1
  }
  chmod 0755 "$wrapper"
}

# harness_apparmor <index> <target>: one profile per pack granting `userns` to
# the EXACT pinned browser executables (Chromium's own sandbox needs a user
# namespace; Ubuntu 24.04 restricts unprivileged ones). Loaded with
# apparmor_parser -r when AppArmor is enabled; the sysctl is never touched.
harness_apparmor() {
  local i="$1" target="$2" id n b pw file tmp name exe
  n="$(jq -r --argjson i "$i" '.packs[$i].browsers // [] | length' "$HARNESS")"
  [ "$n" -gt 0 ] || return 0
  id="$(hfield "$i" .id)"
  pw="$(hfield "$i" .env.PLAYWRIGHT_BROWSERS_PATH)"
  pw="$target/${pw#"{{packDir}}/"}"
  file="$APPARMOR_DIR/automata-harness-$id"
  tmp="$WORK/apparmor-$id"
  {
    printf '# Written by install-batteries.sh (harness %s). Do not edit.\n' "$id"
    printf '# Grants user namespaces to the pinned browsers of %s only.\n' "$(basename "$target")"
    printf 'abi <abi/4.0>,\ninclude <tunables/global>\n'
    for ((b = 0; b < n; b++)); do
      name="$(hfield "$i" ".browsers[$b].name")"
      exe="$pw/$(hfield "$i" ".browsers[$b].dir")/$(hfield "$i" ".browsers[$b].executable")"
      printf '\nprofile automata-%s-%s "%s" flags=(unconfined) {\n  userns,\n}\n' "$id" "$name" "$exe"
    done
  } >"$tmp"
  if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" != "Y" ]; then
    log "harness apparmor $id: the profile this host would load:"
    cat "$tmp" >&2
    record "SKIPPED harness apparmor $id: AppArmor is not enabled on this host (profile not written)"
    return 0
  fi
  if cmp -s "$tmp" "$file" &&
    grep -q "^automata-$id-" /sys/kernel/security/apparmor/profiles 2>/dev/null; then
    record "SKIPPED harness apparmor $id (profile loaded)"
    return 0
  fi
  if ! { mkdir -p "$APPARMOR_DIR" && install -o root -g root -m 0644 "$tmp" "$file" &&
    apparmor_parser -r "$file"; }; then
    record "FAIL harness apparmor $id: could not write or load $file"
    return 1
  fi
  record "INSTALLED harness apparmor $id ($n browser profile(s))"
}

# stage_plugin_tarball <index> <stage>: the operator-staged `git archive` tar
# of the pinned commit, extracted by root into <pack>/src with Python's `data`
# filter, every `paths` entry checked against its pinned git tree id, then the
# plugin root's skills/, agents/ and commands/ linked under <pack>/claude.
# No upstream code runs. Sets STEP_ERROR and returns 1 on failure.
stage_plugin_tarball() {
  local i="$1" stage="$2" pack="$2/pack" id sha tar n p path tree got root kind name entry rel
  id="$(hfield "$i" .id)"
  sha="$(hfield "$i" .sha)"
  tar="$HARNESS_SRC_DIR/$id-$sha.tar"
  if [ ! -f "$tar" ] || [ -L "$tar" ]; then
    STEP_ERROR="no source tarball at $tar (deploy/PILOT-RUNBOOK.md: staging a plugin tarball)"
    return 1
  fi
  mkdir -p "$pack/src"
  # shellcheck disable=SC2016 # a Python program, not shell
  if ! python3 -I -c '
import sys
import tarfile

with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
' "$tar" "$pack/src" >"$WORK/harness-extract.log" 2>&1; then
    STEP_ERROR="cannot extract $tar: $(tail -n 1 "$WORK/harness-extract.log")"
    return 1
  fi
  n="$(jq -r --argjson i "$i" '.packs[$i].paths | length' "$HARNESS")"
  for ((p = 0; p < n; p++)); do
    path="$(hfield "$i" ".paths[$p].path")"
    tree="$(hfield "$i" ".paths[$p].tree")"
    if [ ! -d "$pack/src/$path" ] || [ "$(realpath -e -- "$pack/src/$path" 2>/dev/null)" != "$pack/src/$path" ]; then
      STEP_ERROR="$path is not a plain dir of the tarball"
      return 1
    fi
    rm -rf "$WORK/harness-tree" && mkdir -p "$WORK/harness-tree"
    got="$(git -C "$WORK/harness-tree" -c init.defaultBranch=main init -q &&
      git -C "$WORK/harness-tree" -c core.autocrlf=false -c core.fileMode=true -c core.symlinks=true \
        --work-tree="$pack/src/$path" add -A -f &&
      git -C "$WORK/harness-tree" write-tree)" || got=""
    if [ "$got" != "$tree" ]; then
      STEP_ERROR="$path recomputes to tree ${got:-<error>}, pinned $tree (the tarball is not $sha)"
      return 1
    fi
  done
  # Nothing beyond the pinned paths may ride along in the tarball.
  for entry in "$pack/src"/* "$pack/src"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    rel="${entry#"$pack/src/"}"
    jq -e --argjson i "$i" --arg r "$rel" 'any(.packs[$i].paths[].path; . == $r or startswith($r + "/"))' "$HARNESS" >/dev/null || {
      STEP_ERROR="the tarball holds $rel, which no pinned path names"
      return 1
    }
  done
  root="src/$(hfield "$i" .pluginRoot)"
  for kind in skills agents commands; do
    [ -d "$pack/$root/$kind" ] || continue
    mkdir -p "$pack/claude/$kind"
    for entry in "$pack/$root/$kind"/*; do
      [ -e "$entry" ] || continue
      name="$(basename "$entry")"
      if [ "$kind" = "skills" ]; then
        [ -d "$entry" ] || continue
      else
        if [ ! -f "$entry" ] || [[ "$name" != *.md ]]; then
          continue
        fi
      fi
      ln -s "../../$root/$kind/$name" "$pack/claude/$kind/$name"
    done
  done
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    # shellcheck disable=SC2086 # the unquoted pattern is what expands a `*` segment
    for entry in "$pack/claude/"$rel; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      rm -rf "$entry"
      log "harness $id: discarded ${entry#"$pack"/} (manifest discard list)"
    done
  done < <(jq -r --argjson i "$i" '.packs[$i].discard // [] | .[]' "$HARNESS")
  log "harness $id: $n path(s) at their pinned trees; linked $(find "$pack/claude" -mindepth 2 -maxdepth 2 | wc -l) entries"
}

# derive_agent_files <index> <pack>: each npm-lock `agentFiles` entry, after
# assembly (root's tree now): the sha256-pinned upstream file, never a link,
# copied to claude/agents/<name>.md with its top-level frontmatter `hooks` key
# and that key's indented block dropped; every other byte is kept.
derive_agent_files() {
  local i="$1" pack="$2" n a from sha256 name out dir
  n="$(jq -r --argjson i "$i" '.packs[$i].agentFiles // [] | length' "$HARNESS")"
  [ "$n" -gt 0 ] || return 0
  dir="$pack/claude/agents"
  mkdir -p "$dir"
  if [ "$(realpath -e -- "$dir" 2>/dev/null)" != "$dir" ]; then
    STEP_ERROR="claude/agents is reached through a link"
    return 1
  fi
  for ((a = 0; a < n; a++)); do
    from="$(hfield "$i" ".agentFiles[$a].from")"
    sha256="$(hfield "$i" ".agentFiles[$a].sha256")"
    name="$(hfield "$i" ".agentFiles[$a].name")"
    out="$dir/$name.md"
    if [ ! -f "$pack/$from" ] || [ -L "$pack/$from" ] ||
      [ "$(realpath -e -- "$pack/$from" 2>/dev/null)" != "$pack/$from" ]; then
      STEP_ERROR="agent file $from is not a regular file of the pack"
      return 1
    fi
    if [ "$(sha256_of "$pack/$from")" != "$sha256" ]; then
      STEP_ERROR="agent file $from does not match its pinned sha256"
      return 1
    fi
    if [ -e "$out" ] || [ -L "$out" ]; then
      STEP_ERROR="claude/agents/$name.md already exists in the pack"
      return 1
    fi
    if ! drop_frontmatter_hooks <"$pack/$from" >"$out"; then
      rm -f "$out"
      STEP_ERROR="agent file $from has no closed leading frontmatter block"
      return 1
    fi
    log "harness $(hfield "$i" .id): agent $name from $from (frontmatter hooks dropped)"
  done
}

# drop_frontmatter_hooks < in > out: the leading --- block without its
# top-level `hooks` key (bare or quoted) and every line of that key's block,
# up to the next top-level key or the closing fence. Fails without a block.
drop_frontmatter_hooks() {
  awk '
    { line = $0; sub(/\r$/, "", line) }
    NR == 1 { if (line != "---") exit 3; fm = 1; print; next }
    fm && line ~ /^---[ \t]*$/ { fm = 0; skip = 0; print; next }
    fm && line ~ /^["\047]?[A-Za-z0-9_-]+["\047]?[ \t]*:/ { skip = (line ~ /^["\047]?hooks["\047]?[ \t]*:/) }
    fm && skip { next }
    { print }
    END { if (NR == 0 || fm) exit 4 }
  '
}

# write_wrappers <index> <pack> <target>: each plugin-tarball `wrappers` entry
# as FIXED shell text: every aliasEnv target is set from its source when the
# source is non-empty, then the pack file is exec'd. Only shape-checked names
# and the final pack path are interpolated, the path single-quoted.
write_wrappers() {
  local i="$1" pack="$2" target="$3" n w path exec alias_to alias_from
  n="$(jq -r --argjson i "$i" '.packs[$i].wrappers // [] | length' "$HARNESS")"
  [ "$n" -gt 0 ] || return 0
  case "$target" in
    *"'"*)
      STEP_ERROR="the install root contains a single quote"
      return 1
      ;;
  esac
  for ((w = 0; w < n; w++)); do
    path="$(hfield "$i" ".wrappers[$w].path")"
    exec="$(hfield "$i" ".wrappers[$w].exec")"
    if [ ! -f "$pack/$exec" ] || [ ! -x "$pack/$exec" ]; then
      STEP_ERROR="wrapper $path: $exec is not an executable file of the pack"
      return 1
    fi
    mkdir -p "$pack/$(dirname "$path")"
    if [ -e "$pack/$path" ] || [ -L "$pack/$path" ]; then
      STEP_ERROR="wrapper $path already exists in the pack"
      return 1
    fi
    {
      printf '#!/bin/sh\n'
      printf '# Written by install-batteries.sh (harness wrapper). Do not edit.\n'
      while IFS=$'\t' read -r alias_to alias_from; do
        [ -n "$alias_to" ] || continue
        # shellcheck disable=SC2016 # expands when the wrapper runs
        printf 'if [ -n "${%s:-}" ]; then %s="$%s"; export %s; fi\n' \
          "$alias_from" "$alias_to" "$alias_from" "$alias_to"
      done < <(jq -r --argjson i "$i" --argjson w "$w" '.packs[$i].wrappers[$w].aliasEnv | to_entries[] | [.key, .value] | @tsv' "$HARNESS")
      printf "exec '%s' \"\$@\"\n" "$target/$exec"
    } >"$pack/$path" || {
      STEP_ERROR="cannot write wrapper $path"
      return 1
    }
    chmod 0755 "$pack/$path"
    log "harness $(hfield "$i" .id): wrapper $path -> $exec"
  done
}

# install_harness_pack <index>: SKIPPED at pin; else staged in a private dir
# under <root>, built as the build account, assembled and scanned by root,
# stamped and published by rename.
install_harness_pack() {
  local i="$1" id kind name target expected stage pack out status line hook_skills file avail
  id="$(hfield "$i" .id)"
  kind="$(hfield "$i" .kind)"
  name="$(harness_dir_name "$i")"
  target="$ROOT/$name"
  expected="$(harness_stamp_hash "$i")"

  if harness_at_pin "$target" "$expected"; then
    record "SKIPPED harness pack $name (at pin; $(grep -c '^file ' "$target/.stamp") recorded files re-verified)"
    harness_apparmor "$i" "$target" || true
    return 0
  fi
  # Only a build needs the space (downloads + the staged pack beside any old one).
  avail="$(df -Pk "$ROOT" | awk 'NR == 2 {print $4}')"
  if [ "${avail:-0}" -lt "$HARNESS_MIN_FREE_KB" ]; then
    record "FAIL harness pack $id: $((${avail:-0} / 1024 / 1024)) GiB free under $ROOT, a build needs 5"
    return 1
  fi
  avail="$(df -Pk "$WORK" | awk 'NR == 2 {print $4}')"
  if [ "${avail:-0}" -lt "$HARNESS_MIN_WORK_KB" ]; then
    record "FAIL harness pack $id: $((${avail:-0} / 1024)) MiB free under $WORK, a build needs 1 GiB for downloads"
    return 1
  fi

  if ! stage="$(mktemp -d "$ROOT/.staging.harness.$id.XXXXXX")"; then
    record "FAIL harness pack $id: cannot create a staging dir under $ROOT"
    return 1
  fi
  pack="$stage/pack"
  STEP_ERROR=""
  : >"$WORK/harness-build.log"
  if ! { chmod 0711 "$stage" && mkdir -p "$pack" "$stage/in" "$stage/out" "$stage/build/home" \
    "$stage/build/tmp" "$stage/build/npm-cache" && : >"$stage/build/npmrc" &&
    : >"$stage/build/npmrc-global" && chmod 0755 "$pack" "$stage/in" && chmod 0700 "$stage/out" &&
    chmod 0700 "$stage/build" &&
    chown -R "$BUILD_USER:" "$stage/build"; }; then
    STEP_ERROR="cannot prepare the staging dir"
  elif [ "$kind" = "git-setup" ]; then
    # The build view needs a mount point at the final path: an EMPTY
    # placeholder when no pack is there yet (no stamp, so nothing seeds it).
    if [ ! -e "$target" ] && mkdir -m 0755 "$target"; then
      HARNESS_PLACEHOLDER="$target"
    fi
    stage_git_setup "$i" "$stage" "$target" || STEP_ERROR="${STEP_ERROR:-staging failed}"
  elif [ "$kind" = "plugin-tarball" ]; then
    stage_plugin_tarball "$i" "$stage" || STEP_ERROR="${STEP_ERROR:-staging failed}"
  else
    stage_npm_lock "$i" "$stage" || STEP_ERROR="${STEP_ERROR:-staging failed}"
  fi
  BUILD_VIEW_SRC=""
  BUILD_VIEW_DST=""
  BUILD_OFFLINE=""
  # Success or not: nothing the build started survives, before root reads or
  # removes anything it wrote. A survivor fails the pack.
  if ! kill_build_processes; then
    STEP_ERROR="$STEP_ERROR${STEP_ERROR:+; }build account processes survived SIGKILL"
  fi
  if [ -n "$HARNESS_PLACEHOLDER" ]; then
    rmdir "$HARNESS_PLACEHOLDER" 2>/dev/null || STEP_ERROR="${STEP_ERROR:-the build wrote into the placeholder $HARNESS_PLACEHOLDER}"
    HARNESS_PLACEHOLDER=""
  fi
  if [ -z "$STEP_ERROR" ]; then
    harden_build_tree "$stage" || STEP_ERROR="${STEP_ERROR:-cannot harden the build tree}"
  fi
  if [ -z "$STEP_ERROR" ]; then
    assemble_pack "$i" "$stage" || STEP_ERROR="${STEP_ERROR:-cannot assemble the pack}"
  fi
  if [ -z "$STEP_ERROR" ]; then
    derive_agent_files "$i" "$pack" || STEP_ERROR="${STEP_ERROR:-cannot derive the agent files}"
  fi
  if [ -z "$STEP_ERROR" ]; then
    write_wrappers "$i" "$pack" "$target" || STEP_ERROR="${STEP_ERROR:-cannot write the wrappers}"
  fi
  if [ -z "$STEP_ERROR" ]; then
    place_runtimes "$i" "$stage" || STEP_ERROR="${STEP_ERROR:-cannot place the pack runtimes}"
  fi
  if [ -z "$STEP_ERROR" ] && [ "$(hfield "$i" .mcpServers)" != "" ]; then
    write_mcp_wrapper "$i" "$pack" "$target" || STEP_ERROR="${STEP_ERROR:-cannot write the MCP wrapper}"
  fi
  if [ -z "$STEP_ERROR" ]; then
    # Root-owned already (harden_build_tree); the modes are normalised here.
    if ! { chown -hR root:root "$pack" &&
      find "$pack" -type d -exec chmod 0755 {} + &&
      find "$pack" -type f -perm /111 -exec chmod 0755 {} + &&
      find "$pack" -type f ! -perm /111 -exec chmod 0644 {} +; }; then
      STEP_ERROR="could not set modes or ownership"
    fi
  fi
  if [ -z "$STEP_ERROR" ]; then
    hook_skills="$(jq -r --argjson i "$i" '.packs[$i].frontmatterHookSkills[]' "$HARNESS")"
    out="$WORK/harness-scan.out"
    status=0
    HARNESS_DISCARD_NAMES="${HARNESS_DISCARD_NAMES[*]}" scan_pack "$pack" "$stage" \
      "$stage/build/home/.claude" "$target" "$hook_skills" >"$out" 2>&1 || status=$?
    while IFS= read -r line; do
      case "$line" in
        "ERROR "*) log "harness $id scan: ${line#ERROR }" ;;
        "DISCARD "*) log "harness $id: discarded upstream ${line#DISCARD }" ;;
      esac
    done <"$out"
    if [ "$status" -ne 0 ]; then
      STEP_ERROR="profile scan failed: $(grep -m 1 '^ERROR ' "$out" | cut -c7-)"
    fi
  fi
  if [ -z "$STEP_ERROR" ]; then
    {
      # `node <major>` is what the worker checks against the manifest's nodeMajor.
      printf 'stamp %s\nsource %s\nnode %s\nnode_abi %s\n' "$expected" "$HEAD_SHA" \
        "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" "$(host_node_abi)"
      sed -n 's/^NATIVE /file /p' "$out"
      {
        jq -r --argjson i "$i" --arg pw "$(hfield "$i" .env.PLAYWRIGHT_BROWSERS_PATH)" \
          '.packs[$i].browsers // [] | .[] | "\($pw | ltrimstr("{{packDir}}/"))/\(.dir)/\(.executable)"' "$HARNESS"
        # The runtimes put on the agent's PATH (re-hashed like the browsers).
        jq -r --argjson i "$i" '.packs[$i].dependencies // [] | .[] | .installTo // empty' "$HARNESS"
        # Derived agent files and wrapper shims: root wrote them, the stamp pins them.
        jq -r --argjson i "$i" '(.packs[$i].agentFiles // [] | .[] | "claude/agents/\(.name).md"), (.packs[$i].wrappers // [] | .[] | .path)' "$HARNESS"
      } |
        while IFS= read -r file; do
          printf 'file %s %s\n' "$(sha256_of "$pack/$file")" "$file"
        done
      for file in lib/mcp-filter.mjs etc/tool-allowlist.json mcp-tools.json \
        "$(jq -r --argjson i "$i" '.packs[$i].mcpServers // {} | to_entries[0].value.command // "" | ltrimstr("{{packDir}}/")' "$HARNESS")"; do
        if [ -n "$file" ] && [ -f "$pack/$file" ]; then
          printf 'file %s %s\n' "$(sha256_of "$pack/$file")" "$file"
        fi
      done
    } >"$pack/.stamp" && chmod 0644 "$pack/.stamp" || STEP_ERROR="could not write the stamp"
  fi
  if [ -z "$STEP_ERROR" ] && ! publish_dir "$pack" "$target" "harness pack"; then
    STEP_ERROR="could not publish $target"
  fi
  rm -rf "$stage"
  if [ -n "$STEP_ERROR" ]; then
    record "FAIL harness pack $id: $STEP_ERROR"
    return 1
  fi
  record "INSTALLED harness pack $name ($(du -sh "$target" | cut -f1), $(grep -c '^file ' "$target/.stamp") files recorded)"
  harness_apparmor "$i" "$target" || true
}

# Whatever a build wrote outside its staging dir (its packs are published or
# removed by now) is listed and deleted: it is upstream state nobody vetted.
discard_build_side_writes() {
  local path found=0
  kill_build_processes || record "FAIL harness side writes: $STEP_ERROR"
  while IFS= read -r -d '' path; do
    found=$((found + 1))
    log "harness: discarding a build side write: $path"
    rm -rf "$path"
  done < <(find / /tmp /var/tmp /dev/shm -xdev \( -path /proc -o -path /sys \
    -o -path /var/lib/docker -o -path /var/lib/containerd -o -path "$ROOT" \) -prune \
    -o -user "$BUILD_USER" -print0 2>/dev/null | sort -zu)
  if [ "$found" -eq 0 ]; then
    record "VERIFIED harness side writes: none outside the packs"
  else
    record "DISCARDED harness side writes: $found path(s) outside the packs (see the log)"
  fi
}

list_stale_harness() {
  local dir base i current n
  current="$(while IFS=$'\t' read -r -u 3 i _ _; do harness_dir_name "$i"; done 3< <(harness_rows))"
  n=0
  for dir in "$ROOT"/*@*; do
    [ -d "$dir" ] || continue
    base="$(basename "$dir")"
    jq -e --arg n "${base%%@*}" 'any(.packs[]; .id == $n)' "$HARNESS" >/dev/null || continue
    grep -qxF -- "$base" <<<"$current" && continue
    record "STALE harness pack $dir (left in place; remove by hand with no run in flight)"
    n=$((n + 1))
  done
  [ "$n" -eq 0 ] || log "WARNING: $n stale harness pack version(s) under $ROOT"
}

# write_harness_stamps: the stamp each pack carries after this install, for the
# doctor (written before verify-as-agent, which checks against it): a pack
# whose .stamp no longer matches is not the one this install built or SKIPPED.
write_harness_stamps() {
  local i name
  while IFS=$'\t' read -r -u 3 i _ _; do
    name="$(harness_dir_name "$i")"
    [ -f "$ROOT/$name/.stamp" ] || continue
    printf '%s %s\n' "$name" "$(sed -n '1s/^stamp //p' "$ROOT/$name/.stamp")"
  done 3< <(harness_rows) >"$ROOT/.harness.stamps.tmp"
  chmod 0644 "$ROOT/.harness.stamps.tmp"
  mv -f "$ROOT/.harness.stamps.tmp" "$ROOT/harness.stamps"
}

invalidate_harness_hash() {
  if [ -f "$ROOT/harness.sha256" ]; then
    mv -f "$ROOT/harness.sha256" "$ROOT/harness.sha256.invalid"
  fi
  rm -f "$ROOT/harness.stamps"
}

# sha256 of the harness manifest bytes, then each pack's lockOverlay blob at
# HEAD in manifest order — the recipe the worker recomputes over its own
# checkout (computeHarnessManifestHash in harness-layout.ts), so a harness
# install that lags the deployed worker seeds nothing. Written only when no
# harness item failed.
write_harness_hash() {
  local hash lockfile tmp="$ROOT/.harness.sha256.tmp"
  hash="$({
    cat "$HARNESS"
    while IFS= read -r lockfile; do
      git_repo cat-file blob "$HEAD_SHA:$lockfile"
    done < <(jq -r '.packs[] | .lockOverlay // empty' "$HARNESS")
  } | sha256sum | awk '{print $1}')"
  printf '%s\n' "$hash" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$ROOT/harness.sha256"
  rm -f "$ROOT/harness.sha256.invalid"
}

# install_harness: preflight (also in a dry run), then — root only — the host
# checks, the build account, the doctor, the browser runtime, every pack, the
# side-write sweep, stale versions and the doctor's verify-as-agent.
install_harness() {
  local before="$HARNESS_FAILURES" i status line out cmd
  if [ -z "$HARNESS" ]; then
    record "SKIPPED harness: no $HARNESS_MANIFEST_REPO_PATH at $HEAD_SHA"
    return 0
  fi
  # Any harness FAIL from here on, preflight included, leaves the harness
  # stamp invalid; only a fully passing harness install writes it back.
  [ "$DRY_RUN" -eq 1 ] || invalidate_harness_hash
  harness_preflight || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    record "HARNESS BUILD SKIPPED (dry run: the build account needs root)"
    return 0
  fi

  for cmd in runuser unshare mount pkill python3 timeout dpkg-query fuser apt-get getent useradd groupadd "$NODE_BIN"; do
    command -v "$cmd" >/dev/null 2>&1 || record "FAIL harness preflight $cmd: required command not found"
  done
  while IFS=$'\t' read -r -u 3 i _ _; do
    [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "$(hfield "$i" .nodeMajor)" ] ||
      record "FAIL harness preflight $(hfield "$i" .id): host Node is not the pinned major $(hfield "$i" .nodeMajor)"
  done 3< <(harness_rows)
  [ "$HARNESS_FAILURES" -eq "$before" ] || return 0

  ensure_build_account || return 0
  kill_build_processes || {
    record "FAIL harness build account: $STEP_ERROR"
    return 0
  }
  rm -rf "$ROOT"/.staging.harness.*
  if install_root_file "$HARNESS_DOCTOR_REPO_PATH" "$BIN_DIR/automata-batteries" 0755 &&
    install_root_file "$HARNESS_PROBE_REPO_PATH" "$ROOT/harness-tools/mcp-probe.mjs" 0644 &&
    install_root_file "$HARNESS_MANIFEST_REPO_PATH" "$ROOT/harness.json" 0644; then
    chmod 0755 "$ROOT/harness-tools"
    if [ "$ROOT_FILES_CHANGED" -eq 0 ]; then
      record "SKIPPED harness doctor $BIN_DIR/automata-batteries (unchanged)"
    else
      record "INSTALLED harness doctor $BIN_DIR/automata-batteries (+ $ROOT/harness.json, harness-tools/)"
    fi
  else
    record "FAIL harness doctor: could not install $BIN_DIR/automata-batteries"
    return 0
  fi
  install_browser_runtime || true

  while IFS=$'\t' read -r -u 3 i _ _; do
    install_harness_pack "$i" || true
  done 3< <(harness_rows)

  discard_build_side_writes
  list_stale_harness
  write_harness_stamps

  status=0
  out="$(AUTOMATA_BATTERIES_ROOT="$ROOT" "$BIN_DIR/automata-batteries" verify-as-agent 2>"$WORK/verify.err")" || status=$?
  while IFS= read -r line; do
    case "$line" in
      "VERIFIED harness "* | "FAIL harness "* | "SKIPPED harness "*) record "$line" ;;
    esac
  done <<<"$out"
  if [ "$status" -ne 0 ] && [ "$HARNESS_FAILURES" -eq "$before" ]; then
    record "FAIL harness verify-as-agent: exit $status ($(head -n 1 "$WORK/verify.err"))"
  fi

  if [ "$HARNESS_FAILURES" -eq "$before" ]; then
    write_harness_hash
    record "HARNESS STAMP $(cat "$ROOT/harness.sha256")"
  fi
}
# ── end harness stages ───────────────────────────────────────────────────────

main() {
  local i id repo sha name version url sha256 member license_member row
  if ! git_repo rev-parse --git-dir >/dev/null 2>&1; then
    usage_error "AUTOMATA_REPO=$AUTOMATA_REPO is not a git checkout (set AUTOMATA_REPO=/opt/automata-platform)"
  fi
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/automata-batteries.XXXXXX")"
  SUMMARY="$WORK/summary"
  : >"$SUMMARY"
  trap on_exit EXIT

  HEAD_SHA="$(git_repo rev-parse --verify 'HEAD^{commit}')"
  record "SOURCE checkout $HEAD_SHA"
  MANIFEST="$WORK/batteries.json"
  if [ -n "$BATTERIES_MANIFEST" ]; then
    cat "$BATTERIES_MANIFEST" >"$MANIFEST"
    record "SOURCE manifest $BATTERIES_MANIFEST (dry run)"
  else
    git_repo cat-file blob "$HEAD_SHA:$MANIFEST_REPO_PATH" >"$MANIFEST"
  fi

  HARNESS="$WORK/harness.json"
  if [ -n "$HARNESS_MANIFEST" ]; then
    cat "$HARNESS_MANIFEST" >"$HARNESS"
    record "SOURCE harness manifest $HARNESS_MANIFEST (dry run)"
  elif ! git_repo cat-file blob "$HEAD_SHA:$HARNESS_MANIFEST_REPO_PATH" >"$HARNESS" 2>/dev/null; then
    HARNESS=""
  fi

  preflight || finish
  if [ "$BATTERIES_PREFLIGHT_ONLY" = "1" ]; then
    [ -z "$HARNESS" ] || harness_preflight || true
    record "PREFLIGHT ONLY (dry run): nothing installed"
    finish
  fi
  mkdir -p "$ROOT"

  invalidate_manifest_hash

  while IFS=$'\t' read -r -u 3 name version url sha256 member license_member _; do
    [ -n "$name" ] || continue
    install_cli "$name" "$version" "$url" "$sha256" "$member" "$license_member" || true
  done 3<<<"$CLI_ROWS"

  while IFS=$'\t' read -r -u 3 i id repo sha; do
    install_pack "$i" "$id" "$repo" "$sha" || true
  done 3<<<"$PACK_ROWS"

  # Tools after packs, in manifest order (an aot tool's sdk comes first).
  while IFS= read -r -u 3 row; do
    [ -n "$row" ] || continue
    install_tool "$(jq -r '.key' <<<"$row")" || true
  done 3<<<"$TOOL_ROWS"

  list_stale

  if [ "$DRY_RUN" -eq 1 ]; then
    record "VERIFY SKIPPED (SKIP_SUDO_VERIFY=1, dry run)"
  else
    verify_as_agent
  fi

  if [ "$FAILURES" -eq 0 ]; then
    write_manifest_hash
  fi

  # After the review result is settled: nothing below can touch it.
  install_harness
  finish
}

main "$@"
