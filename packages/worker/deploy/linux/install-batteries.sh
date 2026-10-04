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
# Dry run (developers, non-root): PREFIX=<absolute tmp dir> SKIP_SUDO_VERIFY=1,
# optionally BATTERIES_MANIFEST=<absolute path> to test a modified manifest.
# Both knobs are refused for root and for a PREFIX that resolves to /usr/local.
# Commit first: the manifest and overlays are read from HEAD.

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
# Frontmatter keys that GRANT the invoking turn something (see header).
GRANT_KEYS_RE='^(allowed-tools|hooks|permissionMode|mcpServers):'
# Same list as FORBIDDEN_NAMES in packages/worker/src/agent-run/batteries-manifest.ts.
FORBIDDEN_NAMES=(hooks bin .claude-plugin settings.json settings.local.json .mcp.json plugin.json)

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

# DRY_RUN=0 implies root: every non-root path below exits 2.
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

# shellcheck disable=SC2329 # invoked by `trap on_exit EXIT` in main
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
    FETCH_REPO="$WORK/fetch-$id"
    log "fetching $id @ $sha"
    # A partial fetch of the one pinned commit: trees now, each blob on its
    # first cat-file. The named remote is where those lazy blob fetches go.
    if ! { git init -q "$FETCH_REPO" &&
      git_fetch remote add origin "$repo" &&
      git_fetch -c protocol.version=2 fetch -q --filter=blob:none --depth 1 origin "$sha"; }; then
      STEP_ERROR="fetch of $sha from $repo failed"
      return 1
    fi
    if [ "$(git_fetch rev-parse FETCH_HEAD)" != "$sha" ]; then
      STEP_ERROR="fetched commit is not the pinned sha"
      return 1
    fi
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
  local i id repo sha name version url sha256 member license_member
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
  mkdir -p "$ROOT"

  invalidate_manifest_hash

  while IFS=$'\t' read -r -u 3 name version url sha256 member license_member _; do
    [ -n "$name" ] || continue
    install_cli "$name" "$version" "$url" "$sha256" "$member" "$license_member" || true
  done 3<<<"$CLI_ROWS"

  while IFS=$'\t' read -r -u 3 i id repo sha; do
    install_pack "$i" "$id" "$repo" "$sha" || true
  done 3<<<"$PACK_ROWS"

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
