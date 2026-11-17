#!/bin/bash
set -euo pipefail
#
# opensandbox-p0-probe.sh — the #656 P0 probe (OD-4 of #634): does the DEDICATED
# rootless daemon (install-rootless-docker.sh --profile opensandbox) enforce
# the OpenSandbox egress policy on x86_64 / Ubuntu 24.04? THROWAWAY BOXES ONLY.
#
# The bash half does the root-side checks (environment record, daemon checks,
# the /run copy-up marker, a throwaway server on 127.0.0.1:18092, the sidecar
# ruleset, survivors). The cell probes are the TypeScript driver, which reuses
# the IT harness and makes the enforced cell with the PRODUCTION adapter:
#   packages/sandbox/src/providers/opensandbox-it/p0-probe.ts
#
# Output: one `PASS|FAIL|NOTE <check> <detail>` line per check, `--out DIR/p0.json`
# (booleans, timings and versions only) and a last line
#   P0 VERDICT: rootless                              (exit 0)
#   P0 VERDICT: FAIL (<checks>) -> dind fallback      (exit 1)
# NOTE lines never count as PASS (an untested IPv6 bypass is `NOTE ipv6-vacuous`).
#
# The throwaway key lives only in a 0600 file under /run/automata-opensandbox/p0
# and reaches the driver by file path: never argv, environment or output.
#
# Run as root, from a checkout with `pnpm install --frozen-lockfile` done:
#   sudo packages/worker/deploy/linux/opensandbox-p0-probe.sh \
#     --i-know-this-is-throwaway --out /root/p0-out

RUNNER=automata-opensandbox
WORKER_USER=automata
SOCK_DIR=/run/automata-opensandbox-docker
SOCK="$SOCK_DIR/docker.sock"
RUN_DIR=/run/automata-opensandbox
P0="$RUN_DIR/p0"
PORT=18092
SERVER_NAME=automata-osb-p0-server
DATA_VOLUME=automata-osb-p0-data
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$HERE/../../../.." && pwd)"

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

usage() {
  echo "usage: $0 --i-know-this-is-throwaway --out DIR" >&2
  exit 2
}

throwaway=0
out_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --i-know-this-is-throwaway)
      throwaway=1
      shift
      ;;
    --out)
      out_dir="${2:?--out needs a directory}"
      shift 2
      ;;
    *) usage ;;
  esac
done
[ -n "$out_dir" ] || usage

