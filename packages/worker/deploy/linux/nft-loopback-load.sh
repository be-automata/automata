#!/bin/bash
set -euo pipefail
# Render-check and (re)load the automata loopback table (#367). Root required.
# Run by automata-worker.service from `ExecStartPre=+`, i.e. after systemd
# created the unit's cgroup and before the worker process exists — the ONLY
# moment the `socket cgroupv2` path can be bound to the cgroup id that the
# worker, its proxy and broker will actually create their sockets under.
#
# Refuses, in this order, before touching the kernel:
#   - an unrendered __AGENT_UID__ or __MARK__
#   - a malformed mark, a zero mark, or a mark whose set/test lines disagree
#   - uid 0 or the worker's own uid anywhere in the skuid set; skuid sets that
#     differ between rules (#205: one set per box, every rule fences it)
#   - a slot account whose uid is missing from the set (read from
#     /etc/automata/egress.env, the same file automata-egress.service loads)
#   - a `socket cgroupv2` path that is not the worker unit's, a level that does
#     not match the path's depth, or a cgroup directory that does not exist yet
#   - a mark bit that already appears anywhere else in the live ruleset
#   - a named network namespace: `ip netns exec` remounts /sys, and the cgroup
#     path lookup then fails (seen in the #367 spike)
#   - a ruleset the kernel will not parse (`nft -c`)
# It never flushes: it loads a file that replaces ONE table.
#
# A non-zero exit stops the unit before ExecStart (fail-closed): the worker
# never runs with the fence missing, and the boot log names the reason.
#
# Test seams (never set by the unit): CGROUP_ROOT, EGRESS_ENV, WORKER_CGROUP.

CONF="${1:-}"
WORKER_USER="${WORKER_USER:-automata}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"
WORKER_CGROUP="${WORKER_CGROUP:-system.slice/automata-worker.service}"
EGRESS_ENV="${EGRESS_ENV:-/etc/automata/egress.env}"
TABLE="inet automata_loopback"

fail() { echo "[nft-loopback-load] FAIL: $*" >&2; exit 1; }

[ -n "$CONF" ] || fail "usage: nft-loopback-load.sh <rendered-loopback-nft.conf>"
[ -r "$CONF" ] || fail "cannot read $CONF"
[ "$(id -u)" = "0" ] || fail "must run as root"

grep -q '__AGENT_UID__' "$CONF" && fail "placeholder __AGENT_UID__ is unrendered"
grep -q '__MARK__' "$CONF" && fail "placeholder __MARK__ is unrendered"
grep -q "^table $TABLE\$" "$CONF" || fail "conf does not define table $TABLE"
grep -qE '^\s*flush ruleset' "$CONF" && fail "conf flushes the ruleset — that takes Docker's chains and the engine with it"

# ── mark ────────────────────────────────────────────────────────────────────
# One mark bit, set in `out`, tested in `in`. Both lines must name the same
# value or the input hook judges nothing (or the wrong thing).
MARK_SET="$(grep -oE 'meta mark set meta mark \| 0x[0-9a-fA-F]+' "$CONF" | grep -oE '0x[0-9a-fA-F]+' | sort -u || true)"
MARK_TEST="$(grep -oE 'meta mark & 0x[0-9a-fA-F]+ == 0x[0-9a-fA-F]+' "$CONF" | grep -oE '0x[0-9a-fA-F]+' | sort -u || true)"
[ -n "$MARK_SET" ] || fail "no 'meta mark set meta mark | 0x…' rule in the out chain"
[ "$(printf '%s\n' "$MARK_SET" | grep -c .)" = 1 ] || fail "more than one mark value is set: $(printf '%s' "$MARK_SET" | tr '\n' ' ')"
[ "$MARK_TEST" = "$MARK_SET" ] || fail "the in chain tests mark '$(printf '%s' "$MARK_TEST" | tr '\n' ' ')' but the out chain sets '$MARK_SET'"
MARK="$MARK_SET"
[ "$((MARK))" -ne 0 ] 2>/dev/null || fail "mark $MARK is zero — nothing would be marked"

