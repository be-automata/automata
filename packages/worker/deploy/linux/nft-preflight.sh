#!/bin/bash
# Render-check and load the automata egress table (#192 P7). Root required.
#
# Refuses, in this order, before touching the kernel:
#   - an unrendered __AGENT_UID__
#   - uid 0, or the uid of the account the worker itself runs as, anywhere in
#     the skuid set (#205: one uid per box slot) — fencing either kills every
#     run on the box, and both are one typo away
#   - a ruleset the kernel will not parse (`nft -c`)
#
# It never flushes: it loads a file that replaces ONE table. See egress-nft.conf
# for why a global flush would take Docker's chains — and the engine — with it.
set -uo pipefail

CONF="${1:-}"
WORKER_USER="${WORKER_USER:-automata}"

fail() { echo "[nft-preflight] FAIL: $*" >&2; exit 1; }

[ -n "$CONF" ] || fail "usage: nft-preflight.sh <rendered-egress-nft.conf>"
[ -r "$CONF" ] || fail "cannot read $CONF"
[ "$(id -u)" = "0" ] || fail "must run as root"

grep -q '__AGENT_UID__' "$CONF" && fail "placeholder __AGENT_UID__ is unrendered"

# One uid (`meta skuid 999`) or an anonymous set (`meta skuid { 999, 2001 }`,
# #205: one slot account per box slot). Every uid in it is checked.
UIDS_IN_CONF="$(grep -oE 'meta skuid (\{[0-9, ]+\}|[0-9]+)' "$CONF" | head -1 \
  | sed -E 's/meta skuid //; s/[{}]//g; s/,/ /g')"
[ -n "${UIDS_IN_CONF// /}" ] || fail "no 'meta skuid <uid>' rule found — refusing to load a fence that fences nobody"

WORKER_UID=""
if id -u "$WORKER_USER" >/dev/null 2>&1; then
  WORKER_UID="$(id -u "$WORKER_USER")"
fi
for UID_IN_CONF in $UIDS_IN_CONF; do
  [[ "$UID_IN_CONF" =~ ^[0-9]+$ ]] || fail "malformed uid '$UID_IN_CONF' in the skuid set"
  [ "$UID_IN_CONF" = "0" ] && fail "refusing to fence uid 0"
  if [ -n "$WORKER_UID" ] && [ "$UID_IN_CONF" = "$WORKER_UID" ]; then
    fail "refusing to fence the worker's own uid ($WORKER_UID, $WORKER_USER): it would kill the control-plane poll, the git broker fetch and the credential pull — every run on the box"
  fi
done

# Snapshot what Docker owns, so the load can be proven non-destructive.
BEFORE="$(nft list tables 2>/dev/null | grep -c . || echo 0)"

# Parse-only first. A bad ruleset must never reach the kernel.
nft -c -f "$CONF" || fail "ruleset does not parse"

nft -f "$CONF" || fail "load failed"

AFTER="$(nft list tables 2>/dev/null | grep -c . || echo 0)"
if [ "$AFTER" -lt "$BEFORE" ]; then
  fail "table count dropped ${BEFORE} -> ${AFTER}: something flushed the ruleset. Docker's chains may be gone; restart docker and investigate before running anything."
fi

echo "[nft-preflight] OK — fencing uid(s) ${UIDS_IN_CONF}; tables ${BEFORE} -> ${AFTER}"
