#!/bin/bash
# Prove the egress fence is loaded AND that it did not cost Docker its chains,
# then (#367) that the loopback layer is loaded and judges a live probe matrix
# the way the Target table says. Root required (nft list needs it). Safe to run
# any time: the probes only open connections from a throwaway cgroup under the
# worker unit (`verify-probe`, removed on exit) and never restart anything.
set -uo pipefail

fail() { echo "[nft-verify] FAIL: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "must run as root"

nft list table inet automata_egress >/dev/null 2>&1 \
  || fail "table inet automata_egress is not loaded"

RULES="$(nft list table inet automata_egress 2>/dev/null)"

echo "$RULES" | grep -q 'hook output' \
  || fail "no output-hook chain — meta skuid is meaningless anywhere else"
echo "$RULES" | grep -q 'oif "lo" accept' \
  || fail "loopback is not accepted first: the per-run proxy and brokers would be fenced too"
# One uid, or an anonymous set at N > 1 (#205). nft prints a single-element
# set back as the bare scalar, so both shapes are legitimate here.
SKUID='meta skuid (\{ ?[0-9, ]+ ?\}|[0-9]+)'
echo "$RULES" | grep -qE "$SKUID tcp dport" \
  || fail "no tcp skuid rule"
echo "$RULES" | grep -qE "$SKUID udp dport" \
  || fail "no udp skuid rule — QUIC/HTTP-3 would bypass the fence over udp/443"

# Every `meta skuid` set in the text on stdin — one uid (`999`) or an anonymous
# set (`{ 999, 2001 }`, #205) — normalized (sorted, space-separated), one line
# per DISTINCT set. The tcp and the udp rule must fence the same uids: a conf
# whose udp set misses a slot would otherwise pass on the tcp set alone and
# leave that slot's QUIC/udp-443 egress with no kernel backstop.
skuid_sets() {
  grep -oE 'meta skuid (\{ ?[0-9, ]+ ?\}|[0-9]+)' \
    | sed -E 's/meta skuid //; s/[{}]//g; s/,/ /g' \
    | while IFS= read -r set; do
        printf '%s\n' "$set" | tr ' ' '\n' | grep . | sort -n | tr '\n' ' ' | sed 's/ $//'
        printf '\n'
      done | grep . | sort -u
}

SETS="$(printf '%s\n' "$RULES" | skuid_sets)"
[ "$(printf '%s\n' "$SETS" | grep -c .)" = 1 ] \
  || fail "the skuid sets differ between rules (tcp vs udp): $(printf '%s' "$SETS" | tr '\n' ';')"
FENCED="$SETS"
for u in $FENCED; do
  [ "$u" = "0" ] && fail "uid 0 is fenced"
done

# #205: every slot account's uid must be in the set, or that slot's agent egresses
# around the cooperative proxy with no kernel backstop while the box boots clean.
# Expected accounts: AGENT_USERS (space-separated) or WORKER_AGENT_USER (+
# WORKER_BOX_SLOTS, default 1 → <user>, <user>-1, ...). Neither set ⇒ the check
# is skipped, and says so.
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
    echo "[$2] note: AGENT_USERS / WORKER_AGENT_USER unset — slot-coverage check skipped" >&2
    return 0
  fi
  local u want
  for u in $users; do
    id -u "$u" >/dev/null 2>&1 || fail "slot account $u does not exist on this box"
    want="$(id -u "$u")"
    case " $1 " in
      *" $want "*) ;;
      *) fail "slot account $u (uid $want) is not in the skuid set {$1}: its agent would egress around the proxy with no kernel backstop — re-render egress-nft.conf (AGENT-UID-PROVISIONING.md §6)" ;;
    esac
  done
}
check_slot_coverage "$FENCED" nft-verify

# The fence must not have cost the box its container networking.
DOCKER_CHAINS="$(nft list ruleset 2>/dev/null | grep -cE 'DOCKER|docker' || true)"
[ "$DOCKER_CHAINS" -gt 0 ] || \
  fail "no docker chains in the ruleset — container networking is probably down (did something flush?)"

