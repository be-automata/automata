#!/bin/bash
set -euo pipefail
umask 077
#
# opensandbox-evidence-renew.sh — the weekly renewal of the opensandbox/runc
# conformance evidence (#709). Oneshot, driven by automata-cell-evidence.timer,
# as root. Installed by install-opensandbox.sh.
#
# cell-plan refuses every cell with egress_not_enforced once the profile's
# evidence is older than 30 days. This runs the OPENSANDBOX_IT live suite (a
# throwaway OpenSandbox in a privileged dind on the host's rootful Docker,
# packages/sandbox/opensandbox-it/up.sh) and, on a full pass, pushes the result
# with packages/sandbox/opensandbox-it/push-evidence.sh. www judges the checks
# and records the rows; this script only reports.
#
# It skips (exit 0, one `skip:` line) when a cell exists on the box's OpenSandbox
# server (metadata automata=cell, the tag every cell carries), when a hand-run
# IT is up (an osbit=1 container: up.sh would remove it), or when another
# renewal holds the lock.
#
# Config, root-only (0600), the same file as the box evidence:
#   /etc/automata/profile-evidence.env
#     AUTOMATA_WWW_URL=https://<www host>
#     PROFILE_EVIDENCE_SECRET=<same value as the www Worker secret>
# The OpenSandbox API key comes from /etc/automata/opensandbox.env.
#
# The journal gets fixed lines, counts, the host, expiresAt and enum codes only:
# never a secret, never the IT output (that goes to $STATE/last-it.log, 0600).
#
# Usage: opensandbox-evidence-renew.sh [--dry-run]
#   --dry-run  run the read-only checks and print the plan; run and push nothing

CONFIG="${CELL_EVIDENCE_CONFIG:-/etc/automata/profile-evidence.env}"
OSB_KEY_FILE="${CELL_EVIDENCE_OSB_KEY_FILE:-/etc/automata/opensandbox.env}"
OSB_URL="${CELL_EVIDENCE_OSB_URL:-http://127.0.0.1:8090}"
PLATFORM="${CELL_EVIDENCE_PLATFORM:-/opt/automata-platform}"
STATE="${STATE_DIRECTORY:-/var/lib/automata-cell-evidence}"
LOCK="${CELL_EVIDENCE_LOCK:-/run/automata-cell-evidence.lock}"
IT_TIMEOUT_S="${CELL_EVIDENCE_IT_TIMEOUT_S:-1800}"
# The dind pulls the OpenSandbox BOM images into the host Docker's store.
MIN_FREE_GB="${CELL_EVIDENCE_MIN_FREE_GB:-10}"
IT_TEST=src/providers/opensandbox-cell.integration.test.ts
EVIDENCE="$STATE/opensandbox-runc-conformance.json"

# Root must not rewrite the automata-owned .git/index on a read-only `git status`
# (here or in the IT's own call): no opportunistic index refresh.
export GIT_OPTIONAL_LOCKS=0
# Every docker call here, the IT's and down.sh's included, talks to the same
# daemon: the host's default (rootful) one.
unset DOCKER_HOST

log() { echo "[cell-evidence] $*"; }
fail() {
  echo "[cell-evidence] FAIL: $*" >&2
  exit 1
}

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

[ "$(id -u)" -eq 0 ] || fail "run as root"
for bin in curl docker flock git jq pnpm timeout; do
  command -v "$bin" >/dev/null 2>&1 || fail "$bin is not installed"
done

exec 9>"$LOCK"
if ! flock -n 9; then
  log "skip: another renewal holds $LOCK"
  exit 0
fi

install -d -m 0700 "$STATE"
tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# ── config: two names, read with grep; never `source`d, never echoed ─────────
[ -r "$CONFIG" ] || fail "$CONFIG missing (packages/worker/deploy/README.md, \"OpenSandbox cells\", step 8)"
www="$(grep -E '^AUTOMATA_WWW_URL=' "$CONFIG" | head -1 | cut -d= -f2- || true)"
secret="$(grep -E '^PROFILE_EVIDENCE_SECRET=' "$CONFIG" | head -1 | cut -d= -f2- || true)"
case "$www" in https://*) ;; *) fail "AUTOMATA_WWW_URL must be https://" ;; esac
[ -n "$secret" ] || fail "PROFILE_EVIDENCE_SECRET is empty"
www_host="${www#https://}"
www_host="${www_host%%/*}"

# ── preflight: a clean checkout (www refuses a -dirty platformSha) ───────────
# systemd gives root no HOME, so root's global safe.directory is not read: name
# the one directory, here and (by environment) for the IT's own git calls.
git_p() { git -c safe.directory="$PLATFORM" -C "$PLATFORM" "$@"; }
sha="$(git_p rev-parse --short HEAD)" || fail "no platform checkout at $PLATFORM"
changes="$(git_p status --porcelain)" || fail "git status failed in $PLATFORM"
[ -z "$changes" ] || fail "the checkout at $PLATFORM has local changes; the evidence would be -dirty"
owner="$(stat -c '%u:%g' "$PLATFORM")"
docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)" || fail "the host Docker does not answer (the IT runs a privileged dind on it)"
free_gb="$(df --output=avail -BG "$docker_root" | awk 'NR == 2 {gsub(/G/, "", $1); print $1}')"
[ "${free_gb:-0}" -ge "$MIN_FREE_GB" ] || fail "only ${free_gb:-0} GB free under $docker_root, need $MIN_FREE_GB GB for the IT's images"

