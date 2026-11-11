#!/bin/bash
# box-evidence-probes.sh — the weekly renewal of the box's ADR-014 evidence
# (ADR-014 Consequences, "Evidence upkeep": the probes have to be re-run on a
# schedule). Oneshot, driven by automata-box-evidence.timer, as root.
#
# It is driver B of packages/worker/deploy/README.md ("Security probes"): ADR-013
# probes 2 to 7 in two standalone containers that mirror the run argv, started
# together, each naming the other as its peer. No live run, no worker proxy, so
# probe 1 is not measured and only the automata-box/observe profile is renewed.
#
# The box only REPORTS: it posts the raw probe lines of both containers to
# POST <www>/api/internal/profile-evidence/box, and the control plane decides
# what they prove (packages/shared/src/model/box-evidence.ts). A full pass writes
# evidence; anything else writes nothing and raises an ops alert there. This unit
# also fails loudly (non-zero exit, no Restart=) so `systemctl --failed` shows it.
#
# Config, root-only (0600), NOT worker-box.env (the worker must not hold it):
#   /etc/automata/profile-evidence.env
#     AUTOMATA_WWW_URL=https://<www host>
#     PROFILE_EVIDENCE_SECRET=<same value as the www Worker secret>
# The batteries image comes from WORKER_BATTERIES_IMAGE in worker-box.env (it
# must be pinned by digest), so the probes judge exactly what runs.
#
# Usage: box-evidence-probes.sh [--dry-run]
#   --dry-run  run the probes and print the verdict lines; post nothing
set -uo pipefail

CONFIG="${BOX_EVIDENCE_CONFIG:-/etc/automata/profile-evidence.env}"
WORKER_ENV="${BOX_EVIDENCE_WORKER_ENV:-/home/automata/.automata/worker-box.env}"
PLATFORM="${BOX_EVIDENCE_PLATFORM:-/opt/automata-platform}"
PROBE_REPO="${BOX_EVIDENCE_REPO:-https://github.com/octocat/Hello-World.git}"
DOCKER_SOCK=unix:///run/automata-docker/docker.sock
WORK=/var/tmp/automata-probe
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { echo "[box-evidence] $*"; }
fail() { echo "[box-evidence] FAIL: $*" >&2; exit 1; }

tmp=$(mktemp -d) || fail "mktemp"
chmod 0700 "$tmp"
cleanup() {
  for n in a b; do
    sudo -u automata docker -H "$DOCKER_SOCK" rm -f "automata-probe-$n" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK" "$tmp"
}
trap cleanup EXIT

if [ "$DRY_RUN" = 0 ]; then
  [ -r "$CONFIG" ] || fail "$CONFIG missing (see packages/worker/deploy/README.md, \"Scheduled evidence renewal\")"
  # Read two names only; never `source` it, never echo a value.
  www=$(grep -E '^AUTOMATA_WWW_URL=' "$CONFIG" | head -1 | cut -d= -f2-)
  secret=$(grep -E '^PROFILE_EVIDENCE_SECRET=' "$CONFIG" | head -1 | cut -d= -f2-)
  case "$www" in https://*) ;; *) fail "AUTOMATA_WWW_URL must be https://" ;; esac
  [ -n "$secret" ] || fail "PROFILE_EVIDENCE_SECRET is empty"
fi

img=$(grep -oE '^WORKER_BATTERIES_IMAGE=[^ ]+' "$WORKER_ENV" | head -1 | cut -d= -f2)
digest=${img##*@}
case "$digest" in sha256:*) ;; *) fail "WORKER_BATTERIES_IMAGE is not pinned by digest" ;; esac
gid=$(id -g automata-runner) || fail "no automata-runner user"
uid=$(id -u automata-runner)
pub=$(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]; exit}')
[ -n "$pub" ] || fail "no public IPv4 address"
# The checkout belongs to automata and this runs as root. systemd starts the unit with no
# HOME, so root's global safe.directory is not read and git refuses the repo as "dubious
# ownership": name the one directory here instead.
sha=$(git -c safe.directory="$PLATFORM" -C "$PLATFORM" log -1 --format=%h) || fail "no platform checkout at $PLATFORM"
host=$(hostname -s)
at=$(date -u +%FT%TZ)
log "host=$host at=$at platform=$sha image=$digest"

