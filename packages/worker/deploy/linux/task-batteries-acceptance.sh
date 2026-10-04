#!/bin/bash
set -euo pipefail
#
# Phase 7 acceptance: task-run batteries + the Somnio CLI (ROADMAP Phase 7).
#
#   task-batteries-acceptance.sh local [--dry-run]
#       Developer gates, run from a checkout (bash 3.2 compatible, no root):
#       SC1  install contract: manifest/installer/seed tests (+ with --dry-run
#            the six-run installer proof, network needed)
#       SC2  the task_batteries setting: shared + www routes/UI/dispatch tests
#            (incl. the read-only token mint), the transport golden unchanged
#       SC3  task-run seeding + env: worker gate, seeding, env matrix, real gh
#            through the broker; per-package tsc
#
#   task-batteries-acceptance.sh box --since <journalctl time> --repo <owner/name>
#       Operator evidence on the execution box, as root, Linux only:
#       SC1  manifest.sha256 present and valid, tool stamps, the somnio-skills
#            pack dir; as the agent uid: somnio resolves to the wrapper and its
#            last --version line equals the manifest versionLine, no dart on
#            PATH, the pub cache is not writable
#       SC3  the worker journal since --since has a lane=task run for --repo
#            whose `batteries: lane=task packs=…somnio-skills… manifest=<12hex>`
#            prefix equals manifest.sha256
#       SC4  (box half) that same thread logged the read-only token line and
#            no not-delivered/expired line; python3 requests importable; every
#            review run since --since still logs `batteries: mode=…` with no
#            lane= line and no read-token line. The transcript half of SC4
#            lives in the control plane, so it is printed as EVIDENCE manual
#            lines for the operator to judge.
#
# Box mode is READ-ONLY and safe with runs in flight: no restart, no install,
# no repository write, no schema change; its only writes are two mktemp dirs
# removed by the EXIT trap. It never names a customer: pass --repo.
#
# Why git is hardened: /opt/automata-platform is writable by the worker
# account, so as root its hooks, fsmonitor and config must never execute.
# Every git call goes through git_ro (safe.directory, no fsmonitor, hooks to
# /dev/null, no pager, no system/global config, GIT_* overrides cleared).
#
# Output: `EVIDENCE <what>: <value>` and `CHECK <name>: PASS|FAIL <why>`
# lines; the last line is `ACCEPTANCE: PASS` (exit 0) or
# `ACCEPTANCE: FAIL (<n>)` (exit 1). Misuse exits 2.

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -P "$SCRIPT_DIR/../../../.." && pwd -P)"

BATTERIES_ROOT=/usr/local/lib/automata-batteries
BIN_DIR=/usr/local/bin
BOX_CHECKOUT=/opt/automata-platform
WORKER_UNIT=automata-worker.service
WORKER_USER=automata
AGENT_USER=automata-agent
AGENT_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MANIFEST_REL=packages/worker/deploy/batteries.json
TASK_PACK=somnio-skills
REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'

FAILURES=0
GIT_CHECKOUT=""
WORK=""
AGENT_HOME=""

usage() {
  cat >&2 <<'EOF'
usage: task-batteries-acceptance.sh local [--dry-run]
       task-batteries-acceptance.sh box --since <journalctl time> --repo <owner/name>
EOF
  exit 2
}

