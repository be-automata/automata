#!/bin/bash
set -euo pipefail
#
# Phase 8 acceptance: the audit self-healing lane (audit findings become issues).
#
#   self-heal-acceptance.sh local
#       Developer gates, run from a checkout (bash 3.2 compatible, no root):
#       the targeted shared, www and worker self-heal suites and the www
#       type check.
#
#   self-heal-acceptance.sh box --since <journalctl time>
#       Operator evidence on the execution box, as root, Linux only: every
#       lane=self-heal-audit run in the worker journal posted its
#       "self-heal checks:" line BEFORE its daemon spawned, and no journal
#       line contains the check token header or the token field name.
#
#   self-heal-acceptance.sh github --repo <owner/name> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login>
#       (--bot matches the login with or without GitHub's "[bot]" suffix)
#       From the operator's laptop (gh + jq, GETs only): every
#       automata:finding issue is bot-authored, there is one issue per
#       fingerprint marker, the marker is on line 1, no body carries a
#       closing keyword or an @mention, no finding issue carries a bug or
#       enhancement label, no issue carries the retired needs-human label,
#       and no comment marker appears twice.
#
# Every mode is READ-ONLY: no restart, no install, no repository write, no
# schema change, no GitHub write. Its only write is a mktemp dir removed by
# the EXIT trap. It never names a customer: pass --repo.
#
# Output: `EVIDENCE <what>: <value>` and `CHECK <name>: PASS|FAIL <why>`
# lines; the last line is `ACCEPTANCE: PASS` (exit 0) or
# `ACCEPTANCE: FAIL (<n>)` (exit 1). Misuse exits 2 with usage on stderr.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -P "$SCRIPT_DIR/../../../.." && pwd -P)"

REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
BOT_RE='^[A-Za-z0-9-]+(\[bot\])?$'
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

FAILURES=0
WORK=""

usage() {
  cat >&2 <<'EOF'
usage: self-heal-acceptance.sh local
       self-heal-acceptance.sh box --since <journalctl time>
       self-heal-acceptance.sh github --repo <owner/name> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login>
EOF
  exit 2
}

die() {
  echo "self-heal-acceptance: $*" >&2
  exit 2
}

evidence() {
  echo "EVIDENCE $1: $2"
}

check() {
  if [ "$2" = "PASS" ]; then
    echo "CHECK $1: PASS $3"
  else
    echo "CHECK $1: FAIL $3"
    FAILURES=$((FAILURES + 1))
  fi
}

finish() {
  if [ "$FAILURES" -eq 0 ]; then
    echo "ACCEPTANCE: PASS"
    exit 0
  fi
  echo "ACCEPTANCE: FAIL ($FAILURES)"
  exit 1
}

cleanup() {
  if [ -n "$WORK" ]; then
    rm -rf -- "$WORK"
  fi
}

no_control_chars() {
  case "$2" in
    *[[:cntrl:]]*) die "$1 must not contain control characters" ;;
  esac
}

# run_awk <awk args…>: the ONE way this script runs awk. AWK may name a
# multi-word command (AWK="busybox awk"), so it is split into an argv once.
# Default: awk (mawk on Ubuntu, BWK on macOS; every program here is POSIX awk).
run_awk() {
  local -a awk_cmd
  read -r -a awk_cmd <<<"${AWK:-awk}"
  "${awk_cmd[@]}" "$@"
}

# ---------------------------------------------------------------------------
# local mode
# ---------------------------------------------------------------------------

# gate <name> <command…>: one CHECK line; the log tail on failure.
gate() {
  local name="$1" log status
  shift
  log="$WORK/gate-$(printf '%s' "$name" | tr -c 'A-Za-z0-9' '_').log"
  status=0
  (cd "$REPO_DIR" && "$@") >"$log" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    check "local $name" PASS "(exit 0)"
  else
    check "local $name" FAIL "(exit $status)"
    tail -n 30 "$log" >&2 || true
  fi
}

