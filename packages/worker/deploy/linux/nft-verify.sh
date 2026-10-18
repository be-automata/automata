#!/bin/bash
# Prove the egress fence is loaded AND that it did not cost Docker its chains.
# Read-only; safe to run any time. Root required (nft list needs it).
#
#   nft-verify.sh            static checks of both tables (inet automata_egress,
#                            inet automata_loopback)
#   nft-verify.sh --probe    also runs the #367 loopback probe matrix: connect-
#                            only probes as the agent uid from INSIDE the worker
#                            subtree (a probe from an ssh session lands in the
#                            session scope and tests the wrong thing). It creates
#                            and removes one cgroup, <worker cgroup>/verify-probe,
#                            and starts two throwaway loopback listeners; it sends
#                            no data. Never run it under `ip netns exec`.
set -uo pipefail

PROBE=0
[ "${1:-}" = "--probe" ] && PROBE=1
AGENT_USER="${AGENT_USER:-automata-agent}"
WORKER_USER="${WORKER_USER:-automata}"
WORKER_CGROUP="${WORKER_CGROUP:-/sys/fs/cgroup/system.slice/automata-worker.service}"
ENGINE_BRIDGE_IP="${ENGINE_BRIDGE_IP:-172.18.0.2}"

fail() { echo "[nft-verify] FAIL: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "must run as root"

nft list table inet automata_egress >/dev/null 2>&1 \
  || fail "table inet automata_egress is not loaded"

RULES="$(nft list table inet automata_egress 2>/dev/null)"

echo "$RULES" | grep -q 'hook output' \
  || fail "no output-hook chain — meta skuid is meaningless anywhere else"
echo "$RULES" | grep -q 'oif "lo" accept' \
  || fail "loopback is not accepted first: the per-run proxy and brokers would be fenced too"
echo "$RULES" | grep -qE 'meta skuid [0-9]+ tcp dport' \
  || fail "no tcp skuid rule"
echo "$RULES" | grep -qE 'meta skuid [0-9]+ udp dport' \
  || fail "no udp skuid rule — QUIC/HTTP-3 would bypass the fence over udp/443"

FENCED="$(echo "$RULES" | grep -oE 'meta skuid [0-9]+' | head -1 | awk '{print $3}')"
[ "$FENCED" = "0" ] && fail "uid 0 is fenced"

# The fence must not have cost the box its container networking.
DOCKER_CHAINS="$(nft list ruleset 2>/dev/null | grep -cE 'DOCKER|docker' || true)"
[ "$DOCKER_CHAINS" -gt 0 ] || \
  fail "no docker chains in the ruleset — container networking is probably down (did something flush?)"

# Surface the counters: a rising count is a run trying to egress around the
# cooperative proxy, which is the one thing this backstop exists to catch.
HITS="$(echo "$RULES" | grep -oE 'counter packets [0-9]+' | awk '{s+=$3} END {print s+0}')"

echo "[nft-verify] OK — uid ${FENCED} fenced on tcp+udp 80/443, loopback open, ${DOCKER_CHAINS} docker rules intact, ${HITS} blocked packet(s) so far"

# ── #367: inet automata_loopback ────────────────────────────────────────────
#
# Loaded by automata-worker.service's ExecStartPre, so it exists whenever the
# worker is running. Absent means the worker never started or someone deleted
# the table (the documented immediate rollback).
nft list table inet automata_loopback >/dev/null 2>&1 \
  || fail "table inet automata_loopback is not loaded (the worker unit loads it; see loopback-nft.conf)"
LO_RULES="$(nft list table inet automata_loopback 2>/dev/null)"
echo "$LO_RULES" | grep -q 'socket cgroupv2 level 2 "system.slice/automata-worker.service" accept' \
  || fail "loopback table does not accept the worker subtree: the proxy and git broker would be fenced"
echo "$LO_RULES" | grep -qE 'meta skuid [0-9]+ oif "lo" meta mark set' \
  || fail "loopback table marks nothing: the input-hook check never runs"
LO_UID="$(echo "$LO_RULES" | grep -oE 'meta skuid [0-9]+' | head -1 | awk '{print $3}')"
[ "$LO_UID" = "$FENCED" ] || fail "loopback table fences uid ${LO_UID}, egress table fences uid ${FENCED}"

if echo "$LO_RULES" | grep -qE '\breject\b'; then MODE=enforce; else MODE=observe; fi
lo_hits() { nft list table inet automata_loopback 2>/dev/null | grep -oE 'counter packets [0-9]+' | awk '{s+=$3} END {print s+0}'; }
echo "[nft-verify] OK — loopback fence loaded for uid ${LO_UID} (${MODE}), $(lo_hits) deny packet(s) so far"

[ "$PROBE" = 1 ] || exit 0

# ── Probe matrix ────────────────────────────────────────────────────────────
#
# A "refuse" row passes when the connect is reset in under 1s (enforce) or when
# it raises the deny counter (observe, where it still connects). An "allow" row
# passes when it connects WITHOUT raising the counter, in both modes. A row
# whose target has no listener is SKIPped: a reset from a closed port proves
# nothing about the fence. Counter deltas are box-wide, so run this with no
# agent run in flight.
id -u "$AGENT_USER" >/dev/null 2>&1 || fail "no such user $AGENT_USER (set AGENT_USER)"
[ "$(id -u "$AGENT_USER")" = "$LO_UID" ] || fail "$AGENT_USER is not the fenced uid ${LO_UID}"
[ -d "$WORKER_CGROUP" ] || fail "no worker cgroup at $WORKER_CGROUP — is automata-worker running?"
command -v python3 >/dev/null || fail "python3 is needed for the probe listeners"

PROBE_CG="$WORKER_CGROUP/verify-probe"
LISTENER_PIDS=()
cleanup() {
  for pid in "${LISTENER_PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  # cgroup.kill (kernel >= 5.14) takes anything a listener left behind.
  [ -w "$PROBE_CG/cgroup.kill" ] && echo 1 > "$PROBE_CG/cgroup.kill"
  wait 2>/dev/null
  for _ in $(seq 1 20); do rmdir "$PROBE_CG" 2>/dev/null && break; sleep 0.1; done
  [ -d "$PROBE_CG" ] && echo "[nft-verify] WARN: could not remove $PROBE_CG" >&2
}
trap cleanup EXIT
mkdir -p "$PROBE_CG" || fail "cannot create $PROBE_CG"

# Run "$@" as user $1 inside the probe cgroup.
in_probe_cg() {
  local user="$1"; shift
  bash -c 'echo $$ > "$0/cgroup.procs" && exec runuser -u "$1" -- "${@:2}"' "$PROBE_CG" "$user" "$@"
}

# Start a loopback listener as $1 in the probe cgroup on an ephemeral port;
# prints the port.
start_listener() {
  local out; out="$(mktemp)"
  chmod 0666 "$out"
  in_probe_cg "$1" python3 -c '
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(8)
open(sys.argv[1], "w").write(str(s.getsockname()[1]))
while True:
    c, _ = s.accept(); c.close()' "$out" &
  LISTENER_PIDS+=("$!")
  for _ in $(seq 1 50); do [ -s "$out" ] && break; sleep 0.1; done
  cat "$out"; rm -f "$out"
}

# Is anything on this host listening on $1:$2 (or a wildcard)?
has_listener() {
  local host_re
  case "$1" in
    *:*) host_re="\[${1}\]" ;;
    *) host_re="${1//./\\.}" ;;
  esac
  ss -Hltn "( sport = :$2 )" 2>/dev/null | awk '{print $4}' \
    | grep -qE "^(${host_re}|\*|0\.0\.0\.0|\[::\]):$2$"
}

