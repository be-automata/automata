#!/bin/bash
set -euo pipefail
#
# Harness-battery acceptance: gstack, GSD and ruflo (with its MCP server) in
# task/PR runs on the execution box (plan PR5; PILOT-RUNBOOK "Harness rollout").
#
#   harness-batteries-acceptance.sh local [--dry-run]
#       Developer gates, run from a checkout (bash 3.2 compatible, no root):
#       SC1  install contract: harness manifest, layout, MCP filter and the
#            deploy-asset tests (+ with --dry-run the installer dry-run proof,
#            network needed)
#       SC2  seeding: boot doctor line, review-lane fence, .claude.json MCP
#            entry, battery env, task gate
#       SC3  the setting: shared ids + the harnessBatteries-gated routes/UI;
#            per-package tsc
#
#   harness-batteries-acceptance.sh box --since <journalctl time> --repo <owner/name>
#                                       [--thread <id>] [--live]
#       Operator evidence on the execution box, as root, Linux only:
#       SC1  the install: harness.sha256 valid (no .invalid), the installed
#            harness.json equals the checkout's, `automata-batteries doctor
#            --json` ok with gstack, gsd and ruflo ok+installed, the AppArmor
#            browser profiles loaded, the packs root-owned and not
#            group/world-writable, nothing under the batteries root owned by
#            automata-build, no staging dir, automata-build in cron.deny and
#            at.deny
#       SC2  the worker: a `[worker-boot] harness: hash=<12hex> … ok=…` line
#            since --since whose hash is the harness.sha256 prefix and whose
#            ok= names every harness pack
#       SC3  a lane=task (or lane=pr) run for --repo (or exactly --thread)
#            whose batteries line carries `harness=<12hex>` = that prefix and
#            `harness-packs=` naming every pack; no review run since --since
#            carries a harness (the review-lane fence)
#       SC4  resources: that run's teardown `run cgroup: oom_kill=0`, every
#            harness run since --since OOM-free, its run cgroup gone after
#            teardown, and nothing left running as the agent uid outside a
#            live run cgroup and the engine's Postgres container (uid 999 is
#            shared with docker's postgres image)
#       SC5  the MCP credential fence: with --live (during a drill run), the
#            environ NAMES of every ruflo MCP filter and its server child
#            carry no TOKEN, KEY, SECRET or GIT_CONFIG_; each live run cgroup's
#            memory.peak / oom_kill / pids.peak is sampled. Without --live the
#            sampling is printed as EVIDENCE manual lines.
#       The control-plane half (Skill tool_use, mcp__ruflo__* calls,
#       BATTERY_MISSING) is printed as EVIDENCE manual lines.
#
# Box mode is READ-ONLY and safe with runs in flight: no restart, no install,
# no repository write, no schema change, no signal sent; its only write is one
# mktemp dir removed by the EXIT trap. It never names a customer: pass --repo.
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
AGENT_USER=automata-agent
BUILD_USER="automata-build"
HARNESS_REL=packages/worker/deploy/harness.json
# HARNESS_PACK_IDS in packages/shared/src/model/review-agent-settings.ts.
HARNESS_PACKS="gstack,gsd,ruflo,somnio-engineering"
CGROUP_FS=/sys/fs/cgroup
# The #204 ceiling root when the boot journal does not name one.
DEFAULT_CEILING_ROOT=/sys/fs/cgroup/system.slice/automata-worker.service
APPARMOR_PROFILES=/sys/kernel/security/apparmor/profiles
REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
THREAD_RE='^[A-Za-z0-9_-]+$'
# Environ NAMES the MCP server must never see (values are never printed).
SECRET_NAME_RE='TOKEN|KEY|SECRET|^GIT_CONFIG_'

FAILURES=0
GIT_CHECKOUT=""
WORK=""
# Set by analyse_journal for the resource and fence checks that follow it.
RUN_TID=""
RUN_OOM=""

usage() {
  cat >&2 <<'EOF'
usage: harness-batteries-acceptance.sh local [--dry-run]
       harness-batteries-acceptance.sh box --since <journalctl time> --repo <owner/name> [--thread <id>] [--live]
EOF
  exit 2
}

