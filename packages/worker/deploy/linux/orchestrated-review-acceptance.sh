#!/bin/bash
set -euo pipefail
#
# Phase 6 acceptance: the orchestrated review canary (ROADMAP Phase 6).
#
#   orchestrated-review-acceptance.sh local
#       Developer gates, run from a checkout (bash 3.2 compatible, no root):
#       the www src/server-lib suite (review directory, automations, the
#       supersede recheck), skill-contract-drift.test.ts unchanged vs
#       origin/main, www tsc, and this script's own worker tests.
#
#   orchestrated-review-acceptance.sh box --since <journalctl time> \
#       --repo <owner/name> --pr <n> --expect orchestrated|classic
#       Operator evidence on the execution box, as root, Linux only:
#       manifest.sha256 valid, the gsd-reviewers agent file installed as a
#       regular root-owned file, and the worker journal since --since holds
#       exactly ONE lane=review run for --repo/--pr whose batteries and
#       review-agent lines match --expect, within the 30-minute budget. The
#       transcript half lives in the control plane, so it is printed as
#       EVIDENCE manual lines for the operator to judge.
#
#   orchestrated-review-acceptance.sh github --repo <owner/name> --pr <n> \
#       --head-sha <40 hex> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login>
#       From the operator's laptop (gh + jq, GETs only): the bot posted exactly
#       ONE review on --head-sha, no bot conversation comment and no stray bot
#       review comment since --since, the PR head is still --head-sha (the run
#       pushed nothing), and the review landed within the budget.
#
# Box mode is READ-ONLY and safe with runs in flight: no restart, no install,
# no repository write, no schema change; its only write is a mktemp dir
# removed by the EXIT trap. It never names a customer: pass --repo.
#
# Why git is hardened: /opt/automata-platform is writable by the worker
# account, so as root its hooks, fsmonitor and config must never execute.
# Every git call goes through git_ro (safe.directory, no fsmonitor, hooks to
# /dev/null, no pager, no system/global config, GIT_* overrides cleared).
#
# Output: `EVIDENCE <what>: <value>` and `CHECK <name>: PASS|FAIL <why>`
# lines; the last line is `ACCEPTANCE: PASS` (exit 0) or
# `ACCEPTANCE: FAIL (<n>)` (exit 1). Misuse exits 2 with usage on stderr.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -P "$SCRIPT_DIR/../../../.." && pwd -P)"

BATTERIES_ROOT=/usr/local/lib/automata-batteries
BOX_CHECKOUT=/opt/automata-platform
WORKER_UNIT=automata-worker.service
BUDGET_SECONDS=1800
REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
PR_RE='^[0-9]+$'
SHA_RE='^[0-9a-f]{40}$'
BOT_RE='^[A-Za-z0-9-]+(\[bot\])?$'
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

FAILURES=0
GIT_CHECKOUT=""
WORK=""

usage() {
  cat >&2 <<'EOF'
usage: orchestrated-review-acceptance.sh local
       orchestrated-review-acceptance.sh box --since <journalctl time> --repo <owner/name> --pr <n> --expect orchestrated|classic
       orchestrated-review-acceptance.sh github --repo <owner/name> --pr <n> --head-sha <40 hex> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login>
EOF
  exit 2
}

die() {
  echo "orchestrated-review-acceptance: $*" >&2
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

# The ONE way this script runs git. The subshell scopes the env hardening.
git_ro() {
  (
    unset GIT_DIR GIT_WORK_TREE GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT
    export GIT_CONFIG_NOSYSTEM=1
    export GIT_CONFIG_GLOBAL=/dev/null
    exec git -c safe.directory="$GIT_CHECKOUT" -c core.fsmonitor=false \
      -c core.hooksPath=/dev/null --no-pager -C "$GIT_CHECKOUT" "$@"
  )
}

no_control_chars() {
  case "$2" in
    *[[:cntrl:]]*) die "$1 must not contain control characters" ;;
  esac
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
  GIT_CHECKOUT="$REPO_DIR"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/orchestrated-review-acceptance.XXXXXX")"
  evidence "checkout" "$(git_ro rev-parse HEAD)"

  gate "www server-lib suite (review, automations, supersede-recheck)" \
    pnpm --filter @terragon/www exec vitest run --no-file-parallelism src/server-lib
  gate "skill-contract-drift.test.ts unchanged vs origin/main" \
    git_ro diff --exit-code origin/main -- apps/www/src/server-lib/review/skill-contract-drift.test.ts
  gate "tsc www" env NODE_OPTIONS=--max-old-space-size=12288 \
    pnpm --filter @terragon/www exec tsc --noEmit
  gate "worker acceptance-script tests" \
    pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
    src/agent-run/orchestrated-review-acceptance.test.ts

  finish
}

