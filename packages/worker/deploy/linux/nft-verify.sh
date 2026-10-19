#!/bin/bash
# Prove the egress fence is loaded AND that it did not cost Docker its chains.
# Read-only; safe to run any time. Root required (nft list needs it).
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

FENCED="$(echo "$RULES" | grep -oE "$SKUID" | head -1 \
  | sed -E 's/meta skuid //; s/[{}]//g; s/,/ /g; s/^ +//; s/ +$//')"
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

echo "[nft-verify] OK — uid(s) ${FENCED} fenced on tcp+udp 80/443, loopback open, ${DOCKER_CHAINS} docker rules intact, ${HITS} blocked packet(s) so far"
