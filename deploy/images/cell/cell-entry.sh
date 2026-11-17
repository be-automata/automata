#!/bin/bash
set -euo pipefail
# cell-entry.sh --url https://<broker-host>[:port]
# Run by OpenSandbox's bootstrap as the cell's command (uid 10001). No run.env,
# no socket bridges (#656 Scope 9). Never echoes a value it refuses.
usage() { echo "usage: cell-entry.sh --url https://<host>[:port]" >&2; exit 64; }
[ "$#" -eq 2 ] && [ "$1" = "--url" ] || usage
url="$2"
[[ "$url" =~ ^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$ ]] || usage
# Names the platform itself sets (CELL_ENV_ALLOWLIST in cell-image.ts; a test
# keeps the two lists equal).
allow=" OPENSANDBOX_ID OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE SSL_CERT_FILE OPENSANDBOX_MERGED_CA_PATH GIT_SSL_CAINFO DEBIAN_FRONTEND LANG LC_ALL PUB_CACHE FLUTTER_ROOT FLUTTER_SUPPRESS_ANALYTICS DART_SUPPRESS_ANALYTICS CI PATH SOMNIO_ROOT VENDOR_SKILLS_ROOT CLAUDE_PLUGIN_ROOT YTCTL PLAYWRIGHT_BROWSERS_PATH HOME GSTACK_SESSION_KIND ROBOREV_TELEMETRY_ENABLED MCP_TIMEOUT "
while IFS= read -r name; do
  case "$allow" in *" $name "*) continue ;; esac
  if [[ "${name^^}" =~ TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL ]] || [[ "$name" == AWS_* ]]; then
    echo "cell-entry: $name is set; a cell's credentials live in the sidecar vault, never in its env" >&2
    exit 78
  fi
done < <(compgen -e)
run="$HOME/.automata-run"
# 0700 dirs: only uid 10001 reads the socket. The process umask is left as
# inherited: the box's 0002 (container-entry.ts:76) exists for setgid dirs
# shared with the worker on the host, which a cell does not have.
(umask 0077; mkdir -p "$run/flutter-pin")
exec /usr/local/bin/node /opt/automata-daemon/index.js --url "$url" --socket-path "$run/daemon.sock"