# ---------------------------------------------------------------------------
# box mode
# ---------------------------------------------------------------------------

# analyse_review_journal <journal file> <owner/name> <pr> <expect> <manifest 12-hex prefix>
# The journal comes from `journalctl -o short-unix`: every line starts with
# its epoch seconds. Lines are grouped per `[agent-run <threadId>` (a trace
# suffix is dropped); one TSV row per thread is judged in bash. A redelivered
# run keeps its threadId, so one push = one distinct thread.
analyse_review_journal() {
  local journal="$1" repo="$2" pr="$3" expect="$4" prefix="$5"
  local tid lane run_pr run_repo span batt agent bounds
  local count=0 tids="" sel_tid="" sel_span="" sel_batt="" sel_agent="" sel_bounds=""
  local packs manifest reason

  # shellcheck disable=SC2016 # the single-quoted text is an awk program
  while IFS=$'\t' read -r tid lane run_pr run_repo span batt agent bounds; do
    [ "$lane" = "review" ] || continue
    [ "$run_repo" = "$repo" ] || continue
    [ "$run_pr" = "$pr" ] || continue
    count=$((count + 1))
    tids="$tids $tid"
    sel_tid="$tid"
    sel_span="$span"
    sel_batt="$batt"
    sel_agent="$agent"
    sel_bounds="$bounds"
  done < <("${AWK:-awk}" '
    {
      if (!match($0, /\[agent-run [^] ]+/)) next
      tid = substr($0, RSTART + 11, RLENGTH - 11)
      ts = $1 + 0
      if (!(tid in seen)) { seen[tid] = 1; order[++n] = tid; first[tid] = ts }
      last[tid] = ts
      if (index($0, "] run start: lane=") > 0) {
        l = $0; sub(/.*\] run start: lane=/, "", l); sub(/ .*/, "", l); lane[tid] = l
        p = "-"
        if (match($0, / pr=[0-9]+/)) p = substr($0, RSTART + 4, RLENGTH - 4)
        prn[tid] = p
        r = "-"
        if (match($0, / repo=[^ ]+/)) r = substr($0, RSTART + 6, RLENGTH - 6)
        repo[tid] = r
      }
      if (index($0, "] batteries: ") > 0) {
        b = $0; sub(/.*\] batteries: /, "batteries: ", b); batt[tid] = b
      }
      if (index($0, "] review agent: orchestrated") > 0) {
        a = $0; sub(/.*\] review agent: /, "review agent: ", a); agent[tid] = a
      }
      if (index($0, "] review agent: bounds-rejected") > 0) bounds[tid] = "1"
    }
    END {
      for (i = 1; i <= n; i++) {
        t = order[i]
        s = int(last[t] - first[t] + 0.5)
        printf "%s\t%s\t%s\t%s\t%d\t%s\t%s\t%s\n", t, (t in lane ? lane[t] : "-"), (t in prn ? prn[t] : "-"), (t in repo ? repo[t] : "-"), s, (t in batt ? batt[t] : "-"), (t in agent ? agent[t] : "-"), (t in bounds ? "1" : "0")
      }
    }
  ' "$journal")

  if [ "$count" -eq 0 ]; then
    check "SC2 one review run per push" FAIL "(no lane=review run for $repo pr=$pr since --since)"
    finish_review_checks_missing "$expect"
    return 0
  fi
  if [ "$count" -eq 1 ]; then
    check "SC2 one review run per push" PASS "(thread $sel_tid)"
  else
    check "SC2 one review run per push" FAIL "($count review runs:$tids)"
  fi

  evidence "review thread" "$sel_tid"
  evidence "review batteries line" "$sel_batt"
  evidence "review agent line" "$sel_agent"
  evidence "review journal span seconds" "$sel_span"

  if [ "$expect" = "orchestrated" ]; then
    case "$sel_batt" in
      "batteries: mode=orchestrated packs="*)
        packs="${sel_batt#batteries: mode=orchestrated packs=}"
        packs="${packs%% *}"
        manifest="${sel_batt##* manifest=}"
        if [ -z "$packs" ] || [ "$packs" = "none" ]; then
          check "SC2 orchestrated batteries seeded" FAIL "(packs=${packs:-empty})"
        elif [ "$manifest" != "$prefix" ]; then
          check "SC2 orchestrated batteries seeded" FAIL "(manifest=$manifest, installed manifest.sha256 starts $prefix)"
        else
          check "SC2 orchestrated batteries seeded" PASS "(packs=$packs manifest=$manifest)"
        fi
        ;;
      "batteries: unavailable mode=orchestrated reason="*)
        reason="${sel_batt#batteries: unavailable mode=orchestrated reason=}"
        check "SC2 orchestrated batteries seeded" FAIL "(unavailable: reason=$reason)"
        ;;
      *)
        check "SC2 orchestrated batteries seeded" FAIL "(batteries line: $sel_batt)"
        ;;
    esac
    if [ "$sel_bounds" = "1" ]; then
      check "SC2 orchestrated wire stamped" FAIL "(review agent: bounds-rejected → classic)"
    elif [ "$sel_agent" = "-" ]; then
      check "SC2 orchestrated wire stamped" FAIL "(no 'review agent: orchestrated → daemon' line)"
    else
      check "SC2 orchestrated wire stamped" PASS "($sel_agent)"
    fi
  else
    if [ "$sel_batt" = "batteries: mode=classic" ] && [ "$sel_agent" = "-" ]; then
      check "SC3 classic run" PASS "(batteries: mode=classic, no orchestrated wire line)"
    else
      check "SC3 classic run" FAIL "(batteries line: $sel_batt; review agent line: $sel_agent)"
    fi
  fi

  if [ "$sel_span" -le "$BUDGET_SECONDS" ]; then
    check "SC2 latency within budget" PASS "(${sel_span}s ≤ ${BUDGET_SECONDS}s)"
  else
    check "SC2 latency within budget" FAIL "(${sel_span}s > ${BUDGET_SECONDS}s)"
  fi
}

