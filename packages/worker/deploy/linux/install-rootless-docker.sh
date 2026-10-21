#!/bin/bash
set -euo pipefail
umask 022
#
# install-rootless-docker.sh — the DEDICATED rootless Docker daemon agent-run
# containers execute on (ADR-013 Decision 2, plan P0/P1). Root required.
# Ubuntu 24.04, cgroup v2. For the THROWAWAY box: nothing here touches the
# worker unit, its env or the rootful daemon that runs the engine stack, and it
# never sets WORKER_DEV_CONTAINER_RUNS.
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
#   - /run/automata-docker (tmpfiles.d, 0750 automata-runner:automata-docker):
#     the socket lives here, outside /run/user/<uid> (0700) and outside every
#     run namespace;
#   - cgroup v2 delegation for the runner's user manager:
#     /etc/systemd/system/user@<uid>.service.d/10-automata-delegate.conf with
#     `Delegate=cpu cpuset io memory pids`, so --memory, --pids-limit and
#     --cpus are enforceable under rootless (P0 PROVES it: see
#     prove-container-limits.sh; the migration stops if they are not);
#   - lingering for the runner (its user manager runs without a login);
#   - the user unit automata-runner-docker.service (this dir), enabled and
#     started in the runner's user manager;
#   - verifies, AS THE WORKER ACCOUNT, that the socket answers, that the daemon
#     is rootless on cgroup v2, and that the runner's user manager delegates
#     the cpu, memory and pids controllers.
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
  local fail=0 uid info ctrl
  uid="$(id -u "$RUNNER" 2>/dev/null)" || {
    echo "FAIL runner-user        $RUNNER does not exist"
    return 1
  }
  if id -nG "$worker_user" | tr ' ' '\n' | grep -qx "$GROUP"; then
    echo "ok   worker-group        $worker_user is in $GROUP"
  else
    echo "FAIL worker-group        $worker_user is not in $GROUP"
    fail=1
  fi
  ctrl="/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/cgroup.controllers"
  for c in cpu memory pids; do
    if [ -r "$ctrl" ] && tr ' ' '\n' <"$ctrl" | grep -qx "$c"; then
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
for u in "$RUNNER" "$worker_user"; do
  if ! id -nG "$u" | tr ' ' '\n' | grep -qx "$GROUP"; then
    log "adding $u to $GROUP"
    usermod -aG "$GROUP" "$u"
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
if [ "$(cat "$dropin" 2>/dev/null || true)" != "$want_dropin" ]; then
  log "delegating cpu cpuset io memory pids to user@$runner_uid.service"
  mkdir -p "$dropin_dir"
  printf '%s\n' "$want_dropin" >"$dropin"
  systemctl daemon-reload
  # The running user manager keeps its old delegation until it restarts.
  if systemctl is-active --quiet "user@$runner_uid.service"; then
    systemctl restart "user@$runner_uid.service"
  fi
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

verify