local_mode() {
  [ "$#" -eq 0 ] || usage
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/self-heal-acceptance.XXXXXX")"

  gate "shared self-heal suites" \
    pnpm --filter @terragon/shared exec vitest run --no-file-parallelism \
    src/model/self-heal src/model/audit-findings src/model/schema-gate src/self-heal
  gate "www self-heal suites" \
    pnpm --filter @terragon/www exec vitest run --no-file-parallelism \
    src/server-lib/audit src/app/api/self-heal src/components/settings/self-heal
  gate "worker self-heal suites" \
    pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
    src/agent-run/self-heal
  gate "tsc www" env NODE_OPTIONS=--max-old-space-size=12288 \
    pnpm --filter @terragon/www exec tsc --noEmit

  finish
}

# ---------------------------------------------------------------------------
# box mode
# ---------------------------------------------------------------------------

# analyse_box_journal <journal file>
# The journal comes from `journalctl -o short-unix`. Lines are grouped per
# `[agent-run <threadId>` (a trace suffix is dropped). One TSV row per thread:
# thread, lane, line number of the first "self-heal checks:" line (0 = none),
# line number of the first "daemon spawned:" line (0 = none).
analyse_box_journal() {
  local journal="$1"
  local tid lane checks spawn
  local runs=0 bad="" leaked

  # shellcheck disable=SC2016 # the single-quoted text is an awk program
  while IFS=$'\t' read -r tid lane checks spawn; do
    [ "$lane" = "self-heal-audit" ] || continue
    runs=$((runs + 1))
    if [ "$checks" -eq 0 ]; then
      bad="$bad $tid(no-checks-line)"
    elif [ "$spawn" -ne 0 ] && [ "$checks" -gt "$spawn" ]; then
      bad="$bad $tid(checks-after-spawn)"
    fi
  done < <(run_awk '
    {
      if (!match($0, /\[agent-run [^] ]+/)) next
      tid = substr($0, RSTART + 11, RLENGTH - 11)
      if (!(tid in seen)) { seen[tid] = 1; order[++n] = tid }
      if (index($0, "] run start: lane=") > 0) {
        l = $0; sub(/.*\] run start: lane=/, "", l); sub(/ .*/, "", l); lane[tid] = l
      }
      if (index($0, "] self-heal checks:") > 0 && !(tid in checks)) checks[tid] = NR
      if (index($0, "] daemon spawned:") > 0 && !(tid in spawn)) spawn[tid] = NR
    }
    END {
      for (i = 1; i <= n; i++) {
        t = order[i]
        printf "%s\t%s\t%d\t%d\n", t, (t in lane ? lane[t] : "-"), (t in checks ? checks[t] : 0), (t in spawn ? spawn[t] : 0)
      }
    }
  ' "$journal")

  evidence "self-heal-audit runs in the journal" "$runs"
  if [ "$runs" -eq 0 ]; then
    check "box audit run present" FAIL "(no lane=self-heal-audit run since --since)"
  else
    check "box audit run present" PASS "($runs run(s))"
    if [ -z "$bad" ]; then
      check "box checks before daemon spawn" PASS "(every audit run posted self-heal checks first)"
    else
      check "box checks before daemon spawn" FAIL "(violations:$bad)"
    fi
  fi

  leaked="$(grep -c -i -e 'x-self-heal-check-token' -e 'checkToken' "$journal" || true)"
  if [ "$leaked" = "0" ]; then
    check "box no check token in journal" PASS "(0 lines)"
  else
    check "box no check token in journal" FAIL "($leaked journal lines carry the check token header or field)"
  fi
}

