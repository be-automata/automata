#!/bin/bash
set -euo pipefail
# Render-check and (re)load the automata loopback table (#367). Root required.
# Run by automata-worker.service from `ExecStartPre=+`, i.e. after systemd
# created the unit's cgroup and before the worker process exists — the ONLY
# moment the `socket cgroupv2` path can be bound to the cgroup id that the
# worker, its proxy and broker will actually create their sockets under
# (why: see the header of loopback-nft.conf).
#
# Refuses, in this order, before touching the kernel:
#   - an unrendered __AGENT_UID__ or __MARK__, or a global flush
#   - a malformed or zero mark, or set/test lines that disagree
#   - uid 0 or the worker's own uid anywhere in the skuid set; skuid sets that
#     differ between rules
#   - a skuid set that is not EXACTLY the set the egress fence loaded this
#     boot, read from the marker nft-preflight.sh writes only after a
#     successful load (/run/automata/egress-fence.uids). No marker ⇒
#     automata-egress.service has not fenced this boot ⇒ refuse (fail-closed
#     ordering: that unit is Before= the worker). One source of truth for
#     "which uids are the agent", not a second derivation from egress.env.
#   - a `socket cgroupv2` path that is not the worker unit's, a level that does
#     not match the path's depth, or a cgroup directory that does not exist yet
#   - a named network namespace: `ip netns exec` remounts /sys, and the cgroup
#     path lookup then fails (seen in the #367 spike)
#   - a mark whose BITS overlap any mark another table sets or tests
#   - deny verdicts in a mix of forms (half observe, half enforce)
#   - a ruleset the kernel will not parse (`nft -c`)
# It never flushes: it loads a file that replaces ONE table.
#
# A non-zero exit stops the unit before ExecStart (fail-closed): the worker
# never runs with the fence missing, and the boot log names the reason.
#
# Test seams (never set by the unit): CGROUP_ROOT, FENCE_UIDS_FILE, WORKER_CGROUP.

CONF="${1:-}"
WORKER_USER="${WORKER_USER:-automata}"
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"
WORKER_CGROUP="${WORKER_CGROUP:-system.slice/automata-worker.service}"
FENCE_UIDS_FILE="${FENCE_UIDS_FILE:-/run/automata/egress-fence.uids}"
TABLE="inet automata_loopback"
DENY_LOG='log prefix "automata-lo-deny "'

fail() { echo "[nft-loopback-load] FAIL: $*" >&2; exit 1; }

[ -n "$CONF" ] || fail "usage: nft-loopback-load.sh <rendered-loopback-nft.conf>"
[ -r "$CONF" ] || fail "cannot read $CONF"
[ "$(id -u)" = "0" ] || fail "must run as root"

grep -q '__AGENT_UID__' "$CONF" && fail "placeholder __AGENT_UID__ is unrendered"
grep -q '__MARK__' "$CONF" && fail "placeholder __MARK__ is unrendered"
grep -q "^table $TABLE\$" "$CONF" || fail "conf does not define table $TABLE"
grep -qE '^\s*flush ruleset' "$CONF" && fail "conf flushes the ruleset — that takes Docker's chains and the engine with it"

# ── mark ────────────────────────────────────────────────────────────────────
# One mark bit, set in `out`, tested in `in`. Both lines must name the same
# value or the input hook judges nothing (or the wrong thing).
MARK_SET="$(grep -oE 'meta mark set meta mark \| 0x[0-9a-fA-F]+' "$CONF" | grep -oE '0x[0-9a-fA-F]+' | sort -u || true)"
MARK_TEST="$(grep -oE 'meta mark & 0x[0-9a-fA-F]+ == 0x[0-9a-fA-F]+' "$CONF" | grep -oE '0x[0-9a-fA-F]+' | sort -u || true)"
[ -n "$MARK_SET" ] || fail "no 'meta mark set meta mark | 0x…' rule in the out chain"
[ "$(printf '%s\n' "$MARK_SET" | grep -c .)" = 1 ] || fail "more than one mark value is set: $(printf '%s' "$MARK_SET" | tr '\n' ' ')"
[ "$MARK_TEST" = "$MARK_SET" ] || fail "the in chain tests mark '$(printf '%s' "$MARK_TEST" | tr '\n' ' ')' but the out chain sets '$MARK_SET'"
MARK="$MARK_SET"
[ "$((MARK))" -ne 0 ] 2>/dev/null || fail "mark $MARK is zero — nothing would be marked"

