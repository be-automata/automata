#!/bin/bash
# Render-check and load the automata egress table (#192 P7). Root required.
#
# Refuses, in this order, before touching the kernel:
#   - an unrendered __AGENT_UID__
#   - uid 0, or the uid of the account the worker itself runs as, anywhere in
#     the skuid set (#205: one uid per box slot) — fencing either kills every
#     run on the box, and both are one typo away
#   - a slot account (AGENT_USERS / WORKER_AGENT_USER + WORKER_BOX_SLOTS) whose
#     uid is missing from the set — a fence that skips a slot is no fence
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
check_slot_coverage "$UIDS_IN_CONF" nft-preflight

# Snapshot what Docker owns, so the load can be proven non-destructive.
BEFORE="$(nft list tables 2>/dev/null | grep -c . || echo 0)"

# Parse-only first. A bad ruleset must never reach the kernel.
nft -c -f "$CONF" || fail "ruleset does not parse"

nft -f "$CONF" || fail "load failed"

AFTER="$(nft list tables 2>/dev/null | grep -c . || echo 0)"
if [ "$AFTER" -lt "$BEFORE" ]; then
  fail "table count dropped ${BEFORE} -> ${AFTER}: something flushed the ruleset. Docker's chains may be gone; restart docker and investigate before running anything."
fi

# #205: record what the loaded fence covers, for the worker's boot check. At
# WORKER_BOX_SLOTS > 1 the worker refuses to boot unless every slot uid is in
# this file — written ONLY after a successful load, on tmpfs so a boot where
# this unit never ran has no file to show.
FENCE_UIDS_FILE="${FENCE_UIDS_FILE:-/run/automata/egress-fence.uids}"
install -d -m 755 "$(dirname "$FENCE_UIDS_FILE")" || fail "cannot create $(dirname "$FENCE_UIDS_FILE")"
printf '%s\n' "$UIDS_IN_CONF" > "$FENCE_UIDS_FILE" || fail "cannot write $FENCE_UIDS_FILE"
chmod 644 "$FENCE_UIDS_FILE"

echo "[nft-preflight] OK — fencing uid(s) ${UIDS_IN_CONF}; tables ${BEFORE} -> ${AFTER}; recorded in ${FENCE_UIDS_FILE}"