# Surface the counters: a rising count is a run trying to egress around the
# cooperative proxy, which is the one thing this backstop exists to catch.
HITS="$(echo "$RULES" | grep -oE 'counter packets [0-9]+' | awk '{s+=$3} END {print s+0}')"

# ── #367: the loopback layer ─────────────────────────────────────────────────
# `inet automata_loopback` is loaded by automata-worker.service's ExecStartPre=+
# (nft-loopback-load.sh) on every start, so its absence is a finding only while
# the worker is active. Structure first, then live probes.
#
# PROBES RUN AS EACH SLOT UID FROM INSIDE THE WORKER SUBTREE. A probe from an
# ssh session sits in the session scope and tests the wrong thing. Root creates
# <unit cgroup>/verify-probe, every probe shell moves itself in before dropping
# to the slot uid, and cgroup.kill + rmdir clean up. Probe LISTENERS are started
# after the move: a socket carries the cgroup of the task that CREATED it
# (measured 2026-10-19), so one created outside and moved in is refused — the
# right answer for anything the agent did not create.
#
# Expected, by mode (the Target column of #367):
#   enforce  deny rows REFUSED (reset, not a timeout) in under 1s; allow rows
#            CONNECTED and the deny counters do not move
#   observe  deny rows each raise the deny counters by ≥ 1 (the connection
#            itself goes through); allow rows CONNECTED and the counters do not
#            move. The probe hits land in the `automata-lo-deny` kernel log —
#            the window printed below is the slice to subtract from criterion 9.
# LOOPBACK_PROBES=0 skips the live probes (structure is still checked).
SVC_CG="${CGROUP_ROOT:-/sys/fs/cgroup}/system.slice/automata-worker.service"
PROBE_CG="$SVC_CG/verify-probe"
LO_SUMMARY="loopback layer: not loaded (worker inactive)"
LO_PROBE_PORT_WORKER="${LO_PROBE_PORT_WORKER:-47011}"
LO_PROBE_PORT_AGENT="${LO_PROBE_PORT_AGENT:-47012}"

lo_deny_hits() {
  nft list table inet automata_loopback 2>/dev/null \
    | grep -E 'log prefix "automata-lo-deny "|reject' \
    | grep -oE 'counter packets [0-9]+' | awk '{s+=$3} END {print s+0}'
}

# lo_connect <user> <host> <port>: TCP connect as <user> from inside the probe
# cgroup. Sets LO_RESULT to CONNECTED / REFUSED / TIMEOUT and LO_MS.
lo_connect() {
  local t0 t1 rc
  t0="$(date +%s%N)"
  bash -c "echo \$\$ > '$PROBE_CG/cgroup.procs' && exec runuser -u '$1' -- timeout 1 bash -c 'exec 3<>/dev/tcp/$2/$3'" >/dev/null 2>&1
  rc=$?
  t1="$(date +%s%N)"
  LO_MS=$(( (t1 - t0) / 1000000 ))
  case "$rc" in
    0) LO_RESULT=CONNECTED ;;
    124) LO_RESULT=TIMEOUT ;;
    *) LO_RESULT=REFUSED ;;
  esac
}

# lo_listen <user> <port>: a TCP listener on 127.0.0.1:<port>, created INSIDE
# the probe cgroup as <user>. Killed by cgroup.kill in lo_probe_cleanup.
lo_listen() {
  bash -c "echo \$\$ > '$PROBE_CG/cgroup.procs' && exec runuser -u '$1' -- python3 -c 'import socket,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind((\"127.0.0.1\",$2)); s.listen(5); time.sleep(300)'" >/dev/null 2>&1 &
  local i=0
  while [ "$i" -lt 20 ]; do
    ss -ltnH "sport = :$2" 2>/dev/null | grep -q . && return 0
    sleep 0.1; i=$((i + 1))
  done
  fail "loopback probe: listener on 127.0.0.1:$2 as $1 did not come up"
}

