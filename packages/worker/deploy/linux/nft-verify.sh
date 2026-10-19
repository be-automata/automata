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

# The fence must not have cost the box its container networking.
DOCKER_CHAINS="$(nft list ruleset 2>/dev/null | grep -cE 'DOCKER|docker' || true)"
[ "$DOCKER_CHAINS" -gt 0 ] || \
  fail "no docker chains in the ruleset — container networking is probably down (did something flush?)"

# Surface the counters: a rising count is a run trying to egress around the
# cooperative proxy, which is the one thing this backstop exists to catch.
HITS="$(echo "$RULES" | grep -oE 'counter packets [0-9]+' | awk '{s+=$3} END {print s+0}')"

echo "[nft-verify] OK — uid(s) ${FENCED} fenced on tcp+udp 80/443, loopback open, ${DOCKER_CHAINS} docker rules intact, ${HITS} blocked packet(s) so far"
