#!/bin/sh
# pf-verify.sh — prove the Automata egress anchor is ACTUALLY loaded and PF is on.
# Run as root, after boot and after any OS update. Never assume the boot path
# stayed wired: an OS update rewrites /etc/pf.conf, and a stray `pfctl -X` can
# drop the enable refcount.
set -eu

fail() { echo "pf-verify: FAIL: $*" >&2; exit 1; }

pfctl -s info 2>/dev/null | grep -q "Status: Enabled" || fail "PF is not enabled"

RULES="$(pfctl -a automata-egress -sr 2>/dev/null || true)"
[ -n "$RULES" ] || fail "anchor automata-egress has NO rules loaded"

echo "$RULES" | grep -q "on lo0" || fail "anchor is missing the loopback pass rule (the proxy path would be blocked)"
echo "$RULES" | grep -q "block"  || fail "anchor is missing its block rule"

echo "pf-verify: OK"
echo "$RULES"