# ── skuid set ───────────────────────────────────────────────────────────────
# Every `meta skuid` set in the text on stdin — one uid or an anonymous set —
# normalized (sorted, space-separated), one line per DISTINCT set. Same
# extractor as nft-preflight.sh: every rule must fence the same uids.
skuid_sets() {
  grep -oE 'meta skuid (\{ ?[0-9, ]+ ?\}|[0-9]+)' \
    | sed -E 's/meta skuid //; s/[{}]//g; s/,/ /g' \
    | while IFS= read -r set; do
        printf '%s\n' "$set" | tr ' ' '\n' | grep . | sort -n | tr '\n' ' ' | sed 's/ $//'
        printf '\n'
      done | grep . | sort -u
}
SETS="$(skuid_sets <"$CONF" || true)"
[ -n "$SETS" ] || fail "no 'meta skuid <uid>' rule found — refusing to load a fence that fences nobody"
[ "$(printf '%s\n' "$SETS" | grep -c .)" = 1 ] \
  || fail "the skuid sets differ between rules: $(printf '%s' "$SETS" | tr '\n' ';') — every rule must fence the same uids"
UIDS_IN_CONF="$SETS"

WORKER_UID=""
if id -u "$WORKER_USER" >/dev/null 2>&1; then
  WORKER_UID="$(id -u "$WORKER_USER")"
fi
for UID_IN_CONF in $UIDS_IN_CONF; do
  [[ "$UID_IN_CONF" =~ ^[0-9]+$ ]] || fail "malformed uid '$UID_IN_CONF' in the skuid set"
  [ "$UID_IN_CONF" = "0" ] && fail "refusing to fence uid 0"
  if [ -n "$WORKER_UID" ] && [ "$UID_IN_CONF" = "$WORKER_UID" ]; then
    fail "refusing to fence the worker's own uid ($WORKER_UID, $WORKER_USER): it would mark the worker's own loopback traffic and refuse the engine dial — every run on the box"
  fi
done

# #205 slot coverage. The unit gives this script no environment, so the slot
# accounts are read from the egress env file (KEY=VALUE lines, parsed — never
# sourced). An explicit environment wins, for the operator's dry runs.
read_env_key() { # $1 = key
  [ -r "$EGRESS_ENV" ] || return 0
  sed -nE "s/^$1=\"?([^\"]*)\"?\$/\1/p" "$EGRESS_ENV" | tail -1
}
AGENT_USERS="${AGENT_USERS:-$(read_env_key AGENT_USERS)}"
WORKER_AGENT_USER="${WORKER_AGENT_USER:-$(read_env_key WORKER_AGENT_USER)}"
WORKER_BOX_SLOTS="${WORKER_BOX_SLOTS:-$(read_env_key WORKER_BOX_SLOTS)}"
expected_slot_users() {
  if [ -n "${AGENT_USERS:-}" ]; then
    echo "$AGENT_USERS"
  elif [ -n "${WORKER_AGENT_USER:-}" ]; then
    local n="${WORKER_BOX_SLOTS:-1}" i=1 out="$WORKER_AGENT_USER"
    while [ "$i" -lt "$n" ]; do out="$out $WORKER_AGENT_USER-$i"; i=$((i + 1)); done
    echo "$out"
  fi
}
check_slot_coverage() { # $1 = space-separated uids in the fence, $2 = tag
  local users; users="$(expected_slot_users)"
  if [ -z "$users" ]; then
    echo "[$2] note: AGENT_USERS / WORKER_AGENT_USER unset (env and $EGRESS_ENV) — slot-coverage check skipped" >&2
    return 0
  fi
  local u want
  for u in $users; do
    id -u "$u" >/dev/null 2>&1 || fail "slot account $u does not exist on this box"
    want="$(id -u "$u")"
    case " $1 " in
      *" $want "*) ;;
      *) fail "slot account $u (uid $want) is not in the skuid set {$1}: its agent would reach the engine over loopback unfenced — re-render loopback-nft.conf (AGENT-UID-PROVISIONING.md §7)" ;;
    esac
  done
}
check_slot_coverage "$UIDS_IN_CONF" nft-loopback-load

