#!/bin/bash
set -euo pipefail
# verify.sh IMAGE: offline smoke test of a built cell image (#656 PR-F).
#
# One throwaway container with the cell's hardening: no network, no
# capabilities, no-new-privileges, --init. The rootfs stays writable, as in a
# cell. Checks identity, the baked bundle and scripts, absolute node, that no
# credential name or file is in the image, the CA config, the entry's
# refusals and a daemon start-and-message round trip.
# Exit 0 = every check passed; 1 = at least one failed; 2 = usage/docker error.
#
#   deploy/images/cell/verify.sh automata-cell:ci
#   deploy/images/cell/verify.sh ghcr.io/be-automata/automata-cell@sha256:<digest>
#
# Prints one line per check. Never needs a credential.
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 IMAGE" >&2
  exit 2
fi
image="$1"

if ! command -v docker >/dev/null 2>&1; then
  echo "verify: docker not found" >&2
  exit 2
fi

rc=0
docker run --rm -i --platform linux/amd64 --network none \
  --cap-drop ALL --security-opt no-new-privileges --init \
  --entrypoint /bin/bash "$image" -s <<'IN_CONTAINER' || rc=$?
set -uo pipefail
fail=0
NODE=/usr/local/bin/node
BUNDLE=/opt/automata-daemon/index.js
ENTRY=/opt/automata/cell-entry.sh
SEND=/opt/automata/cell-send.sh
CA=/home/agent/.opensandbox/merged-ca-certificates.pem

ok() { printf 'ok   %-22s %s\n' "$1" "$2"; }
bad() { printf 'FAIL %-22s %s\n' "$1" "$2"; fail=1; }

# assert NAME DETAIL COMMAND...: pass when COMMAND exits 0.
assert() {
  local name="$1" detail="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then ok "$name" "$detail"; else bad "$name" "$detail"; fi
}

# expect_exit NAME WANT CMD...: pass when CMD exits WANT.
expect_exit() {
  local name="$1" want="$2" got
  shift 2
  "$@" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then ok "$name" "exit $want"; else bad "$name" "want exit $want, got $got"; fi
}

# ── identity ────────────────────────────────────────────────────────────────
assert identity-uid "uid=$(id -u)" test "$(id -u)" -eq 10001
assert identity-home "HOME=$HOME" test "$HOME" = /home/agent

# ── the baked bundle ────────────────────────────────────────────────────────
assert bundle-mode "root-owned, 0444" test "$(stat -c '%U %a' "$BUNDLE")" = "root 444"
version="$($NODE "$BUNDLE" --version 2>&1)"
case "$version" in
  "Terragon Daemon v"[0-9]*) ok bundle-version "$version" ;;
  *) bad bundle-version "got: $version" ;;
esac

# ── absolute node ───────────────────────────────────────────────────────────
# PATH starts with an agent-writable dir, so the scripts must never resolve
# node through it.
assert node-owner "$NODE is root-owned, not writable by uid 10001" \
  bash -c "test -x $NODE && test \"\$(stat -c %U $NODE)\" = root && ! test -w $NODE"
assert scripts-mode "entry and send are root-owned, 0555" \
  bash -c "test \"\$(stat -c '%U %a' $ENTRY)\" = 'root 555' && test \"\$(stat -c '%U %a' $SEND)\" = 'root 555'"
bare=0
for s in "$ENTRY" "$SEND"; do
  grep -qF "$NODE" "$s" || bare=1
  grep -vE '^[[:space:]]*#' "$s" | grep -qE '(^|[[:space:];|&(])node([[:space:]]|$)' && bare=1
done
assert node-absolute "scripts name only $NODE" test "$bare" -eq 0

# ── no credential in the image ──────────────────────────────────────────────
allow=" $(sed -n 's/^allow="\(.*\)"$/\1/p' "$ENTRY") "
leaks=""
while IFS= read -r name; do
  case "$allow" in *" $name "*) continue ;; esac
  name_uc="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
  if printf '%s' "$name_uc" | grep -qE 'TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL'; then leaks="$leaks $name"; fi
  case "$name" in AWS_*) leaks="$leaks $name" ;; esac
done < <(compgen -e)
assert no-credential-env "no credential-shaped env name${leaks:+ (found:$leaks)}" test -z "$leaks"
assert allow-list-read "the entry's allow list is non-empty" test "${#allow}" -gt 10
assert no-settings "no ~/.claude/settings.json" test ! -e "$HOME/.claude/settings.json"
assert no-claude-json "no ~/.claude.json" test ! -e "$HOME/.claude.json"
assert no-credentials-file "no ~/.claude/.credentials.json" test ! -e "$HOME/.claude/.credentials.json"

# ── CA config for a non-root guest ──────────────────────────────────────────
assert ca-merged-path "OPENSANDBOX_MERGED_CA_PATH=$CA" test "${OPENSANDBOX_MERGED_CA_PATH:-}" = "$CA"
assert ca-git-cainfo "GIT_SSL_CAINFO=$CA" test "${GIT_SSL_CAINFO:-}" = "$CA"
assert ca-dir-creatable "uid 10001 can create ~/.opensandbox" mkdir -p "$(dirname "$CA")"
# GIT_SSL_CAINFO is only needed while git links libcurl-gnutls (it ignores
# SSL_CERT_FILE). If it does not, fix the Decisions text, not this check.
if ldd "$(git --exec-path)/git-remote-https" 2>/dev/null | grep -q libcurl-gnutls; then
  ok git-libcurl "git-remote-https links libcurl-gnutls"
else
  bad git-libcurl "git-remote-https does not link libcurl-gnutls: GIT_SSL_CAINFO is not needed"
fi

# ── PATH ────────────────────────────────────────────────────────────────────
case "$PATH" in
  /home/agent/.automata-run/flutter-pin:*) ok path-shim-first "PATH starts with the shim dir" ;;
  *) bad path-shim-first "PATH=$PATH" ;;
esac

# ── the entry's refusals ────────────────────────────────────────────────────
expect_exit entry-no-args 64 "$ENTRY"
expect_exit entry-http 64 "$ENTRY" --url http://x
expect_exit entry-bad-host 64 "$ENTRY" --url 'https://a;b'
canary="canary-$$-$RANDOM"
out="$(DAEMON_TOKEN="$canary" "$ENTRY" --url https://example.org 2>&1)"
status=$?
if [ "$status" -ne 78 ]; then
  bad entry-env-refusal "want exit 78, got $status"
elif printf '%s' "$out" | grep -qF "$canary"; then
  bad entry-env-refusal "the canary value was echoed"
else
  ok entry-env-refusal "exit 78, canary not echoed"
fi

# ── round trip: the daemon starts and accepts a message ─────────────────────
"$ENTRY" --url https://example.org >/dev/null 2>&1 &
daemon=$!
sock="$HOME/.automata-run/daemon.sock"
for _ in $(seq 1 100); do
  [ -S "$sock" ] && break
  sleep 0.1
done
assert daemon-socket "socket appears within 10s" test -S "$sock"
msg="$(printf '{"type":"ping"}' | base64 -w0)"
expect_exit send-roundtrip 0 "$SEND" "$msg"
kill "$daemon" 2>/dev/null
wait "$daemon" 2>/dev/null

if [ "$fail" -eq 0 ]; then echo "verify: all checks passed"; fi
exit "$fail"
IN_CONTAINER
# 0 and 1 are the checks' own verdict; any other code is docker failing.
case "$rc" in 0 | 1) exit "$rc" ;; *) echo "verify: docker run failed (exit $rc)" >&2; exit 2 ;; esac
