#!/bin/bash
set -euo pipefail
umask 022
#
# install-rootless-docker.sh — the DEDICATED rootless Docker daemon agent-run
# containers execute on (ADR-013 Decision 2, plan P0/P1). Root required.
# Ubuntu 24.04, cgroup v2. Nothing here touches the worker unit, its env or the
# rootful daemon that runs the engine stack.
#
# What it does (idempotent: every step checks before it changes, so a second
# run changes nothing and restarts nothing):
#   - installs docker-ce-rootless-extras, uidmap, dbus-user-session and
#     slirp4netns when missing (the Docker apt repo is already configured on
#     the box: the engine stack's docker-ce comes from it);
#   - Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor:
#     when kernel.apparmor_restrict_unprivileged_userns=1 it installs the
#     rootlesskit profile Docker documents (userns allowed for that binary only);
#   - system user `automata-runner` (no login shell, no sudo), home
#     /var/lib/automata-runner, with its own 65536-id subuid/subgid range placed
#     after every existing range;
#   - group `automata-docker`: the runner and the worker account are members.
#     Membership is what lets the worker reach the daemon's socket WITHOUT sudo,
#     and reaching it is acting as `automata-runner`, never as host root;
#   - the worker account joins `automata-runner`'s PRIMARY group too: the
#     run-dir hand-over (ADR-013 "Daemon socket") makes <runDir> setgid and
#     group-owned by that group (WORKER_CONTAINER_RUN_GID, container gid 0 via
#     `--group-add 0`), and the worker can only chgrp to a group it is in;
#   - /run/automata-docker (tmpfiles.d, 0750 automata-runner:automata-docker):
#     the socket lives here, outside /run/user/<uid> (0700) and outside every
#     run namespace. The socket itself is automata-runner:automata-docker 0660,
#     set by the unit from the host side (see automata-runner-docker.service:
#     dockerd's own --group resolves inside the user namespace);
#   - cgroup v2 delegation for the runner's user manager:
#     /etc/systemd/system/user@<uid>.service.d/10-automata-delegate.conf with
#     `Delegate=cpu cpuset io memory pids`, so --memory, --pids-limit and
#     --cpus are enforceable under rootless (P0 PROVES it: see
#     prove-container-limits.sh; the migration stops if they are not);
#   - lingering for the runner (its user manager runs without a login);
#   - the user unit automata-runner-docker.service (this dir), enabled and
#     started in the runner's user manager;
#   - verifies (also all `--check` does): the worker is in both groups, the
#     runner has its subuid/subgid ranges and lingers, its user manager
#     delegates the cpu, memory and pids controllers, the socket dir and the
#     socket carry the owner, group and mode above (nothing for "other"), and,
#     AS THE WORKER ACCOUNT, that the socket answers and the daemon is rootless
#     on cgroup v2.
#     It does not prove the limits are enforced: prove-container-limits.sh does.
#
# Usage: install-rootless-docker.sh [--worker-user NAME] [--check]
#   --worker-user  the worker's account (default: automata)
#   --check        verify only; change nothing (exit 1 on any failure)
#
# Pulling the batteries image is a separate, explicit step (by digest only):
#   sudo -u automata-runner -- env XDG_RUNTIME_DIR=/run/user/<uid> \
#     docker -H unix:///run/automata-docker/docker.sock pull <repo>@sha256:<digest>

RUNNER=automata-runner
RUNNER_HOME=/var/lib/automata-runner
GROUP=automata-docker
SOCK_DIR=/run/automata-docker
SOCK="$SOCK_DIR/docker.sock"
UNIT=automata-runner-docker.service
SUBID_COUNT=65536
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

worker_user=automata
check_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worker-user)
      worker_user="${2:?--worker-user needs a name}"
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    *)
      echo "usage: $0 [--worker-user NAME] [--check]" >&2
      exit 2
      ;;
  esac
done