sudo -u automata docker -H "$DOCKER_SOCK" info >/dev/null 2>&1 || fail "rootless engine at $DOCKER_SOCK does not answer"
install -d -m 0755 -o automata -g automata "$WORK"
probe_run() { # NAME SELF PEER
  local dir=$WORK/$1
  sudo -u automata install -d -m 2770 -g "$gid" "$dir" "$dir/sock"
  sudo -u automata git clone -q --depth 1 "$PROBE_REPO" "$dir/repo" || return 1
  echo "$2" | sudo -u automata tee "$dir/repo/.automata-probe-token" >/dev/null
  sudo -u automata chgrp -R "$gid" "$dir/repo" && sudo -u automata chmod -R g+rwX "$dir/repo"
  timeout 600 sudo -u automata docker -H "$DOCKER_SOCK" run --rm -i \
    --name "automata-probe-$1" --pull never --init --network none --cap-drop ALL \
    --security-opt no-new-privileges --read-only --user 10001:10001 --workdir /workspace \
    --memory 1500m --memory-swap 1500m --pids-limit 4096 --cpus 2 \
    --tmpfs /tmp:rw,nosuid,nodev,size=536870912,mode=1777 --shm-size 268435456b \
    --mount "type=bind,src=$dir/repo,dst=/workspace" \
    --mount "type=bind,src=$dir/sock,dst=/run/automata" \
    --mount "type=bind,src=$PLATFORM/packages/daemon/dist/index.js,dst=/opt/automata-daemon/index.js,readonly" \
    --mount type=volume,dst=/home/agent --mount type=volume,dst=/opt/flutter \
    --mount type=volume,dst=/opt/somnio-ai-tools/agent-rules/adapters \
    --group-add 0 --env AUTOMATA_RUN_LANE=review --entrypoint /bin/bash "$img" \
    -s -- --only 2,3,4,5,6,7 --runner-uid "$uid" --host-addr "$pub" \
    --self "$2" --peer "$3" < "$PLATFORM/packages/worker/deploy/linux/container-security-probes.sh"
}
tok_a="probe-run-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
tok_b="probe-run-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
probe_run a "$tok_a" "$tok_b" >"$tmp/a.out" 2>&1 &
probe_run b "$tok_b" "$tok_a" >"$tmp/b.out" 2>&1 &
wait

# Only the verdict lines leave the box: the server ignores the rest anyway.
grep -E '^(PASS|FAIL|SKIP) ' "$tmp/a.out" >"$tmp/a.lines" || true
grep -E '^(PASS|FAIL|SKIP) ' "$tmp/b.out" >"$tmp/b.lines" || true
p=$(cat "$tmp/a.lines" "$tmp/b.lines" | grep -c '^PASS ')
f=$(cat "$tmp/a.lines" "$tmp/b.lines" | grep -c '^FAIL ')
s=$(cat "$tmp/a.lines" "$tmp/b.lines" | grep -c '^SKIP ')
log "probes pass=$p fail=$f skip=$s (a full pass is 12/0/0)"
cat "$tmp/a.lines" "$tmp/b.lines" | cut -c1-120

if [ "$DRY_RUN" = 1 ]; then
  log "dry run: nothing posted"
  [ "$f" = 0 ] && [ "$p" = 12 ] && [ "$s" = 0 ]
  exit $?
fi

python3 - "$tmp/a.lines" "$tmp/b.lines" "$host" "$at" "$sha" "$digest" >"$tmp/body.json" <<'PY' || fail "could not build the report"
import json, sys
a, b, host, at, sha, digest = sys.argv[1:7]
print(json.dumps({
    "host": host,
    "measuredAt": at,
    "platformSha": sha,
    "imageDigest": digest,
    "containers": [open(a).read(), open(b).read()],
}))
PY
# The secret goes in a 0600 header file, never on a command line.
( umask 077; printf 'x-automata-profile-evidence-token: %s\n' "$secret" >"$tmp/headers" )
code=$(curl -sS -o "$tmp/resp.json" -w '%{http_code}' --max-time 60 \
  -H @"$tmp/headers" -H 'content-type: application/json' \
  --data-binary @"$tmp/body.json" "${www%/}/api/internal/profile-evidence/box") || fail "post failed"
resp=$(head -c 300 "$tmp/resp.json")
log "www answered $code $resp"
[ "$code" = 200 ] || fail "www refused the report ($code)"
grep -q '"recorded":true' "$tmp/resp.json" || fail "evidence NOT renewed (see the ops alert)"
log "evidence renewed"