lo_probe_cleanup() {
  [ -d "$PROBE_CG" ] || return 0
  echo 1 > "$PROBE_CG/cgroup.kill" 2>/dev/null || true
  local i=0
  while [ "$i" -lt 50 ] && [ -s "$PROBE_CG/cgroup.procs" ]; do sleep 0.1; i=$((i + 1)); done
  rmdir "$PROBE_CG" 2>/dev/null || echo "[nft-verify] note: could not remove $PROBE_CG" >&2
}

LO_FAILS=0
lo_row() { # <expect: deny|allow> <label> <user> <host> <port>
  local before after
  before="$(lo_deny_hits)"
  lo_connect "$3" "$4" "$5"
  after="$(lo_deny_hits)"
  local delta=$((after - before)) verdict=ok
  case "$1:$LO_MODE" in
    deny:enforce)
      { [ "$LO_RESULT" = REFUSED ] && [ "$LO_MS" -lt 1000 ]; } || verdict=FAIL ;;
    deny:observe)
      [ "$delta" -ge 1 ] || verdict=FAIL ;;
    allow:*)
      { [ "$LO_RESULT" = CONNECTED ] && [ "$delta" -eq 0 ]; } || verdict=FAIL ;;
  esac
  [ "$verdict" = ok ] || LO_FAILS=$((LO_FAILS + 1))
  printf '[nft-verify]   %-5s %-34s uid %-5s -> %-22s %-9s %5dms deny+%d %s\n' "$1" "$2" "$3" "$4:$5" "$LO_RESULT" "$LO_MS" "$delta" "$verdict"
}

if ! nft list table inet automata_loopback >/dev/null 2>&1; then
  if systemctl is-active --quiet automata-worker.service 2>/dev/null; then
    fail "automata-worker is active but table inet automata_loopback is not loaded — the unit's ExecStartPre=+ loader did not run (installed unit not re-rendered for #367?)"
  fi
  echo "[nft-verify] note: inet automata_loopback is not loaded and the worker is inactive — loopback checks skipped" >&2