die() {
  printf 'p0-probe: FATAL: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -s)" = Linux ] || die "Linux only"
# Never the production box, flag or no flag.
[ "$(hostname)" != automata-exec-1 ] || die "refusing to run on automata-exec-1"
# The throwaway guard: a live worker or its seal key means a real box.
if [ "$throwaway" -ne 1 ]; then
  if systemctl is-active --quiet automata-worker.service || [ -e /etc/automata/payload-seal.key ]; then
    die "this looks like a real box (worker active or payload-seal.key present); pass --i-know-this-is-throwaway on a throwaway box only"
  fi
fi
id -u "$RUNNER" >/dev/null 2>&1 || die "$RUNNER is missing: run install-rootless-docker.sh --profile opensandbox first"
runner_uid="$(id -u "$RUNNER")"

mkdir -p "$out_dir"
results=()
emit() {
  printf '%s %s %s\n' "$1" "$2" "${3:-}"
  results+=("$1 $2")
}
check() { # check NAME DETAIL <command...>: PASS when the command succeeds
  local name="$1" detail="$2"
  shift 2
  if "$@"; then emit PASS "$name" "$detail"; else emit FAIL "$name" "$detail"; fi
}

# dk ARGS...: docker on the DEDICATED daemon, as its account, with a client
# config under the probe's own directory (no ~/.docker).
dk() {
  runuser -u "$RUNNER" -- env -u DOCKER_HOST XDG_RUNTIME_DIR="/run/user/$runner_uid" \
    DOCKER_CONFIG="$P0/dockercfg" docker -H "unix://$SOCK" "$@"
}
clean_text() { tr -cd 'A-Za-z0-9._ :/+@=,-' | cut -c1-120; }

snapshot() {
  {
    dk ps -a --format '{{.Names}}' | sed 's/^/container /'
    dk volume ls -q | sed 's/^/volume /'
    dk network ls --format '{{.Name}}' | sed 's/^/network /'
    find "/run/user/$runner_uid/docker/netns" -maxdepth 1 -type f -printf 'netns %f\n' 2>/dev/null || true
  } | sort
}

# shellcheck disable=SC2329 # invoked through `check` or a trap
teardown_probe() {
  # Keep the server's log tail for a failed run (lines naming a key dropped).
  if [ -n "${out_dir:-}" ] && [ -d "$out_dir" ]; then
    dk logs --tail 300 "$SERVER_NAME" 2>&1 | grep -v -i -E 'api[_-]?key|authorization|token' \
      >"$out_dir/server.log" || true
  fi
  dk rm -f -v "$SERVER_NAME" >/dev/null 2>&1 || true
  dk volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
  if [ -d "$P0" ]; then
    runuser -u "$RUNNER" -- find "$P0" -mindepth 1 -delete 2>/dev/null || true
    rmdir "$P0" 2>/dev/null || true
  fi
}
trap teardown_probe EXIT

record_environment() {
  local arch
  arch="$(uname -m)"
  check arch-x86_64 "$arch" [ "$arch" = x86_64 ]
  # shellcheck source=/dev/null
  emit NOTE os-release "$(. /etc/os-release && echo "$PRETTY_NAME" | clean_text)"
  emit NOTE kernel "$(uname -r | clean_text)"
  emit NOTE docker-version "$(docker --version | clean_text)"
  emit NOTE rootlesskit-version "$(rootlesskit --version 2>&1 | head -n1 | clean_text)"
  emit NOTE slirp4netns-flags "$(slirp4netns --help 2>&1 | grep -oE -e '--(disable-host-loopback|detach-netns)' | sort -u | tr '\n' ' ' | clean_text)"
  emit NOTE apparmor-restrict-userns "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a)"
  emit NOTE apparmor-distro-profile "$([ -e /etc/apparmor.d/rootlesskit ] && echo present || echo absent)"
  emit NOTE apparmor-automata-profile "$([ -e /etc/apparmor.d/automata-rootlesskit ] && echo present || echo absent)"
  emit NOTE apparmor-status "$(aa-status 2>/dev/null | grep -i rootlesskit | head -n3 | tr '\n' ';' | clean_text)"
  emit NOTE host-ipv6 "$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/ {print $2}' | tr '\n' ' ' | clean_text)"
}

# shellcheck disable=SC2329 # invoked through `check` or a trap
rootless_cgroup2() {
  local info
  info="$(dk info --format '{{.SecurityOptions}} cgroup{{.CgroupVersion}}' 2>/dev/null)" || return 1
  case "$info" in *rootless*cgroup2*) return 0 ;; *) return 1 ;; esac
}

# shellcheck disable=SC2329 # invoked through `check` or a trap
worker_cannot_reach() {
  ! runuser -u "$WORKER_USER" -- env -u DOCKER_HOST docker -H "unix://$SOCK" info >/dev/null 2>&1
}

# shellcheck disable=SC2329 # invoked through `check` or a trap
runner_distinct() {
  local mine theirs
  mine="$(dk info --format '{{.DockerRootDir}}')"
  theirs="$(docker -H unix:///run/automata-docker/docker.sock info --format '{{.DockerRootDir}}')"
  [ -n "$mine" ] && [ "$mine" != "$theirs" ]
}

daemon_checks() {
  check daemon-rootless-cgroup2 "docker info on the dedicated socket" rootless_cgroup2
  check worker-denied "$WORKER_USER cannot reach the socket" worker_cannot_reach
  if [ -S /run/automata-docker/docker.sock ]; then
    check runner-daemon-distinct "other socket, other data root" runner_distinct
  else
    emit NOTE runner-daemon-distinct "runner daemon not installed on this box"
  fi
}

