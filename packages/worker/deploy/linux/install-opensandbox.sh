#!/bin/bash
set -euo pipefail
umask 022
#
# install-opensandbox.sh — the OpenSandbox 1.2.1 server on the box (#656, ADR-014).
# Root required. Ubuntu 24.04, cgroup v2. The server runs as a container on the
# DEDICATED rootless daemon (install-rootless-docker.sh --profile opensandbox),
# under automata-opensandbox.service. Nothing here touches the worker unit, its
# env, the runner daemon or the rootful daemon.
#
# What it does (idempotent: every step checks before it changes):
#   1. runs install-rootless-docker.sh --profile opensandbox;
#   2. pulls the four BOM images by digest into the dedicated store (empty
#      DOCKER_CONFIG, 3 tries) and tags them automata-osb/*;
#   3. creates /etc/automata/opensandbox.env when absent: root:root 0600, one
#      line OPENSANDBOX_API_KEY=<64 hex>, generated under umask 077. When it
#      exists it is verified (owner, mode, shape) and refused if wrong. The key
#      is never printed, never in argv, and the shell trace is never on;
#   4. installs the config template and automata-opensandbox.service, enables
#      and starts it (restarts it only when the unit or the template changed);
#   5. verifies: /health 200 on 127.0.0.1:8090, the listener on loopback only,
#      an authenticated GET /sandboxes is 200 and an unauthenticated one is 401.
#
# Usage: install-opensandbox.sh [--check] [--pull-cell-image REF@sha256:DIGEST]
#   --check             verify only; change nothing (exit 1 on any failure)
#   --pull-cell-image   pull the cell image by digest only (a tag exits 2) into
#                       the dedicated store, after refusing when less than
#                       CELL_IMAGE_MIN_FREE_GB (default 20) is free there
#
# Server logs: journalctl -u automata-opensandbox (the dedicated daemon's
# logging driver cannot be read back with `docker logs`).

# The IT BOM (packages/sandbox/opensandbox-it/up.sh), pulled by digest and
# re-tagged locally; a test pins these four to the ones in up.sh.
# opensandbox/server:release-1.2.1
SERVER=opensandbox/server@sha256:07f9b39adb8cadf68357dd1b86367068210e960fc4cb50e11b75176387557ea7
# opensandbox/execd:release-1.2.1
EXECD=opensandbox/execd@sha256:6b12d17844ac7167271488302c71934e47f76abb9ddab19ec8529bd1c1c56b23
# opensandbox/egress:release-1.2.1
EGRESS=opensandbox/egress@sha256:84b98d3b5989a87389c977f6433f8cd3c7998d03aa15aaae41ebcb15b7eb8000
# python:3.12-slim
PY=python@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

RUNNER=automata-opensandbox
RUNNER_HOME=/var/lib/automata-opensandbox
SOCK=/run/automata-opensandbox-docker/docker.sock
KEY_FILE=/etc/automata/opensandbox.env
UNIT=automata-opensandbox.service
UNIT_DEST="/etc/systemd/system/$UNIT"
TEMPLATE_DIR=/usr/local/share/automata-opensandbox
TEMPLATE="$TEMPLATE_DIR/opensandbox-server.toml"
PORT=8090
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: $0 [--check] [--pull-cell-image REF@sha256:DIGEST]" >&2
  exit 2
}

check_only=0
cell_image=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      check_only=1
      shift
      ;;
    --pull-cell-image)
      cell_image="${2:?--pull-cell-image needs REF@sha256:DIGEST}"
      shift 2
      ;;
    *) usage ;;
  esac
done
if [ -n "$cell_image" ]; then
  [[ "$cell_image" =~ @sha256:[0-9a-f]{64}$ ]] || {
    echo "install-opensandbox: the cell image must be pinned by digest (REF@sha256:<64 hex>)" >&2
    exit 2
  }
fi