else
  LO="$(nft list table inet automata_loopback 2>/dev/null)"
  LO_MODE=enforce
  echo "$LO" | grep -q 'log prefix "automata-lo-deny "' && LO_MODE=observe
  echo "$LO" | grep -q 'hook output' \
    || fail "loopback: no output-hook chain — nothing marks the agent's loopback packets"
  echo "$LO" | grep -qE 'oif "lo" meta mark set' \
    || fail "loopback: no mark rule on oif lo"
  echo "$LO" | grep -q 'hook input' \
    || fail "loopback: no input-hook chain — the receiving socket is only known there"
  echo "$LO" | grep -qE 'iif "lo" meta mark & 0x[0-9a-f]+ == 0x[0-9a-f]+ ct state new jump agent_lo' \
    || fail "loopback: the input chain does not route the agent's new marked connections to agent_lo"
  echo "$LO" | grep -q 'socket cgroupv2 level 2 "system.slice/automata-worker.service"' \
    || fail "loopback: no cgroup admit rule for the worker unit — the proxy and broker would be fenced"
  echo "$LO" | grep -qE '127\.0\.0\.53.*dport 53' \
    || fail "loopback: DNS to systemd-resolved is not admitted"
  echo "$LO" | grep -qE 'tcp dport 25432 counter' \
    || fail "loopback: test Postgres :25432 is not admitted (decision D2)"
  LO_SETS="$(printf '%s\n' "$LO" | skuid_sets)"
  [ "$LO_SETS" = "$FENCED" ] \
    || fail "loopback fences uid(s) {$LO_SETS} but the egress fence covers {$FENCED} — both tables must cover the same slot accounts"
  LO_SUMMARY="loopback layer: loaded, mode=${LO_MODE}, $(lo_deny_hits) deny hit(s) so far"

  if [ "${LOOPBACK_PROBES:-1}" != "0" ]; then
    command -v python3 >/dev/null 2>&1 || fail "loopback probes need python3 (set LOOPBACK_PROBES=0 to skip)"
    [ -d "$SVC_CG" ] || fail "loopback probes: $SVC_CG does not exist — is the worker unit running?"
    WORKER_USER="${WORKER_USER:-automata}"
    id -u "$WORKER_USER" >/dev/null 2>&1 || fail "loopback probes: worker account $WORKER_USER does not exist (WORKER_USER=)"
    BRIDGE_IP=""
    if command -v docker >/dev/null 2>&1; then
      ENGINE_CID="$(docker ps -q -f name=hatchet-lite 2>/dev/null | head -1)"
      [ -n "$ENGINE_CID" ] && BRIDGE_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$ENGINE_CID" 2>/dev/null || true)"
    fi
    PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -nE 's/.* src ([0-9.]+).*/\1/p' | head -1)"
    trap lo_probe_cleanup EXIT
    lo_probe_cleanup
    mkdir "$PROBE_CG" || fail "cannot create $PROBE_CG"
    lo_listen "$WORKER_USER" "$LO_PROBE_PORT_WORKER"
    echo "[nft-verify] loopback probes (mode=${LO_MODE}) start $(date -u +%Y-%m-%dT%H:%M:%SZ) from $PROBE_CG"
    SLOT_I=0
    for u in $FENCED; do
      AGENT_NAME="$(getent passwd "$u" | cut -d: -f1)"
      [ -n "$AGENT_NAME" ] || fail "loopback probes: no account for uid $u"
      # One port per slot account; cgroup.kill reaps every listener at the end.
      AGENT_PORT=$((LO_PROBE_PORT_AGENT + SLOT_I)); SLOT_I=$((SLOT_I + 1))
      lo_listen "$AGENT_NAME" "$AGENT_PORT"
      lo_row deny  "engine gRPC (docker-proxy)"        "$u" 127.0.0.1 7077
      lo_row deny  "engine API (docker-proxy)"         "$u" 127.0.0.1 8888
      lo_row deny  "cloudflared metrics"               "$u" 127.0.0.1 20241
      if [ -n "$BRIDGE_IP" ]; then
        lo_row deny "engine gRPC (bridge)"             "$u" "$BRIDGE_IP" 7077
        lo_row deny "engine API (bridge)"              "$u" "$BRIDGE_IP" 8888
      else
        echo "[nft-verify]   note: engine bridge ip unknown — bridge rows skipped" >&2
      fi
      if [ -n "$PUBLIC_IP" ]; then
        lo_row deny "sshd via the box's public ip"     "$u" "$PUBLIC_IP" 22
      fi
      lo_row deny  "sshd via ::1"                      "$u" ::1 22
      lo_row allow "worker-uid listener (proxy/broker)" "$u" 127.0.0.1 "$LO_PROBE_PORT_WORKER"
      lo_row allow "the slot's own listener"           "$u" 127.0.0.1 "$AGENT_PORT"
      lo_row allow "test Postgres"                     "$u" 127.0.0.1 25432
      if bash -c "echo \$\$ > '$PROBE_CG/cgroup.procs' && exec runuser -u '$AGENT_NAME' -- getent hosts github.com" >/dev/null 2>&1; then
        printf '[nft-verify]   %-5s %-34s uid %-5s -> %-22s %-9s %s\n' allow "DNS (getent hosts github.com)" "$u" 127.0.0.53:53 RESOLVED ok
      else
        LO_FAILS=$((LO_FAILS + 1))
        printf '[nft-verify]   %-5s %-34s uid %-5s -> %-22s %-9s %s\n' allow "DNS (getent hosts github.com)" "$u" 127.0.0.53:53 UNRESOLVED FAIL
      fi
    done
    echo "[nft-verify] loopback probes end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    lo_probe_cleanup
    trap - EXIT
    [ "$LO_FAILS" -eq 0 ] || fail "loopback: $LO_FAILS probe row(s) did not match the Target table for mode=${LO_MODE}"
    LO_SUMMARY="$LO_SUMMARY, probes ok"
  fi
fi

echo "[nft-verify] OK — uid(s) ${FENCED} fenced on tcp+udp 80/443, loopback open, ${DOCKER_CHAINS} docker rules intact, ${HITS} blocked packet(s) so far; ${LO_SUMMARY}"
