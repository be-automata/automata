#!/bin/bash
set -euo pipefail
PATH=/usr/bin:/bin
# cell-send.sh <base64 message>: write one daemon message (exec has no stdin).
# One argv string is capped at 128 KiB on Linux (MAX_ARG_STRLEN), so the
# argument may be at most 131071 characters (CELL_SEND_MAX_BYTES in
# cell-image.ts); PR-E caps or splits a larger message.
# Exit codes: 64 bad argument, 65 argument over the cap.
max=131071
[ "$#" -eq 1 ] || { echo "usage: cell-send.sh <base64>" >&2; exit 64; }
case "$1" in ""|*[!A-Za-z0-9+/=]*) echo "cell-send: argument is not base64" >&2; exit 64 ;; esac
[ "${#1}" -le "$max" ] || { echo "cell-send: argument is over $max characters" >&2; exit 65; }
printf '%s' "$1" | base64 -d | /usr/local/bin/node /opt/automata/daemon.js --write \
  --socket-path "$HOME/.automata-run/daemon.sock" --timeout 10000
