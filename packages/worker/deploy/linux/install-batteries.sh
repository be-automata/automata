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
# Dry run (developers, non-root): PREFIX=<absolute tmp dir> SKIP_SUDO_VERIFY=1,
# optionally BATTERIES_MANIFEST=<absolute path> to test a modified manifest,
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

AGENT_USER="${AGENT_USER:-automata-agent}"
WORKER_USER="${WORKER_USER:-automata}"
SKIP_SUDO_VERIFY="${SKIP_SUDO_VERIFY:-}"
BATTERIES_MANIFEST="${BATTERIES_MANIFEST:-}"
BATTERIES_DOWNLOAD_CACHE="${BATTERIES_DOWNLOAD_CACHE:-}"
BATTERIES_PREFLIGHT_ONLY="${BATTERIES_PREFLIGHT_ONLY:-}"
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
  [ -n "$BATTERIES_DOWNLOAD_CACHE" ] || [ -n "$BATTERIES_PREFLIGHT_ONLY" ]; then
  if [ "$(id -u)" = "0" ]; then
    usage_error "dry-run knobs are refused for root (SKIP_SUDO_VERIFY / BATTERIES_MANIFEST / BATTERIES_DOWNLOAD_CACHE / BATTERIES_PREFLIGHT_ONLY)"
  fi
  if [ "$PREFIX" = "/usr/local" ]; then
    usage_error "SKIP_SUDO_VERIFY=1 / BATTERIES_MANIFEST / BATTERIES_DOWNLOAD_CACHE / BATTERIES_PREFLIGHT_ONLY require a non-default PREFIX"
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
    "FAIL "*) FAILURES=$((FAILURES + 1)) ;;
  esac
}

sha256_of() {
  sha256sum "$1" | awk '{print $1}'
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
  FINISHED=1
  print_summary
  if [ "$FAILURES" -eq 0 ]; then
    echo "RESULT: PASS"
    exit 0
  fi
  echo "RESULT: FAIL (${FAILURES} failure(s))"
  exit 1
}

