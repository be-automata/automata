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
#   2. pulls the four BOM images (opensandbox-bom.sh) by digest into the
#      dedicated store (empty DOCKER_CONFIG, 3 tries) and tags them automata-osb/*;
#   3. creates /etc/automata/opensandbox.env when absent: root:root 0600, one
#      line OPENSANDBOX_API_KEY=<64 hex>, generated under umask 077. When it
#      exists it is verified (owner, mode, shape) and refused if wrong. The key
#      is never printed, never in argv, and the shell trace is never on;
#   4. installs the config template, render-opensandbox-config.sh and
#      automata-opensandbox.service, makes the account's 0700 run dir for the
#      rendered config, enables and starts the unit (restarts it only when a
#      file, the key or an image changed), and installs the worker drop-in
#      automata-worker.service.d/opensandbox.conf (LoadCredential= for the same
#      key file). The worker is NOT restarted: it takes the credential at its
#      next restart (automata-worker-safe-restart). It also installs the
#      weekly evidence renewal, automata-cell-evidence.{service,timer} (#709),
#      and enables the timer once /etc/automata/profile-evidence.env exists;
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

RUNNER=automata-opensandbox
RUNNER_HOME=/var/lib/automata-opensandbox
SOCK=/run/automata-opensandbox-docker/docker.sock
KEY_FILE=/etc/automata/opensandbox.env
UNIT=automata-opensandbox.service
UNIT_DEST="/etc/systemd/system/$UNIT"
TEMPLATE_DIR=/usr/local/share/automata-opensandbox
TEMPLATE="$TEMPLATE_DIR/opensandbox-server.toml"
RENDER="$TEMPLATE_DIR/render-opensandbox-config.sh"
# The rendered config (it holds the key). Not under /run: rootlesskit copies /run
# up when the dedicated daemon starts, so a directory made there later is
# invisible to the containers.
RUN_DIR="$RUNNER_HOME/run"
WORKER_DROPIN=/etc/systemd/system/automata-worker.service.d/opensandbox.conf
# The weekly conformance-evidence renewal (#709) and the config it reads.
EVIDENCE_UNITS=(automata-cell-evidence.service automata-cell-evidence.timer)
EVIDENCE_TIMER=automata-cell-evidence.timer
EVIDENCE_CONFIG=/etc/automata/profile-evidence.env
PORT=8090
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/opensandbox-bom.sh"

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
if [ -n "$cell_image" ] && [ "$check_only" -eq 1 ]; then
  echo "install-opensandbox: --check changes nothing and cannot be combined with --pull-cell-image" >&2
  exit 2
fi
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

# ensure_key_file: sets key_new=1 when it generated the key (the unit must restart).
# refuse_key_file WHY: exit 2. The worker drop-in's LoadCredential= has no
# fallback: with the drop-in in place a missing key file stops the worker from
# restarting, so this never leaves one behind without a valid key file.
refuse_key_file() {
  printf 'opensandbox: FATAL: %s\n' "$1" >&2
  printf 'opensandbox: remove %s and run systemctl daemon-reload BEFORE removing or replacing %s (the worker cannot restart without the key file while the drop-in exists), then fix the key file and re-run\n' "$WORKER_DROPIN" "$KEY_FILE" >&2
  exit 2
}

ensure_key_file() {
  key_new=0
  if [ -e "$KEY_FILE" ]; then
    verify_key_file >/dev/null || refuse_key_file "$KEY_FILE exists but is wrong (owner, mode or shape)"
    return 0
  fi
  # A missing key beside an installed drop-in was deleted, not never made: never
  # replace it silently (Automata #669). The drop-in goes first, then a re-run.
  if [ -e "$WORKER_DROPIN" ]; then
    refuse_key_file "$KEY_FILE is missing while the worker drop-in exists"
  fi
  log "generating $KEY_FILE"
  # An existing /etc/automata keeps its mode; a new one is 0700 (README: root only).
  [ -d "$(dirname "$KEY_FILE")" ] || install -d -o root -g root -m 0700 "$(dirname "$KEY_FILE")"
  rm -f "$KEY_FILE.new"
  (
    umask 077
    { printf 'OPENSANDBOX_API_KEY='; openssl rand -hex 32; } >"$KEY_FILE.new"
  )
  chown root:root "$KEY_FILE.new"
  mv "$KEY_FILE.new" "$KEY_FILE"
  verify_key_file >/dev/null || refuse_key_file "the generated $KEY_FILE is not valid"
  key_new=1
}