# ── cgroup path ─────────────────────────────────────────────────────────────
# The one rule that lets the proxy and broker through names the worker unit's
# cgroup. A different path is a different fence (a parent slice would admit
# every system service); a missing directory means we are not inside the
# unit's start sequence and the id would be stale by the time the worker runs.
CG_RULE="$(grep -oE 'socket cgroupv2 level [0-9]+ "[^"]+"' "$CONF" | sort -u || true)"
[ -n "$CG_RULE" ] || fail "no 'socket cgroupv2 level N \"path\"' rule — nothing would admit the proxy and broker"
[ "$(printf '%s\n' "$CG_RULE" | grep -c .)" = 1 ] || fail "more than one socket cgroupv2 rule: $(printf '%s' "$CG_RULE" | tr '\n' ';')"
CG_LEVEL="$(printf '%s' "$CG_RULE" | sed -E 's/.*level ([0-9]+) .*/\1/')"
CG_PATH="$(printf '%s' "$CG_RULE" | sed -E 's/.*"([^"]+)"/\1/')"
[ "$CG_PATH" = "$WORKER_CGROUP" ] || fail "socket cgroupv2 path is '$CG_PATH', expected the worker unit's '$WORKER_CGROUP'"
CG_DEPTH="$(printf '%s' "$CG_PATH" | tr '/' '\n' | grep -c .)"
[ "$CG_LEVEL" = "$CG_DEPTH" ] || fail "socket cgroupv2 level $CG_LEVEL does not match the depth ($CG_DEPTH) of '$CG_PATH'"
[ -d "$CGROUP_ROOT/$CG_PATH" ] || fail "cgroup $CGROUP_ROOT/$CG_PATH does not exist — run from the worker unit's ExecStartPre=+, not by hand before the unit starts"

# ── no `ip netns exec` ──────────────────────────────────────────────────────
if command -v ip >/dev/null 2>&1; then
  NETNS="$(ip netns identify 2>/dev/null || true)"
  [ -z "$NETNS" ] || fail "running inside network namespace '$NETNS': ip netns exec remounts /sys and the cgroup path lookup fails"
fi

# ── mark collision ──────────────────────────────────────────────────────────
# The mark bit must be ours alone: another table setting or testing it would
# either admit the agent or fence someone else. Our own table (from an earlier
# load) is excluded from the scan.
RULESET_OTHERS="$(nft list ruleset 2>/dev/null | awk -v t="table $TABLE {" '
  $0 == t { skip = 1; next }
  skip && $0 == "}" { skip = 0; next }
  !skip { print }' || true)"
MARK_HEX="${MARK#0x}"
if printf '%s\n' "$RULESET_OTHERS" | grep -qiE "0x0*${MARK_HEX}\b"; then
  fail "mark $MARK already appears outside $TABLE in the live ruleset — pick another bit"
fi

# Snapshot what Docker owns, so the load can be proven non-destructive.
BEFORE="$(nft list tables 2>/dev/null | grep -c . || true)"
BEFORE="${BEFORE:-0}"

nft -c -f "$CONF" || fail "ruleset does not parse"
nft -f "$CONF" || fail "load failed"

AFTER="$(nft list tables 2>/dev/null | grep -c . || true)"
AFTER="${AFTER:-0}"
if [ "$AFTER" -lt "$BEFORE" ]; then
  fail "table count dropped ${BEFORE} -> ${AFTER}: something flushed the ruleset. Docker's chains may be gone; restart docker and investigate before running anything."
fi

MODE=enforce
grep -q 'log prefix "automata-lo-deny "' "$CONF" && MODE=observe
echo "[nft-loopback-load] OK — mode=${MODE}; uid(s) ${UIDS_IN_CONF}; mark ${MARK}; cgroup ${CG_PATH} (level ${CG_LEVEL}); tables ${BEFORE} -> ${AFTER}"