# ── idle check: no cell on the box's OpenSandbox, no hand-run IT ─────────────
# The key reaches curl through a 0600 header file, never argv.
[ -r "$OSB_KEY_FILE" ] || fail "$OSB_KEY_FILE missing (install-opensandbox.sh)"
sed -n 's/^OPENSANDBOX_API_KEY=/OPEN-SANDBOX-API-KEY: /p' "$OSB_KEY_FILE" >"$tmp/osb-headers"
code="$(curl -sS --max-time 10 -o "$tmp/cells.json" -w '%{http_code}' -H "@$tmp/osb-headers" \
  "${OSB_URL%/}/sandboxes?metadata=automata%3Dcell&page=1&pageSize=100")" || fail "the OpenSandbox server at $OSB_URL does not answer"
rm -f "$tmp/osb-headers"
[ "$code" = 200 ] || fail "GET /sandboxes answered $code"
# The page shape the cell adapter reads (items[].metadata, pagination.hasNextPage).
# The tag is re-checked here, and a malformed page, or a further page after one
# with no cell, fails closed: the box is never called idle without knowing.
cells="$(jq -er '
  if (.items // []) | type != "array" then error("items") else . end
  | ([(.items // [])[] | select(.metadata.automata == "cell")] | length) as $n
  | if $n == 0 and .pagination.hasNextPage == true then error("paged") else $n end
' "$tmp/cells.json" 2>/dev/null)" || fail "GET /sandboxes answered a page this script cannot count"
if [ "$cells" -gt 0 ]; then
  log "skip: $cells cell(s) live on the OpenSandbox server (metadata automata=cell); evidence not renewed this run"
  exit 0
fi
# Running ones only: a stopped osbit-dind left by a crash or a reboot would
# otherwise make every later run skip, and up.sh removes it anyway.
its="$(docker ps -q --filter label=osbit=1 --filter status=running | wc -l | tr -d ' ')" || fail "docker ps failed on the host Docker"
if [ "$its" -gt 0 ]; then
  log "skip: an OPENSANDBOX_IT run is up on the host Docker ($its osbit=1 container(s)); evidence not renewed this run"
  exit 0
fi

log "host=$(hostname -s) platform=$sha cells=0 push-to=$www_host"
if [ "$dry_run" -eq 1 ]; then
  log "dry run, plan: OPENSANDBOX_IT=1 OPENSANDBOX_IT_STATE=$STATE pnpm --filter @terragon/sandbox exec vitest run $IT_TEST (in $PLATFORM, up to ${IT_TIMEOUT_S}s), then push-evidence.sh to https://$www_host"
  log "dry run: nothing run, nothing pushed"
  exit 0
fi

# ── the IT; its output stays in a 0600 file, never the journal ───────────────
rm -f "$EVIDENCE"
it_rc=0
# `9>&-` on every child: an orphan must never keep holding the lock.
(
  cd "$PLATFORM" || exit 1
  env HOME="$STATE" CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    OPENSANDBOX_IT=1 OPENSANDBOX_IT_STATE="$STATE" \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$PLATFORM" \
    timeout -k 60 "$IT_TIMEOUT_S" pnpm --filter @terragon/sandbox exec \
    vitest run --no-cache --no-file-parallelism "$IT_TEST"
) >"$STATE/last-it.log" 2>&1 9>&- || it_rc=$?
# A timed-out or crashed run can skip the IT's own teardown; with the lock held
# and no running osbit container before the run, whatever is left is this run's.
bash "$PLATFORM/packages/sandbox/opensandbox-it/down.sh" >>"$STATE/last-it.log" 2>&1 9>&- || true
# Whatever the run left under the package as root goes back to the checkout's owner.
find "$PLATFORM/packages/sandbox" -xdev -user 0 -exec chown -h "$owner" {} + 2>/dev/null || true
[ "$it_rc" -eq 0 ] || fail "OPENSANDBOX_IT failed (exit $it_rc); see $STATE/last-it.log"
[ -s "$EVIDENCE" ] || fail "OPENSANDBOX_IT passed but wrote no evidence file"
log "OPENSANDBOX_IT passed"

# ── the push. `secret` is a shell variable, never exported: only push-evidence.sh
# gets it, in its own environment (never argv); the IT, up.sh and vitest never do.
push_rc=0
PROFILE_EVIDENCE_SECRET="$secret" OPENSANDBOX_IT_STATE="$STATE" \
  "$PLATFORM/packages/sandbox/opensandbox-it/push-evidence.sh" "$www" >"$tmp/reply.json" 2>"$tmp/push.err" 9>&- || push_rc=$?
if [ "$push_rc" -ne 0 ] || ! jq -e '.recorded == true' "$tmp/reply.json" >/dev/null 2>&1; then
  # curl's own error (DNS, TLS) names only the URL: the secret went on its stdin.
  { echo "--- push-evidence.sh stderr"; cat "$tmp/push.err"; } >>"$STATE/last-it.log"
  why="$(jq -r '[.error, .reason] | map(select(. != null)) | join(" ") | select(. != "")' "$tmp/reply.json" 2>/dev/null || true)"
  fail "www did not record the evidence (push exit $push_rc${why:+, $why}); see $STATE/last-it.log"
fi
rows="$(jq -r '.rows' "$tmp/reply.json")"
expires="$(jq -r '.expiresAt' "$tmp/reply.json")"
log "renewed: rows=$rows expiresAt=$expires"