die() {
  echo "harness-batteries-acceptance: $*" >&2
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

# has_all_packs <csv>: every HARNESS_PACKS id is in the comma list.
has_all_packs() {
  local id
  for id in ${HARNESS_PACKS//,/ }; do
    case ",$1," in
      *",$id,"*) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# run_cgroup_path <ceiling root> <threadId>: runCgroupPath() in run-cgroup.ts —
# run-<id with [^a-zA-Z0-9_-] as _>-<first 8 hex of sha256(raw id)>.
run_cgroup_path() {
  local safe digest
  safe="$(printf '%s' "$2" | LC_ALL=C tr -c 'a-zA-Z0-9_-' '_')"
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$2" | sha256sum)"
  else
    digest="$(printf '%s' "$2" | shasum -a 256)"
  fi
  printf '%s/run-%s-%s\n' "$1" "$safe" "${digest:0:8}"
}

# strip_ansi <in> <out>: the worker's logger colours its lines.
strip_ansi() {
  sed "s/$(printf '\033')\[[0-9;]*m//g" "$1" >"$2"
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
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/harness-batteries-acceptance.XXXXXX")"
  evidence "checkout" "$(git_ro rev-parse HEAD)"

  gate SC1 "harness manifest, layout, MCP filter and deploy assets" \
    pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
    src/agent-run/harness-manifest.test.ts src/agent-run/harness-layout.test.ts \
    src/agent-run/harness-mcp-filter.test.ts src/agent-run/batteries-manifest.test.ts \
    src/agent-run/deploy-assets.test.ts
  if [ "$dry_run" -eq 1 ]; then
    gate SC1 "installer dry-run proof (batteries-dry-run.sh)" \
      /bin/bash --noprofile --norc packages/worker/deploy/linux/batteries-dry-run.sh
  fi

  gate SC2 "worker seeding, review-lane fence, MCP entry and battery env" \
    pnpm --filter @terragon/worker exec vitest run --no-file-parallelism \
    src/agent-run/batteries-seed.test.ts src/agent-run/agent-credentials.test.ts \
    src/agent-run/daemon-env.test.ts src/agent-run/task-agent.test.ts \
    src/agent-run/run-lane.test.ts

  gate SC3 "shared harness ids and task pack validation" \
    pnpm --filter @terragon/shared exec vitest run --no-file-parallelism \
    src/model/review-agent-settings.test.ts
  gate SC3 "www harnessBatteries gate: routes, Review tab, task resolver" \
    pnpm --filter @terragon/www exec vitest run --no-file-parallelism \
    src/app/api/review-settings src/components/settings/review-agent \
    src/server-lib/task
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

# analyse_boot <clean journal> <harness 12-hex prefix>: SC2 on the LAST
# `[worker-boot] harness:` line in the window.
analyse_boot() {
  local journal="$1" prefix="$2" line hash ok
  line="$(grep -F '[worker-boot] harness: ' "$journal" | tail -n 1 || true)"
  if [ -z "$line" ]; then
    check "SC2 worker boot harness line" FAIL "(no [worker-boot] harness: line since --since; pass a --since before the worker's last restart)"
    return 0
  fi
  line="${line#*\[worker-boot\] }"
  evidence "worker boot line" "$line"
  hash=""
  ok=""
  if [[ "$line" =~ ^harness:\ hash=([0-9a-f]{12})\  ]]; then
    hash="${BASH_REMATCH[1]}"
  fi
  if [[ "$line" =~ \ ok=([^ ]+) ]]; then
    ok="${BASH_REMATCH[1]}"
  fi
  if [ -z "$hash" ]; then
    check "SC2 worker boot harness line" FAIL "(the worker sees no usable harness: $line)"
  elif [ "$hash" != "$prefix" ]; then
    check "SC2 worker boot harness line" FAIL "(hash=$hash, installed harness.sha256 starts ${prefix:-none})"
  elif ! has_all_packs "$ok"; then
    check "SC2 worker boot harness line" FAIL "(ok=$ok lacks one of $HARNESS_PACKS)"
  else
    check "SC2 worker boot harness line" PASS "(hash=$hash ok=$ok)"
  fi
}

# analyse_journal <clean journal> <owner/name> <harness 12-hex prefix> [thread]
# Groups `[agent-run <threadId>` lines per thread, joins each thread's
# `[agent-run] run cgroup: … thread=<id>` teardown line, and judges the latest
# lane=task|pr run for the repo (or exactly the given thread), every harness
# run's OOM counter, and every review run's batteries line.
analyse_journal() {
  local journal="$1" repo="$2" prefix="$3" want_tid="${4:-}"
  local tid lane run_repo batt oom skips
  local run_lane="" run_batt="" hash packs
  local review_n=0 review_bad=0 review_bad_tids="" review_short=0 review_fenced=0
  local harness_runs=0 harness_ooms=0 harness_oom_tids=""

  RUN_TID=""
  RUN_OOM=""
  while IFS=$'\t' read -r tid lane run_repo batt oom skips; do
    case "$batt" in
      *" harness="[0-9a-f]*)
        harness_runs=$((harness_runs + 1))
        case "$oom" in
          - | 0) ;;
          *)
            harness_ooms=$((harness_ooms + 1))
            harness_oom_tids="$harness_oom_tids $tid(oom_kill=$oom)"
            ;;
        esac
        ;;
    esac
    case "$lane" in
      task | pr)
        if [ -n "$want_tid" ]; then
          [ "$tid" = "$want_tid" ] || continue
        elif [ "$run_repo" != "$repo" ]; then
          continue
        fi
        RUN_TID="$tid"
        RUN_OOM="$oom"
        run_lane="$lane"
        run_batt="$batt"
        ;;
      review)
        if [ "$skips" != "0" ]; then
          review_fenced=$((review_fenced + 1))
        fi
        # A review that never reached its batteries line (died at clone)
        # says nothing about seeding; it is counted, not judged.
        if [ "$batt" = "-" ]; then
          review_short=$((review_short + 1))
          continue
        fi
        review_n=$((review_n + 1))
        case "$batt" in
          *" harness="* | *" harness-packs="* | "batteries: lane="* | "batteries: unavailable lane="*)
            review_bad=$((review_bad + 1))
            review_bad_tids="$review_bad_tids $tid"
            ;;
        esac
        ;;
    esac
  done < <(awk '
    {
      if (index($0, "] run cgroup: oom_kill=") > 0 && match($0, / thread=[^ ]+/)) {
        t = substr($0, RSTART + 8, RLENGTH - 8)
        o = $0; sub(/.*run cgroup: oom_kill=/, "", o); sub(/ .*/, "", o)
        oom[t] = o
        next
      }
      if (!match($0, /\[agent-run [^] ]+/)) next
      tid = substr($0, RSTART + 11, RLENGTH - 11)
      if (!(tid in seen)) { seen[tid] = 1; order[++n] = tid; skips[tid] = 0 }
      if (index($0, "] run start: lane=") > 0) {
        l = $0; sub(/.*\] run start: lane=/, "", l); sub(/ .*/, "", l); lane[tid] = l
        r = ""
        if (match($0, / repo=[^ ]+/)) r = substr($0, RSTART + 6, RLENGTH - 6)
        repo[tid] = r
      }
      if (index($0, "] batteries: skip pack ") > 0 && index($0, " reason=review-lane") > 0) {
        skips[tid]++
        next
      }
      if (index($0, "] batteries: lane=") > 0 || index($0, "] batteries: mode=") > 0 ||
          index($0, "] batteries: unavailable lane=") > 0 || index($0, "] batteries: unavailable mode=") > 0) {
        b = $0; sub(/.*\] batteries: /, "batteries: ", b); sub(/[ \t]+$/, "", b); batt[tid] = b
      }
    }
    END {
      for (i = 1; i <= n; i++) {
        t = order[i]
        printf "%s\t%s\t%s\t%s\t%s\t%s\n", t, (t in lane ? lane[t] : "-"), (t in repo ? repo[t] : "-"), (t in batt ? batt[t] : "-"), (t in oom ? oom[t] : "-"), skips[t]
      }
    }
  ' "$journal")

  if [ -z "$RUN_TID" ]; then
    if [ -n "$want_tid" ]; then
      check "SC3 harness run seeded" FAIL "(thread $want_tid is not a lane=task|pr run in the journal window)"
    else
      check "SC3 harness run seeded" FAIL "(no lane=task|pr run for $repo in the journal window)"
    fi
  else
    evidence "harness-run thread" "$RUN_TID (lane=$run_lane)"
    evidence "harness-run batteries line" "$run_batt"
    hash=""
    packs=""
    if [[ "$run_batt" =~ \ harness=([^ ]+) ]]; then
      hash="${BASH_REMATCH[1]}"
    fi
    if [[ "$run_batt" =~ \ harness-packs=([^ ]+) ]]; then
      packs="${BASH_REMATCH[1]}"
    fi
    if [ -z "$hash" ]; then
      check "SC3 harness run seeded" FAIL "(the run's batteries line carries no harness=; is the repo's Task agent packs setting gstack, gsd, ruflo?)"
    elif [ "$hash" != "$prefix" ]; then
      check "SC3 harness run seeded" FAIL "(harness=$hash, installed harness.sha256 starts ${prefix:-none})"
    elif ! has_all_packs "$packs"; then
      check "SC3 harness run seeded" FAIL "(harness-packs=${packs:-none} lacks one of $HARNESS_PACKS)"
    else
      check "SC3 harness run seeded" PASS "(harness=$hash harness-packs=$packs)"
    fi
  fi

  evidence "review runs inspected" "$review_n"
  evidence "review runs without a batteries line (ended before seeding)" "$review_short"
  evidence "review runs whose harness ids were refused (skip pack … reason=review-lane)" "$review_fenced"
  if [ "$review_bad" -eq 0 ]; then
    if [ "$review_n" -eq 0 ]; then
      check "SC3 review lane carries no harness" PASS "(no review run in the window; re-run after the next PR review)"
    else
      check "SC3 review lane carries no harness" PASS "($review_n review run(s): batteries: mode=…, no harness=)"
    fi
  else
    check "SC3 review lane carries no harness" FAIL "($review_bad review run(s):$review_bad_tids)"
  fi

  evidence "harness runs since --since" "$harness_runs"
  if [ "$harness_ooms" -eq 0 ]; then
    check "SC4 harness runs OOM-free" PASS "($harness_runs harness run(s), no oom_kill)"
  else
    check "SC4 harness runs OOM-free" FAIL "($harness_ooms run(s):$harness_oom_tids)"
  fi
}

