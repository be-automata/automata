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
# - Exactly ONE helper reference is tolerated: the decision-ledger helper named
#   once in the vendored gstack checklist. It is safe because the adapter
#   declares that ledger unavailable and forbids running any command named in
#   the vendored files. Any other reference, or a different count after a pin
#   bump, fails the pack.
# - Pack dirs are published by rename from a staging dir on the same
#   filesystem, because Phase 5 links runs into these paths. Old dirs are never
#   pruned: they are reported STALE and removed by hand with no run in flight.
#
# Dry run (developers, non-root): PREFIX=<absolute tmp dir> SKIP_SUDO_VERIFY=1,
# optionally BATTERIES_MANIFEST=<absolute path> to test a modified manifest.
# Both knobs are refused for root and for a PREFIX that resolves to /usr/local.
# Commit first: the manifest and overlays are read from HEAD.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
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

# The single tolerated helper reference (see header). Single-quoted on purpose.
ALLOWED_HELPER_REF_FILE="skills/gstack-review/checklist.md"
# shellcheck disable=SC2088 # a literal string to search for, never a path to expand
ALLOWED_HELPER_REF='~/.claude/skills/gstack/bin/gstack-decision-search'

AGENT_USER="${AGENT_USER:-automata-agent}"
WORKER_USER="${WORKER_USER:-automata}"
SKIP_SUDO_VERIFY="${SKIP_SUDO_VERIFY:-}"
BATTERIES_MANIFEST="${BATTERIES_MANIFEST:-}"
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

