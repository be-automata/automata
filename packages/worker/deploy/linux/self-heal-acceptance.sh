#!/bin/bash
set -euo pipefail
#
# Self-heal acceptance: the audit lane (phase 8, findings become issues) and
# the fix lane (phase 9, a fenced branch becomes a draft PR, then a human merge).
#
#   self-heal-acceptance.sh local
#       Developer gates, run from a checkout (bash 3.2 compatible, no root):
#       the targeted shared, www and worker self-heal suites and the www
#       type check.
#
#   self-heal-acceptance.sh box --since <journalctl time> [--expect-fix]
#       Operator evidence on the execution box, as root, Linux only: every
#       lane=self-heal-audit run in the worker journal posted its
#       "self-heal checks:" line BEFORE its daemon spawned, and no journal
#       line contains the check token header or the token field name.
#       Phase 9: every lane=self-heal-fix run logged its "self-heal fix-check:
#       status=" line after the terminal thread poll and before "box lock
#       released"; no journal line carries the gate token header or field;
#       ref-fence refusals are listed as EVIDENCE. --expect-fix makes a window
#       without a fix run a failure.
#
#   self-heal-acceptance.sh github --repo <owner/name> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login> [--expect-fix]
#       (--bot matches the login with or without GitHub's "[bot]" suffix)
#       From the operator's laptop (gh + jq, GETs only): every
#       automata:finding issue is bot-authored, there is one issue per
#       fingerprint marker, the marker is on line 1, no body carries a
#       closing keyword or an @mention, no finding issue carries a bug or
#       enhancement label, no issue carries the retired needs-human label,
#       and no comment marker appears twice.
#       Phase 9, on automata/fix-* PRs created since --since: bot-authored,
#       a draft before ready, readied by the bot only after the CI gate
#       source's checks succeeded on the gated head, "Fixes #<ledger issue>",
#       at most one open per issue, none merged by the bot, exactly one bot
#       review at the gated head of every ready PR; and every default-branch
#       commit since --since reached it through a PR merged by a non-bot.
#       Branch protection is reported as INFO, never as a failure.
#       --expect-fix makes a window without a fix PR a failure.
#
# Every mode is READ-ONLY: no restart, no install, no repository write, no
# schema change, no GitHub write. Its only write is a mktemp dir removed by
# the EXIT trap. It never names a customer: pass --repo.
#
# Output: `EVIDENCE <what>: <value>`, `INFO <what>: <value>` and
# `CHECK <name>: PASS|FAIL <why>` lines (INFO never fails a run); the last line is `ACCEPTANCE: PASS` (exit 0) or
# `ACCEPTANCE: FAIL (<n>)` (exit 1). Misuse exits 2 with usage on stderr.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -P "$SCRIPT_DIR/../../../.." && pwd -P)"

REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
BOT_RE='^[A-Za-z0-9-]+(\[bot\])?$'
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
SHA_RE='^[0-9a-f]{40}$'
NUM_RE='^[0-9]+$'
BRANCH_RE='^[A-Za-z0-9._/-]+$'

FAILURES=0
WORK=""