log() { printf 'rootless-docker: %s\n' "$*"; }
# in_group USER GROUP: USER is a member of GROUP (primary or supplementary).
in_group() { id -nG "$1" | tr ' ' '\n' | grep -qx "$2"; }
die() {
  printf 'rootless-docker: FATAL: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -s)" = Linux ] || die "Linux only"
[ -f /sys/fs/cgroup/cgroup.controllers ] || die "cgroup v2 (unified hierarchy) is required"
id -u "$worker_user" >/dev/null 2>&1 || die "worker account $worker_user does not exist"

# ── verification (also the tail of every install run) ─────────────────────────
verify() {
  local fail=0 uid run_group info ctrl got
  uid="$(id -u "$RUNNER" 2>/dev/null)" || {
    echo "FAIL runner-user        $RUNNER does not exist"
    return 1
  }
  run_group="$(id -gn "$RUNNER")"
  if in_group "$worker_user" "$GROUP"; then
    echo "ok   worker-group        $worker_user is in $GROUP"
  else
    echo "FAIL worker-group        $worker_user is not in $GROUP"
    fail=1
  fi
  # The run-dir hand-over (WORKER_CONTAINER_RUN_GID, --group-add 0).
  if in_group "$worker_user" "$run_group"; then
    echo "ok   worker-run-group    $worker_user is in $run_group ($RUNNER's primary group)"
  else
    echo "FAIL worker-run-group    $worker_user is not in $run_group ($RUNNER's primary group)"
    fail=1
  fi
  # The group grant is the whole access control: the dir admits only the
  # group, the socket only owner and group. A subordinate gid on the socket
  # (dockerd's --group resolved inside the user namespace) fails here.
  got="$(stat -c '%U:%G %a' "$SOCK_DIR" 2>/dev/null || echo missing)"
  if [ "$got" = "$RUNNER:$GROUP 750" ]; then
    echo "ok   socket-dir          $SOCK_DIR is $got"
  else
    echo "FAIL socket-dir          $SOCK_DIR is $got, want $RUNNER:$GROUP 750"
    fail=1
  fi
  got="$(stat -c '%U:%G %a' "$SOCK" 2>/dev/null || echo missing)"
  if [ -S "$SOCK" ] && [ "$got" = "$RUNNER:$GROUP 660" ]; then
    echo "ok   socket-perms        $SOCK is $got"
  else
    echo "FAIL socket-perms        $SOCK is $got, want a socket $RUNNER:$GROUP 660"
    fail=1
  fi
  # Each id range is what maps container uids to unprivileged host ids, and
  # linger is what keeps the daemon up with nobody logged in.
  for f in /etc/subuid /etc/subgid; do
    if grep -q "^$RUNNER:[0-9]*:$SUBID_COUNT\$" "$f" 2>/dev/null; then
      echo "ok   ${f#/etc/}-range        $RUNNER has its $SUBID_COUNT ids"
    else
      echo "FAIL ${f#/etc/}-range        no $RUNNER:<start>:$SUBID_COUNT line in $f"
      fail=1
    fi
  done
  if [ "$(loginctl show-user "$RUNNER" --property=Linger --value 2>/dev/null || true)" = yes ]; then
    echo "ok   linger              $RUNNER lingers"
  else
    echo "FAIL linger              $RUNNER does not linger (its daemon stops at logout/reboot)"
    fail=1
  fi
  ctrl="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/cgroup.controllers"
  for c in cpu memory pids; do
    if [ -r "$ctrl" ] && tr ' ' '\n' <"$ctrl" | grep -x "$c" >/dev/null; then
      echo "ok   delegated-$c        user@$uid.service"
    else
      echo "FAIL delegated-$c        not in $ctrl"
      fail=1
    fi
  done
  # As the WORKER, through its group grant, with no DOCKER_HOST of its own.
  if info="$(runuser -u "$worker_user" -- env -u DOCKER_HOST docker -H "unix://$SOCK" \
    info --format '{{.CgroupVersion}} {{json .SecurityOptions}}' 2>&1)"; then
    case "$info" in
      2\ *rootless*) echo "ok   rootless-socket     $SOCK answers the worker: cgroup v2, rootless" ;;
      *)
        echo "FAIL rootless-socket     $SOCK answers but is not rootless on cgroup v2: $info"
        fail=1
        ;;
    esac
  else
    echo "FAIL rootless-socket     $SOCK does not answer the worker: $info"
    fail=1
  fi
  return "$fail"
}

if [ "$check_only" -eq 1 ]; then
  verify
  exit $?
fi

# ── packages ─────────────────────────────────────────────────────────────────
missing=()
for pkg in docker-ce-rootless-extras uidmap dbus-user-session slirp4netns; do
  dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
done
if [ "${#missing[@]}" -gt 0 ]; then
  # A bare docker-ce-rootless-extras resolves to the newest version and
  # upgrades docker-ce with it, restarting the root daemon that runs the engine
  # stack: pin it to the installed docker-ce instead.
  dce_ver="$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || true)"
  if [ -n "$dce_ver" ]; then
    for i in "${!missing[@]}"; do
      [ "${missing[$i]}" != docker-ce-rootless-extras ] || missing[i]="docker-ce-rootless-extras=$dce_ver"
    done
  fi
  log "installing ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
fi
command -v dockerd-rootless.sh >/dev/null || die "dockerd-rootless.sh missing after install"

# ── AppArmor: unprivileged userns for rootlesskit only (Ubuntu 24.04) ─────────
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  rk="$(command -v rootlesskit)" || die "rootlesskit missing"
  profile="/etc/apparmor.d/automata-rootlesskit"
  want="$(printf 'abi <abi/4.0>,\ninclude <tunables/global>\n\n%s flags=(unconfined) {\n  userns,\n}\n' "$rk")"
  if [ ! -f "$profile" ] || [ "$(cat "$profile")" != "$want" ]; then
    log "AppArmor: allowing userns for $rk"
    printf '%s\n' "$want" >"$profile"
    apparmor_parser -r "$profile"
  fi
fi

# ── the runner account and its id ranges ─────────────────────────────────────
if ! getent group "$GROUP" >/dev/null; then
  log "creating group $GROUP"
  groupadd --system "$GROUP"