die() {
  echo "task-batteries-acceptance: $*" >&2
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
  if [ -n "$AGENT_HOME" ]; then
    rm -rf -- "$AGENT_HOME"
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

# Phase 3 agent spawn shape: the worker account sudo's to the agent uid with
# an empty env; values reach the agent shell ONLY through BATTERIES_CHECK_*.
# shellcheck disable=SC2016 # "$1" must expand in the agent's sh, not here
as_agent() {
  local command_string="$1" check_name="$2" check_args="$3" check_path="$4"
  runuser -u "$WORKER_USER" -- env -i HOME="$AGENT_HOME" PATH="$AGENT_PATH" \
    BATTERIES_CHECK_NAME="$check_name" BATTERIES_CHECK_ARGS="$check_args" \
    BATTERIES_CHECK_PATH="$check_path" \
    /usr/bin/sudo -n -u "$AGENT_USER" -E -- /bin/sh -c 'exec bash -lc "$1"' sh "$command_string" </dev/null
}

# ---------------------------------------------------------------------------
# local mode
# ---------------------------------------------------------------------------

# gate <SC label> <name> <command…>: one CHECK line; the log tail on failure.
gate() {
  local label="$1" name="$2" log status
  shift 2
  log="$WORK/gate-$(printf '%s' "$label-$name" | tr -c 'A-Za-z0-9' '_').log"
  status=0
  (cd "$REPO_DIR" && "$@") >"$log" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    check "$label $name" PASS "(exit 0)"
  else
    check "$label $name" FAIL "(exit $status)"
    tail -n 30 "$log" >&2 || true
  fi
}

local_mode() {
  local dry_run=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      *) usage ;;
    esac
    shift
  done
  GIT_CHECKOUT="$REPO_DIR"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/task-batteries-acceptance.XXXXXX")"
  evidence "checkout" "$(git_ro rev-parse HEAD)"

  gate SC1 "worker manifest, installer contract and seeding" \
    pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
    src/agent-run/batteries-manifest.test.ts src/agent-run/deploy-assets.test.ts \
    src/agent-run/batteries-seed.test.ts
  if [ "$dry_run" -eq 1 ]; then
    gate SC1 "installer dry-run proof (batteries-dry-run.sh)" \
      /bin/bash --noprofile --norc packages/worker/deploy/linux/batteries-dry-run.sh
  fi

  gate SC2 "shared setting, pack requirements and read-only minter" \
    pnpm --filter @terragon/shared exec vitest run --no-file-parallelism \
    src/model/review-agent-settings.test.ts src/model/repo-review-settings.test.ts \
    src/github-app.test.ts
  gate SC2 "www routes, Review tab, resolver and dispatch" \
    pnpm --filter @terragon/www exec vitest run --no-file-parallelism \
    src/app/api/review-settings src/components/settings/review-agent \
    src/queries/review-settings-queries.test.ts src/server-lib/review src/server-lib/task \
    src/agent/hatchet/dispatch.test.ts src/agent/hatchet/dispatch-golden.test.ts \
    src/agent/hatchet/transport.test.ts
  gate SC2 "transport golden unchanged vs origin/main (transport.golden.json)" \
    git_ro diff --exit-code origin/main -- apps/www/src/agent/hatchet/__fixtures__/transport.golden.json

  gate SC3 "worker task gate, seeding, read-token env and real gh via the broker" \
    pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
    src/agent-run/task-agent.test.ts src/agent-run/agent-credentials.test.ts \
    src/agent-run/daemon-env.test.ts src/agent-run/workflow-cleanup.test.ts \
    src/agent-run/broker-integration.test.ts src/agent-run/run-lane.test.ts
  gate SC3 "tsc shared" pnpm --filter @terragon/shared exec tsc --noEmit
  gate SC3 "tsc worker" pnpm --filter @terragon/worker exec tsc --noEmit
  gate SC3 "tsc daemon" pnpm --filter @terragon/daemon exec tsc --noEmit
  gate SC3 "tsc www" env NODE_OPTIONS=--max-old-space-size=12288 \
    pnpm --filter @terragon/www exec tsc --noEmit

  finish
}

# ---------------------------------------------------------------------------
# box mode
# ---------------------------------------------------------------------------