# ── skuid set ───────────────────────────────────────────────────────────────
# Every `meta skuid` set in the text on stdin — one uid or an anonymous set —
# normalized (sorted, space-separated), one line per DISTINCT set. Same
# extractor as nft-preflight.sh: every rule must fence the same uids.
skuid_sets() {
  grep -oE 'meta skuid (\{ ?[0-9, ]+ ?\}|[0-9]+)' \
    | sed -E 's/meta skuid //; s/[{}]//g; s/,/ /g' \
    | while IFS= read -r set; do
        printf '%s\n' "$set" | tr ' ' '\n' | grep . | sort -n | tr '\n' ' ' | sed 's/ $//'
        printf '\n'
      done | grep . | sort -u
}
SETS="$(skuid_sets <"$CONF" || true)"
[ -n "$SETS" ] || fail "no 'meta skuid <uid>' rule found — refusing to load a fence that fences nobody"
[ "$(printf '%s\n' "$SETS" | grep -c .)" = 1 ] \
  || fail "the skuid sets differ between rules: $(printf '%s' "$SETS" | tr '\n' ';') — every rule must fence the same uids"
UIDS_IN_CONF="$SETS"

WORKER_UID="$(id -u "$WORKER_USER" 2>/dev/null || true)"
for UID_IN_CONF in $UIDS_IN_CONF; do
  [[ "$UID_IN_CONF" =~ ^[0-9]+$ ]] || fail "malformed uid '$UID_IN_CONF' in the skuid set"
  [ "$UID_IN_CONF" = "0" ] && fail "refusing to fence uid 0"
  if [ -n "$WORKER_UID" ] && [ "$UID_IN_CONF" = "$WORKER_UID" ]; then
    fail "refusing to fence the worker's own uid ($WORKER_UID, $WORKER_USER): it would mark the worker's own loopback traffic and refuse the engine dial — every run on the box"
  fi
done

# The egress fence's marker is the single source of truth for the slot uids
# (#205): written by nft-preflight.sh only after `inet automata_egress` loaded.
[ -r "$FENCE_UIDS_FILE" ] \
  || fail "no $FENCE_UIDS_FILE — automata-egress.service has not loaded the egress fence this boot; the loopback layer never runs ahead of it"
FENCED_UIDS="$(tr ' ' '\n' <"$FENCE_UIDS_FILE" | grep . | sort -n | tr '\n' ' ' | sed 's/ $//')"
[ "$UIDS_IN_CONF" = "$FENCED_UIDS" ] \
  || fail "skuid set {$UIDS_IN_CONF} is not the set the egress fence covers {$FENCED_UIDS} — re-render loopback-nft.conf with the same __AGENT_UID__ as egress-nft.conf (AGENT-UID-PROVISIONING.md §7)"

