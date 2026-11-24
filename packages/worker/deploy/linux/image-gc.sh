#!/bin/bash
set -euo pipefail
#
# Remove the box's run images that nothing pins (2026-11-24: the execution box
# disk reached 100% and every run failed `No space left on device`; old images
# held more of it than anything else). Root required; driven daily by
# automata-image-gc.timer. `--dry-run` prints what it would remove.
#
# Two daemons, one repository each, and only that repository is ever touched:
#
#   runner daemon (/run/automata-docker/docker.sock), automata-batteries:
#     keeps CURRENT and PREVIOUS from /etc/automata/batteries-image.state
#     (provision-execution-box.sh keeps PREVIOUS on purpose: an image rollback
#     is an env change) and the worker's WORKER_BATTERIES_IMAGE. Removes the
#     images older than that, which nothing else ever removed.
#   OpenSandbox daemon (/run/automata-opensandbox-docker/docker.sock),
#     automata-cell: keeps the worker's WORKER_OPENSANDBOX_GUEST_IMAGE. Nothing
#     rotated these at all; every new cell pin left the last 13-17 GB image.
#
# An image is kept when ANY digest it carries is kept. With nothing to keep
# for a daemon (no pin found), that daemon is skipped: never "remove all".
# `docker rmi` runs WITHOUT --force, so an image a container still uses is
# refused by Docker and logged, never removed. A failed removal is a log line;
# the script fails only on a config error (not root, unreadable state).
#
# The pins are read from worker-box.env, never sourced: the last
# `[export ]KEY=value` line wins, quotes stripped.

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

DOCKER="${IMAGE_GC_DOCKER:-docker}"
RUNNER_SOCK="${IMAGE_GC_RUNNER_SOCK:-/run/automata-docker/docker.sock}"
OSB_SOCK="${IMAGE_GC_OSB_SOCK:-/run/automata-opensandbox-docker/docker.sock}"
STATE="${IMAGE_GC_STATE:-/etc/automata/batteries-image.state}"
WORKER_ENV="${IMAGE_GC_WORKER_ENV:-}"
BATTERIES_REPO=ghcr.io/be-automata/automata-batteries
CELL_REPO=ghcr.io/be-automata/automata-cell

log() { echo "[image-gc] $*"; }
fail() {
  echo "[image-gc] FAIL: $*" >&2
  exit 1
}

if [ -z "${IMAGE_GC_SKIP_ROOT_CHECK:-}" ]; then
  [ "$(id -u)" = "0" ] || fail "must run as root"
fi
if [ -z "$WORKER_ENV" ]; then
  home="$(getent passwd automata | cut -d: -f6 || true)"
  WORKER_ENV="${home:-/home/automata}/.automata/worker-box.env"
fi

# file_value FILE KEY: the last `[export ]KEY=value` in FILE, quotes stripped.
file_value() {
  [ -r "$1" ] || return 0
  sed -n -E "s/^(export[[:space:]]+)?$2=//p" "$1" | tail -n 1 | tr -d "\"'"
}

# digest_of REF: the sha256:<hex> of a `<repo>@sha256:<hex>` reference, or "".
digest_of() {
  case "$1" in
    *@sha256:*) printf '%s\n' "${1#*@}" ;;
  esac
}

# gc SOCK REPO KEEP_DIGEST...: remove REPO's images on SOCK that carry none of
# the KEEP digests.
gc() {
  local sock="$1" repo="$2"
  shift 2
  local keep=()
  local d
  for d in "$@"; do [ -n "$d" ] && keep+=("$d"); done
  if [ "${#keep[@]}" -eq 0 ]; then
    log "skip $repo: no pinned digest found, nothing is removed"
    return 0
  fi
  if [ ! -S "$sock" ] && [ -z "${IMAGE_GC_SKIP_SOCKET_CHECK:-}" ]; then
    log "skip $repo: no daemon socket at $sock"
    return 0
  fi
  local rows
  if ! rows="$("$DOCKER" -H "unix://$sock" images --no-trunc --digests \
    --format '{{.ID}} {{.Repository}} {{.Digest}}' "$repo")"; then
    log "skip $repo: cannot list images on $sock"
    return 0
  fi
  # Image ids to keep: any row whose digest is kept.
  local kept_ids="" id r dig k
  while read -r id r dig; do
    [ -n "$id" ] || continue
    for k in "${keep[@]}"; do
      [ "$dig" = "$k" ] && kept_ids="$kept_ids $id"
    done
  done <<<"$rows"
  local seen="" removed=0 refused=0
  while read -r id r dig; do
    [ -n "$id" ] && [ "$r" = "$repo" ] || continue
    case " $kept_ids $seen " in *" $id "*) continue ;; esac
    seen="$seen $id"
    if [ "$DRY_RUN" -eq 1 ]; then
      log "would remove $repo ${id#sha256:}"
      removed=$((removed + 1))
      continue
    fi
    if "$DOCKER" -H "unix://$sock" rmi "$id" >/dev/null 2>&1; then
      log "removed $repo ${id#sha256:}"
      removed=$((removed + 1))
    else
      log "kept $repo ${id#sha256:}: docker refused the removal (in use?)"
      refused=$((refused + 1))
    fi
  done <<<"$rows"
  log "$repo: kept ${keep[*]}; removed=$removed refused=$refused"
}

[ -e "$STATE" ] && [ ! -r "$STATE" ] && fail "cannot read $STATE"

gc "$RUNNER_SOCK" "$BATTERIES_REPO" \
  "$(digest_of "$(file_value "$STATE" CURRENT)")" \
  "$(digest_of "$(file_value "$STATE" PREVIOUS)")" \
  "$(digest_of "$(file_value "$WORKER_ENV" WORKER_BATTERIES_IMAGE)")"

gc "$OSB_SOCK" "$CELL_REPO" \
  "$(digest_of "$(file_value "$WORKER_ENV" WORKER_OPENSANDBOX_GUEST_IMAGE)")"