# sample_cgroup <run cgroup dir>: memory.peak, oom_kill and pids.peak (read only).
sample_cgroup() {
  local dir="$1" name value
  for name in memory.peak pids.peak pids.current; do
    value="$(cat "$dir/$name" 2>/dev/null || echo unreadable)"
    evidence "$(basename "$dir") $name" "$value"
  done
  value="$(awk '$1 == "oom_kill" { print $2 }' "$dir/memory.events" 2>/dev/null || true)"
  evidence "$(basename "$dir") memory.events oom_kill" "${value:-unreadable}"
}

# agent_leftovers <ceiling root>: the agent uid's processes, split into the
# engine's Postgres (docker-* cgroup: uid 999 is shared), live runs (a run-*
# cgroup under the ceiling root) and leftovers (anything else).
agent_leftovers() {
  local root_rel="${1#"$CGROUP_FS"}" pid cg args docker=0 inflight=0 leftovers=0 tools=0
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    cg="$(sed -n 's/^0:://p' "/proc/$pid/cgroup" 2>/dev/null || true)"
    [ -n "$cg" ] || continue
    case "$cg" in
      */docker-*.scope | */docker/*)
        docker=$((docker + 1))
        continue
        ;;
      "$root_rel"/run-*)
        inflight=$((inflight + 1))
        continue
        ;;
    esac
    leftovers=$((leftovers + 1))
    args="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-160 || true)"
    case "$args" in
      *mcp-filter.mjs* | *ruflo* | *bun* | *chrome*) tools=$((tools + 1)) ;;
    esac
    evidence "leftover agent process" "pid=$pid cgroup=$cg args=$args"
  done < <(pgrep -u "$AGENT_USER" 2>/dev/null || true)
  evidence "agent-uid processes in the engine's Postgres container" "$docker"
  evidence "agent-uid processes in a live run cgroup" "$inflight"
  if [ "$leftovers" -eq 0 ]; then
    check "SC4 nothing left running as $AGENT_USER" PASS "(outside live runs and the engine's Postgres)"
  else
    check "SC4 nothing left running as $AGENT_USER" FAIL "($leftovers process(es), $tools of them ruflo-mcp/bun/chrome)"
  fi
}

# mcp_pids: every live ruflo MCP filter (bin/ruflo-mcp execs it) running as
# the agent uid, then each filter's children (the server it spawned).
mcp_pids() {
  local pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    echo "$pid"
    pgrep -P "$pid" 2>/dev/null || true
  done < <(pgrep -u "$AGENT_USER" -f '/lib/mcp-filter\.mjs' 2>/dev/null || true)
}

# mcp_fence: the environ NAMES (never values) of every mcp_pids process.
mcp_fence() {
  local pid n=0 names bad bad_all=""
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    n=$((n + 1))
    names="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | cut -d= -f1 | LC_ALL=C sort -u || true)"
    evidence "ruflo MCP pid $pid environ names" "$(printf '%s' "${names:-unreadable}" | tr '\n' ' ')"
    bad="$(printf '%s\n' "$names" | grep -E "$SECRET_NAME_RE" | tr '\n' ' ' || true)"
    if [ -n "$bad" ]; then
      bad_all="$bad_all pid=$pid:$bad"
    fi
  done < <(mcp_pids)
  if [ "$n" -eq 0 ]; then
    check "SC5 MCP server credential fence" FAIL "(--live: no ruflo MCP filter running as $AGENT_USER; re-run while the drill run is in flight)"
  elif [ -z "$bad_all" ]; then
    check "SC5 MCP server credential fence" PASS "($n process(es): no TOKEN/KEY/SECRET/GIT_CONFIG_ names)"
  else
    check "SC5 MCP server credential fence" FAIL "(${bad_all# })"
  fi
}

box_mode() {
  local since="" repo="" thread="" live=0 hash prefix status doctor id dir found
  local profile root run_cg
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
      --thread)
        [ "$#" -ge 2 ] || die "--thread needs a value"
        thread="$2"
        shift 2
        ;;
      --live)
        live=1
        shift
        ;;
      *) usage ;;
    esac
  done
  [ -n "$since" ] || die "box mode needs --since <time, e.g. \"2026-10-12 18:00 UTC\">"
  [ -n "$repo" ] || die "box mode needs --repo <owner/name>"
  [[ "$repo" =~ $REPO_RE ]] || die "--repo must match $REPO_RE"
  if [ -n "$thread" ] && ! [[ "$thread" =~ $THREAD_RE ]]; then
    die "--thread must match $THREAD_RE"
  fi
  case "$since" in
    *[[:cntrl:]]*) die "--since must not contain control characters" ;;
  esac
  [ "$(id -u)" = "0" ] || die "box mode must run as root"
  [ "$(uname -s)" = "Linux" ] || die "box mode runs on the Linux execution box only"

  GIT_CHECKOUT="$BOX_CHECKOUT"
  WORK="$(mktemp -d /tmp/harness-batteries-acceptance.XXXXXX)"

  # --- SC1: the install -----------------------------------------------------
  hash=""
  if [ -f "$BATTERIES_ROOT/harness.sha256" ]; then
    hash="$(awk 'NR == 1 { print $1 }' "$BATTERIES_ROOT/harness.sha256")"
  fi
  if [ -e "$BATTERIES_ROOT/harness.sha256.invalid" ]; then
    check "SC1 harness stamp" FAIL "(harness.sha256.invalid present: the last harness install failed)"
  elif [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    check "SC1 harness stamp" PASS "(harness.sha256 $hash)"
  else
    check "SC1 harness stamp" FAIL "(harness.sha256 missing or not 64-hex)"
  fi
  evidence "harness.sha256" "${hash:-none}"
  prefix="${hash:0:12}"

  if git_ro cat-file blob "HEAD:$HARNESS_REL" >"$WORK/harness.json" 2>/dev/null; then
    evidence "checkout HEAD" "$(git_ro rev-parse HEAD)"
    if cmp -s "$WORK/harness.json" "$BATTERIES_ROOT/harness.json"; then
      check "SC1 installed harness.json = checkout" PASS "(the worker's manifest parser reads the installed pins)"
    else
      check "SC1 installed harness.json = checkout" FAIL "($BATTERIES_ROOT/harness.json differs from HEAD:$HARNESS_REL: re-run the installer, then restart the worker when idle)"
    fi
  else
    check "SC1 installed harness.json = checkout" FAIL "(cannot read HEAD:$HARNESS_REL from $BOX_CHECKOUT)"
  fi

  status=0
  doctor="$("$BIN_DIR/automata-batteries" doctor --json 2>"$WORK/doctor.err")" || status=$?
  if ! jq -e . >/dev/null 2>&1 <<<"$doctor"; then
    check "SC1 doctor" FAIL "(automata-batteries doctor --json exited $status without JSON: $(head -n 1 "$WORK/doctor.err"))"
    doctor='{}'
  elif jq -e '.ok == true' >/dev/null <<<"$doctor"; then
    check "SC1 doctor" PASS "(ok: true, node $(jq -r '.node.version' <<<"$doctor"))"
  else
    check "SC1 doctor" FAIL "(ok: false; $(jq -c '{error, harness, packs: [(.packs // [])[] | {id, ok, installed}]}' <<<"$doctor"))"
  fi
  for id in ${HARNESS_PACKS//,/ }; do
    if jq -e --arg id "$id" '[(.packs // [])[] | select(.id == $id and .ok == true and .installed == true)] | length == 1' >/dev/null <<<"$doctor"; then
      check "SC1 doctor pack $id" PASS "($(jq -r --arg id "$id" '.packs[] | select(.id == $id) | .dir' <<<"$doctor"))"
    else
      check "SC1 doctor pack $id" FAIL "(not ok+installed: $(jq -c --arg id "$id" '[(.packs // [])[] | select(.id == $id) | {ok, installed, present, stampValid, nodeAbiMatch, headlessSafeMissing}]' <<<"$doctor"))"
    fi
  done

  found=0
  while IFS= read -r profile; do
    [ -n "$profile" ] || continue
    found=$((found + 1))
    if grep -q "^$profile (" "$APPARMOR_PROFILES" 2>/dev/null; then
      check "SC1 AppArmor profile $profile" PASS "(loaded)"
    else
      check "SC1 AppArmor profile $profile" FAIL "(not loaded; aa-status | grep automata-)"
    fi
  done < <(jq -r '(.packs // [])[] | .id as $id | (.browsers // [])[] | "automata-\($id)-\(.name)"' "$BATTERIES_ROOT/harness.json" 2>/dev/null || true)
  if [ "$found" -eq 0 ]; then
    check "SC1 AppArmor profiles" FAIL "(the installed harness.json names no browser)"
  fi

  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if [ ! -d "$dir" ]; then
      check "SC1 pack ownership $(basename "$dir")" FAIL "(missing)"
      continue
    fi
    found="$(find "$dir" -xdev \( ! -user root -o \( -type f -o -type d \) -perm /022 \) -print -quit 2>/dev/null || true)"
    if [ -z "$found" ]; then
      check "SC1 pack ownership $(basename "$dir")" PASS "(root-owned, not group/world-writable)"
    else
      check "SC1 pack ownership $(basename "$dir")" FAIL "(first offender: $found)"
    fi
  done < <(jq -r '(.packs // [])[] | .dir' <<<"$doctor")

  found="$(find "$BATTERIES_ROOT" -maxdepth 1 -name '.staging.*' -print -quit 2>/dev/null || true)"
  if [ -z "$found" ]; then
    check "SC1 no install in progress" PASS "(no staging dir)"
  else
    check "SC1 no install in progress" FAIL "($found: an install is running or was aborted; judge after it ends)"
  fi
  if id -u "$BUILD_USER" >/dev/null 2>&1; then
    found="$(find "$BATTERIES_ROOT" -xdev -user "$BUILD_USER" -print -quit 2>/dev/null || true)"
    if [ -z "$found" ]; then
      check "SC1 nothing owned by $BUILD_USER" PASS "(under $BATTERIES_ROOT)"
    else
      check "SC1 nothing owned by $BUILD_USER" FAIL "(first: $found)"
    fi
    if grep -qxF -- "$BUILD_USER" /etc/cron.deny 2>/dev/null && grep -qxF -- "$BUILD_USER" /etc/at.deny 2>/dev/null; then
      check "SC1 $BUILD_USER denied cron and at" PASS "(/etc/cron.deny, /etc/at.deny)"
    else
      check "SC1 $BUILD_USER denied cron and at" FAIL "(missing from /etc/cron.deny or /etc/at.deny)"
    fi
  else
    check "SC1 build account" FAIL "(no $BUILD_USER account)"
  fi

  # --- SC2-SC4: the worker journal ---------------------------------------------
  root="$(journalctl -u "$WORKER_UNIT" -b --no-pager -o cat 2>/dev/null |
    sed -n 's/.*\[worker-boot\] memory ceiling armed: \([^ ]*\) .*/\1/p' | tail -n 1 || true)"
  evidence "run cgroup root" "${root:-$DEFAULT_CEILING_ROOT (default: no boot line this boot)}"
  root="${root:-$DEFAULT_CEILING_ROOT}"

  if journalctl -u "$WORKER_UNIT" --since "$since" --no-pager -o cat >"$WORK/journal.raw" 2>"$WORK/journal.err"; then
    strip_ansi "$WORK/journal.raw" "$WORK/journal.txt"
    evidence "journal lines since $since" "$(wc -l <"$WORK/journal.txt" | tr -d ' ')"
    analyse_boot "$WORK/journal.txt" "$prefix"
    analyse_journal "$WORK/journal.txt" "$repo" "$prefix" "$thread"
  else
    check "SC2 worker journal" FAIL "(journalctl -u $WORKER_UNIT failed: $(head -n 1 "$WORK/journal.err"))"
  fi

  # --- SC4: the judged run's resources ------------------------------------------
  if [ -n "$RUN_TID" ]; then
    run_cg="$(run_cgroup_path "$root" "$RUN_TID")"
    case "$RUN_OOM" in
      -)
        if [ -d "$run_cg" ]; then
          evidence "harness run" "still in flight; sampling $run_cg"
          sample_cgroup "$run_cg"
          check "SC4 harness run teardown" FAIL "(the run is still in flight: re-run after it ends)"
        else
          check "SC4 harness run teardown" FAIL "(no run cgroup: oom_kill= line for $RUN_TID and no live cgroup)"
        fi
        ;;
      0)
        if [ -d "$run_cg" ]; then
          check "SC4 harness run teardown" FAIL "(oom_kill=0 but $run_cg is still present)"
        else
          check "SC4 harness run teardown" PASS "(oom_kill=0; run cgroup removed)"
        fi
        ;;
      *) check "SC4 harness run teardown" FAIL "(oom_kill=$RUN_OOM for $RUN_TID)" ;;
    esac
  fi
  agent_leftovers "$root"

  # --- SC5: the MCP credential fence and live sampling --------------------------
  if [ "$live" -eq 1 ]; then
    mcp_fence
    found=0
    for run_cg in "$root"/run-*; do
      [ -d "$run_cg" ] || continue
      found=$((found + 1))
      sample_cgroup "$run_cg"
    done
    evidence "live run cgroups sampled" "$found"
  else
    echo "EVIDENCE manual SC5: during the drill run, re-run with --live (reads /proc/<ruflo-mcp child>/environ names: no TOKEN/KEY/SECRET/GIT_CONFIG_)"
    echo "EVIDENCE manual SC4: during the drill run, sample cat $root/run-<thread>-<8hex>/{memory.peak,memory.events,pids.peak} (--live prints them); memory.peak < memory.max, oom_kill 0, pids.peak < 4096"
  fi

  # --- The control-plane half: the operator judges the thread -------------------
  echo "EVIDENCE manual transcript: the first tool call runs automata-batteries doctor --json and the run continues (no BATTERY_MISSING <name> in the final message)"
  echo "EVIDENCE manual transcript: a Skill tool_use for investigate (output shows SKILL_START_PROTO: 1 / SESSION_KIND: spawned) and one for gsd-debug; .planning/debug/*.md in the PR diff, naming no customer"
  echo "EVIDENCE manual transcript: init lists the ruflo MCP server connected; mcp__ruflo__memory_store then mcp__ruflo__memory_retrieve return the same nonce; mcp__ruflo__system_health answers"
  echo "EVIDENCE manual transcript: a non-allowlisted ruflo tool is absent from the tool list or refused (-32601) — never executed"
  echo "EVIDENCE manual transcript: gstack browse goto https://example.com reports the title 'Example Domain'; egress_events has the run's example.com row"
  echo "EVIDENCE manual PR diff: no .gstack/, .claude-flow/ or .swarm/ paths"

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