# ── cgroup path ─────────────────────────────────────────────────────────────
# The one rule that lets the proxy and broker through names the worker unit's
# cgroup. A different path is a different fence (a parent slice would admit
# every system service); a missing directory means the unit is not up, and a
# table bound now would be stale by the time it is.
CG_RULE="$(grep -oE 'socket cgroupv2 level [0-9]+ "[^"]+"' "$CONF" | sort -u || true)"
[ -n "$CG_RULE" ] || fail "no 'socket cgroupv2 level N \"path\"' rule — nothing would admit the proxy and broker"
[ "$(printf '%s\n' "$CG_RULE" | grep -c .)" = 1 ] || fail "more than one socket cgroupv2 rule: $(printf '%s' "$CG_RULE" | tr '\n' ';')"
CG_LEVEL="$(printf '%s' "$CG_RULE" | sed -E 's/.*level ([0-9]+) .*/\1/')"
CG_PATH="$(printf '%s' "$CG_RULE" | sed -E 's/.*"([^"]+)"/\1/')"
[ "$CG_PATH" = "$WORKER_CGROUP" ] || fail "socket cgroupv2 path is '$CG_PATH', expected the worker unit's '$WORKER_CGROUP'"
CG_DEPTH="$(printf '%s' "$CG_PATH" | tr '/' '\n' | grep -c .)"
[ "$CG_LEVEL" = "$CG_DEPTH" ] || fail "socket cgroupv2 level $CG_LEVEL does not match the depth ($CG_DEPTH) of '$CG_PATH'"
[ -d "$CGROUP_ROOT/$CG_PATH" ] || fail "cgroup $CGROUP_ROOT/$CG_PATH does not exist — the worker unit is not up; run from its ExecStartPre=+ (or by hand while it runs)"
# By hand (from an ssh session) the table binds the worker's CURRENT cgroup —
# correct until the next restart, which reloads it from ExecStartPre=+.
HAND_RUN=""
grep -q "/$CG_PATH\(/\|\$\)" /proc/self/cgroup 2>/dev/null || HAND_RUN=" (by hand: bound to the running worker's cgroup; the unit reloads on its next start)"

# ── no `ip netns exec` ──────────────────────────────────────────────────────
if command -v ip >/dev/null 2>&1; then
  NETNS="$(ip netns identify 2>/dev/null || true)"
  [ -z "$NETNS" ] || fail "running inside network namespace '$NETNS': ip netns exec remounts /sys and the cgroup path lookup fails"
fi

# ── mark collision ──────────────────────────────────────────────────────────
# Our mark BIT must be ours alone: a foreign rule that sets or tests an
# overlapping bit would either admit the agent or fence someone else. Our own
# table (from an earlier load) is excluded from the scan.
RULESET_OTHERS="$(nft list ruleset 2>/dev/null | awk -v t="table $TABLE {" '
  $0 == t { skip = 1; next }
  skip && $0 == "}" { skip = 0; next }
  !skip { print }' || true)"
for OTHER in $(printf '%s\n' "$RULESET_OTHERS" | grep -oE 'mark[^0]*0x[0-9a-fA-F]+' | grep -oE '0x[0-9a-fA-F]+' | sort -u); do
  [ "$((OTHER & MARK))" -eq 0 ] 2>/dev/null \
    || fail "mark $MARK overlaps mark $OTHER used outside $TABLE in the live ruleset — pick another bit"
done

# ── one rollout mode, not a mix ─────────────────────────────────────────────
# Every deny verdict is either the observe form (log + accept) or the enforce
# form (reject). A half-flipped file would read as "observe" to the verifier
# while already refusing some rows.
OBSERVE_LINES="$(grep -vE '^\s*#' "$CONF" | grep -c "$DENY_LOG" || true)"
ENFORCE_LINES="$(grep -vE '^\s*#' "$CONF" | grep -c 'counter reject' || true)"
if [ "$OBSERVE_LINES" -gt 0 ] && [ "$ENFORCE_LINES" -gt 0 ]; then
  fail "deny verdicts are mixed: $OBSERVE_LINES observe (log+accept) and $ENFORCE_LINES enforce (reject) — flip all of them together"
fi
[ "$((OBSERVE_LINES + ENFORCE_LINES))" -gt 0 ] || fail "no deny verdict found — a fence that denies nothing"
MODE=enforce
[ "$OBSERVE_LINES" -gt 0 ] && MODE=observe

# Snapshot what Docker owns, so the load can be proven non-destructive.
BEFORE="$(nft list tables 2>/dev/null | grep -c . || true)"

nft -c -f "$CONF" || fail "ruleset does not parse"
nft -f "$CONF" || fail "load failed"

AFTER="$(nft list tables 2>/dev/null | grep -c . || true)"
if [ "$AFTER" -lt "$BEFORE" ]; then
  fail "table count dropped ${BEFORE} -> ${AFTER}: something flushed the ruleset. Docker's chains may be gone; restart docker and investigate before running anything."
fi

echo "[nft-loopback-load] OK — mode=${MODE}; uid(s) ${UIDS_IN_CONF}; mark ${MARK}; cgroup ${CG_PATH} (level ${CG_LEVEL}); tables ${BEFORE} -> ${AFTER}${HAND_RUN}"