# With no matching run, every per-run CHECK fails explicitly.
finish_review_checks_missing() {
  if [ "$1" = "orchestrated" ]; then
    check "SC2 orchestrated batteries seeded" FAIL "(no matching run)"
    check "SC2 orchestrated wire stamped" FAIL "(no matching run)"
  else
    check "SC3 classic run" FAIL "(no matching run)"
  fi
  check "SC2 latency within budget" FAIL "(no matching run)"
}

print_manual_checklist() {
  if [ "$1" = "orchestrated" ]; then
    echo "EVIDENCE manual transcript: init tools include Agent/Task and Skill"
    echo "EVIDENCE manual transcript: init skills include gstack-review and security-audit"
    echo "EVIDENCE manual transcript: init agents include gsd-code-reviewer and gsd-security-auditor (if missing: symlinked agent files did not load → execute 06-04 Task 2)"
    echo "EVIDENCE manual transcript: at least one assistant line with a non-null parent_tool_use_id"
    echo "EVIDENCE manual transcript: at least one Skill tool_use or a Bash call to shellcheck/actionlint/gitleaks"
    echo "EVIDENCE manual transcript: the lead's last message ends with a block opened by the json review-intent tag"
    echo 'EVIDENCE manual thread: the first user message contains "## Orchestrated review — you are the lead reviewer"'
    echo 'EVIDENCE manual thread: sourceMetadata has reviewPromptMode "orchestrated"'
    echo "EVIDENCE manual daemon log: 'holding result until exit' for the run when a background sub-agent ran"
  else
    echo 'EVIDENCE manual thread: the first user message does NOT contain "## Orchestrated review — you are the lead reviewer"'
    echo "EVIDENCE manual thread: sourceMetadata has no reviewPromptMode"
    echo "EVIDENCE manual daemon log: the spawned argv equals REVIEW_POLICY_JOINED (no Agent, no --max-turns)"
  fi
}