box_mode() {
  local since=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --since)
        [ "$#" -ge 2 ] || die "$1 needs a value"
        since="$2"
        shift 2
        ;;
      *) usage ;;
    esac
  done
  [ -n "$since" ] || die "box mode needs --since <time, e.g. \"2026-10-04 02:00 UTC\">"
  no_control_chars --since "$since"
  [ "$(id -u)" = "0" ] || die "box mode must run as root"
  [ "$(uname -s)" = "Linux" ] || die "box mode runs on the Linux execution box only"

  WORK="$(mktemp -d /tmp/self-heal-acceptance.XXXXXX)"
  if journalctl -u automata-worker.service --since "$since" --no-pager -o short-unix >"$WORK/journal.txt" 2>"$WORK/journal.err"; then
    evidence "journal lines since $since" "$(wc -l <"$WORK/journal.txt" | tr -d ' ')"
    analyse_box_journal "$WORK/journal.txt"
  else
    check "box audit run present" FAIL "(journalctl -u automata-worker.service failed: $(head -n 1 "$WORK/journal.err"))"
  fi
  finish
}

# ---------------------------------------------------------------------------
# github mode
# ---------------------------------------------------------------------------

# analyse_github <finding issues.json> <needs-human issues.json> <comments.json> <bot login>
# Each file is one JSON array. Pull requests are ignored: the issues endpoint
# returns them too.
analyse_github() {
  local issues="$1" human="$2" comments="$3" bot="$4"
  local base n_issues n_comments bad_issue_auth bad_comment_auth dup_fp no_line1
  local bad_text bad_labels human_n dup_comment

  base="${bot%\[bot\]}"
  n_issues="$(jq '[.[] | select(has("pull_request") | not)] | length' "$issues")"
  n_comments="$(jq '[.[] | select((.body // "") | startswith("<!-- automata-finding-comment:v1"))] | length' "$comments")"
  evidence "automata:finding issues" "$n_issues"
  evidence "marker comments" "$n_comments"

  bad_issue_auth="$(jq --arg b "$base" \
    '[.[] | select(has("pull_request") | not) | select(.user.login != $b and .user.login != ($b + "[bot]"))] | length' "$issues")"
  bad_comment_auth="$(jq --arg b "$base" \
    '[.[] | select((.body // "") | startswith("<!-- automata-finding-comment:v1")) | select(.user.login != $b and .user.login != ($b + "[bot]"))] | length' "$comments")"
  if [ "$bad_issue_auth" = "0" ] && [ "$bad_comment_auth" = "0" ]; then
    check "github bot authorship" PASS "(all finding issues and marker comments are bot-authored)"
  else
    check "github bot authorship" FAIL "($bad_issue_auth issues and $bad_comment_auth marker comments not authored by $bot)"
  fi

  dup_fp="$(jq '[.[] | select(has("pull_request") | not) | (.body // "") | [match("<!-- automata-finding:v1 fp=([A-Za-z0-9_-]+) -->"; "g").captures[0].string] | unique[]] | group_by(.) | map(select(length > 1)) | length' "$issues")"
  if [ "$dup_fp" = "0" ]; then
    check "github one issue per fingerprint" PASS "(no fingerprint marker on two issues)"
  else
    check "github one issue per fingerprint" FAIL "($dup_fp fingerprints appear on more than one issue)"
  fi

  no_line1="$(jq '[.[] | select(has("pull_request") | not) | select(((.body // "") | split("\n")[0] | rtrimstr("\r") | test("^<!-- automata-finding:v1 fp=[A-Za-z0-9_-]+ -->")) | not)] | length' "$issues")"
  if [ "$no_line1" = "0" ]; then
    check "github marker on line 1" PASS "(every finding issue)"
  else
    check "github marker on line 1" FAIL "($no_line1 issues without the marker on line 1)"
  fi

  # Closing keywords and mentions, on finding issue bodies and marker comment
  # bodies. Code spans are removed first, so `@types/node` is not a mention.
  bad_text="$(jq -n --slurpfile i "$issues" --slurpfile c "$comments" '
    def closing: test("\\b(close[sd]?|fix(es|ed)?|resolve[sd]?)\\s*:?\\s+((#|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#)[0-9]+|https?://github\\.com/\\S+/issues/[0-9]+)"; "i");
    def mention: gsub("`[^`]*`"; "") | test("(^|[^A-Za-z0-9_/@])@[A-Za-z0-9]");
    ([$i[0][] | select(has("pull_request") | not) | (.body // "")] +
     [$c[0][] | (.body // "") | select(startswith("<!-- automata-finding-comment:v1"))])
    | map(select(closing or mention)) | length')"
  if [ "$bad_text" = "0" ]; then
    check "github no closing keyword or mention" PASS "(none)"
  else
    check "github no closing keyword or mention" FAIL "($bad_text bodies carry a closing keyword or an @mention)"
  fi

  bad_labels="$(jq '[.[] | select(has("pull_request") | not) | select([.labels[]?.name] | any(. == "bug" or . == "enhancement" or . == "automata:needs-human"))] | length' "$issues")"
  human_n="$(jq '[.[] | select(has("pull_request") | not)] | length' "$human")"
  if [ "$bad_labels" = "0" ] && [ "$human_n" = "0" ]; then
    check "github label hygiene" PASS "(no bug, enhancement or automata:needs-human label)"
  else
    check "github label hygiene" FAIL "($bad_labels finding issues with a forbidden label, $human_n issues with automata:needs-human)"
  fi

  dup_comment="$(jq '[.[] | (.body // "") | select(startswith("<!-- automata-finding-comment:v1")) | split("\n")[0]] | group_by(.) | map(select(length > 1)) | length' "$comments")"
  if [ "$dup_comment" = "0" ]; then
    check "github no duplicate comment marker" PASS "(each marker appears once)"
  else
    check "github no duplicate comment marker" FAIL "($dup_comment comment markers appear more than once)"
  fi
}

github_mode() {
  local repo="" since="" bot="" status
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo | --since | --bot)
        [ "$#" -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --repo) repo="$2" ;;
          --since) since="$2" ;;
          --bot) bot="$2" ;;
        esac
        shift 2
        ;;
      *) usage ;;
    esac
  done
  [[ "$repo" =~ $REPO_RE ]] || die "--repo must match $REPO_RE"
  no_control_chars --since "$since"
  [[ "$since" =~ $ISO_RE ]] || die "--since must be YYYY-MM-DDTHH:MM:SSZ (UTC)"
  [[ "$bot" =~ $BOT_RE ]] || die "--bot must match $BOT_RE"
  command -v gh >/dev/null 2>&1 || die "github mode needs gh"
  command -v jq >/dev/null 2>&1 || die "github mode needs jq"
  jq -n --arg s "$since" '$s | fromdateiso8601' >/dev/null || die "--since did not parse"

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/self-heal-acceptance.XXXXXX")"
  status=0
  {
    gh api --paginate "repos/$repo/issues?labels=automata%3Afinding&state=all&per_page=100" >"$WORK/issues.pages" &&
      gh api --paginate "repos/$repo/issues?labels=automata%3Aneeds-human&state=all&per_page=100" >"$WORK/human.pages" &&
      gh api --paginate "repos/$repo/issues/comments?since=$since&per_page=100" >"$WORK/comments.pages"
  } 2>"$WORK/gh.err" || status=$?
  if [ "$status" -ne 0 ]; then
    check "github fetch" FAIL "(a GitHub GET exited $status: $(head -n 1 "$WORK/gh.err"))"
    finish
  fi
  jq -s 'add // []' "$WORK/issues.pages" >"$WORK/issues.json"
  jq -s 'add // []' "$WORK/human.pages" >"$WORK/human.json"
  jq -s 'add // []' "$WORK/comments.pages" >"$WORK/comments.json"

  analyse_github "$WORK/issues.json" "$WORK/human.json" "$WORK/comments.json" "$bot"
  finish
}

main() {
  [ "$#" -ge 1 ] || usage
  local mode="$1"
  shift
  trap cleanup EXIT
  case "$mode" in
    local) local_mode "$@" ;;
    box) box_mode "$@" ;;
    github) github_mode "$@" ;;
    *) usage ;;
  esac
}

# Sourcing (the analyser tests) defines the functions without running.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