# ── verification (also the tail of every install run) ────────────────────────
# hdr_dir is global: the EXIT trap in verify_server runs after the function's locals are gone.
verify_server() {
  local fail=0 _ addrs code got
  verify_key_file || fail=1
  got="$(stat -c '%U:%G %a' "$RUN_DIR" 2>/dev/null || echo missing)"
  if [ "$got" = "$RUNNER:$RUNNER 700" ]; then
    echo "ok   run-dir             $RUN_DIR is $got"
  else
    echo "FAIL run-dir             $RUN_DIR is $got, want $RUNNER:$RUNNER 700"
    fail=1
  fi
  if cmp -s "$HERE/automata-worker-opensandbox.conf" "$WORKER_DROPIN"; then
    echo "ok   worker-dropin       $WORKER_DROPIN matches the repo file"
  else
    echo "FAIL worker-dropin       $WORKER_DROPIN is missing or differs from automata-worker-opensandbox.conf"
    fail=1
  fi
  local u
  for u in "${EVIDENCE_UNITS[@]}"; do
    if cmp -s "$HERE/$u" "/etc/systemd/system/$u"; then
      echo "ok   cell-evidence-unit  /etc/systemd/system/$u matches the repo file"
    else
      echo "FAIL cell-evidence-unit  /etc/systemd/system/$u is missing or differs from the repo file"
      fail=1
    fi
  done
  if systemctl is-enabled --quiet "$EVIDENCE_TIMER"; then
    echo "ok   cell-evidence-timer $EVIDENCE_TIMER is enabled"
  else
    echo "FAIL cell-evidence-timer $EVIDENCE_TIMER is not enabled (needs $EVIDENCE_CONFIG; README, OpenSandbox cells, step 8)"
    fail=1
  fi
  if systemctl is-active --quiet "$UNIT"; then
    echo "ok   unit-active         $UNIT"
  else
    echo "FAIL unit-active         $UNIT is not active (journalctl -u ${UNIT%.service})"
    return 1
  fi
  code=000
  for _ in $(seq 1 60); do
    code="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" || true)"
    [ "$code" = 200 ] && break
    sleep 1
  done
  if [ "$code" = 200 ]; then
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
  code="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/sandboxes" || true)"
  if [ "$code" = 401 ]; then
    echo "ok   unauthenticated     GET /sandboxes without a key is 401"
  else
    echo "FAIL unauthenticated     GET /sandboxes without a key is $code, want 401"
    fail=1
  fi
  # The key reaches curl through a 0600 header file, never argv.
  hdr_dir="$(mktemp -d)"
  trap 'rm -f "$hdr_dir/h"; rmdir "$hdr_dir"' EXIT
  sed 's/^OPENSANDBOX_API_KEY=/OPEN-SANDBOX-API-KEY: /' "$KEY_FILE" >"$hdr_dir/h"
  code="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H "@$hdr_dir/h" "http://127.0.0.1:$PORT/sandboxes" || true)"
  rm -f "$hdr_dir/h"
  rmdir "$hdr_dir"
  trap - EXIT
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
changed=0
for pair in "${BOM_PAIRS[@]}"; do
  pull_one "${pair% *}"
  # A tag that now points at another image (a bumped pin) restarts the unit.
  before="$(dk image inspect -f '{{.Id}}' "${pair#* }" 2>/dev/null || true)"
  dk tag "${pair% *}" "${pair#* }"
  [ "$before" = "$(dk image inspect -f '{{.Id}}' "${pair#* }")" ] || changed=1
done
log "images pulled by digest and tagged automata-osb/*"

# ── 3. the key ───────────────────────────────────────────────────────────────
ensure_key_file
[ "${key_new:-0}" -eq 0 ] || changed=1

# ── 4. the template, the unit and the worker drop-in ─────────────────────────
# install_changed SRC DEST MODE: installs SRC as root when DEST differs; 0 when it did.
install_changed() {
  cmp -s "$1" "$2" && return 1
  log "installing $2"
  install -D -o root -g root -m "$3" "$1" "$2"
}

install -d -o root -g root -m 0755 "$TEMPLATE_DIR"
install -d -o "$RUNNER" -g "$RUNNER" -m 0700 "$RUN_DIR"
if install_changed "$HERE/opensandbox-server.toml" "$TEMPLATE" 0644; then changed=1; fi
if install_changed "$HERE/render-opensandbox-config.sh" "$RENDER" 0755; then changed=1; fi
if install_changed "$HERE/$UNIT" "$UNIT_DEST" 0644; then changed=1; fi
# The worker only reads it at its next restart; it is never restarted here.
install_changed "$HERE/automata-worker-opensandbox.conf" "$WORKER_DROPIN" 0644 || true
for u in "${EVIDENCE_UNITS[@]}"; do
  install_changed "$HERE/$u" "/etc/systemd/system/$u" 0644 || true
done
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1
if [ "$changed" -eq 1 ]; then
  systemctl restart "$UNIT"
else
  systemctl start "$UNIT"
fi
# The renewal needs the evidence secret; without it the timer would fail every week.
if [ -e "$EVIDENCE_CONFIG" ]; then
  systemctl enable --now "$EVIDENCE_TIMER" >/dev/null
  log "$EVIDENCE_TIMER enabled"
else
  log "WARNING: $EVIDENCE_CONFIG is missing, so $EVIDENCE_TIMER is installed but not enabled (README, OpenSandbox cells, step 8)"
fi
# The first layout rendered the config under /run/automata-opensandbox (a key at
# rest on tmpfs): drop what it left, now that the unit no longer mounts it.
rm -f /run/automata-opensandbox/config.toml
rmdir /run/automata-opensandbox 2>/dev/null || true

# ── 5. verify ────────────────────────────────────────────────────────────────
verify_server
