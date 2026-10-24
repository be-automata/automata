#!/bin/bash
set -euo pipefail
umask 022
#
# provision-execution-box.sh — ADR-013 "Fleet: one provisioning script" (plan
# P2, #431). Brings a fresh Ubuntu 24.04 box, or an existing one, to the
# container model. Root required. Idempotent: every step checks before it
# changes, so a second run prints only `ok`/`skip` lines and changes nothing.
#
# Steps, in order (one `ok|changed|skip <step> <detail>` line each; the first
# failure prints `FAIL <step> <detail>` and exits 1):
#
#   packages            docker-ce, its rootless extras, uidmap, dbus-user-session,
#                       slirp4netns and socat (the Docker apt repo is added when
#                       absent, exactly as cloud-init.yaml adds it)
#   rootless-daemon     packages/worker/deploy/linux/install-rootless-docker.sh:
#                       the automata-runner account, subuid/subgid, cgroup v2
#                       delegation, lingering, the socket group grant, AppArmor.
#                       Its own --check decides ok vs changed.
#   image-pull          the batteries image BY DIGEST into the rootless daemon's
#                       store (a tag reference is refused before anything runs)
#   image-attestation   `gh attestation verify oci://<ref> --repo be-automata/automata`;
#                       with no `gh` on the box: skip, with a loud WARNING on
#                       stderr (provenance NOT verified), never silently
#   proc-hidepid        /proc without hidepid (the host-uid fence's mount): a
#                       container cannot start under it. prepare-only reports
#                       it (skip) and skips image-verify; full mode drops it
#                       from /etc/fstab (backed up) and remounts /proc
#   image-verify        deploy/images/batteries/verify.sh against the digest, as
#                       the worker account, through the rootless socket
#   image-record        /etc/automata/batteries-image.state: CURRENT=<ref>, and
#                       the CURRENT it replaces becomes PREVIOUS
#   previous-image      the PREVIOUS digest stays pulled (pulled back if gone),
#                       so an image rollback is an env change. This script never
#                       removes an image. It is not pulled back when that would
#                       leave under PREVIOUS_MIN_FREE_GB (default 10) free in the
#                       rootless store: skip with a WARNING, and a rollback then
#                       pulls it first.
#   worker-runtime      full mode: node (the worker's floor) and pnpm on the host (checked only:
#                       the cloud-init.yaml base bring-up installs them)
#   worker-launcher     full mode: run-worker.sh.template -> ~/.automata/run-worker.sh
#   worker-unit         full mode: automata-worker.service rendered and enabled
#                       (never started or restarted: the operator restarts the
#                       worker at an idle moment)
#   worker-env          full mode: the container-path keys in
#                       ~/.automata/worker-box.env (WORKER_BATTERIES_IMAGE,
#                       WORKER_CONTAINER_DOCKER_SOCKET, WORKER_CONTAINER_RUN_GID)
#
# Modes:
#   (default)       full: every step above. For a fresh box (throwaway, or a
#                   new fleet box). The base bring-up (cloud-init.yaml: node,
#                   pnpm, the worker account, the checkout) is a precondition.
#   --prepare-only  the PRODUCTION box before the release (plan P2): the
#                   rootless daemon and the pre-pulled, verified digest only.
#                   The four worker-* steps print `skip`: no worker unit, env,
#                   launcher, nft table, slot account or drop-in is touched.
#   --dry-run       report what each step would change; change nothing (the
#                   read-only checks, attestation and verify.sh, still run when
#                   the image is already present).
#
# Never, in any mode: the dev-only container switch (ADR-013 Decision 6; only
# the throwaway box's env sets it, by hand), and nothing host-path is removed
# (no slot account, sudoers line, nft table, drop-in or battery tree: that is
# P4). With the loopback fence not provisioned on the box, the worker unit is
# rendered without its loader line (containers have their own loopback); with
# it provisioned, the unit keeps it.
#
# Usage:
#   sudo deploy/provision-execution-box.sh --image ghcr.io/be-automata/automata-batteries@sha256:<digest> \
#     [--prepare-only] [--dry-run] [--worker-user automata] [--repo /opt/automata-platform]
#
# `gh attestation verify` talks to the GitHub API: give it a token (any
# read-only one) as GH_TOKEN, e.g. `sudo GH_TOKEN=… deploy/provision-execution-box.sh …`.
#
# Exit: 0 every step ok/changed/skip; 1 a step failed; 2 usage or a refused
# image reference.