fi
if ! id -u "$RUNNER" >/dev/null 2>&1; then
  log "creating system user $RUNNER"
  useradd --system --create-home --home-dir "$RUNNER_HOME" --shell /usr/sbin/nologin "$RUNNER"
fi
# The runner needs automata-docker itself: the unit's ExecStartPost chgrp runs
# as the runner, and its user manager only has the groups it started with.
runner_joined=0
if ! in_group "$RUNNER" "$GROUP"; then
  log "adding $RUNNER to $GROUP"
  usermod -aG "$GROUP" "$RUNNER"
  runner_joined=1
fi
# The worker: automata-docker for the socket, the runner's primary group for
# the run-dir hand-over (WORKER_CONTAINER_RUN_GID, --group-add 0).
run_group="$(id -gn "$RUNNER")"
for g in "$GROUP" "$run_group"; do
  if ! in_group "$worker_user" "$g"; then
    log "adding $worker_user to $g (a RUNNING worker gets it only when it restarts)"
    usermod -aG "$g" "$worker_user"
  fi
done
# One range per file, placed after every existing range so no two accounts
# share a host id.
for f in /etc/subuid /etc/subgid; do
  touch "$f"
  if ! grep -q "^$RUNNER:" "$f"; then
    start="$(awk -F: 'BEGIN{m=100000} {e=$2+$3; if (e>m) m=e} END{print m}' "$f")"
    log "allocating $f range $start+$SUBID_COUNT for $RUNNER"
    printf '%s:%s:%s\n' "$RUNNER" "$start" "$SUBID_COUNT" >>"$f"
  fi
done
runner_uid="$(id -u "$RUNNER")"

# ── socket dir, delegation, linger ───────────────────────────────────────────
tmpfiles=/etc/tmpfiles.d/automata-docker.conf
want_tmpfiles="d $SOCK_DIR 0750 $RUNNER $GROUP -"
if [ "$(cat "$tmpfiles" 2>/dev/null || true)" != "$want_tmpfiles" ]; then
  printf '%s\n' "$want_tmpfiles" >"$tmpfiles"
fi
systemd-tmpfiles --create "$tmpfiles"

dropin_dir="/etc/systemd/system/user@$runner_uid.service.d"
dropin="$dropin_dir/10-automata-delegate.conf"
want_dropin="$(printf '[Service]\nDelegate=cpu cpuset io memory pids')"
restart_manager="$runner_joined"
if [ "$(cat "$dropin" 2>/dev/null || true)" != "$want_dropin" ]; then
  log "delegating cpu cpuset io memory pids to user@$runner_uid.service"
  mkdir -p "$dropin_dir"
  printf '%s\n' "$want_dropin" >"$dropin"
  systemctl daemon-reload
  restart_manager=1
fi
# A running user manager keeps its old delegation and its old groups until it
# restarts.
if [ "$restart_manager" -eq 1 ] && systemctl is-active --quiet "user@$runner_uid.service"; then
  log "restarting user@$runner_uid.service"
  systemctl restart "user@$runner_uid.service"
fi
if [ "$(loginctl show-user "$RUNNER" --property=Linger --value 2>/dev/null || echo no)" != yes ]; then
  log "enabling linger for $RUNNER"
  loginctl enable-linger "$RUNNER"
fi
for _ in $(seq 1 50); do
  [ -S "/run/user/$runner_uid/bus" ] && break
  sleep 0.2
done
[ -S "/run/user/$runner_uid/bus" ] || die "the user manager of $RUNNER did not come up"

# ── the user unit ────────────────────────────────────────────────────────────
unit_dir="$RUNNER_HOME/.config/systemd/user"
install -d -o "$RUNNER" -g "$RUNNER" -m 0755 "$RUNNER_HOME/.config" "$RUNNER_HOME/.config/systemd" "$unit_dir"
if ! cmp -s "$HERE/$UNIT" "$unit_dir/$UNIT"; then
  log "installing $UNIT"
  install -o "$RUNNER" -g "$RUNNER" -m 0644 "$HERE/$UNIT" "$unit_dir/$UNIT"
  changed_unit=1
else
  changed_unit=0
fi
as_runner() {
  runuser -u "$RUNNER" -- env XDG_RUNTIME_DIR="/run/user/$runner_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runner_uid/bus" "$@"
}
as_runner systemctl --user daemon-reload
as_runner systemctl --user enable "$UNIT" >/dev/null
if [ "$changed_unit" -eq 1 ]; then
  as_runner systemctl --user restart "$UNIT"
else
  as_runner systemctl --user start "$UNIT"
fi
for _ in $(seq 1 100); do
  [ -S "$SOCK" ] && break
  sleep 0.2
done
[ -S "$SOCK" ] || die "$SOCK did not appear (journalctl --user -M $RUNNER@ -u $UNIT)"
# The unit's ExecStartPost sets the socket's group right after it appears;
# give a restart the same bounded wait for it.
for _ in $(seq 1 50); do
  [ "$(stat -c %G "$SOCK" 2>/dev/null || true)" = "$GROUP" ] && break
  sleep 0.2
done

verify