# shellcheck disable=SC2317,SC2329 # invoked by `trap on_exit EXIT` in main (SC2317 on shellcheck <0.10, SC2329 on >=0.10)
on_exit() {
  local status=$?
  if [ -n "$SUMMARY" ] && [ "$FINISHED" -eq 0 ]; then
    print_summary
    echo "FAIL script: aborted with status ${status} (see the log above)"
    echo "RESULT: FAIL ($((FAILURES + 1)) failure(s))"
    status=1
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
  local re_id='^[a-z0-9][a-z0-9-]*$'
  local re_version_args='^-{0,2}[a-z]+$'
  local re_sha1='^[0-9a-f]{40}$'
  local re_sha256='^[0-9a-f]{64}$'
  local re_semver='^[0-9]+\.[0-9]+\.[0-9]+$'
  local re_github='^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
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
    [[ "$id" =~ $re_id ]] || record "FAIL preflight pack: bad id"
    [ "$repo" = "self" ] || [[ "$repo" =~ $re_github ]] ||
      record "FAIL preflight $id: repo must be self or a github https url"
    [[ "$sha" =~ $re_sha1 ]] || record "FAIL preflight $id: sha is not 40 hex"
    while IFS=$'\t' read -r -u 4 src dest git_id ex_rest; do
      check_vendored_path "$id" src "$src"
      check_vendored_path "$id" dest "$dest"
      [[ "$dest" =~ $re_dest ]] || record "FAIL preflight $id: dest outside the pack layout"
      [[ "$git_id" =~ $re_sha1 ]] || record "FAIL preflight $id: gitId is not 40 hex"
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
    [[ "$name" =~ $re_id ]] || record "FAIL preflight cli: bad name"
    [[ "$version" =~ $re_semver ]] || record "FAIL preflight $name: bad version"
    [[ "$args" =~ $re_version_args ]] || record "FAIL preflight $name: bad versionArgs"
    [[ "$sha256" =~ $re_sha256 ]] || record "FAIL preflight $name: sha256 is not 64 hex"
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
  local re_id='^[a-z0-9][a-z0-9-]*$'
  local re_version_args='^-{0,2}[a-z]+$'
  local re_sha1='^[0-9a-f]{40}$'
  local re_sha256='^[0-9a-f]{64}$'
  local re_semver='^[0-9]+\.[0-9]+\.[0-9]+$'
  local re_github='^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  local re_root_env='^[A-Z][A-Z0-9]*_ROOT$'
  local re_version_line='^[A-Za-z0-9 ._-]+$'
  local re_smoke_word='^-{0,2}[a-z0-9][a-z0-9_-]*$'
  local re_platform='^[a-z0-9]+-[a-z0-9]+$'
  local sdk_keys='["name","kind","version","url","sha256","licenseMember","license"]'
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
    if [[ "$name" =~ $re_id ]]; then
      label="$name"
    else
      record "FAIL preflight $label: bad name"
    fi
    kind="$(jq -r '.value.kind // "" | strings' <<<"$row")"
    case "$kind" in
      dart-sdk) keys="$sdk_keys" ;;
      dart-aot) keys="$aot_keys" ;;
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
    [[ "$version" =~ $re_semver ]] || record "FAIL preflight $label: bad version"

    if [ "$kind" = "dart-sdk" ]; then
      url="$(tool_field "$i" url)"
      sha256="$(tool_field "$i" sha256)"
      license_member="$(tool_field "$i" licenseMember)"
      [[ "$sha256" =~ $re_sha256 ]] || record "FAIL preflight $label: sha256 is not 64 hex"
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
    [[ "$repo" =~ $re_github ]] || record "FAIL preflight $label: repo must be a github https url"
    [[ "$sha" =~ $re_sha1 ]] || record "FAIL preflight $label: sha is not 40 hex"
    while IFS=$'\t' read -r -u 4 src dest git_id; do
      if ! safe_rel_path "$src" || ! safe_rel_path "$dest"; then
        record "FAIL preflight $label: unsafe subpath"
      fi
      [[ "$git_id" =~ $re_sha1 ]] || record "FAIL preflight $label: gitId is not 40 hex"
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
    [[ "$lock_sha256" =~ $re_sha256 ]] || record "FAIL preflight $label: lockSha256 is not 64 hex"
    sdk="$(tool_field "$i" sdk)"
    grep -qxF -- "$sdk dart-sdk" <<<"$seen" || record "FAIL preflight $label: sdk must name an earlier dart-sdk tool"
    wrapper="$(tool_field "$i" wrapper)"
    [[ "$wrapper" =~ $re_id ]] || record "FAIL preflight $label: bad wrapper"
    if grep -qxF -- "$wrapper" <<<"$cli_names" || grep -qxF -- "$wrapper" <<<"$wrappers"; then
      record "FAIL preflight $label: wrapper collides with a CLI name or another wrapper"
    fi
    wrappers="$wrappers$wrapper"$'\n'
    root_env="$(tool_field "$i" rootEnv)"
    [[ "$root_env" =~ $re_root_env ]] || record "FAIL preflight $label: rootEnv must match $re_root_env"
    args="$(tool_field "$i" versionArgs)"
    [[ "$args" =~ $re_version_args ]] || record "FAIL preflight $label: versionArgs must be one word"
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
  log "downloading $name $version"
  if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$dl" "$url"; then
    record "FAIL cli $name: download failed"
    return 1
  fi
  if ! printf '%s  %s\n' "$sha256" "$dl" | sha256sum -c - >/dev/null 2>&1; then
    record "FAIL cli $name: sha256 mismatch (got $(sha256_of "$dl"))"
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
  if ! { printf 'tarball_sha256 %s\nbinary_sha256 %s\n' "$sha256" "$bin_sha" >"$stamp.tmp" &&
    chmod 0644 "$stamp.tmp" &&
    mv -f "$stamp.tmp" "$stamp"; }; then
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
  if [ -n "$cached" ] && [ -f "$cached" ]; then
    log "using the cached $name $version zip (sha256 re-checked below)"
    if ! cp "$cached" "$zip"; then
      STEP_ERROR="cannot copy the cached zip"
      return 1
    fi
  else
    log "downloading $name $version"
    if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$zip" "$url"; then
      STEP_ERROR="download failed"
      return 1
    fi
  fi
  # Before ANY extraction; a cached copy that does not match is a FAIL, never
  # silently replaced.
  if ! printf '%s  %s\n' "$sha256" "$zip" | sha256sum -c - >/dev/null 2>&1; then
    STEP_ERROR="sha256 mismatch (got $(sha256_of "$zip"))"
    return 1
  fi
  if [ -n "$cached" ] && [ ! -f "$cached" ]; then
    if ! { mkdir -p "$BATTERIES_DOWNLOAD_CACHE" && cp "$zip" "$cached.tmp.$$" &&
      mv -f "$cached.tmp.$$" "$cached"; }; then
      log "could not cache $name $version (continuing)"
    fi
  fi

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
    dart-sdk) target="$ROOT/$name@$version" ;;
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
    printf 'stamp %s\nartifact_sha256 %s\nsource %s\n' "$expected" "$(sha256_of "$artifact")" "$HEAD_SHA" >"$stamp.tmp" &&
    chmod 0644 "$stamp.tmp" &&
    mv -f "$stamp.tmp" "$stamp"; }; then
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
    if jq -e --arg d "$base" '
      any(.packs[]; (.id + "@" + .sha) == $d)
      or any((.tools // [])[];
        (.name + "@" + (if .kind == "dart-sdk" then .version else .sha end)) == $d)' \
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
  mv -f "$tmp" "$ROOT/manifest.sha256"
  rm -f "$ROOT/manifest.sha256.invalid"
}

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

  preflight || finish
  if [ "$BATTERIES_PREFLIGHT_ONLY" = "1" ]; then
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
  finish
}

main "$@"