RUNNER=automata-runner
SOCK=/run/automata-docker/docker.sock
STATE=/etc/automata/batteries-image.state
PREVIOUS_MIN_FREE_GB="${PREVIOUS_MIN_FREE_GB:-10}"
ATTEST_REPO=be-automata/automata
UNIT_PATH=/etc/systemd/system/automata-worker.service
LOOPBACK_CONF=/etc/automata/loopback-nft.conf
LOOPBACK_LOADER=/usr/local/sbin/nft-loopback-load.sh
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

image=""
worker_user=automata
repo="$(cd "$HERE/.." && pwd)"
mode=full
dry_run=0

usage() {
  echo "usage: $0 --image <repo>@sha256:<digest> [--prepare-only] [--dry-run] [--worker-user NAME] [--repo PATH]" >&2
  exit 2
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      image="${2:-}"
      shift 2 || usage
      ;;
    --worker-user)
      worker_user="${2:-}"
      shift 2 || usage
      ;;
    --repo)
      repo="${2:-}"
      shift 2 || usage
      ;;
    --prepare-only)
      mode=prepare-only
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    *) usage ;;
  esac
done

refuse() {
  printf 'provision: refused: %s\n' "$*" >&2
  exit 2
}

# The worker's own rule (container-image.ts parsePinnedImage, ADR-013 I5): ONE
# immutable image, <repository>@sha256:<64 lowercase hex>. A tag is refused,
# and so is repo:tag@sha256:… (Docker would run the digest and the tag would
# be a label that lies about what runs).
DIGEST_RE='^sha256:[0-9a-f]{64}$'
REPO_RE='^([A-Za-z0-9.-]+(:[0-9]{1,5})?/)?[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*$'
validate_image() {
  local ref="$1" name digest last
  [ -n "$ref" ] || refuse "--image is required (<repository>@sha256:<digest>)"
  case "$ref" in
    *[[:space:]]*) refuse "image reference '$ref' contains whitespace" ;;
    *@*@*) refuse "image reference '$ref' has more than one '@'" ;;
    *@*) ;;
    *) refuse "image reference '$ref' is not pinned by digest: a tag can move under a running box (ADR-013 I5); use <repository>@sha256:<digest>" ;;
  esac
  name="${ref%@*}"
  digest="${ref#*@}"
  [[ "$digest" =~ $DIGEST_RE ]] || refuse "image digest '$digest' is not sha256:<64 lowercase hex>"
  last="${name##*/}"
  case "$last" in
    *:*) refuse "image reference '$ref' carries a tag next to its digest; pin the digest alone" ;;
  esac
  [[ "$name" =~ $REPO_RE ]] || refuse "image repository '$name' is not a valid lowercase repository name"
}
validate_image "$image"
[[ "$worker_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || refuse "--worker-user '$worker_user' is not an account name"
case "$repo" in
  /*) ;;
  *) refuse "--repo must be an absolute path" ;;
esac
# The templates are rendered with sed `s#…#…#`: a path carrying '#', '&' or a
# backslash would corrupt the render.
case "$repo" in *'#'* | *'&'* | *\\*) refuse "--repo '$repo' contains a character the template render cannot carry" ;; esac

INSTALLER="$repo/packages/worker/deploy/linux/install-rootless-docker.sh"
VERIFY="$repo/deploy/images/batteries/verify.sh"
UNIT_TEMPLATE="$repo/packages/worker/deploy/linux/automata-worker.service"
LAUNCHER_TEMPLATE="$repo/packages/worker/deploy/linux/run-worker.sh.template"

# ── reporting ────────────────────────────────────────────────────────────────
report() { printf '%s %s %s\n' "$1" "$2" "$3"; }
fail() {
  printf 'FAIL %s %s\n' "$1" "$2"
  exit 1
}
note() { printf 'provision: %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || {
  echo "provision: run as root" >&2
  exit 1
}
[ "$(uname -s)" = Linux ] || fail preflight "Linux only"
[ -f /sys/fs/cgroup/cgroup.controllers ] || fail preflight "cgroup v2 (unified hierarchy) is required"
id -u "$worker_user" >/dev/null 2>&1 || fail preflight "worker account $worker_user does not exist (the cloud-init.yaml base bring-up creates it)"
for f in "$INSTALLER" "$VERIFY" "$UNIT_TEMPLATE" "$LAUNCHER_TEMPLATE"; do
  [ -r "$f" ] || fail preflight "$f missing: --repo must be an automata-platform checkout"
done
# /etc/os-release is read, never sourced.
os_field() { sed -n "s/^$1=//p" /etc/os-release 2>/dev/null | tr -d '"' | head -n 1; }
if [ "$(os_field ID)-$(os_field VERSION_ID)" != ubuntu-24.04 ]; then
  note "WARNING: not Ubuntu 24.04; the steps are written for it"
fi
dry_label=""
[ "$dry_run" -eq 0 ] || dry_label=" (dry-run)"
report ok preflight "mode=$mode$dry_label image=$image"

# ── packages ─────────────────────────────────────────────────────────────────
PACKAGES="docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras uidmap dbus-user-session slirp4netns socat"
wait_for_apt() {
  local _
  for _ in $(seq 1 120); do
    fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock >/dev/null 2>&1 || return 0
    sleep 5
  done
  return 1
}
step_packages() {
  local missing="" pkg repo_added=0
  for pkg in $PACKAGES; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing="$missing $pkg"
  done
  if [ -z "$missing" ]; then
    report ok packages "all present"
    return
  fi
  # Never upgrade the root daemon that runs the engine stack: apt resolves a
  # bare docker-ce-rootless-extras to the newest version and upgrades docker-ce
  # with it, which restarts dockerd. On a box that has docker-ce, every Docker
  # package added here is pinned to docker-ce's installed version.
  local dce_ver
  dce_ver="$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || true)"
  if [ -n "$dce_ver" ]; then
    missing="$(for pkg in $missing; do
      case "$pkg" in docker-ce*) printf ' %s=%s' "$pkg" "$dce_ver" ;; *) printf ' %s' "$pkg" ;; esac
    done)"
  fi
  if [ "$dry_run" -eq 1 ]; then
    report changed packages "would install:$missing"
    return
  fi
  if ! grep -rqs download.docker.com /etc/apt/sources.list.d/; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc ||
      fail packages "could not fetch Docker's apt key"
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(os_field VERSION_CODENAME) stable" \
      >/etc/apt/sources.list.d/docker.list
    repo_added=1
  fi
  wait_for_apt || fail packages "dpkg/apt lock still held after 10 minutes"
  # shellcheck disable=SC2086 # a word list on purpose
  { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing; } >&2 ||
    fail packages "apt-get install failed:$missing"
  report changed packages "installed:$missing$([ "$repo_added" -eq 1 ] && echo ' (added the Docker apt repo)')"
}

# ── the rootless daemon (reuse, never duplicate) ─────────────────────────────
rootless_ok=0
step_rootless() {
  local out
  if out="$("$INSTALLER" --worker-user "$worker_user" --check 2>&1)"; then
    rootless_ok=1
    report ok rootless-daemon "install-rootless-docker.sh --check passed"
    return
  fi
  if [ "$dry_run" -eq 1 ]; then
    report changed rootless-daemon "would run install-rootless-docker.sh ($(printf '%s\n' "$out" | grep -c '^FAIL' || true) failing checks)"
    return
  fi
  "$INSTALLER" --worker-user "$worker_user" >&2 || fail rootless-daemon "install-rootless-docker.sh failed (output above)"
  "$INSTALLER" --worker-user "$worker_user" --check >&2 || fail rootless-daemon "installed, but --check still fails"
  rootless_ok=1
  report changed rootless-daemon "installed by install-rootless-docker.sh; --check passes"
}

home_of() { getent passwd "$1" | cut -d: -f6; }
# As the runner, like the installer's own README recipe; HOME set so the
# docker CLI never reaches for root's config.
runner_docker() {
  local uid
  uid="$(id -u "$RUNNER")"
  runuser -u "$RUNNER" -- env HOME="$(home_of "$RUNNER")" XDG_RUNTIME_DIR="/run/user/$uid" \
    docker -H "unix://$SOCK" "$@"
}
image_present() { [ "$rootless_ok" -eq 1 ] && runner_docker image inspect "$1" >/dev/null 2>&1; }

# step_pull STEP REF: the digest is in the rootless daemon's store.
step_pull() {
  local step="$1" ref="$2"
  if [ "$rootless_ok" -ne 1 ]; then
    report skip "$step" "dry-run: the rootless daemon is not installed yet"
    return
  fi
  if image_present "$ref"; then
    report ok "$step" "${ref#*@} present in the rootless store"
    return
  fi
  if [ "$dry_run" -eq 1 ]; then
    report changed "$step" "would pull ${ref#*@} (by digest)"
    return
  fi
  runner_docker pull "$ref" >&2 || fail "$step" "docker pull $ref failed"
  image_present "$ref" || fail "$step" "pulled, but $ref is not in the store"
  report changed "$step" "pulled ${ref#*@} by digest"
}

step_attestation() {
  if ! command -v gh >/dev/null 2>&1; then
    {
      echo "WARNING ============================================================="
      echo "WARNING  gh is not installed: the image's build provenance was NOT"
      echo "WARNING  verified (gh attestation verify oci://$image --repo $ATTEST_REPO)."
      echo "WARNING  Install gh and re-run before the first run uses this digest."
      echo "WARNING ============================================================="
    } >&2
    report skip image-attestation "gh not installed: provenance NOT verified (see WARNING)"
    return
  fi
  if ! image_present "$image"; then
    report skip image-attestation "image not pulled yet (dry-run)"
    return
  fi
  gh attestation verify "oci://$image" --repo "$ATTEST_REPO" >&2 ||
    fail image-attestation "gh attestation verify failed for $image (GH_TOKEN set?)"
  report ok image-attestation "provenance verified against $ATTEST_REPO"
}

# The host-uid fence mounts /proc with hidepid (fstab). Under it the runner's
# systemd user manager cannot see a container's processes (they run as
# subordinate uids), so runc's scope request fails with "Interactive
# authentication required" and no container starts (seen on the production
# box, reproduced on the throwaway box, 2026-10-23). A container has its own
# pid namespace, so the container model does not need hidepid. prepare-only
# leaves the host fence alone and says so; full mode removes it (fstab backed
# up next to it; a revert re-adds the line and remounts).
hidepid_blocks=0
step_proc_hidepid() {
  local opts
  opts="$(findmnt -no OPTIONS /proc 2>/dev/null || true)"
  case ",$opts," in
    *,hidepid=invisible,* | *,hidepid=noaccess,* | *,hidepid=ptraceable,* | *,hidepid=1,* | *,hidepid=2,* | *,hidepid=4,*) ;;
    *)
      report ok proc-hidepid "/proc has no hidepid"
      return
      ;;
  esac
  if [ "$mode" != full ]; then
    hidepid_blocks=1
    report skip proc-hidepid "/proc is mounted $opts (host-uid fence): containers cannot start until the cutover removes it (full mode)"
    return
  fi
  if [ "$dry_run" -eq 1 ]; then
    report changed proc-hidepid "would drop hidepid from /etc/fstab and remount /proc (now: $opts)"
    return
  fi
  if awk '$2 == "/proc" && $4 ~ /hidepid=/ { found = 1 } END { exit !found }' /etc/fstab; then
    cp -p /etc/fstab "/etc/fstab.bak-hidepid-$(date -u +%Y%m%dT%H%M%SZ)" || fail proc-hidepid "cannot back up /etc/fstab"
    { awk '!($2 == "/proc" && $4 ~ /hidepid=/)' /etc/fstab >/etc/fstab.provision.tmp &&
      mv -f /etc/fstab.provision.tmp /etc/fstab; } || fail proc-hidepid "cannot rewrite /etc/fstab"
  fi
  mount -o remount,hidepid=off /proc || fail proc-hidepid "remount of /proc without hidepid failed"
  report changed proc-hidepid "dropped hidepid from /etc/fstab and remounted /proc (was: $opts)"
}

step_verify() {
  local out
  if ! image_present "$image"; then
    report skip image-verify "image not pulled yet (dry-run)"
    return
  fi
  if [ "$hidepid_blocks" -eq 1 ]; then
    report skip image-verify "no container can start under hidepid (see proc-hidepid); run verify at the cutover"
    return
  fi
  if ! out="$(runuser -u "$worker_user" -- env HOME="$(home_of "$worker_user")" DOCKER_HOST="unix://$SOCK" \
    "$VERIFY" "$image" 2>&1)"; then
    printf '%s\n' "$out" >&2
    fail image-verify "verify.sh failed against $image (output above)"
  fi
  report ok image-verify "verify.sh passed ($(printf '%s\n' "$out" | grep -c '^ok ' || true) checks) as $worker_user"
}

# The state file is parsed, never sourced.
state_get() {
  [ -r "$STATE" ] || return 0
  sed -n "s/^$1=//p" "$STATE" | tail -n 1
}
previous=""
step_record() {
  local current prev want
  current="$(state_get CURRENT)"
  prev="$(state_get PREVIOUS)"
  if [ "$current" = "$image" ]; then
    previous="$prev"
    report ok image-record "CURRENT is ${image#*@}${prev:+, PREVIOUS ${prev#*@}}"
    return
  fi
  [ -n "$current" ] && prev="$current"
  previous="$prev"
  if [ "$dry_run" -eq 1 ]; then
    report changed image-record "would record CURRENT=${image#*@}${prev:+ PREVIOUS=${prev#*@}}"
    return
  fi
  want="$(printf 'CURRENT=%s\n' "$image")"
  [ -n "$prev" ] && want="$(printf '%s\nPREVIOUS=%s' "$want" "$prev")"
  install -d -m 0755 /etc/automata
  printf '%s\n' "$want" >"$STATE.tmp"
  chmod 0644 "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
  report changed image-record "CURRENT=${image#*@}${prev:+ PREVIOUS=${prev#*@}}"
}

step_previous() {
  if [ -z "$previous" ]; then
    report skip previous-image "no previous digest recorded"
    return
  fi
  if ! (validate_image "$previous") 2>/dev/null; then
    fail previous-image "PREVIOUS in $STATE is not a digest reference"
  fi
  if [ "$rootless_ok" -eq 1 ] && ! image_present "$previous" && ! previous_fits; then
    report skip previous-image "WARNING not pulled: ${previous#*@} would leave under ${PREVIOUS_MIN_FREE_GB} GB free in the rootless store (an image rollback re-pulls it first)"
    return
  fi
  step_pull previous-image "$previous"
}

# previous_fits: pulling one more image the size of CURRENT still leaves
# PREVIOUS_MIN_FREE_GB free where the rootless daemon stores images. A 12.5 GB
# image twice on a 75 GB disk left 3.3 GB, and verify.sh (and every run's
# workspace) died with ENOSPC; runs need the disk more than a rollback image.
previous_fits() {
  local root size avail
  root="$(runner_docker info -f '{{.DockerRootDir}}')" || return 1
  size="$(runner_docker image inspect -f '{{.Size}}' "$image")" || return 1
  avail="$(df -B1 --output=avail "$root" | tail -n 1)" || return 1
  [ $((avail - size)) -ge $((PREVIOUS_MIN_FREE_GB * 1024 * 1024 * 1024)) ]
}

# ── full mode only: the worker unit, its launcher and its env ────────────────
worker_home() { home_of "$worker_user"; }
# Created when missing; an existing ~/.automata keeps its mode and owner.
ensure_dot_automata() {
  [ -d "$1/.automata" ] || install -d -m 0700 -o "$worker_user" -g "$2" "$1/.automata"
}

# install_if_changed STEP WANT_CONTENT PATH MODE OWNER GROUP: 0 = it differed
# (and, unless --dry-run, was written), 1 = already as wanted.
install_if_changed() {
  local step="$1" want="$2" path="$3" fmode="$4" owner="$5" group="$6"
  if [ -f "$path" ] && [ "$(cat "$path")" = "$want" ]; then
    return 1
  fi
  if [ "$dry_run" -eq 1 ]; then
    return 0
  fi
  # umask 077: the env file holds secrets, never readable mid-write.
  (umask 077 && printf '%s\n' "$want" >"$path.provision.tmp") || fail "$step" "cannot write $path"
  { chown "$owner:$group" "$path.provision.tmp" && chmod "$fmode" "$path.provision.tmp" &&
    mv -f "$path.provision.tmp" "$path"; } || fail "$step" "cannot install $path"
  return 0
}

# The base bring-up the worker itself needs (cloud-init.yaml): checked, never
# installed here.
# The floor is Node's built-in env-proxy support (NODE_USE_ENV_PROXY), which
# the worker's host-side tools rely on behind the egress proxy:
# >=22.21.0 on 22.x, or >=24.0.0.
step_worker_runtime() {
  local version major minor
  version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  major="${version%%.*}"
  minor="$(printf '%s' "$version" | cut -d. -f2)"
  case "$major" in
    22) [ "${minor:-0}" -ge 21 ] 2>/dev/null || major="" ;;
    '' | *[!0-9]*) major="" ;;
    *) [ "$major" -ge 24 ] || major="" ;;
  esac
  [ -n "$major" ] || fail worker-runtime "node >=22.21.0 (22.x) or >=24 is required on the host (got: ${version:-none}); run the cloud-init.yaml base bring-up first"
  command -v pnpm >/dev/null 2>&1 || fail worker-runtime "pnpm is missing; run the cloud-init.yaml base bring-up first"
  report ok worker-runtime "node $version, pnpm present"
}

step_worker_launcher() {
  local home want path group
  home="$(worker_home)"
  group="$(id -gn "$worker_user")"
  case "$home" in /* ) ;; *) fail worker-launcher "$worker_user has no absolute home" ;; esac
  case "$home" in *'#'* | *'&'* | *\\*) fail worker-launcher "home '$home' cannot be rendered" ;; esac
  path="$home/.automata/run-worker.sh"
  want="$(sed "s#__REPO__#$repo#g;s#__HOME__#$home#g" "$LAUNCHER_TEMPLATE")"
  [ "$dry_run" -eq 1 ] || ensure_dot_automata "$home" "$group"
  if install_if_changed worker-launcher "$want" "$path" 0755 "$worker_user" "$group"; then
    report changed worker-launcher "$([ "$dry_run" -eq 1 ] && echo 'would render' || echo rendered) $path"
  else
    report ok worker-launcher "$path matches the template"
  fi
}

step_worker_unit() {
  local home want detail
  home="$(worker_home)"
  want="$(sed "s#__USER__#$worker_user#g;s#__HOME__#$home#g;s#__REPO__#$repo#g" "$UNIT_TEMPLATE")"
  # The #367 loopback fence is host-path provisioning (AGENT-UID-PROVISIONING.md
  # §7). Where it is provisioned the unit keeps loading it (removing anything
  # host-path is P4); where it is not, its loader line would fail every start,
  # and a container run has its own loopback anyway.
  if [ -r "$LOOPBACK_CONF" ] && [ -x "$LOOPBACK_LOADER" ]; then
    detail="with the host-path loopback fence loader (provisioned on this box)"
  else
    want="$(printf '%s\n' "$want" | sed '/^ExecStartPre=+.*nft-loopback-load\.sh/d')"
    detail="without the loopback fence loader (not provisioned on this box)"
  fi
  local did="" verb=""
  [ "$dry_run" -eq 0 ] || verb="would "
  if install_if_changed worker-unit "$want" "$UNIT_PATH" 0644 root root; then
    [ "$dry_run" -eq 1 ] || systemctl daemon-reload
    did="${verb}render $UNIT_PATH $detail"
  fi
  if ! systemctl is-enabled --quiet automata-worker.service 2>/dev/null; then
    [ "$dry_run" -eq 1 ] || systemctl enable automata-worker.service >&2
    did="${did:+$did; }${verb}enable it"
  fi
  # Never started or restarted here: a restart mid-run drops the run.
  if [ -n "$did" ]; then
    report changed worker-unit "$did; restart the worker at an idle moment"
  else
    report ok worker-unit "$UNIT_PATH matches the template, $detail; enabled"
  fi
}

# Sets KEY=VALUE pairs in the worker's env file, keeping every other line as
# it is. The file holds the box's secrets: no value is ever printed but the
# three this step owns, which are not secret.
step_worker_env() {
  local home path group gid want current changed_keys="" kv k v
  home="$(worker_home)"
  group="$(id -gn "$worker_user")"
  path="$home/.automata/worker-box.env"
  if ! gid="$(id -g "$RUNNER" 2>/dev/null)"; then
    [ "$dry_run" -eq 1 ] || fail worker-env "$RUNNER does not exist"
    gid="<automata-runner gid>"
  fi
  current="$(cat "$path" 2>/dev/null || true)"
  want="$current"
  for kv in "WORKER_BATTERIES_IMAGE=$image" "WORKER_CONTAINER_DOCKER_SOCKET=$SOCK" "WORKER_CONTAINER_RUN_GID=$gid"; do
    k="${kv%%=*}"
    v="${kv#*=}"
    [ "$(printf '%s\n' "$want" | sed -n "s/^$k=//p" | tail -n 1)" = "$v" ] && continue
    changed_keys="$changed_keys $k"
    if printf '%s\n' "$want" | grep -q "^$k="; then
      want="$(printf '%s\n' "$want" | awk -v k="$k" -v line="$kv" 'index($0, k "=") == 1 { print line; next } { print }')"
    else
      want="$(printf '%s\n%s' "$want" "$kv" | sed '/./,$!d')"
    fi
  done
  if [ -z "$changed_keys" ]; then
    report ok worker-env "$path carries the container-path keys"
    return
  fi
  if [ "$dry_run" -eq 1 ]; then
    report changed worker-env "would set$changed_keys in $path"
    return
  fi
  ensure_dot_automata "$home" "$group"
  install_if_changed worker-env "$want" "$path" 0600 "$worker_user" "$group" || true
  report changed worker-env "set$changed_keys in $path$([ -z "$current" ] && echo ' (new file: add the box secrets by hand)')"
}

step_packages
step_rootless
step_pull image-pull "$image"
step_attestation
step_proc_hidepid
step_verify
step_record
step_previous
if [ "$mode" = full ]; then
  step_worker_runtime
  step_worker_launcher
  step_worker_unit
  step_worker_env
else
  report skip worker-runtime "prepare-only"
  report skip worker-launcher "prepare-only"
  report skip worker-unit "prepare-only"
  report skip worker-env "prepare-only"
fi
