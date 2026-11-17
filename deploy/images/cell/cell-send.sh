#!/bin/bash
set -euo pipefail
# cell-send.sh <base64 message>: write one daemon message (exec has no stdin).
[ "$#" -eq 1 ] || { echo "usage: cell-send.sh <base64>" >&2; exit 64; }
case "$1" in ""|*[!A-Za-z0-9+/=]*) echo "cell-send: argument is not base64" >&2; exit 64 ;; esac
printf '%s' "$1" | base64 -d | /usr/local/bin/node /opt/automata-daemon/index.js --write \
  --socket-path "$HOME/.automata-run/daemon.sock" --timeout 10000