DRY_RUN=0
if [ -n "$SKIP_SUDO_VERIFY" ] || [ -n "$BATTERIES_MANIFEST" ]; then
  if [ "$(id -u)" = "0" ]; then
    usage_error "dry-run knobs are refused for root (SKIP_SUDO_VERIFY / BATTERIES_MANIFEST)"
  fi
  if [ "$PREFIX" = "/usr/local" ]; then
    usage_error "SKIP_SUDO_VERIFY=1 / BATTERIES_MANIFEST require a non-default PREFIX"
  fi
  if [ "$SKIP_SUDO_VERIFY" != "1" ]; then
    usage_error "a dry run needs SKIP_SUDO_VERIFY=1 (non-root cannot verify through sudo)"
  fi
  case "$BATTERIES_MANIFEST" in
    "" | /*) ;;
    *) usage_error "BATTERIES_MANIFEST must be an absolute path" ;;
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
IS_ROOT=0
[ "$(id -u)" = "0" ] && IS_ROOT=1

FAILURES=0
WORK=""
SUMMARY=""
VERIFY_HOME=""
FINISHED=0
HEAD_SHA=""
MANIFEST=""
SCRIPT_HASH=""
FETCH_REPO=""
STEP_ERROR=""

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

# jq on one compact JSON entry: a raw scalar field.
jf() {
  printf '%s' "$1" | jq -r "$2"
}

# jq on one compact JSON entry: a list of objects, one compact object per line.
jl() {
  printf '%s' "$1" | jq -c "$2"
}

finish() {
  FINISHED=1
  echo "== automata batteries summary =="
  cat "$SUMMARY"
  if [ "$FAILURES" -eq 0 ]; then
    echo "RESULT: PASS"
    exit 0
  fi
  echo "RESULT: FAIL (${FAILURES} failure(s))"
  exit 1
}

# shellcheck disable=SC2329 # invoked by `trap on_exit EXIT` in main
on_exit() {
  local status=$?
  if [ -n "$SUMMARY" ] && [ "$FINISHED" -eq 0 ]; then
    echo "== automata batteries summary =="
    cat "$SUMMARY"
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

# Same shapes as packages/worker/src/agent-run/batteries-manifest.ts; names and
# versionArgs reach a root shell and an agent shell, so they are re-checked here.
preflight() {
  local re_id='^[a-z0-9][a-z0-9-]*$'
  local re_version_args='^-{0,2}[a-z]+$'
  local re_sha1='^[0-9a-f]{40}$'
  local re_sha256='^[0-9a-f]{64}$'
  local re_semver='^[0-9]+\.[0-9]+\.[0-9]+$'
  local re_github='^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  local re_dest='^(LICENSE|skills/[a-z0-9-]+(/.+)?|agents/[a-z0-9-]+\.md)$'
  local cmd entry sub ov ex id name value field

  for cmd in git jq curl sha256sum tar gzip awk find mktemp; do
    command -v "$cmd" >/dev/null 2>&1 || record "FAIL preflight $cmd: required command not found"
  done
  if [ "$DRY_RUN" -eq 0 ]; then
    for cmd in runuser /usr/bin/sudo; do
      command -v "$cmd" >/dev/null 2>&1 || record "FAIL preflight $cmd: required command not found"
    done
  fi
  [ "$FAILURES" -eq 0 ] || return 1

  if ! jq -e '.schemaVersion == 1 and (.packs | type == "array") and (.clis | type == "array")' \
    "$MANIFEST" >/dev/null; then
    record "FAIL preflight manifest: schemaVersion must be 1 with packs and clis arrays"
    return 1
  fi
  # Raw (-r) reads below are line-based: a control character in any string
  # could split one value into two that each pass the checks.
  if ! jq -e '[.. | strings | test("[\u0000-\u001f\u007f]")] | any | not' "$MANIFEST" >/dev/null; then
    record "FAIL preflight manifest: a string contains a control character"
    return 1
  fi

  while IFS= read -r -u 3 entry; do
    id="$(jf "$entry" '.id')"
    [[ "$id" =~ $re_id ]] || record "FAIL preflight pack: bad id"
    value="$(jf "$entry" '.repo')"
    [ "$value" = "self" ] || [[ "$value" =~ $re_github ]] ||
      record "FAIL preflight $id: repo must be self or a github https url"
    value="$(jf "$entry" '.sha')"
    [[ "$value" =~ $re_sha1 ]] || record "FAIL preflight $id: sha is not 40 hex"
    while IFS= read -r -u 4 sub; do
      for field in src dest; do
        value="$(jf "$sub" ".$field")"
        safe_rel_path "$value" || record "FAIL preflight $id: unsafe $field"
      done
      value="$(jf "$sub" '.dest')"
      [[ "$value" =~ $re_dest ]] || record "FAIL preflight $id: dest outside the pack layout"
      value="$(jf "$sub" '.gitId')"
      [[ "$value" =~ $re_sha1 ]] || record "FAIL preflight $id: gitId is not 40 hex"
      while IFS= read -r -u 5 ex; do
        safe_rel_path "$ex" || record "FAIL preflight $id: unsafe exclude"
      done 5< <(jf "$sub" '.exclude // [] | .[]')
    done 4< <(jl "$entry" '.subpaths[]')
    while IFS= read -r -u 4 ov; do
      value="$(jf "$ov" '.from')"
      safe_rel_path "$value" || record "FAIL preflight $id: unsafe overlay from"
      case "$value" in
        "$OVERLAY_DIR_PREFIX"*) ;;
        *) record "FAIL preflight $id: overlay from outside $OVERLAY_DIR_PREFIX" ;;
      esac
      value="$(jf "$ov" '.dest')"
      safe_rel_path "$value" || record "FAIL preflight $id: unsafe overlay dest"
      case "$value" in
        skills/*) ;;
        *) record "FAIL preflight $id: overlay dest outside skills/" ;;
      esac
    done 4< <(jl "$entry" '.overlays // [] | .[]')
  done 3< <(jq -c '.packs[]' "$MANIFEST")

  while IFS= read -r -u 3 entry; do
    name="$(jf "$entry" '.name')"
    [[ "$name" =~ $re_id ]] || record "FAIL preflight cli: bad name"
    value="$(jf "$entry" '.version')"
    [[ "$value" =~ $re_semver ]] || record "FAIL preflight $name: bad version"
    value="$(jf "$entry" '.versionArgs')"
    [[ "$value" =~ $re_version_args ]] || record "FAIL preflight $name: bad versionArgs"
    value="$(jf "$entry" '.sha256')"
    [[ "$value" =~ $re_sha256 ]] || record "FAIL preflight $name: sha256 is not 64 hex"
    value="$(jf "$entry" '.url')"
    case "$value" in
      https://github.com/*) ;;
      *) record "FAIL preflight $name: url is not a github https url" ;;
    esac
    for field in member licenseMember; do
      value="$(jf "$entry" ".$field")"
      safe_rel_path "$value" || record "FAIL preflight $name: unsafe $field"
    done
  done 3< <(jq -c '.clis[]' "$MANIFEST")

  [ "$FAILURES" -eq 0 ]
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
  awk '
    { line = $0; sub(/\r$/, "", line) }
    NR == 1 && line == "---" { fm = 1; print; next }
    fm && line == "---" { fm = 0; skip = 0; print; next }
    fm && line ~ /^(allowed-tools|hooks|permissionMode|mcpServers):/ { skip = 1; next }
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

# Any hit is a FAIL for the whole pack (STEP_ERROR set).
verify_staging() {
  local stage="$1" hit file total allowed=0 skill_dir
  hit="$(find "$stage" \( -name hooks -o -name settings.json -o -name settings.local.json \
    -o -name .mcp.json -o -name plugin.json -o -name .claude-plugin \) -print | head -n 1)"
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
    if awk '
      { line = $0; sub(/\r$/, "", line) }
      NR == 1 { if (line != "---") exit 1; fm = 1; next }
      fm && line == "---" { exit 1 }
      fm && line ~ /^(allowed-tools|hooks|permissionMode|mcpServers):/ { exit 0 }
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
  total="$({ grep -roF -e 'gstack/bin' -e 'gstack-skill-start' "$stage" || true; } | wc -l | tr -d ' ')"
  if [ -f "$stage/$ALLOWED_HELPER_REF_FILE" ]; then
    allowed="$({ grep -oF -- "$ALLOWED_HELPER_REF" "$stage/$ALLOWED_HELPER_REF_FILE" || true; } | wc -l | tr -d ' ')"
    if [ "$allowed" -ne 1 ]; then
      STEP_ERROR="$ALLOWED_HELPER_REF_FILE holds the allowlisted helper reference $allowed times (expected 1); re-review the allowlist"
      return 1
    fi
  fi
  if [ "$((total - allowed))" -ne 0 ]; then
    STEP_ERROR="$((total - allowed)) helper reference(s) beyond the single allowlisted one"
    return 1
  fi
  return 0
}

# Rename a staged pack dir into place. An existing dir is moved aside (never
# deleted) and reported STALE.
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
  record "STALE pack $aside (left in place)"
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

install_cli() {
  local entry="$1" name version url sha256 member license_member stamp dl x tmp lic_dir lic_file bin_sha
  name="$(jf "$entry" '.name')"
  version="$(jf "$entry" '.version')"
  url="$(jf "$entry" '.url')"
  sha256="$(jf "$entry" '.sha256')"
  member="$(jf "$entry" '.member')"
  license_member="$(jf "$entry" '.licenseMember')"
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
    { [ "$IS_ROOT" -eq 0 ] || chown root:root "$tmp"; } &&
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

# The stamp's hash covers the manifest entry, the overlay blob ids at HEAD and
# this script; the `source` line records provenance and is not compared, so a
# new unrelated commit does not reinstall (and rename aside) an unchanged pack.
pack_stamp_hash() {
  local entry="$1" ov from
  {
    printf '%s\n' "$entry"
    while IFS= read -r -u 6 ov; do
      from="$(jf "$ov" '.from')"
      git_repo rev-parse --verify --quiet "$HEAD_SHA:$from" || printf 'absent %s\n' "$from"
    done 6< <(jl "$entry" '.overlays // [] | .[]')
    printf '%s\n' "$SCRIPT_HASH"
  } | sha256sum | awk '{print $1}'
}

install_pack() {
  local entry="$1" id repo sha target expected g stage sub src dest git_id ov from md
  local -a excludes
  id="$(jf "$entry" '.id')"
  repo="$(jf "$entry" '.repo')"
  sha="$(jf "$entry" '.sha')"
  target="$ROOT/$id@$sha"
  expected="$(pack_stamp_hash "$entry")"

  if [ -f "$target/.stamp" ] && [ "$(head -n 1 "$target/.stamp")" = "stamp $expected" ]; then
    record "SKIPPED pack $id $sha (already at pin)"
    return 0
  fi

  if [ "$repo" = "self" ]; then
    if ! git_repo cat-file -e "$sha^{commit}" 2>/dev/null; then
      record "FAIL pack $id: pinned sha not in $AUTOMATA_REPO history — fetch origin as the automata user first"
      return 1
    fi
    g=git_repo
  else
    FETCH_REPO="$WORK/fetch-$id"
    log "fetching $id @ $sha"
    if ! git init -q "$FETCH_REPO" ||
      ! git_fetch -c protocol.version=2 fetch -q --depth 1 "$repo" "$sha"; then
      record "FAIL pack $id: fetch of $sha from $repo failed"
      return 1
    fi
    if [ "$(git_fetch rev-parse FETCH_HEAD)" != "$sha" ]; then
      record "FAIL pack $id: fetched commit is not the pinned sha"
      return 1
    fi
    g=git_fetch
  fi

  if ! stage="$(mktemp -d "$ROOT/.staging.$id.XXXXXX")"; then
    record "FAIL pack $id: cannot create a staging dir under $ROOT"
    return 1
  fi
  while IFS= read -r -u 6 sub; do
    src="$(jf "$sub" '.src')"
    dest="$(jf "$sub" '.dest')"
    git_id="$(jf "$sub" '.gitId')"
    excludes=()
    while IFS= read -r ex; do
      excludes+=("$ex")
    done < <(jf "$sub" '.exclude // [] | .[]')
    if ! extract_object "$g" "$sha" "$src" "$git_id" "$stage/$dest" ${excludes[@]+"${excludes[@]}"}; then
      rm -rf "$stage"
      record "FAIL pack $id: $STEP_ERROR"
      return 1
    fi
  done 6< <(jl "$entry" '.subpaths[]')

  while IFS= read -r -u 6 ov; do
    from="$(jf "$ov" '.from')"
    dest="$(jf "$ov" '.dest')"
    mkdir -p "$(dirname "$stage/$dest")"
    if ! git_repo cat-file blob "$HEAD_SHA:$from" >"$stage/$dest" 2>/dev/null; then
      rm -rf "$stage"
      record "FAIL pack $id: overlay $from is absent at $HEAD_SHA"
      return 1
    fi
  done 6< <(jl "$entry" '.overlays // [] | .[]')

  while IFS= read -r -d '' md; do
    if ! strip_frontmatter "$md"; then
      rm -rf "$stage"
      record "FAIL pack $id: frontmatter strip failed"
      return 1
    fi
  done < <(find "$stage" -type f -name '*.md' -print0)

  if ! verify_staging "$stage"; then
    rm -rf "$stage"
    record "FAIL pack $id: $STEP_ERROR"
    return 1
  fi

  if ! { printf 'stamp %s\nsource %s\n' "$expected" "$HEAD_SHA" >"$stage/.stamp" &&
    find "$stage" -type d -exec chmod 0755 {} + &&
    find "$stage" -type f -exec chmod 0644 {} + &&
    { [ "$IS_ROOT" -eq 0 ] || chown -R root:root "$stage"; }; }; then
    rm -rf "$stage"
    record "FAIL pack $id: could not set modes or ownership"
    return 1
  fi
  if ! publish_dir "$stage" "$target"; then
    rm -rf "$stage"
    record "FAIL pack $id: could not publish $target"
    return 1
  fi
  record "INSTALLED pack $id $sha"
}

list_stale() {
  local dir base
  for dir in "$ROOT"/*@*; do
    [ -d "$dir" ] || continue
    base="$(basename "$dir")"
    if ! jq -e --arg d "$base" 'any(.packs[]; (.id + "@" + .sha) == $d)' "$MANIFEST" >/dev/null; then
      record "STALE pack $dir (left in place)"
    fi
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

# shellcheck disable=SC2016 # constant command strings: values expand in the agent shell from env
verify_as_agent() {
  local entry name args found id sha target root_count agent_count
  VERIFY_HOME="$(mktemp -d /tmp/automata-batteries-verify.XXXXXX)"
  chown "$AGENT_USER" "$VERIFY_HOME"
  chmod 700 "$VERIFY_HOME"

  while IFS= read -r -u 3 entry; do
    name="$(jf "$entry" '.name')"
    args="$(jf "$entry" '.versionArgs')"
    # stdout only: a noisy login profile must not break the compare.
    found="$(as_agent 'command -v -- "$BATTERIES_CHECK_NAME"' "$name" "" "" 2>/dev/null)" || found=""
    if [ "$found" != "$BIN_DIR/$name" ]; then
      record "FAIL verify $name: agent resolves '${found:-nothing}', expected $BIN_DIR/$name"
      continue
    fi
    # versionArgs is shape-checked to a single word, so it is left unquoted.
    if as_agent '"$BATTERIES_CHECK_NAME" $BATTERIES_CHECK_ARGS >/dev/null 2>&1' "$name" "$args" "" 2>/dev/null; then
      record "VERIFIED agent cli $name"
    else
      record "FAIL verify $name: '$name $args' failed as $AGENT_USER"
    fi
  done 3< <(jq -c '.clis[]' "$MANIFEST")

  while IFS= read -r -u 3 entry; do
    id="$(jf "$entry" '.id')"
    sha="$(jf "$entry" '.sha')"
    target="$ROOT/$id@$sha"
    if [ ! -d "$target" ]; then
      record "FAIL verify $id: $target is missing"
      continue
    fi
    root_count="$(find "$target" -type f | wc -l | tr -d ' ')"
    agent_count="$(as_agent 'find "$BATTERIES_CHECK_PATH" -type f -exec test -r {} \; -print | wc -l' "" "" "$target" 2>/dev/null | tr -d ' ')" || agent_count=""
    if [ "$agent_count" != "$root_count" ]; then
      record "FAIL verify $id: agent can read ${agent_count:-0} of $root_count files"
      continue
    fi
    if ! as_agent 'test ! -w "$BATTERIES_CHECK_PATH"' "" "" "$target" 2>/dev/null; then
      record "FAIL verify $id: $target is writable by $AGENT_USER"
      continue
    fi
    record "VERIFIED agent pack $id ($root_count files readable, dir read-only)"
  done 3< <(jq -c '.packs[]' "$MANIFEST")
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
  local entry
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
  SCRIPT_HASH="$(sha256_of "$SCRIPT_SELF")"

  preflight || finish
  mkdir -p "$ROOT"

  invalidate_manifest_hash

  while IFS= read -r -u 3 entry; do
    install_cli "$entry" || true
  done 3< <(jq -c '.clis[]' "$MANIFEST")

  while IFS= read -r -u 3 entry; do
    install_pack "$entry" || true
  done 3< <(jq -c '.packs[]' "$MANIFEST")

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
