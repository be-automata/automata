#!/bin/bash
set -euo pipefail
#
# render-opensandbox-config.sh KEYFILE TEMPLATE OUT [PORT] — renders the
# OpenSandbox server config (#656): TEMPLATE with `__API_KEY__` replaced by the
# key in KEYFILE, written to OUT (mode 0600). KEYFILE is either the credential
# (one `OPENSANDBOX_API_KEY=<key>` line) or a bare key. PORT, when given,
# replaces the template's `port =` line (the P0 probe's throwaway server).
#
# The key goes file to file: never argv, never the environment, never stdout.
# An empty key is refused and leaves no OUT behind.
#
# Used by automata-opensandbox.service (ExecStartPre) and opensandbox-p0-probe.sh.

[ "$#" -ge 3 ] && [ "$#" -le 4 ] || {
  echo "usage: $0 KEYFILE TEMPLATE OUT [PORT]" >&2
  exit 2
}
keyfile="$1" template="$2" out="$3" port="${4:-}"
[ -z "$port" ] || [[ "$port" =~ ^[0-9]{1,5}$ ]] || {
  echo "render-opensandbox-config: PORT must be a number" >&2
  exit 2
}

umask 077
# A file left by a crash keeps its old mode under a redirect: make a new one.
rm -f "$out"
if ! awk -v port="$port" '
  FILENAME == ARGV[1] { k = $0; sub(/^OPENSANDBOX_API_KEY=/, "", k); next }
  k == "" { exit 1 }
  port != "" && /^port = / { print "port = " port; next }
  { sub(/__API_KEY__/, k); print }
' "$keyfile" "$template" >"$out"; then
  rm -f "$out"
  echo "render-opensandbox-config: empty key in $keyfile" >&2
  exit 1
fi