box_mode() {
  local since="" repo="" pr="" expect="" hash prefix manifest_json gsd_sha agent_path agent_stat
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --since | --repo | --pr | --expect)
        [ "$#" -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --since) since="$2" ;;
          --repo) repo="$2" ;;
          --pr) pr="$2" ;;
          --expect) expect="$2" ;;
        esac
        shift 2
        ;;
      *) usage ;;
    esac
  done
  [ -n "$since" ] || die "box mode needs --since <time, e.g. \"2026-10-04 02:00 UTC\">"
  [ -n "$repo" ] || die "box mode needs --repo <owner/name>"
  [ -n "$pr" ] || die "box mode needs --pr <number>"
  [ -n "$expect" ] || die "box mode needs --expect orchestrated|classic"
  [[ "$repo" =~ $REPO_RE ]] || die "--repo must match $REPO_RE"
  [[ "$pr" =~ $PR_RE ]] || die "--pr must be all digits"
  case "$expect" in
    orchestrated | classic) ;;
    *) die "--expect must be orchestrated or classic" ;;
  esac
  no_control_chars --since "$since"
  [ "$(id -u)" = "0" ] || die "box mode must run as root"
  [ "$(uname -s)" = "Linux" ] || die "box mode runs on the Linux execution box only"

  GIT_CHECKOUT="$BOX_CHECKOUT"
  WORK="$(mktemp -d /tmp/orchestrated-review-acceptance.XXXXXX)"

  hash=""
  if [ -s "$BATTERIES_ROOT/manifest.sha256" ]; then
    # shellcheck disable=SC2016 # the single-quoted text is an awk program
    hash="$("${AWK:-awk}" 'NR == 1 { print $1 }' "$BATTERIES_ROOT/manifest.sha256")"
  fi
  if [ -e "$BATTERIES_ROOT/manifest.sha256.invalid" ]; then
    check "box install manifest" FAIL "(manifest.sha256.invalid present: the last install failed)"
  elif [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    check "box install manifest" PASS "(manifest.sha256 $hash)"
  else
    check "box install manifest" FAIL "(manifest.sha256 missing or not 64-hex)"
  fi
  evidence "manifest.sha256" "${hash:-none}"
  prefix="${hash:0:12}"

  manifest_json="$WORK/batteries.json"
  if git_ro cat-file blob HEAD:packages/worker/deploy/batteries.json >"$manifest_json" 2>/dev/null &&
    jq -e . "$manifest_json" >/dev/null 2>&1; then
    evidence "checkout HEAD" "$(git_ro rev-parse HEAD)"
  else
    printf '{}\n' >"$manifest_json"
  fi
  gsd_sha="$(jq -r '.packs[]? | select(.id == "gsd-reviewers") | .sha' "$manifest_json")"
  agent_path="$BATTERIES_ROOT/gsd-reviewers@$gsd_sha/agents/gsd-code-reviewer.md"
  if [ -z "$gsd_sha" ]; then
    check "box gsd agent file" FAIL "(the checkout manifest has no gsd-reviewers pin)"
  elif [ -L "$agent_path" ] || [ ! -e "$agent_path" ]; then
    check "box gsd agent file" FAIL "($agent_path missing or a symlink)"
  else
    agent_stat="$(stat -c '%F|%U|%a' -- "$agent_path")"
    evidence "gsd agent file" "$agent_path ($agent_stat)"
    case "$agent_stat" in
      "regular file|root|"*[0-7][0145][0145]) check "box gsd agent file" PASS "(regular, root-owned, not group/other-writable)" ;;
      *) check "box gsd agent file" FAIL "($agent_stat)" ;;
    esac
  fi

  if journalctl -u automata-worker.service --since "$since" --no-pager -o short-unix >"$WORK/journal.txt" 2>"$WORK/journal.err"; then
    evidence "journal lines since $since" "$(wc -l <"$WORK/journal.txt" | tr -d ' ')"
    analyse_review_journal "$WORK/journal.txt" "$repo" "$pr" "$expect" "$prefix"
  else
    check "SC2 one review run per push" FAIL "(journalctl -u $WORKER_UNIT failed: $(head -n 1 "$WORK/journal.err"))"
  fi

  print_manual_checklist "$expect"
  finish
}

# ---------------------------------------------------------------------------
# github mode
# ---------------------------------------------------------------------------

