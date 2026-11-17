#!/bin/bash
set -euo pipefail
orig_path="${PATH:-}"
# Every external command below resolves through root-owned dirs: the inherited
# PATH starts with an agent-writable shim dir (Decision 5).
PATH=/usr/bin:/bin
# cell-entry.sh --url https://<broker-host>[:port]
# Run by OpenSandbox's bootstrap as the cell's command (uid 10001). No run.env,
# no socket bridges (#656 Scope 9). Never echoes a value it refuses.
# Exit codes: 64 bad arguments, 66 HOME is not an absolute directory, 78 a
# credential-shaped env name is set (CELL_ENTRY_EXIT in cell-image.ts).
usage() { echo "usage: cell-entry.sh --url https://<host>[:port]" >&2; exit 64; }
[ "$#" -eq 2 ] && [ "$1" = "--url" ] || usage
url="$2"
[[ "$url" =~ ^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$ ]] || usage
if [[ "${HOME:-}" != /* ]] || [ ! -d "$HOME" ]; then
  echo "cell-entry: HOME is not an absolute directory" >&2
  exit 66
fi
# Names exempt from the refusal (CELL_ENV_ALLOWLIST in cell-image.ts), and the
# static run env the daemon may also start with (CELL_RUN_ENV). A test keeps
# both equal to their constants.
allow="OPENSANDBOX_ID OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE SSL_CERT_FILE OPENSANDBOX_MERGED_CA_PATH GIT_SSL_CAINFO DEBIAN_FRONTEND LANG LC_ALL PUB_CACHE FLUTTER_ROOT FLUTTER_SUPPRESS_ANALYTICS DART_SUPPRESS_ANALYTICS CI PATH SOMNIO_ROOT VENDOR_SKILLS_ROOT CLAUDE_PLUGIN_ROOT YTCTL PLAYWRIGHT_BROWSERS_PATH HOME GSTACK_SESSION_KIND ROBOREV_TELEMETRY_ENABLED MCP_TIMEOUT"
run_env="FORCE_COLOR TOOL_FAILURE_STREAK_LIMIT"
# Case-insensitive; CELL_FORBIDDEN_ENV_PATTERN_SOURCE in cell-image.ts.
forbidden='TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|APIKEY|_KEY$|PRIVATE|PASS|AUTH|_PAT$|COOKIE|DATABASE_URL|^AWS_'
is_in() { local n; for n in $2; do [ "$n" = "$1" ] && return 0; done; return 1; }
# The raw environment: bash hands children every entry it received, including
# names that are not shell identifiers (`npm_config_//r.org/:_authToken`), and
# `compgen -e` does not list those. Read it NUL-separated from procfs.
read_environ() {
  if [ -r "/proc/$$/environ" ]; then cat "/proc/$$/environ"; else /usr/bin/env -0; fi
}
keep=()
while IFS= read -r -d '' entry; do
  name="${entry%%=*}"
  [ -n "$name" ] || continue
  if ! is_in "$name" "$allow" && [[ "${name^^}" =~ $forbidden ]]; then
    echo "cell-entry: $name is set; a cell's credentials live in the sidecar vault, never in its env" >&2
    exit 78
  fi
  if [ "$name" = PATH ]; then keep+=("PATH=$orig_path")
  elif is_in "$name" "$allow $run_env"; then keep+=("$entry"); fi
done < <(read_environ)
run="$HOME/.automata-run"
# 0700 dirs: only uid 10001 reads the socket. The process umask is left as
# inherited: the box's 0002 (container-entry.ts:76) exists for setgid dirs
# shared with the worker on the host, which a cell does not have.
(umask 0077; mkdir -p "$run/flutter-pin")
# env -i: the daemon (and every agent child, which inherits its env) starts
# with only the names kept above, never a name this script did not vet.
exec /usr/bin/env -i "${keep[@]}" /usr/local/bin/node /opt/automata-daemon/index.js --url "$url" --socket-path "$run/daemon.sock"