pull_images() {
  local pair ref tag attempt
  for pair in "$SERVER automata-osb/server:1.2.1" "$EXECD automata-osb/execd:1.2.1" \
    "$EGRESS automata-osb/egress:1.2.1" "$PY automata-osb/py:3.12"; do
    ref="${pair% *}"
    tag="${pair#* }"
    for attempt in 1 2 3; do
      dk pull -q "$ref" >/dev/null && break
      [ "$attempt" = 3 ] && die "pull failed: $ref"
      sleep $((attempt * 5))
    done
    dk tag "$ref" "$tag"
  done
  emit NOTE images-pulled "4 by digest, tagged automata-osb/*"
}

prepare_state() {
  [ -d "$RUN_DIR" ] || die "$RUN_DIR is missing: the opensandbox profile's tmpfiles entry creates it"
  runuser -u "$RUNNER" -- mkdir -p -m 0700 "$P0" "$P0/dockercfg"
}

# The copy-up check behind decision 4: a marker written under /run/automata-opensandbox
# must be visible inside a container of the dedicated daemon (rootlesskit copies /run
# up at its start). On FAIL, G1 uses the /var/lib fallback.
# shellcheck disable=SC2329 # invoked through `check` or a trap
run_dir_visible() {
  local want got
  want="p0-marker-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s' "$want" | runuser -u "$RUNNER" -- tee "$P0/marker" >/dev/null
  got="$(dk run --rm -v "$P0:/x:ro" "$PY" cat /x/marker 2>/dev/null)" || return 1
  [ "$got" = "$want" ]
}

# Throwaway key and rendered config, both 0600 and owned by the rootless uid.
render_config() {
  (
    umask 077
    openssl rand -hex 32 >"$P0/key"
    awk -v port="$PORT" 'NR == FNR { k = $0; next }
      /^port = / { print "port = " port; next }
      { sub(/__API_KEY__/, k); print }' "$P0/key" "$HERE/opensandbox-server.toml" >"$P0/config.toml"
  )
  chown "$RUNNER:$RUNNER" "$P0/key" "$P0/config.toml"
}

start_server() {
  dk run -d --name "$SERVER_NAME" --network host --label automata.osb.p0=1 \
    -v "$SOCK:/var/run/docker.sock" -v "$P0:/etc/opensandbox:ro" -v "$DATA_VOLUME:/data" \
    -e SANDBOX_CONFIG_PATH=/etc/opensandbox/config.toml automata-osb/server:1.2.1 >/dev/null
}

# shellcheck disable=SC2329 # invoked through `check` or a trap
server_healthy() {
  local _
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# shellcheck disable=SC2329 # invoked through `check` or a trap
loopback_only() {
  local addrs
  addrs="$(ss -ltnH "sport = :$PORT" | awk '{print $4}')"
  [ -n "$addrs" ] && ! printf '%s\n' "$addrs" | grep -qv '^127\.0\.0\.1:'
}

# shellcheck disable=SC2329 # invoked through `check` or a trap
only_dedicated_socket() {
  local sources
  sources="$(dk inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$SERVER_NAME" | grep 'docker.sock' || true)"
  [ "$sources" = "$SOCK" ]
}

server_checks() {
  check server-healthy "127.0.0.1:$PORT answers /health on the host netns" server_healthy
  check server-host-loopback "listener on 127.0.0.1 only" loopback_only
  check server-mounts-dedicated-socket-only "the one socket mount is the dedicated socket" only_dedicated_socket
}

# While the driver runs, capture the sidecar's ruleset from a live cell.
watch_sidecar() {
  local c
  while [ ! -e "$P0/driver.done" ]; do
    c="$(dk ps --format '{{.Names}}' | grep egress | head -n1 || true)"
    if [ -n "$c" ] && dk exec "$c" nft list ruleset >"$P0/nft.txt" 2>/dev/null &&
      grep -q 'table inet opensandbox' "$P0/nft.txt"; then
      return 0
    fi
    sleep 2
  done
}

first_addr() { getent "$1" example.org | awk 'NR == 1 {print $1}'; }

