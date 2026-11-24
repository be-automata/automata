#!/bin/bash
set -euo pipefail
#
# Tell Slack when the execution box disk fills up, before runs start failing
# (2026-11-24: the disk reached 100% at 15:59 UTC and every run failed
# `No space left on device` for four hours before anyone looked). Root
# required; driven every 10 minutes by automata-disk-alert.timer.
#
# One message when the filesystem holding the run dirs crosses ALERT_PCT
# (default 85) and one when it drops back under CLEAR_PCT (default 80), so a
# disk sitting at 86% does not post every 10 minutes. The last state is kept
# in STATE_DIR.
#
# The Slack incoming-webhook URL is a secret: it lives in a root-only file
# (0600) and goes to curl through a config on stdin, never argv, so `ps` and
# the journal never see it. No file means no alert: the check still runs and
# logs, and says the webhook is missing.

ALERT_PCT="${DISK_ALERT_PCT:-85}"
CLEAR_PCT="${DISK_CLEAR_PCT:-80}"
MOUNT="${DISK_ALERT_MOUNT:-/usr/local/automata/runs}"
URL_FILE="${DISK_ALERT_URL_FILE:-/etc/automata/slack-disk-alert.url}"
STATE_DIR="${DISK_ALERT_STATE_DIR:-/var/lib/automata-disk-alert}"
BOX="${DISK_ALERT_BOX:-$(hostname -s)}"
CURL="${DISK_ALERT_CURL:-curl}"
DF="${DISK_ALERT_DF:-df}"

log() { echo "[disk-alert] $*"; }
fail() {
  echo "[disk-alert] FAIL: $*" >&2
  exit 1
}

if [ -z "${DISK_ALERT_SKIP_ROOT_CHECK:-}" ]; then
  [ "$(id -u)" = "0" ] || fail "must run as root"
fi
[[ "$ALERT_PCT" =~ ^[0-9]+$ ]] && [[ "$CLEAR_PCT" =~ ^[0-9]+$ ]] ||
  fail "DISK_ALERT_PCT and DISK_CLEAR_PCT must be whole numbers"
[ "$CLEAR_PCT" -lt "$ALERT_PCT" ] || fail "DISK_CLEAR_PCT must be below DISK_ALERT_PCT"

# The nearest existing ancestor: a fresh box may have no run root yet.
target="$MOUNT"
while [ ! -e "$target" ] && [ "$target" != "/" ]; do target="$(dirname "$target")"; done

read -r used avail <<<"$("$DF" -P -B1G --output=pcent,avail "$target" | tail -n 1 | tr -d '%')"
# GNU df prints `-BG` sizes with or without a G suffix depending on the form.
avail="${avail//[!0-9]/}"
[[ "$used" =~ ^[0-9]+$ ]] && [ -n "$avail" ] || fail "could not read disk usage for $target"

install -d -m 0700 "$STATE_DIR"
prev="$(cat "$STATE_DIR/state" 2>/dev/null || echo ok)"
now="$prev"
if [ "$used" -ge "$ALERT_PCT" ]; then
  now=high
elif [ "$used" -lt "$CLEAR_PCT" ]; then
  now=ok
fi
log "disk ${used}% used, ${avail}G free on ${target} (state ${prev} -> ${now})"
[ "$now" = "$prev" ] && exit 0

if [ "$now" = high ]; then
  text=":warning: *${BOX}* disk is ${used}% full (${avail}G free under ${target}). Runs fail with \`No space left on device\` at 100%. Check: \`du -xh --max-depth=2 /var/lib /usr/local | sort -h | tail\`."
else
  text=":white_check_mark: *${BOX}* disk is back to ${used}% (${avail}G free under ${target})."
fi

if [ ! -s "$URL_FILE" ]; then
  log "no webhook at ${URL_FILE}: not posted (state kept at ${prev})"
  exit 0
fi
url="$(head -n 1 "$URL_FILE" | tr -d '[:space:]')"
[[ "$url" =~ ^https://hooks\.slack\.com/ ]] || fail "${URL_FILE} is not a Slack webhook URL"

body="$(printf '{"text":"%s"}' "$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g')")"
if printf 'url = "%s"\n' "$url" | "$CURL" -sS -f -m 20 -K - \
  -H 'Content-Type: application/json' --data-binary "$body" >/dev/null; then
  echo "$now" >"$STATE_DIR/state"
  log "posted: ${now}"
else
  # State unchanged, so the next tick retries the post.
  log "post failed: Slack did not accept it; will retry next tick"
fi
