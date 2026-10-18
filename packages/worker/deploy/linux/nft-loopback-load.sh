#!/bin/bash
set -euo pipefail
# Render-check and (re)load the automata loopback table (#367). Root required.
#
# Run by automata-worker.service as `ExecStartPre=+`, AFTER systemd has created
# the unit's cgroup and BEFORE the worker starts: nft binds `socket cgroupv2` to
# the cgroup's inode id at load time, and every worker restart makes a new one.
# A non-zero exit stops the unit before ExecStart, so the worker never runs
# unfenced. See loopback-nft.conf.
#
# Refuses, in this order, before touching the kernel:
#   - an unrendered __AGENT_UID__ or __MARK__
#   - uid 0, or the worker's own uid (same guards as nft-preflight.sh)
#   - a missing worker cgroup: the path would not resolve, or would bind stale
#   - root missing (checked here, after the static guards, so they can be
#     exercised without it)
#   - a mark value some other table already uses
#   - a ruleset the kernel will not parse (`nft -c`)
#
# Never run it under `ip netns exec`: that remounts /sys, and the cgroup path
# lookup then fails. It never flushes; the file replaces ONE table.

CONF="${1:-}"
WORKER_USER="${WORKER_USER:-automata}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"
TABLE="inet automata_loopback"

fail() {
  echo "[nft-loopback-load] FAIL: $*" >&2
  exit 1
}

[ -n "$CONF" ] || fail "usage: nft-loopback-load.sh <rendered-loopback-nft.conf>"
[ -r "$CONF" ] || fail "cannot read $CONF"

for placeholder in __AGENT_UID__ __MARK__; do
  if grep -q "$placeholder" "$CONF"; then
    fail "placeholder $placeholder is unrendered"
  fi
done

UID_IN_CONF="$(grep -oE 'meta skuid [0-9]+' "$CONF" | head -1 | awk '{print $3}' || true)"
[ -n "$UID_IN_CONF" ] || fail "no 'meta skuid <uid>' rule found — refusing to load a fence that fences nobody"
[ "$UID_IN_CONF" = "0" ] && fail "refusing to fence uid 0"

if id -u "$WORKER_USER" >/dev/null 2>&1; then
  WORKER_UID="$(id -u "$WORKER_USER")"
  [ "$UID_IN_CONF" = "$WORKER_UID" ] &&
    fail "refusing to fence the worker's own uid ($WORKER_UID, $WORKER_USER): the git broker, the proxy and the engine poll all run as it"
fi

MARK="$(grep -oE 'meta mark set meta mark \| 0x[0-9a-fA-F]+' "$CONF" | head -1 | awk '{print $NF}' || true)"
[ -n "$MARK" ] || fail "no 'meta mark set meta mark | <mark>' rule found"

CGROUP_PATH="$(grep -oE 'socket cgroupv2 level [0-9]+ "[^"]+"' "$CONF" | head -1 | sed -E 's/.*"([^"]+)"/\1/' || true)"
[ -n "$CGROUP_PATH" ] || fail "no 'socket cgroupv2 level <n> \"<path>\"' rule found"
[ -d "$CGROUP_ROOT/$CGROUP_PATH" ] ||
  fail "cgroup $CGROUP_ROOT/$CGROUP_PATH does not exist: run this from the worker unit's ExecStartPre, never at boot or under ip netns exec"

[ "$(id -u)" = "0" ] || fail "must run as root"

# Mark collision: any other table using our bit would have its packets judged
# by this fence, or ours by it. Our own table is skipped (a reload sees it).
OTHER_MARKS="$(nft list ruleset | awk -v t="table $TABLE {" '
  $0 == t { skip = 1; next }
  skip && $0 == "}" { skip = 0; next }
  !skip' | grep -ci -- "$MARK" || true)"
[ "$OTHER_MARKS" = "0" ] || fail "mark $MARK is already used outside table $TABLE ($OTHER_MARKS line(s)); pick another bit"

BEFORE="$(nft list tables | grep -c . || true)"

# Parse-only first. A bad ruleset must never reach the kernel.
nft -c -f "$CONF" || fail "ruleset does not parse"
nft -f "$CONF" || fail "load failed"

AFTER="$(nft list tables | grep -c . || true)"
if [ "$AFTER" -lt "$BEFORE" ]; then
  fail "table count dropped ${BEFORE} -> ${AFTER}: something flushed the ruleset. Docker's chains may be gone; restart docker and investigate before running anything."
fi

echo "[nft-loopback-load] OK — uid ${UID_IN_CONF} loopback-fenced by listener cgroup ${CGROUP_PATH}, mark ${MARK}; tables ${BEFORE} -> ${AFTER}"
