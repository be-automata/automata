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