# analyse_github <pull.json> <reviews.json> <issue_comments.json>
#   <review_comments.json> <head sha> <since epoch> <bot login>
analyse_github() {
  local pull="$1" reviews="$2" issue_comments="$3" review_comments="$4"
  local head="$5" since="$6" bot="$7"
  local live_head on_head review_id state submitted latency stray_issue stray_review

  live_head="$(jq -r '.head.sha // "-"' "$pull")"
  evidence "PR head" "$live_head"
  if [ "$live_head" = "$head" ]; then
    check "SC2 zero commits from the run" PASS "(head still $head)"
  else
    check "SC2 zero commits from the run" FAIL "(head moved to $live_head)"
  fi

  on_head="$(jq --arg bot "$bot" --arg head "$head" \
    '[.[] | select(.user.login == $bot and .commit_id == $head)] | length' "$reviews")"
  if [ "$on_head" != "1" ]; then
    check "SC2 exactly one review on head" FAIL "($on_head bot reviews on $head)"
    check "SC2 review latency within budget" FAIL "(no single review on head)"
    review_id="-"
  else
    review_id="$(jq -r --arg bot "$bot" --arg head "$head" \
      '[.[] | select(.user.login == $bot and .commit_id == $head)][0].id' "$reviews")"
    state="$(jq -r --arg bot "$bot" --arg head "$head" \
      '[.[] | select(.user.login == $bot and .commit_id == $head)][0].state' "$reviews")"
    submitted="$(jq -r --arg bot "$bot" --arg head "$head" \
      '[.[] | select(.user.login == $bot and .commit_id == $head)][0].submitted_at' "$reviews")"
    latency="$(jq -n --arg at "$submitted" --argjson since "$since" '($at | fromdateiso8601) - $since')"
    evidence "review id" "$review_id"
    evidence "review state" "$state"
    evidence "review submitted_at" "$submitted"
    evidence "review latency seconds" "$latency"
    check "SC2 exactly one review on head" PASS "(review $review_id)"
    if [ "$latency" -ge 0 ] && [ "$latency" -le "$BUDGET_SECONDS" ]; then
      check "SC2 review latency within budget" PASS "(${latency}s ≤ ${BUDGET_SECONDS}s)"
    else
      check "SC2 review latency within budget" FAIL "(${latency}s, budget ${BUDGET_SECONDS}s)"
    fi
  fi

  stray_issue="$(jq --arg bot "$bot" --argjson since "$since" \
    '[.[] | select(.user.login == $bot and (.created_at | fromdateiso8601) >= $since)] | length' "$issue_comments")"
  stray_review="$(jq --arg bot "$bot" --argjson since "$since" --arg rid "$review_id" \
    '[.[] | select(.user.login == $bot and (.created_at | fromdateiso8601) >= $since and ((.pull_request_review_id | tostring) != $rid))] | length' "$review_comments")"
  evidence "bot conversation comments since --since" "$stray_issue"
  evidence "bot review comments outside the one review" "$stray_review"
  if [ "$stray_issue" = "0" ] && [ "$stray_review" = "0" ]; then
    check "SC2 zero bot comments" PASS "(none outside the one review)"
  else
    check "SC2 zero bot comments" FAIL "($stray_issue conversation, $stray_review stray review comments)"
  fi
}

github_mode() {
  local repo="" pr="" head="" since="" bot="" since_epoch status
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo | --pr | --head-sha | --since | --bot)
        [ "$#" -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --repo) repo="$2" ;;
          --pr) pr="$2" ;;
          --head-sha) head="$2" ;;
          --since) since="$2" ;;
          --bot) bot="$2" ;;
        esac
        shift 2
        ;;
      *) usage ;;
    esac
  done
  [[ "$repo" =~ $REPO_RE ]] || die "--repo must match $REPO_RE"
  [[ "$pr" =~ $PR_RE ]] || die "--pr must be all digits"
  no_control_chars --head-sha "$head"
  [[ "$head" =~ $SHA_RE ]] || die "--head-sha must be 40 lowercase hex"
  no_control_chars --since "$since"
  [[ "$since" =~ $ISO_RE ]] || die "--since must be YYYY-MM-DDTHH:MM:SSZ (UTC)"
  [[ "$bot" =~ $BOT_RE ]] || die "--bot must match $BOT_RE"
  command -v gh >/dev/null 2>&1 || die "github mode needs gh"
  command -v jq >/dev/null 2>&1 || die "github mode needs jq"
  since_epoch="$(jq -n --arg s "$since" '$s | fromdateiso8601')" || die "--since did not parse"

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/orchestrated-review-acceptance.XXXXXX")"
  status=0
  {
    gh api --paginate "repos/$repo/pulls/$pr" >"$WORK/pull.pages" &&
      gh api --paginate "repos/$repo/pulls/$pr/reviews" >"$WORK/reviews.pages" &&
      gh api --paginate "repos/$repo/issues/$pr/comments" >"$WORK/issue_comments.pages" &&
      gh api --paginate "repos/$repo/pulls/$pr/comments" >"$WORK/review_comments.pages"
  } 2>"$WORK/gh.err" || status=$?
  if [ "$status" -ne 0 ]; then
    check "github fetch" FAIL "(a GitHub GET exited $status: $(head -n 1 "$WORK/gh.err"))"
    finish
  fi
  jq -s 'add' "$WORK/pull.pages" >"$WORK/pull.json"
  jq -s 'add // []' "$WORK/reviews.pages" >"$WORK/reviews.json"
  jq -s 'add // []' "$WORK/issue_comments.pages" >"$WORK/issue_comments.json"
  jq -s 'add // []' "$WORK/review_comments.pages" >"$WORK/review_comments.json"

  analyse_github "$WORK/pull.json" "$WORK/reviews.json" "$WORK/issue_comments.json" \
    "$WORK/review_comments.json" "$head" "$since_epoch" "$bot"
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