usage() {
  cat >&2 <<'EOF'
usage: self-heal-acceptance.sh local
       self-heal-acceptance.sh box --since <journalctl time> [--expect-fix]
       self-heal-acceptance.sh github --repo <owner/name> --since <YYYY-MM-DDTHH:MM:SSZ> --bot <login> [--expect-fix]
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

# info <what> <value>: a recorded fact that never changes the verdict.
info() {
  echo "INFO $1: $2"
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
    src/agent-run/self-heal src/agent-run/receive-pack-refs src/agent-run/git-broker
  gate "tsc www" env NODE_OPTIONS=--max-old-space-size=12288 \
    pnpm --filter @terragon/www exec tsc --noEmit

  finish
}

# ---------------------------------------------------------------------------
# box mode
# ---------------------------------------------------------------------------

# analyse_box_journal <journal file> [expect_fix 0|1]
# The journal comes from `journalctl -o short-unix`. Lines are grouped per
# `[agent-run <threadId>` (a trace suffix is dropped). One TSV row per thread:
# thread, lane, then line numbers (0 = none) of the first "self-heal checks:"
# line, the first "daemon spawned:" line, the first terminal thread poll, the
# first "self-heal fix-check: status=" summary and the first "box lock
# released" line; last, the fix-check status word ("-" = none).
analyse_box_journal() {
  local journal="$1" expect_fix="${2:-0}"
  local tid lane checks spawn terminal fixsum released fixstatus
  local runs=0 bad="" leaked fixruns=0 aborted=0 fixbad="" refusals line

  # shellcheck disable=SC2016 # the single-quoted text is an awk program
  while IFS=$'\t' read -r tid lane checks spawn terminal fixsum released fixstatus; do
    case "$lane" in
      self-heal-audit)
        runs=$((runs + 1))
        if [ "$checks" -eq 0 ]; then
          bad="$bad $tid(no-checks-line)"
        elif [ "$spawn" -ne 0 ] && [ "$checks" -gt "$spawn" ]; then
          bad="$bad $tid(checks-after-spawn)"
        fi
        ;;
      self-heal-fix)
        fixruns=$((fixruns + 1))
        if [ "$fixstatus" = "aborted" ]; then
          aborted=$((aborted + 1))
        elif [ "$fixsum" -eq 0 ]; then
          fixbad="$fixbad $tid(no-fix-check-line)"
        elif [ "$terminal" -eq 0 ] || [ "$fixsum" -lt "$terminal" ]; then
          fixbad="$fixbad $tid(fix-check-before-terminal-poll)"
        elif [ "$released" -eq 0 ] || [ "$fixsum" -gt "$released" ]; then
          fixbad="$fixbad $tid(fix-check-after-lock-release)"
        fi
        ;;
    esac
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
      if (index($0, "(terminal=true)") > 0 && !(tid in term)) term[tid] = NR
      if (index($0, "] self-heal fix-check: status=") > 0 && !(tid in fixsum)) {
        fixsum[tid] = NR
        s = $0; sub(/.*\] self-heal fix-check: status=/, "", s); sub(/ .*/, "", s); fixst[tid] = s
      }
      if (index($0, "] box lock released") > 0 && !(tid in rel)) rel[tid] = NR
    }
    END {
      for (i = 1; i <= n; i++) {
        t = order[i]
        printf "%s\t%s\t%d\t%d\t%d\t%d\t%d\t%s\n", t, (t in lane ? lane[t] : "-"), (t in checks ? checks[t] : 0), (t in spawn ? spawn[t] : 0), (t in term ? term[t] : 0), (t in fixsum ? fixsum[t] : 0), (t in rel ? rel[t] : 0), (t in fixst ? fixst[t] : "-")
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

  # Phase 9: the fix lane.
  evidence "self-heal-fix runs in the journal" "$fixruns"
  evidence "self-heal-fix runs aborted" "$aborted"
  if [ "$fixruns" -eq 0 ]; then
    if [ "$expect_fix" = "1" ]; then
      check "box fix run present" FAIL "(no lane=self-heal-fix run since --since)"
    fi
  elif [ -z "$fixbad" ]; then
    check "box fix-check order" PASS "(after the terminal poll, before the box lock release)"
  else
    check "box fix-check order" FAIL "(violations:$fixbad)"
  fi

  leaked="$(grep -c -i -e 'x-self-heal-gate-token' -e 'gateToken' "$journal" || true)"
  if [ "$leaked" = "0" ]; then
    check "box no gate token in journal" PASS "(0 lines)"
  else
    check "box no gate token in journal" FAIL "($leaked journal lines carry the gate token header or field)"
  fi

  refusals="$(grep -c -e 'ref fence refused push' "$journal" || true)"
  evidence "ref-fence refusals" "$refusals"
  if [ "$refusals" != "0" ]; then
    while IFS= read -r line; do
      evidence "ref-fence refusal" "$(printf '%s' "${line#*] }" | tr -c '[:print:]' '?' | cut -c1-300)"
    done < <(grep -e 'ref fence refused push' "$journal" | head -n 10)
  fi
}

box_mode() {
  local since="" expect_fix=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --since)
        [ "$#" -ge 2 ] || die "$1 needs a value"
        since="$2"
        shift 2
        ;;
      --expect-fix)
        expect_fix=1
        shift
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
    analyse_box_journal "$WORK/journal.txt" "$expect_fix"
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

# Shared jq definitions for the phase 9 analysers. $b is the bot login
# without the "[bot]" suffix.
# shellcheck disable=SC2016 # jq programs, not shell expansions
JQ_FIX_DEFS='
  def isbot($b): . == $b or . == ($b + "[bot]");
  def isfix: ((.head.ref // "") | startswith("automata/fix-"));
  def fixes: [(.body // "") | match("(?i)\\bfixes #([0-9]+)\\b"; "g") | .captures[0].string | tonumber];
  def okconc: . == "success" or . == "neutral" or . == "skipped";
  def check_ok($r):
    if has("state") then (.state == "success" and (.updated_at // "9999") <= $r)
    else (.status == "completed" and ((.conclusion // "") | okconc) and (.completed_at // "9999") <= $r) end;
  def bot_ready($b): [.timeline[]? | select(.event == "ready_for_review" and ((.actor.login // "") | isbot($b)))][0];
  def human_ready($b): [.timeline[]? | select(.event == "ready_for_review" and (((.actor.login // "") | isbot($b)) | not))][0];
  def gate_ok($b; $ctx):
    (bot_ready($b).created_at) as $r
    | ((.check_runs // []) + (.statuses // [])) as $all
    | if ($ctx | length) > 0 then
        all($ctx[]; . as $c
          | [$all[] | select(.name == $c or .context == $c)] as $m
          | ($m | length) > 0 and all($m[]; check_ok($r)))
      elif ($all | length) == 0 then
        any(.labels[]?; .name == "needs-human-approve")
      else all($all[]; check_ok($r)) end;
'

# analyse_fix_prs <fix prs.json> <finding issues.json> <protection.json> <bot login> [expect_fix 0|1]
# prs.json: one JSON array of full pull objects, each extended with
# gated_sha, timeline, reviews, check_runs and statuses (of the gated head).
# protection.json: {"readable": bool, "contexts": [required check names]}.
analyse_fix_prs() {
  local prs="$1" issues="$2" protection="$3" bot="$4" expect_fix="${5:-0}"
  local base n_fix contexts bad

  base="${bot%\[bot\]}"
  n_fix="$(jq "$JQ_FIX_DEFS"' [.[] | select(isfix)] | length' "$prs")"
  evidence "automata/fix-* PRs since --since" "$n_fix"

  contexts="$(jq -r '(.contexts // []) | join(",")' "$protection")"
  if [ -z "$contexts" ]; then
    info "branch protection" "none (gate source all-checks)"
  else
    info "branch protection" "required checks $contexts (gate source protection)"
  fi

  if [ "$n_fix" = "0" ]; then
    if [ "$expect_fix" = "1" ]; then
      check "github fix PRs present" FAIL "(no automata/fix-* PR since --since)"
    fi
    return 0
  fi

  bad="$(jq -r --arg b "$base" "$JQ_FIX_DEFS"' [.[] | select(isfix) | select((.user.login // "") | isbot($b) | not) | .number] | map(tostring) | join(" ")' "$prs")"
  if [ -z "$bad" ]; then
    check "github fix PR bot authorship" PASS "(every fix PR is bot-authored)"
  else
    check "github fix PR bot authorship" FAIL "(not authored by $bot: #${bad// / #})"
  fi

  bad="$(jq -r "$JQ_FIX_DEFS"' [.[] | select(isfix)
      | ([.timeline[]? | select(.event == "ready_for_review" or .event == "convert_to_draft") | .event]) as $e
      | select((.draft != true and ($e | length) == 0) or (($e | length) > 0 and $e[0] == "convert_to_draft"))
      | .number] | map(tostring) | join(" ")' "$prs")"
  if [ -z "$bad" ]; then
    check "github fix PR draft before ready" PASS "(every fix PR started as a draft)"
  else
    check "github fix PR draft before ready" FAIL "(opened ready, never a draft: #${bad// / #})"
  fi

  evidence "fix PRs readied by a person" "$(jq --arg b "$base" "$JQ_FIX_DEFS"' [.[] | select(isfix) | select(bot_ready($b) == null and human_ready($b) != null)] | length' "$prs")"
  bad="$(jq -r --arg b "$base" --slurpfile p "$protection" "$JQ_FIX_DEFS"' [.[] | select(isfix) | select(bot_ready($b) != null)
      | select(gate_ok($b; ($p[0].contexts // [])) | not) | .number] | map(tostring) | join(" ")' "$prs")"
  if [ -z "$bad" ]; then
    check "github fix PR ready after CI gate" PASS "(the bot readied each PR only after its gate checks succeeded on the gated head)"
  else
    check "github fix PR ready after CI gate" FAIL "(readied before the gate checks succeeded: #${bad// / #})"
  fi

  bad="$(jq -r --slurpfile i "$issues" "$JQ_FIX_DEFS"' ([$i[0][] | select(has("pull_request") | not) | .number]) as $ledger
      | [.[] | select(isfix) | select((fixes | length) == 0 or any(fixes[]; . as $n | ($ledger | any(. == $n)) | not)) | .number]
      | map(tostring) | join(" ")' "$prs")"
  if [ -z "$bad" ]; then
    check "github fix PR finding link" PASS "(each says Fixes #<ledger finding issue>)"
  else
    check "github fix PR finding link" FAIL "(no Fixes #<ledger issue>: #${bad// / #})"
  fi

  bad="$(jq -r "$JQ_FIX_DEFS"' [.[] | select(isfix and .state == "open") | fixes[]] | group_by(.) | map(select(length > 1) | .[0]) | map(tostring) | join(" ")' "$prs")"
  if [ -z "$bad" ]; then
    check "github one open fix PR per issue" PASS "(no issue has two open fix PRs)"
  else
    check "github one open fix PR per issue" FAIL "(issues with more than one open fix PR: #${bad// / #})"
  fi

  bad="$(jq -r --arg b "$base" "$JQ_FIX_DEFS"' [.[] | select(isfix) | select((.merged_by.login // "") | isbot($b)) | .number] | map(tostring) | join(" ")' "$prs")"
  if [ -z "$bad" ]; then
    check "github no PR merged by the bot" PASS "(no fix PR was merged by $bot)"
  else
    check "github no PR merged by the bot" FAIL "(merged by $bot: #${bad// / #})"
  fi

  bad="$(jq -r --arg b "$base" "$JQ_FIX_DEFS"' [.[] | select(isfix and .draft != true) | . as $pr
      | select(([.reviews[]? | select(((.user.login // "") | isbot($b)) and .commit_id == $pr.gated_sha)] | length) != 1)
      | .number] | map(tostring) | join(" ")' "$prs")"
  if [ -z "$bad" ]; then
    check "github one bot review at the ready head" PASS "(exactly one bot review at each ready PR's gated head)"
  else
    check "github one bot review at the ready head" FAIL "(not exactly one bot review at the gated head: #${bad// / #})"
  fi
}

# analyse_default_branch <commits.json> <bot login>
# commits.json: [{sha, prs: [full pull objects associated with the commit]}].
analyse_default_branch() {
  local commits="$1" bot="$2" base n bad

  base="${bot%\[bot\]}"
  n="$(jq 'length' "$commits")"
  evidence "default-branch commits since --since" "$n"
  bad="$(jq -r --arg b "$base" "$JQ_FIX_DEFS"' [.[] | select(([.prs[]? | select(.merged_at != null and ((.merged_by.login // "") | length) > 0 and ((.merged_by.login | isbot($b)) | not))] | length) == 0) | .sha[0:7]] | join(" ")' "$commits")"
  if [ -z "$bad" ]; then
    check "github default-branch commits via human-merged PRs" PASS "(every commit reached the branch through a PR merged by a non-bot)"
  else
    check "github default-branch commits via human-merged PRs" FAIL "(no PR merged by a non-bot: $bad)"
  fi
}

# The gated head of a fix PR: the last commit before the first ready
# transition, else the PR head. Input: the pull object; $tl: its timeline.
# shellcheck disable=SC2016 # a jq program, not a shell expansion
JQ_GATED_SHA='
  . as $pr | $tl[0] as $t
  | ([$t | to_entries[] | select(.value.event == "ready_for_review") | .key][0]) as $ri
  | (if $ri == null then null else ([$t[0:$ri][] | select(.event == "committed") | .sha] | last) end)
    // $pr.head.sha
'

# fetch_fix_lane <repo> <since>: writes prs.json, protection.json and
# commits.json into $WORK. GETs only; returns non-zero on a failed read
# (protection and rulesets excepted: unreadable means none).
fetch_fix_lane() {
  local repo="$1" since="$2" default n sha readable

  gh api "repos/$repo" </dev/null >"$WORK/repo.json" || return 1
  default="$(jq -r '.default_branch // empty' "$WORK/repo.json")"
  [[ "$default" =~ $BRANCH_RE ]] || return 1

  gh api --paginate "repos/$repo/pulls?state=all&per_page=100" </dev/null >"$WORK/pulls.pages" || return 1
  jq -r -s --arg s "$since" '(add // []) | .[] | select((.head.ref // "") | startswith("automata/fix-")) | select((.created_at // "") >= $s) | .number' \
    "$WORK/pulls.pages" >"$WORK/fix-numbers.txt"

  echo '[]' >"$WORK/prs.json"
  while IFS= read -r n; do
    [[ "$n" =~ $NUM_RE ]] || return 1
    gh api "repos/$repo/pulls/$n" </dev/null >"$WORK/pr.json" || return 1
    gh api --paginate "repos/$repo/issues/$n/timeline?per_page=100" </dev/null >"$WORK/tl.pages" || return 1
    gh api --paginate "repos/$repo/pulls/$n/reviews?per_page=100" </dev/null >"$WORK/rv.pages" || return 1
    jq -s 'add // []' "$WORK/tl.pages" >"$WORK/tl.json"
    jq -s 'add // []' "$WORK/rv.pages" >"$WORK/rv.json"
    sha="$(jq -r --slurpfile tl "$WORK/tl.json" "$JQ_GATED_SHA" "$WORK/pr.json")"
    [[ "$sha" =~ $SHA_RE ]] || return 1
    gh api --paginate "repos/$repo/commits/$sha/check-runs?per_page=100" </dev/null >"$WORK/cr.pages" || return 1
    gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" </dev/null >"$WORK/st.pages" || return 1
    jq -s '[.[].check_runs[]?]' "$WORK/cr.pages" >"$WORK/cr.json"
    jq -s '[.[].statuses[]?]' "$WORK/st.pages" >"$WORK/st.json"
    jq --arg sha "$sha" --slurpfile tl "$WORK/tl.json" --slurpfile rv "$WORK/rv.json" \
      --slurpfile cr "$WORK/cr.json" --slurpfile st "$WORK/st.json" \
      '. + {gated_sha: $sha, timeline: $tl[0], reviews: $rv[0], check_runs: $cr[0], statuses: $st[0]}' \
      "$WORK/pr.json" >"$WORK/one.json"
    jq --slurpfile one "$WORK/one.json" '. + $one' "$WORK/prs.json" >"$WORK/prs.next"
    mv "$WORK/prs.next" "$WORK/prs.json"
  done <"$WORK/fix-numbers.txt"

  # Branch protection is optional: 403/404 (free plan, none) reads as none.
  readable=true
  if ! gh api "repos/$repo/branches/$default/protection/required_status_checks" </dev/null >"$WORK/prot.json" 2>/dev/null; then
    echo '{}' >"$WORK/prot.json"
    readable=false
  fi
  if ! gh api "repos/$repo/rules/branches/$default" </dev/null >"$WORK/rules.json" 2>/dev/null; then
    echo '[]' >"$WORK/rules.json"
  fi
  jq -n --argjson readable "$readable" --slurpfile p "$WORK/prot.json" --slurpfile r "$WORK/rules.json" \
    '{readable: $readable, contexts: ((($p[0].contexts // []) + [($p[0].checks // [])[]?.context]
      + [($r[0] // [])[]? | select(.type == "required_status_checks") | .parameters.required_status_checks[]?.context]) | unique)}' \
    >"$WORK/protection.json"

  gh api --paginate "repos/$repo/commits?sha=$default&since=$since&per_page=100" </dev/null >"$WORK/commits.pages" || return 1
  jq -r -s '(add // []) | .[].sha' "$WORK/commits.pages" >"$WORK/shas.txt"
  echo '[]' >"$WORK/commits.json"
  while IFS= read -r sha; do
    [[ "$sha" =~ $SHA_RE ]] || return 1
    gh api "repos/$repo/commits/$sha/pulls" </dev/null >"$WORK/cp.json" || return 1
    jq -r '.[].number' "$WORK/cp.json" >"$WORK/cp-numbers.txt"
    echo '[]' >"$WORK/cprs.json"
    while IFS= read -r n; do
      [[ "$n" =~ $NUM_RE ]] || return 1
      if ! [ -s "$WORK/pull-$n.json" ]; then
        gh api "repos/$repo/pulls/$n" </dev/null >"$WORK/pull-$n.json" || return 1
      fi
      jq --slurpfile p "$WORK/pull-$n.json" '. + $p' "$WORK/cprs.json" >"$WORK/cprs.next"
      mv "$WORK/cprs.next" "$WORK/cprs.json"
    done <"$WORK/cp-numbers.txt"
    jq --arg sha "$sha" --slurpfile prs "$WORK/cprs.json" '. + [{sha: $sha, prs: $prs[0]}]' \
      "$WORK/commits.json" >"$WORK/commits.next"
    mv "$WORK/commits.next" "$WORK/commits.json"
  done <"$WORK/shas.txt"
}

github_mode() {
  local repo="" since="" bot="" status expect_fix=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --expect-fix)
        expect_fix=1
        shift
        ;;
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

  status=0
  fetch_fix_lane "$repo" "$since" 2>"$WORK/gh-fix.err" || status=$?
  if [ "$status" -ne 0 ]; then
    check "github fix-lane fetch" FAIL "(a GitHub GET or its parse exited $status: $(head -n 1 "$WORK/gh-fix.err"))"
    finish
  fi
  analyse_fix_prs "$WORK/prs.json" "$WORK/issues.json" "$WORK/protection.json" "$bot" "$expect_fix"
  analyse_default_branch "$WORK/commits.json" "$bot"
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