run_driver() {
  local v4 v6 box_ip drv=0
  v4="$(first_addr ahostsv4)"
  v6="$(first_addr ahostsv6)"
  box_ip="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
  [ -n "$v4" ] && [ -n "$box_ip" ] || die "could not resolve example.org over IPv4 or find the box address"
  rm -f "$P0/driver.done" 2>/dev/null || true
  watch_sidecar &
  local watcher=$!
  set +e
  (cd "$repo_root" && node --import tsx packages/sandbox/src/providers/opensandbox-it/p0-probe.ts \
    --base-url "http://127.0.0.1:$PORT" --key-file "$P0/key" --allow-host httpbin.org \
    --example-v4 "$v4" --example-v6 "${v6:-none}" --box-ip "$box_ip" \
    --out "$out_dir/driver.json") 2>&1 | tee "$out_dir/driver.log"
  drv="${PIPESTATUS[0]}"
  set -e
  : >"$P0/driver.done"
  wait "$watcher" || true
  local st name _rest
  while read -r st name _rest; do
    case "$st" in PASS | FAIL | NOTE) results+=("$st $name") ;; esac
  done <"$out_dir/driver.log"
  [ "$drv" -eq 0 ] || emit FAIL driver-exit "exit $drv"
}

sidecar_ruleset() {
  if [ -s "$P0/nft.txt" ] && grep -q 'table inet opensandbox' "$P0/nft.txt"; then
    check sidecar-ruleset-policy-drop "table inet opensandbox, policy drop" grep -q 'policy drop' "$P0/nft.txt"
    if grep -qE 'table ip6 .*nat|redirect' "$P0/nft.txt"; then
      emit NOTE sidecar-ip6-nat-redirect "rendered"
    else
      emit NOTE sidecar-ip6-nat-redirect "not rendered"
    fi
    cp "$P0/nft.txt" "$out_dir/nft.txt"
  else
    emit FAIL sidecar-ruleset-policy-drop "no ruleset captured from a live sidecar"
  fi
}

survivors() {
  local before="$1" after
  teardown_server_only
  after="$(snapshot)"
  if [ "$before" = "$after" ]; then
    emit PASS no-survivors "containers, volumes, networks, netns back to baseline"
  else
    emit FAIL no-survivors "$(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep '^[<>]' | tr '\n' ';' | clean_text)"
  fi
  emit NOTE netfilter-diff "not compared; docker's empty 'table ip raw' is expected"
}

teardown_server_only() {
  dk rm -f -v "$SERVER_NAME" >/dev/null 2>&1 || true
  dk volume rm -f "$DATA_VOLUME" >/dev/null 2>&1 || true
}

has_pass() {
  local r
  for r in "${results[@]}"; do [ "$r" = "PASS $1" ] && return 0; done
  return 1
}

# A verdict needs these to have actually passed, so a driver that died early is not "rootless".
require_passes() {
  local c
  for c in run-dir-visible self-check-blocked allowed-https-200 example-dns-nxdomain negative-control-4of4 sidecar-ruleset-policy-drop; do
    has_pass "$c" || emit FAIL "required-$c" "never passed"
  done
}

write_json() {
  local verdict="$1" sep="" r
  {
    printf '{"verdict":"%s","arch":"%s","checks":[' "$verdict" "$(uname -m)"
    for r in "${results[@]}"; do
      printf '%s{"status":"%s","check":"%s"}' "$sep" "${r%% *}" "${r#* }"
      sep=","
    done
    printf '],"driver":'
    if [ -s "$out_dir/driver.json" ]; then cat "$out_dir/driver.json"; else printf 'null'; fi
    printf '}\n'
  } >"$out_dir/p0.json"
}

verdict() {
  local failed=() r
  for r in "${results[@]}"; do
    [ "${r%% *}" = FAIL ] && failed+=("${r#* }")
  done
  if [ "${#failed[@]}" -eq 0 ]; then
    write_json rootless
    echo "P0 VERDICT: rootless"
    exit 0
  fi
  write_json fail
  echo "P0 VERDICT: FAIL (${failed[*]}) -> dind fallback"
  exit 1
}

record_environment
daemon_checks
prepare_state
pull_images
check run-dir-visible "marker under $RUN_DIR/p0 read back in a container" run_dir_visible
baseline="$(snapshot)"
render_config
start_server
server_checks
run_driver
sidecar_ruleset
survivors "$baseline"
require_passes
verdict