# analyse_journal <journal file> <owner/name> <manifest 12-hex prefix>
# Groups `[agent-run <threadId>` lines per thread and judges the latest
# lane=task run for the repo, then every review run.
analyse_journal() {
  local journal="$1" repo="$2" prefix="$3"
  local tid lane run_repo batt applied missing expired
  local task_tid="" task_batt="" task_applied=0 task_missing=0 task_expired=0
  local review_n=0 review_bad=0 review_bad_tids="" review_short=0 packs manifest

  while IFS=$'\t' read -r tid lane run_repo batt applied missing expired; do
    case "$lane" in
      task)
        if [ "$run_repo" = "$repo" ]; then
          task_tid="$tid"
          task_batt="$batt"
          task_applied="$applied"
          task_missing="$missing"
          task_expired="$expired"
        fi
        ;;
      review)
        # A review that never reached its batteries line (died at clone)
        # says nothing about seeding; it is counted, not judged.
        if [ "$batt" = "-" ]; then
          review_short=$((review_short + 1))
          continue
        fi
        review_n=$((review_n + 1))
        case "$batt" in
          "batteries: mode="* | "batteries: unavailable mode="*)
            if [ "$applied" != "0" ]; then
              review_bad=$((review_bad + 1))
              review_bad_tids="$review_bad_tids $tid"
            fi
            ;;
          *)
            review_bad=$((review_bad + 1))
            review_bad_tids="$review_bad_tids $tid"
            ;;
        esac
        ;;
    esac
  done < <(awk '
    {
      if (!match($0, /\[agent-run [^] ]+/)) next
      tid = substr($0, RSTART + 11, RLENGTH - 11)
      if (!(tid in seen)) { seen[tid] = 1; order[++n] = tid; applied[tid] = 0; missing[tid] = 0; expired[tid] = 0 }
      if (index($0, "] run start: lane=") > 0) {
        l = $0; sub(/.*\] run start: lane=/, "", l); sub(/ .*/, "", l); lane[tid] = l
        r = ""
        if (match($0, / repo=[^ ]+/)) r = substr($0, RSTART + 6, RLENGTH - 6)
        repo[tid] = r
      }
      if (index($0, "] batteries: lane=") > 0 || index($0, "] batteries: mode=") > 0 ||
          index($0, "] batteries: unavailable lane=") > 0 || index($0, "] batteries: unavailable mode=") > 0) {
        b = $0; sub(/.*\] batteries: /, "batteries: ", b); batt[tid] = b
      }
      if (index($0, "] task agent: github read token → GITHUB_TOKEN") > 0) applied[tid] = 1
      if (index($0, "] task agent: read token required but not delivered") > 0) missing[tid] = 1
      if (index($0, "] task agent: read token expired before start") > 0) expired[tid] = 1
    }
    END {
      for (i = 1; i <= n; i++) {
        t = order[i]
        printf "%s\t%s\t%s\t%s\t%d\t%d\t%d\n", t, (t in lane ? lane[t] : "-"), (t in repo ? repo[t] : "-"), (t in batt ? batt[t] : "-"), applied[t], missing[t], expired[t]
      }
    }
  ' "$journal")

  if [ -z "$task_tid" ]; then
    check "SC3 task run seeded" FAIL "(no lane=task run for $repo in the journal window)"
    check "SC4 read-only token delivered" FAIL "(no lane=task run for $repo)"
  else
    evidence "task-run thread" "$task_tid"
    evidence "task-run batteries line" "$task_batt"
    packs=""
    manifest=""
    case "$task_batt" in
      "batteries: lane=task packs="*)
        packs="${task_batt#batteries: lane=task packs=}"
        packs="${packs%% *}"
        manifest="${task_batt##* manifest=}"
        ;;
    esac
    if [ -z "$packs" ]; then
      check "SC3 task run seeded" FAIL "(the run's batteries line is not a seeded lane=task line)"
    elif [ "$manifest" != "$prefix" ]; then
      check "SC3 task run seeded" FAIL "(manifest=$manifest, installed manifest.sha256 starts $prefix)"
    else
      case ",$packs," in
        *",$TASK_PACK,"*) check "SC3 task run seeded" PASS "(packs=$packs manifest=$manifest)" ;;
        *) check "SC3 task run seeded" FAIL "(packs=$packs lacks $TASK_PACK)" ;;
      esac
    fi
    if [ "$task_missing" != "0" ]; then
      check "SC4 read-only token delivered" FAIL "(read token required but not delivered)"
    elif [ "$task_expired" != "0" ]; then
      check "SC4 read-only token delivered" FAIL "(read token expired before start)"
    elif [ "$task_applied" != "1" ]; then
      check "SC4 read-only token delivered" FAIL "(no task agent: github read token → GITHUB_TOKEN line)"
    else
      check "SC4 read-only token delivered" PASS "(GITHUB_TOKEN = read-only token; GH_TOKEN stays the broker bearer)"
    fi
  fi

  evidence "review runs inspected" "$review_n"
  evidence "review runs without a batteries line (ended before seeding)" "$review_short"
  if [ "$review_bad" -eq 0 ]; then
    if [ "$review_n" -eq 0 ]; then
      check "SC4 review runs unaffected" PASS "(no review run in the window; re-run after the next PR review)"
    else
      check "SC4 review runs unaffected" PASS "($review_n review run(s): batteries: mode=…, no lane= line, no read token)"
    fi
  else
    check "SC4 review runs unaffected" FAIL "($review_bad review run(s):$review_bad_tids)"
  fi
}