# Connect-only probe as the agent uid; exit 0 connected, 1 refused, 124 timeout.
# shellcheck disable=SC2016 # expanded by the inner bash, from its arguments
connect() { in_probe_cg "$AGENT_USER" timeout 1 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>/dev/null; }

PASS=0; FAILED=0; SKIPPED=0
row() { # row <allow|refuse> <host> <port> [label]
  local want="$1" host="$2" port="$3" label="${4:-$2:$3}" before after rc
  # The bridge target's listener is in the container's netns, out of ss's view.
  if [ "$host" != "$ENGINE_BRIDGE_IP" ] && ! has_listener "$host" "$port"; then
    echo "  SKIP  $label (no listener)"; SKIPPED=$((SKIPPED + 1)); return
  fi
  before="$(lo_hits)"; connect "$host" "$port"; rc=$?; after="$(lo_hits)"
  local ok=0
  case "$want:$MODE" in
    allow:*) [ "$rc" = 0 ] && [ "$after" = "$before" ] && ok=1 ;;
    refuse:enforce) [ "$rc" = 1 ] && ok=1 ;;
    refuse:observe) [ "$after" -gt "$before" ] && ok=1 ;;
  esac
  if [ "$ok" = 1 ]; then echo "  PASS  $want $label (rc=$rc, deny +$((after - before)))"; PASS=$((PASS + 1))
  else echo "  FAIL  $want $label (rc=$rc, deny +$((after - before)))"; FAILED=$((FAILED + 1)); fi
}

PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')"
WORKER_PORT="$(start_listener "$WORKER_USER")"
OWN_PORT="$(start_listener "$AGENT_USER")"
[ -n "$WORKER_PORT" ] && [ -n "$OWN_PORT" ] || fail "probe listeners did not start"

echo "[nft-verify] loopback probe matrix (${MODE}):"
row refuse 127.0.0.1 7077
row refuse 127.0.0.1 8888
row refuse 127.0.0.1 20241
row refuse "$ENGINE_BRIDGE_IP" 7077
row refuse "$ENGINE_BRIDGE_IP" 8888
[ -n "$PUBLIC_IP" ] && row refuse "$PUBLIC_IP" 22
row refuse ::1 7077
row refuse ::1 8888
row allow 127.0.0.1 "$WORKER_PORT" "worker-uid listener 127.0.0.1:$WORKER_PORT"
row allow 127.0.0.1 "$OWN_PORT" "agent's own listener 127.0.0.1:$OWN_PORT"
row allow 127.0.0.1 25432
BEFORE_DNS="$(lo_hits)"
if in_probe_cg "$AGENT_USER" getent hosts github.com >/dev/null && [ "$(lo_hits)" = "$BEFORE_DNS" ]; then
  echo "  PASS  allow getent hosts github.com"; PASS=$((PASS + 1))
else
  echo "  FAIL  allow getent hosts github.com"; FAILED=$((FAILED + 1))
fi

echo "[nft-verify] probes: ${PASS} pass, ${FAILED} fail, ${SKIPPED} skip; deny counter now $(lo_hits)"
[ "$FAILED" = 0 ] || fail "${FAILED} loopback probe(s) did not match the expected result"
