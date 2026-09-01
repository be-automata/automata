#!/bin/sh
# pf-preflight.sh — refuse to load the Automata egress anchor unless it fences
# the RIGHT uid (#108, amendment A8). Run as root.
#
# The failure this exists to prevent: loading an anchor whose `user <uid>` still
# renders to the operator's own uid blocks the operator AND the worker — the
# control-plane poll, the git broker's upstream fetch and the credential pull all
# die at once, and every run on the box fails. That is cheap to prevent and
# expensive to diagnose, so it is a script and not a sentence in a runbook.
#
# Usage: sudo ./pf-preflight.sh <agent-user>            # e.g. _automata-agent
set -eu

AGENT_USER="${1:?usage: pf-preflight.sh <agent-user>}"
ANCHOR_FILE="${ANCHOR_FILE:-/etc/pf.anchors/automata-egress}"
WRAPPER_CONF="${WRAPPER_CONF:-/etc/automata-pf.conf}"

fail() { echo "pf-preflight: FAIL: $*" >&2; exit 1; }

[ -f "$ANCHOR_FILE" ]  || fail "$ANCHOR_FILE does not exist"
[ -f "$WRAPPER_CONF" ] || fail "$WRAPPER_CONF does not exist"

# 1. The placeholder must actually have been substituted.
if grep -q "__AGENT_UID__" "$ANCHOR_FILE"; then
  fail "$ANCHOR_FILE still contains __AGENT_UID__ — substitute id -u $AGENT_USER first"
fi

# 2. Every rendered `user <uid>` must name the agent account, and never uid 501.
AGENT_UID="$(id -u "$AGENT_USER" 2>/dev/null)" || fail "no such user: $AGENT_USER"
[ "$AGENT_UID" = "501" ] && fail "$AGENT_USER resolves to uid 501 — that is a login account, not a role account"

RENDERED_UIDS="$(sed -n 's/.*[[:space:]]user[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' "$ANCHOR_FILE" | sort -u)"
[ -n "$RENDERED_UIDS" ] || fail "$ANCHOR_FILE contains no 'user <uid>' rule — it would fence nobody"
for uid in $RENDERED_UIDS; do
  [ "$uid" = "$AGENT_UID" ] || fail "anchor fences uid $uid, but $AGENT_USER is uid $AGENT_UID"
done

# 3. Parse without loading. A bad ruleset must fail HERE, not half-applied.
pfctl -n -f "$WRAPPER_CONF" || fail "pfctl -n -f $WRAPPER_CONF did not parse"

# 4. Load, and enable with -E, NEVER -e. Apple's own /etc/pf.conf header documents
#    the enable REFCOUNT: with -e, any macOS component calling `pfctl -X <token>`
#    drops the count to zero and silently disables PF and our anchor — no log, no
#    error. -E takes a reference nobody else can release on our behalf.
pfctl -E -f "$WRAPPER_CONF"

echo "pf-preflight: loaded $WRAPPER_CONF (anchor fences uid $AGENT_UID / $AGENT_USER)"