box_mode() {
  local since="" repo="" hash prefix manifest_json tool_rows tool pack_sha
  local wrapper args version_line out resolved last status
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --since)
        [ "$#" -ge 2 ] || die "--since needs a value"
        since="$2"
        shift 2
        ;;
      --repo)
        [ "$#" -ge 2 ] || die "--repo needs a value"
        repo="$2"
        shift 2
        ;;
      *) usage ;;
    esac
  done
  [ -n "$since" ] || die "box mode needs --since <time, e.g. \"2026-10-04 02:00 UTC\">"
  [ -n "$repo" ] || die "box mode needs --repo <owner/name>"
  [[ "$repo" =~ $REPO_RE ]] || die "--repo must match $REPO_RE"
  case "$since" in
    *[[:cntrl:]]*) die "--since must not contain control characters" ;;
  esac
  [ "$(id -u)" = "0" ] || die "box mode must run as root"
  [ "$(uname -s)" = "Linux" ] || die "box mode runs on the Linux execution box only"

  GIT_CHECKOUT="$BOX_CHECKOUT"
  WORK="$(mktemp -d /tmp/task-batteries-acceptance.XXXXXX)"
  AGENT_HOME="$(mktemp -d /tmp/task-batteries-agent-home.XXXXXX)"
  chown "$AGENT_USER" "$AGENT_HOME"
  chmod 700 "$AGENT_HOME"

  # --- SC1: the install -----------------------------------------------------
  hash=""
  if [ -f "$BATTERIES_ROOT/manifest.sha256" ]; then
    hash="$(awk 'NR == 1 { print $1 }' "$BATTERIES_ROOT/manifest.sha256")"
  fi
  if [ -e "$BATTERIES_ROOT/manifest.sha256.invalid" ]; then
    check "SC1 install manifest" FAIL "(manifest.sha256.invalid present: the last install failed)"
  elif [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    check "SC1 install manifest" PASS "(manifest.sha256 $hash)"
  else
    check "SC1 install manifest" FAIL "(manifest.sha256 missing or not 64-hex)"
  fi
  evidence "manifest.sha256" "${hash:-none}"
  prefix="${hash:0:12}"

  manifest_json="$WORK/batteries.json"
  if git_ro cat-file blob HEAD:packages/worker/deploy/batteries.json >"$manifest_json" 2>/dev/null &&
    jq -e . "$manifest_json" >/dev/null 2>&1; then
    evidence "checkout HEAD" "$(git_ro rev-parse HEAD)"
  else
    check "SC1 checkout manifest" FAIL "(cannot read HEAD:$MANIFEST_REL from $BOX_CHECKOUT)"
    printf '{}\n' >"$manifest_json"
  fi

  tool_rows="$(jq -r '(.tools // [])[] | "\(.name)@\(.version)"' "$manifest_json")"
  if [ -z "$tool_rows" ]; then
    check "SC1 tool stamps" FAIL "(the checkout manifest names no tools)"
  fi
  while IFS= read -r tool; do
    [ -n "$tool" ] || continue
    if [ -f "$BATTERIES_ROOT/tools/$tool.stamp" ]; then
      check "SC1 tool stamp $tool" PASS "($BATTERIES_ROOT/tools/$tool.stamp)"
    else
      check "SC1 tool stamp $tool" FAIL "(no $BATTERIES_ROOT/tools/$tool.stamp)"
    fi
  done <<<"$tool_rows"

  pack_sha="$(jq -r --arg id "$TASK_PACK" '.packs[]? | select(.id == $id) | .sha' "$manifest_json")"
  if [ -n "$pack_sha" ] && [ -d "$BATTERIES_ROOT/$TASK_PACK@$pack_sha" ]; then
    check "SC1 pack $TASK_PACK" PASS "($BATTERIES_ROOT/$TASK_PACK@$pack_sha)"
  else
    check "SC1 pack $TASK_PACK" FAIL "(not installed at the checkout pin ${pack_sha:-none})"
  fi

  # --- SC1: what the agent uid sees ------------------------------------------
  wrapper="$(jq -r '[(.tools // [])[] | select(.kind == "dart-aot")][0].wrapper // empty' "$manifest_json")"
  args="$(jq -r '[(.tools // [])[] | select(.kind == "dart-aot")][0].versionArgs // empty' "$manifest_json")"
  version_line="$(jq -r '[(.tools // [])[] | select(.kind == "dart-aot")][0].versionLine // empty' "$manifest_json")"
  if [ -z "$wrapper" ] || [ -z "$version_line" ]; then
    check "SC1 agent somnio" FAIL "(the checkout manifest has no dart-aot tool)"
  else
    status=0
    # shellcheck disable=SC2016 # constant command string: values expand in the agent shell from env
    out="$(as_agent 'p="$(command -v -- "$BATTERIES_CHECK_NAME")"; printf "RESOLVED:%s\n" "$p"; [ "$p" = "$BATTERIES_CHECK_PATH" ] || exit 3; "$BATTERIES_CHECK_NAME" $BATTERIES_CHECK_ARGS' \
      "$wrapper" "$args" "$BIN_DIR/$wrapper" 2>/dev/null)" || status=$?
    resolved="$(printf '%s\n' "$out" | sed -n 's/^RESOLVED://p' | tail -n 1)"
    last="${out##*$'\n'}"
    evidence "agent $wrapper resolves" "${resolved:-nothing}"
    evidence "agent $wrapper $args (last line)" "$last"
    if [ "$resolved" != "$BIN_DIR/$wrapper" ]; then
      check "SC1 agent somnio" FAIL "(resolves '${resolved:-nothing}', expected $BIN_DIR/$wrapper)"
    elif [ "$status" -ne 0 ]; then
      check "SC1 agent somnio" FAIL "($wrapper $args exited $status as $AGENT_USER)"
    elif [ "$last" != "$version_line" ]; then
      check "SC1 agent somnio" FAIL "(last line '$last', manifest versionLine '$version_line')"
    else
      check "SC1 agent somnio" PASS "($last)"
    fi
  fi

  status=0
  as_agent 'command -v dart >/dev/null 2>&1 && exit 4; exit 0' "" "" "" >/dev/null 2>&1 || status=$?
  case "$status" in
    0) check "SC1 no dart on the agent PATH" PASS "(build-only SDK)" ;;
    4) check "SC1 no dart on the agent PATH" FAIL "(dart resolves for $AGENT_USER)" ;;
    *) check "SC1 no dart on the agent PATH" FAIL "(the check could not run as $AGENT_USER, status $status)" ;;
  esac

  status=0
  # shellcheck disable=SC2016 # constant command string: the path arrives via env
  as_agent '[ -e "$BATTERIES_CHECK_PATH" ] || exit 5; [ -w "$BATTERIES_CHECK_PATH" ] && exit 4; exit 0' \
    "" "" "$BATTERIES_ROOT/pub-cache" >/dev/null 2>&1 || status=$?
  case "$status" in
    0) check "SC1 pub cache not writable" PASS "($BATTERIES_ROOT/pub-cache)" ;;
    4) check "SC1 pub cache not writable" FAIL "($AGENT_USER can write $BATTERIES_ROOT/pub-cache)" ;;
    5) check "SC1 pub cache not writable" FAIL "($BATTERIES_ROOT/pub-cache is missing)" ;;
    *) check "SC1 pub cache not writable" FAIL "(the check could not run as $AGENT_USER, status $status)" ;;
  esac

  status=0
  as_agent 'python3 -c "import requests" >/dev/null 2>&1' "" "" "" >/dev/null 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    check "SC4 python3 requests (dora_metrics.py)" PASS "(importable as $AGENT_USER)"
  else
    check "SC4 python3 requests (dora_metrics.py)" FAIL "(import requests failed as $AGENT_USER, status $status)"
  fi

  # --- SC3/SC4: the worker journal ---------------------------------------------
  if journalctl -u automata-worker.service --since "$since" --no-pager -o cat >"$WORK/journal.txt" 2>"$WORK/journal.err"; then
    evidence "journal lines since $since" "$(wc -l <"$WORK/journal.txt" | tr -d ' ')"
    analyse_journal "$WORK/journal.txt" "$repo" "$prefix"
  else
    check "SC3 worker journal" FAIL "(journalctl -u $WORKER_UNIT failed: $(head -n 1 "$WORK/journal.err"))"
  fi

  # --- SC4: transcript evidence the operator judges in the control plane -------
  echo "EVIDENCE manual transcript: somnio --version prints $version_line"
  echo "EVIDENCE manual transcript: Skill invocations of dora-metrics, react-health-audit and security-audit; thread status complete"
  echo "EVIDENCE manual reports = each report's content (DORA, react-health, security) quoted or summarised in the transcript or final message — a branch is not evidence (reports/ is gitignored)"
  echo "EVIDENCE manual somnio exit codes: record verbatim; never pass/fail evidence"
  echo "EVIDENCE manual DORA: Deployment Frequency + Lead Time computed from GitHub in the unchanged run — no 401"
  echo "EVIDENCE manual www: no '[hatchet] task agent: read token mint failed' line for the run"

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
    *) usage ;;
  esac
}

# Sourcing (the journal-analysis tests) defines the functions without running.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
