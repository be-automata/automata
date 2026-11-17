# shellcheck shell=bash disable=SC2034
# Sourced by install-rootless-docker.sh and opensandbox-p0-probe.sh: the two
# socket checks both run, so they cannot drift. Both need $SOCK (the daemon's
# socket); DOCKER_CONFIG_DIR, when set, is the docker client config to use.

# docker_as USER ARGS...: docker on $SOCK as USER, with no DOCKER_HOST of its own.
docker_as() {
  local user="$1"
  shift
  runuser -u "$user" -- env -u DOCKER_HOST ${DOCKER_CONFIG_DIR:+"DOCKER_CONFIG=$DOCKER_CONFIG_DIR"} \
    docker -H "unix://$SOCK" "$@"
}

# rootless_cgroup2 USER: the daemon answers USER, is rootless and on cgroup v2.
# Leaves what it saw in $socket_info.
rootless_cgroup2() {
  socket_info=""
  socket_info="$(docker_as "$1" info --format '{{.CgroupVersion}} {{json .SecurityOptions}}' 2>&1)" || return 1
  case "$socket_info" in 2\ *rootless*) return 0 ;; *) return 1 ;; esac
}

# socket_denied USER: 0 when USER is refused FOR PERMISSION (another failure
# proves nothing about the denial), 1 when USER reaches the daemon, 2 when it is
# refused for another reason. Leaves what it saw in $socket_info.
socket_denied() {
  socket_info=""
  if socket_info="$(docker_as "$1" info 2>&1)"; then
    return 1
  fi
  printf '%s' "$socket_info" | grep -qi 'permission denied' || return 2
}
