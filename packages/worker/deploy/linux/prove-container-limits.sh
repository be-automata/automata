#!/bin/bash
set -euo pipefail
#
# prove-container-limits.sh SOCKET IMAGE — the ADR-013 P0 BLOCKER: under the
# daemon at SOCKET, are --memory, --pids-limit and --cpus actually enforced?
#
#   memory  a container that allocates past --memory is OOM-killed and
#           .State.OOMKilled is true;
#   pids    a fork loop inside --pids-limit stops at the limit;
#   cpus    a CPU burner under --cpus 0.5 is throttled (cpu.stat nr_throttled
#           and throttled_usec grow), read from inside the container;
#   rm      `docker rm -f -v` of a container with a setsid-detached child leaves
#           nothing of it running (the container is the reaper).
#
# Each probe prints one PASS/FAIL line; exit 0 iff every probe passed. Every
# container runs with the run hardening baseline (--network none, --cap-drop
# ALL, no-new-privileges, --init, --read-only) and is removed afterwards.
# Needs no credential. Run it as the WORKER account on the box (it reaches the
# rootless socket through its group), e.g.:
#
#   sudo -u automata packages/worker/deploy/linux/prove-container-limits.sh \
#     /run/automata-docker/docker.sock \
#     ghcr.io/be-automata/automata-batteries@sha256:<digest>

if [ "$#" -ne 2 ]; then
  echo "usage: $0 SOCKET IMAGE" >&2
  exit 2
fi
sock="$1"
image="$2"
d() { docker -H "unix://$sock" "$@"; }
base=(--network none --cap-drop ALL --security-opt no-new-privileges --init --read-only
  --tmpfs "/tmp:rw,nosuid,nodev,size=64m" --user 10001:10001 --entrypoint /bin/bash)
fail=0
pass() { printf 'PASS %-7s %s\n' "$1" "$2"; }
bad() {
  printf 'FAIL %-7s %s\n' "$1" "$2"
  fail=1
}
# One name per probe, removed on exit whatever happened.
prefix="automata-prove-$$"
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  for p in mem pids pidsctl cpu rm; do d rm -f -v "$prefix-$p" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

d version --format '{{.Server.Version}}' >/dev/null || {
  echo "FAIL socket  $sock does not answer" >&2
  exit 2
}
printf 'info    %s\n' "$(d info --format 'cgroup v{{.CgroupVersion}} driver={{.CgroupDriver}} security={{json .SecurityOptions}}')"

# ── memory: 128 MiB limit, allocate 512 MiB ──────────────────────────────────
n="$prefix-mem"
d run --name "$n" "${base[@]}" --memory 128m --memory-swap 128m "$image" \
  -c 'python3 -c "b = bytearray(512 * 1024 * 1024); print(len(b))"' >/dev/null 2>&1 || true
state="$(d inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' "$n" 2>/dev/null || echo "missing")"
case "$state" in
  "true "*) pass memory "allocation past --memory was OOM-killed (OOMKilled=true, exit ${state#* })" ;;
  *) bad memory "not OOM-killed under --memory 128m (state: $state)" ;;
esac

# ── pids: 64-task limit, try 200 sleepers ────────────────────────────────────
n="$prefix-pids"
# The same loop with a high limit is the control: it must get past 64, or
# the probe could not tell an enforced limit from a loop that never forked.
# shellcheck disable=SC2016 # expanded inside the container
fork_loop='for _ in $(seq 1 200); do (sleep 30 &) 2>/dev/null; done
  sleep 1; ls /proc | grep -c "^[0-9]*$"'
out="$(d run --name "$n" "${base[@]}" --pids-limit 64 "$image" -c "$fork_loop" 2>/dev/null || true)"
procs="$(printf '%s' "$out" | tail -n 1)"
ctl="$(d run --name "$prefix-pidsctl" "${base[@]}" --pids-limit 1024 "$image" -c "$fork_loop" 2>/dev/null | tail -n 1 || true)"
if ! [[ "$ctl" =~ ^[0-9]+$ ]] || [ "$ctl" -le 64 ]; then
  bad pids "control run under --pids-limit 1024 did not exceed 64 tasks (saw: ${ctl:-nothing}); probe inconclusive"
elif [[ "$procs" =~ ^[0-9]+$ ]] && [ "$procs" -le 64 ]; then
  pass pids "fork loop stopped at the limit ($procs live tasks <= 64; control without it: $ctl)"
else
  bad pids "fork loop not bounded by --pids-limit 64 (saw: ${procs:-nothing}; control: $ctl)"
fi

# ── cpus: 0.5 CPU, burn 3 s, read the container's own cpu.stat ───────────────
n="$prefix-cpu"
# shellcheck disable=SC2016 # expanded inside the container
out="$(d run --name "$n" "${base[@]}" --cpus 0.5 "$image" -c '
  end=$((SECONDS + 3)); while [ "$SECONDS" -lt "$end" ]; do :; done
  grep -E "^(nr_throttled|throttled_usec) " /sys/fs/cgroup/cpu.stat' 2>/dev/null || true)"
throttled="$(printf '%s\n' "$out" | awk '$1 == "nr_throttled" {print $2}')"
if [[ "$throttled" =~ ^[0-9]+$ ]] && [ "$throttled" -gt 0 ]; then
  pass cpus "burner throttled under --cpus 0.5 (nr_throttled=$throttled)"
else
  bad cpus "no throttling observed under --cpus 0.5 (cpu.stat: ${out:-unreadable})"
fi

# ── rm -f: a setsid-detached child dies with the container ───────────────────
n="$prefix-rm"
d run -d --name "$n" "${base[@]}" "$image" -c 'setsid sleep 600 </dev/null >/dev/null 2>&1 & sleep 600' >/dev/null
sleep 1
# Every process of the container, as HOST pids (the detached child included).
pids="$(d top "$n" -eo pid 2>/dev/null | tail -n +2 | tr -d ' ' | tr '\n' ' ')"
d rm -f -v "$n" >/dev/null
sleep 1
alive=""
count=0
for p in $pids; do
  count=$((count + 1))
  # `ps -p`, not `kill -0`: the container's processes run as subordinate uids,
  # so a signal probe from the worker account is EPERM for every one of them,
  # alive or not, and the probe would pass vacuously.
  if [[ "$p" =~ ^[0-9]+$ ]] && ps -p "$p" >/dev/null 2>&1; then alive="$alive $p"; fi
done
if [ "$(uname -s)" != Linux ]; then
  # Docker Desktop/OrbStack: those pids live in a VM, invisible from here.
  printf 'SKIP %-7s %s\n' rm "host pids are only checkable on a Linux host"
elif [ "$count" -lt 2 ]; then
  bad rm "could not list the container's processes before removal (docker top: ${pids:-none})"
elif [ -n "$alive" ]; then
  bad rm "host pid(s)$alive still alive after docker rm -f"
elif d inspect "$n" >/dev/null 2>&1; then
  bad rm "container still exists after docker rm -f"
else
  pass rm "docker rm -f -v removed the container and all $count of its processes, the setsid child included"
fi

exit "$fail"