log() { printf 'opensandbox: %s\n' "$*"; }
die() {
  printf 'opensandbox: FATAL: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -s)" = Linux ] || die "Linux only"

# dk ARGS...: docker on the DEDICATED daemon, as its account, with an empty
# client config (no ~/.docker, no registry credentials).
dk() {
  runuser -u "$RUNNER" -- env -u DOCKER_HOST DOCKER_CONFIG="$RUNNER_HOME/dockercfg" \
    docker -H "unix://$SOCK" "$@"
}

prepare_client_config() {
  install -d -o "$RUNNER" -g "$RUNNER" -m 0700 "$RUNNER_HOME/dockercfg"
}

# ── the pull of the cell image (its own action) ──────────────────────────────
pull_cell_image() {
  local min="${CELL_IMAGE_MIN_FREE_GB:-20}" free store="$RUNNER_HOME/docker"
  [[ "$min" =~ ^[0-9]+$ ]] || die "CELL_IMAGE_MIN_FREE_GB must be a whole number"
  id -u "$RUNNER" >/dev/null 2>&1 || die "$RUNNER is missing: run $0 first"
  [ -d "$store" ] || store="$RUNNER_HOME"
  free="$(df --output=avail -BG "$store" | awk 'NR == 2 {gsub(/G/, "", $1); print $1}')"
  [ "${free:-0}" -ge "$min" ] || die "only ${free:-0} GB free under $store, need $min GB (the cell image takes about 12.5 GB per store)"
  prepare_client_config
  pull_one "$cell_image"
  log "pulled $cell_image"
}

pull_one() {
  local ref="$1" attempt
  dk image inspect "$ref" >/dev/null 2>&1 && return 0
  for attempt in 1 2 3; do
    dk pull -q "$ref" >/dev/null && return 0
    [ "$attempt" = 3 ] && die "pull failed: $ref"
    sleep $((attempt * 5))
  done
}

# ── the key file ─────────────────────────────────────────────────────────────
verify_key_file() {
  local got
  got="$(stat -c '%U:%G %a' "$KEY_FILE" 2>/dev/null || echo missing)"
  if [ "$got" != "root:root 600" ]; then
    echo "FAIL key-file            $KEY_FILE is $got, want root:root 600"
    return 1
  fi
  if [ "$(wc -l <"$KEY_FILE")" -ne 1 ] || ! grep -Eqx 'OPENSANDBOX_API_KEY=[0-9a-f]{64}' "$KEY_FILE"; then
    echo "FAIL key-file            $KEY_FILE is not exactly one OPENSANDBOX_API_KEY=<64 hex> line"
    return 1
  fi
  echo "ok   key-file            $KEY_FILE is root:root 600, one OPENSANDBOX_API_KEY line"
}

ensure_key_file() {
  if [ -e "$KEY_FILE" ]; then
    verify_key_file >/dev/null || die "$KEY_FILE exists but is wrong (owner, mode or shape); fix or remove it by hand"
    return 0
  fi
  log "generating $KEY_FILE"
  install -d -o root -g root -m 0755 "$(dirname "$KEY_FILE")"
  (
    umask 077
    { printf 'OPENSANDBOX_API_KEY='; openssl rand -hex 32; } >"$KEY_FILE.new"
  )
  chown root:root "$KEY_FILE.new"
  mv "$KEY_FILE.new" "$KEY_FILE"
}

# ── verification (also the tail of every install run) ────────────────────────
verify_server() {
  local fail=0 _ addrs hdr_dir code
  verify_key_file || fail=1
  if systemctl is-active --quiet "$UNIT"; then
    echo "ok   unit-active         $UNIT"
  else
    echo "FAIL unit-active         $UNIT is not active (journalctl -u ${UNIT%.service})"
    return 1
  fi
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true)" = 200 ]; then
    echo "ok   health              127.0.0.1:$PORT/health is 200"
  else
    echo "FAIL health              127.0.0.1:$PORT/health did not answer 200"
    fail=1
  fi
  addrs="$(ss -ltnH "sport = :$PORT" | awk '{print $4}')"
  if [ -n "$addrs" ] && ! printf '%s\n' "$addrs" | grep -qv '^127\.0\.0\.1:'; then
    echo "ok   loopback-only       listener on 127.0.0.1:$PORT only"
  else
    echo "FAIL loopback-only       listeners: ${addrs:-none} (want 127.0.0.1 only)"
    fail=1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/sandboxes" || true)"
  if [ "$code" = 401 ]; then
    echo "ok   unauthenticated     GET /sandboxes without a key is 401"
  else
    echo "FAIL unauthenticated     GET /sandboxes without a key is $code, want 401"
    fail=1
  fi
  # The key reaches curl through a 0600 header file, never argv.
  hdr_dir="$(mktemp -d)"
  sed 's/^OPENSANDBOX_API_KEY=/OPEN-SANDBOX-API-KEY: /' "$KEY_FILE" >"$hdr_dir/h"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "@$hdr_dir/h" "http://127.0.0.1:$PORT/sandboxes" || true)"
  rm -f "$hdr_dir/h"
  rmdir "$hdr_dir"
  if [ "$code" = 200 ]; then
    echo "ok   authenticated       GET /sandboxes with the key is 200"
  else
    echo "FAIL authenticated       GET /sandboxes with the key is $code, want 200"
    fail=1
  fi
  return "$fail"
}

if [ -n "$cell_image" ]; then
  pull_cell_image
  exit 0
fi

if [ "$check_only" -eq 1 ]; then
  "$HERE/install-rootless-docker.sh" --profile opensandbox --check || exit 1
  verify_server
  exit $?
fi

# ── 1. the dedicated daemon ──────────────────────────────────────────────────
"$HERE/install-rootless-docker.sh" --profile opensandbox
prepare_client_config

# ── 2. the images, by digest ─────────────────────────────────────────────────
for pair in "$SERVER automata-osb/server:1.2.1" "$EXECD automata-osb/execd:1.2.1" \
  "$EGRESS automata-osb/egress:1.2.1" "$PY automata-osb/py:3.12"; do
  pull_one "${pair% *}"
  dk tag "${pair% *}" "${pair#* }"
done
log "images pulled by digest and tagged automata-osb/*"

# ── 3. the key ───────────────────────────────────────────────────────────────
ensure_key_file

# ── 4. the template and the unit ─────────────────────────────────────────────
changed=0
install -d -o root -g root -m 0755 "$TEMPLATE_DIR"
for pair in "$HERE/opensandbox-server.toml $TEMPLATE" "$HERE/$UNIT $UNIT_DEST"; do
  if ! cmp -s "${pair% *}" "${pair#* }"; then
    log "installing ${pair#* }"
    install -o root -g root -m 0644 "${pair% *}" "${pair#* }"
    changed=1
  fi
done
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1
if [ "$changed" -eq 1 ]; then
  systemctl restart "$UNIT"
else
  systemctl start "$UNIT"
fi

# ── 5. verify ────────────────────────────────────────────────────────────────
verify_server
