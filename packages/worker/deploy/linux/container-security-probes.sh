#!/bin/bash
set -euo pipefail
#
# container-security-probes.sh — the seven ADR-013 "Security probes" (plan P2
# acceptance, and the release check right after the P3 deploy). Runs INSIDE a
# run container, as the image's `agent` user, and judges the container from
# the only place an agent ever stands:
#
#   1 egress-denied       a non-allowlisted host through the run's proxy
#                         (127.0.0.1:3128, bridged from egress-proxy.sock) is
#                         refused with 403, and with no proxy there is no route
#                         at all (no interface but lo, no route, no direct dial)
#   2 engine-unreachable  the engine's 7077/8888 on loopback, the slirp and
#                         docker0 host addresses, the metadata address and every
#                         --host-addr refuse or are unreachable
#   3 userns-mapping      uid_map maps container root to the rootless daemon's
#                         user (--runner-uid) and `agent` to a subordinate uid;
#                         never the identity map of a rootful daemon
#   4 no-capabilities     CapEff, CapPrm, CapBnd (and CapAmb) are zero and
#                         NoNewPrivs is 1
#   5 readonly-rootfs     writes outside /workspace, HOME, /opt/flutter, /tmp
#                         and /dev/shm fail with EROFS, and those five ARE
#                         writable (an all-unwritable box would pass vacuously)
#   6 review-no-write     review lane only: /run/automata holds daemon.sock and
#                         egress-proxy.sock and nothing else, no GitHub token in
#                         any visible env or under HOME, /workspace/.git, /tmp,
#                         and `git push --dry-run` from /workspace fails.
#                         Other lanes: SKIP (they are entitled to the brokers)
#   7 run-isolation       pid 1 is the container's init and no host or worker
#                         process is visible; mounts are the run's own; no
#                         --peer token (another concurrent run's id) appears in
#                         any process, env, socket, mount or file in reach
#
# Each probe prints one `PASS|FAIL|SKIP <n> <name> <detail>` line; exit 0 iff
# no probe FAILED. A probe that cannot gather its evidence FAILS (inconclusive
# is not a pass): probe 1 needs the run's egress proxy forwarded in, probe 6 a
# git checkout with an origin, probe 7 at least one --peer.
#
# What only the HOST can check (packages/worker/deploy/README.md, "Security
# probes"): probe 1's audit row (an enforce-mode `deny` in egress_events for
# --denied-host after the start time this script prints) and probe 7's "two
# containers started together" (the driver starts them and passes each the
# other's token).
#
# Usage (normally fed on stdin by the host driver: `docker exec -i <ctr> bash -s -- …`):
#   container-security-probes.sh [--lane review|pr|task] [--runner-uid UID]
#     [--host-addr ADDR]… [--peer TOKEN]… [--self TOKEN]
#     [--denied-host HOST] [--allow-url URL] [--only N[,N…]]
#
#   --lane         defaults to $AUTOMATA_RUN_LANE (the run container's argv env)
#   --runner-uid   host uid of automata-runner; probe 3 requires root to map to it
#   --host-addr    a host address to prove unreachable (the box's public IP …)
#   --peer         a token of ANOTHER run that must not be visible from here
#   --self         this run's token; must be the content of
#                  /workspace/.automata-probe-token (proves probe 7 looked at
#                  its own workspace)
#   --denied-host  probe 1's non-allowlisted host (default example.org)
#   --allow-url    probe 1's positive control: must succeed through the proxy
#   --only         run only these probes (the rest print nothing)
#
# Test seams (never set by the driver): PROBE_PROC, PROBE_SOCK_DIR,
# PROBE_WORKSPACE, PROBE_TMP.

PROC="${PROBE_PROC:-/proc}"
SOCK_DIR="${PROBE_SOCK_DIR:-/run/automata}"
WORKSPACE="${PROBE_WORKSPACE:-/workspace}"
TMP_DIR="${PROBE_TMP:-/tmp}"

lane="${AUTOMATA_RUN_LANE:-}"
runner_uid=""
denied_host="example.org"
allow_url=""
only=""
self_token=""
host_addrs=()
peers=()

usage() {
  sed -n '/^# Usage/,/^#   --only/p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' >&2 || true
  exit 2
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lane) lane="${2:?--lane needs a value}"; shift 2 ;;
    --runner-uid) runner_uid="${2:?--runner-uid needs a uid}"; shift 2 ;;
    --host-addr) host_addrs+=("${2:?--host-addr needs an address}"); shift 2 ;;
    --peer) peers+=("${2:?--peer needs a token}"); shift 2 ;;
    --self) self_token="${2:?--self needs a token}"; shift 2 ;;
    --denied-host) denied_host="${2:?--denied-host needs a host}"; shift 2 ;;
    --allow-url) allow_url="${2:?--allow-url needs a URL}"; shift 2 ;;
    --only) only="${2:?--only needs N[,N…]}"; shift 2 ;;
    -h | --help) usage ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      ;;
  esac
done
case "$lane" in
  review | pr | task) ;;
  *)
    echo "--lane must be review, pr or task (got: ${lane:-nothing}; \$AUTOMATA_RUN_LANE is unset)" >&2
    exit 2
    ;;
esac
if [ -n "$runner_uid" ] && ! [[ "$runner_uid" =~ ^[0-9]+$ ]]; then
  echo "--runner-uid must be a numeric uid" >&2
  exit 2
fi
for p in ${peers[@]+"${peers[@]}"}; do
  # A short peer token matches by accident everywhere; a run id never is.
  if [ "${#p}" -lt 8 ]; then
    echo "--peer token '$p' is shorter than 8 characters" >&2
    exit 2
  fi
done

failed=0
line() { printf '%s %s %-20s %s\n' "$1" "$2" "$3" "$4"; }
pass() { line PASS "$1" "$2" "$3"; }
bad() {
  line FAIL "$1" "$2" "$3"
  failed=1
}
skip() { line SKIP "$1" "$2" "$3"; }
wanted() {
  [ -z "$only" ] && return 0
  case ",$only," in *",$1,"*) return 0 ;; esac
  return 1
}
# tcp_open HOST PORT: a TCP connect succeeds within 3 s.
tcp_open() {
  # shellcheck disable=SC2016 # expanded by the inner bash
  timeout 3 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" >/dev/null 2>&1
}
# Every search below captures its input first and matches with `case` or a
# here-string: under pipefail, `producer | grep -q` reports a MISS whenever
# grep exits early and the producer dies of SIGPIPE, a false negative no
# security probe can afford.
#
# Interfaces other than lo, and routes, in this network namespace.
net_ifaces() {
  local i out=""
  for i in /sys/class/net/*; do
    [ -e "$i" ] || continue
    [ "${i##*/}" = lo ] || out="$out ${i##*/}"
  done
  printf '%s' "${out# }"
}
net_routes() {
  local n=0
  if [ -r "$PROC/net/route" ]; then n=$(($(wc -l <"$PROC/net/route") - 1)); fi
  [ "$n" -lt 0 ] && n=0
  printf '%s' "$n"
}
# Every readable environ of a process in this container, NUL→newline. Same
# uid, same pid namespace: exactly the reach the agent has.
all_environs() {
  local f
  for f in "$PROC"/[0-9]*/environ; do
    [ -r "$f" ] && tr '\0' '\n' <"$f" 2>/dev/null
  done
  env
}
# The run's proxy URL (it may carry the run's proxy credential: never printed).
proxy_url() {
  local v="${HTTPS_PROXY:-${https_proxy:-}}"
  if [ -z "$v" ]; then
    v="$(all_environs | sed -n 's/^HTTPS_PROXY=//p' | head -n 1)" || true
  fi
  printf '%s' "${v:-http://127.0.0.1:3128}"
}

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'info lane=%s uid=%s start=%s\n' "$lane" "$(id -u)" "$started"

# ── 1. egress to a non-allowlisted host is refused; no route without the proxy
probe_egress() {
  local n=1 name=egress-denied why="" code rc ifaces routes proxy envs cred=uncredentialed
  ifaces="$(net_ifaces)"
  routes="$(net_routes)"
  [ -z "$ifaces" ] || why="$why; interfaces besides lo: $ifaces"
  [ "$routes" -eq 0 ] || why="$why; $routes route(s) in $PROC/net/route"
  if tcp_open 1.1.1.1 443; then why="$why; a direct dial to 1.1.1.1:443 connected"; fi
  if curl -sS -o /dev/null -m 8 --noproxy '*' "https://$denied_host/" >/dev/null 2>&1; then
    why="$why; https://$denied_host answered with no proxy"
  fi
  if [ ! -S "$SOCK_DIR/egress-proxy.sock" ]; then
    bad "$n" "$name" "no egress proxy forwarded ($SOCK_DIR/egress-proxy.sock absent): the proxy half is unproven${why}"
    return
  fi
  envs="$(all_environs)"
  if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] || grep -q '^HTTPS_PROXY=.*@' <<<"$envs"; then
    cred="the run's proxy URL"
  fi
  proxy="$(proxy_url)"
  rc=0
  code="$(curl -sS -o /dev/null -m 20 --proxy "$proxy" -w '%{http_connect}' "https://$denied_host/" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    why="$why; https://$denied_host was REACHED through the proxy (CONNECT $code)"
  else
    case "$code" in
      403) ;;
      407) why="$why; the proxy answered 407 (no credential): pass the run's HTTPS_PROXY, the allowlist is unproven" ;;
      *) why="$why; the proxy did not refuse with 403 (CONNECT ${code:-none}, curl exit $rc)" ;;
    esac
  fi
  if [ -n "$allow_url" ] && ! curl -sS -o /dev/null -m 20 --proxy "$proxy" "$allow_url" >/dev/null 2>&1; then
    why="$why; positive control $allow_url failed through the proxy (is the proxy live?)"
  fi
  if [ -n "$why" ]; then
    bad "$n" "$name" "${why#; }"
  else
    pass "$n" "$name" "CONNECT $denied_host refused 403 via $cred${allow_url:+, control $allow_url allowed}; no route without it (lo only, 0 routes); host: expect an enforce-mode deny row for $denied_host in egress_events after $started"
  fi
}

# ── 2. engine ports and host addresses are unreachable ──────────────────────
probe_engine() {
  local n=2 name=engine-unreachable open="" count=0 t a
  local targets="127.0.0.1:7077 127.0.0.1:8888 10.0.2.2:7077 10.0.2.2:8888 172.17.0.1:7077 172.17.0.1:8888 169.254.169.254:80"
  for a in ${host_addrs[@]+"${host_addrs[@]}"}; do
    targets="$targets $a:7077 $a:8888 $a:22"
  done
  for t in $targets; do
    count=$((count + 1))
    if tcp_open "${t%:*}" "${t##*:}"; then open="$open $t"; fi
  done
  if [ -n "$open" ]; then
    bad "$n" "$name" "connected to:$open"
  elif [ "${#host_addrs[@]}" -eq 0 ]; then
    bad "$n" "$name" "all $count default targets refused, but no --host-addr was given: the box's own addresses are unproven"
  else
    pass "$n" "$name" "all $count targets refused or unreachable (engine 7077/8888 on loopback, host gateways, metadata, ${host_addrs[*]})"
  fi
}

# ── 3. container root is the runner, agent a subordinate uid ────────────────
probe_userns() {
  local n=3 name=userns-mapping map="$PROC/self/uid_map" uid inside host len root_host="" agent_host="" why=""
  uid="$(id -u)"
  if [ ! -r "$map" ]; then
    bad "$n" "$name" "$map unreadable"
    return
  fi
  [ "$uid" -ne 0 ] || why="$why; running as container root"
  while read -r inside host len; do
    [ -n "${len:-}" ] || continue
    if [ "$inside" -eq 0 ] && [ "$host" -eq 0 ] && [ "$len" -ge 4294967295 ]; then
      why="$why; identity uid map (0 0 $len): no user namespace, a rootful daemon"
    fi
    if [ "$inside" -le 0 ] && [ $((inside + len)) -gt 0 ]; then root_host=$((host - inside)); fi
    if [ "$inside" -le "$uid" ] && [ $((inside + len)) -gt "$uid" ]; then agent_host=$((host + uid - inside)); fi
  done <"$map"
  if [ -z "$root_host" ]; then
    why="$why; container root is unmapped"
  elif [ "$root_host" -eq 0 ]; then
    why="$why; container root maps to HOST ROOT"
  elif [ -n "$runner_uid" ] && [ "$root_host" -ne "$runner_uid" ]; then
    why="$why; container root maps to host uid $root_host, not automata-runner ($runner_uid)"
  fi
  if [ -z "$agent_host" ]; then
    why="$why; uid $uid is unmapped"
  elif [ "$agent_host" -lt 100000 ] || [ "$agent_host" = "$root_host" ]; then
    why="$why; uid $uid maps to host uid $agent_host, not a subordinate id (>= 100000)"
  fi
  if [ -z "$runner_uid" ]; then
    why="$why; no --runner-uid given: root's host uid $root_host is unverified"
  fi
  if [ -n "$why" ]; then
    bad "$n" "$name" "${why#; }"
  else
    pass "$n" "$name" "root -> host $root_host (automata-runner), uid $uid -> host $agent_host (subordinate)"
  fi
}

# ── 4. no capabilities, no new privileges ───────────────────────────────────
probe_caps() {
  local n=4 name=no-capabilities status="$PROC/self/status" why="" c v
  if [ ! -r "$status" ]; then
    bad "$n" "$name" "$status unreadable"
    return
  fi
  for c in CapEff CapPrm CapBnd CapAmb; do
    v="$(sed -n "s/^$c:[[:space:]]*//p" "$status")"
    if [ -z "$v" ]; then
      [ "$c" = CapAmb ] || why="$why; no $c line"
    elif ! [[ "$v" =~ ^0+$ ]]; then
      why="$why; $c=$v"
    fi
  done
  v="$(sed -n 's/^NoNewPrivs:[[:space:]]*//p' "$status")"
  [ "$v" = 1 ] || why="$why; NoNewPrivs=${v:-absent}"
  if [ -n "$why" ]; then
    bad "$n" "$name" "${why#; }"
  else
    pass "$n" "$name" "CapEff, CapPrm, CapBnd, CapAmb zero; NoNewPrivs 1"
  fi
}

# ── 5. read-only rootfs outside the writable set ────────────────────────────
probe_rofs() {
  local n=5 name=readonly-rootfs why="" out d group r root_opts seen="" ro_count=0
  local writable="$WORKSPACE ${HOME:-/home/agent} /opt/flutter /tmp /dev/shm"
  local readonly_dirs="/ /etc /usr /usr/local /usr/local/bin /opt /opt/automata /opt/automata-daemon /var /var/tmp /var/lib /srv /mnt /home /run /bin /sbin /lib"
  if ! command -v python3 >/dev/null 2>&1; then
    bad "$n" "$name" "python3 missing: cannot read errno"
    return
  fi
  # One line per dir: WRITABLE, EROFS or ERR:<errno name>; absent dirs skipped.
  # shellcheck disable=SC2086 # two word lists on purpose
  out="$(
    python3 - $writable -- $readonly_dirs <<'PY'
import errno, os, sys
group = "w"
for d in sys.argv[1:]:
    if d == "--":
        group = "r"
        continue
    if not os.path.isdir(d):
        continue
    p = os.path.join(d, ".automata-probe-%d" % os.getpid())
    try:
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        os.unlink(p)
        r = "WRITABLE"
    except OSError as e:
        r = "EROFS" if e.errno == errno.EROFS else "ERR:" + errno.errorcode.get(e.errno, str(e.errno))
    print(group, r, d)
PY
  )" || {
    bad "$n" "$name" "the write probe itself failed"
    return
  }
  while read -r group r d; do
    [ -n "${d:-}" ] || continue
    seen="$seen|$d|"
    if [ "$group" = w ]; then
      [ "$r" = WRITABLE ] || why="$why; $d must be writable, got $r"
    else
      if [ "$r" = EROFS ]; then ro_count=$((ro_count + 1)); else why="$why; $d: $r (want EROFS)"; fi
    fi
  done <<EOF
$out
EOF
  for d in $writable; do
    case "$seen" in *"|$d|"*) ;; *) why="$why; $d is missing" ;; esac
  done
  root_opts="$(awk '$5 == "/" { print $6 }' "$PROC/self/mountinfo" 2>/dev/null || true)"
  case ",$root_opts," in
    *,ro,*) ;;
    *) why="$why; / is not mounted ro in mountinfo (options: ${root_opts:-none})" ;;
  esac
  if [ -n "$why" ]; then
    bad "$n" "$name" "${why#; }"
  else
    pass "$n" "$name" "$ro_count rootfs dirs EROFS; /workspace, HOME, /opt/flutter, /tmp, /dev/shm writable"
  fi
}

# ── 6. review lane: no write credential in reach ────────────────────────────
# Credential SHAPES (a token, or the Basic extraheader the legacy git path
# writes), never a mention of one: the image's docs talk about tokens.
TOKEN_RE='gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|x-access-token:[A-Za-z0-9_]{20,}|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]: *[Bb]asic +[A-Za-z0-9+/=]{20,}'
probe_review() {
  local n=6 name=review-no-write why="" e extra="" envs envhits files rc=0 out="" remote
  if [ "$lane" != review ]; then
    skip "$n" "$name" "lane=$lane: the git/gh brokers are expected outside the review lane"
    return
  fi
  # (a) sockets: absence, not denial (ADR-013 Run path 3).
  for e in "$SOCK_DIR"/* "$SOCK_DIR"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    case "${e##*/}" in daemon.sock | egress-proxy.sock) ;; *) extra="$extra ${e##*/}" ;; esac
  done
  [ -z "$extra" ] || why="$why; $SOCK_DIR holds$extra (want only daemon.sock, egress-proxy.sock)"
  # (b) env of every process in reach: names and values, values never printed.
  envs="$(all_environs)"
  envhits="$(grep -E '^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)=.' <<<"$envs" | cut -d= -f1 | sort -u | tr '\n' ' ')" || true
  [ -z "$envhits" ] || why="$why; token variable(s) set: $envhits"
  if grep -qE "$TOKEN_RE" <<<"$envs"; then why="$why; a GitHub credential value is in a process env"; fi
  # (c) files the worker could have copied in, and git's own config.
  [ ! -e "${HOME:-/home/agent}/.git-credentials" ] || why="$why; ~/.git-credentials exists"
  files="$(find "${HOME:-/home/agent}" "$WORKSPACE/.git" "$TMP_DIR" "$SOCK_DIR" -xdev \
    \( -name node_modules -o -name objects \) -prune -o -type f -size -1024k -print0 2>/dev/null |
    xargs -0r grep -lIE "$TOKEN_RE" 2>/dev/null | head -n 5 | tr '\n' ' ')" || true
  [ -z "$files" ] || why="$why; credential-shaped content in: $files"
  # (d) the push itself.
  if [ ! -d "$WORKSPACE/.git" ]; then
    why="$why; no git checkout at $WORKSPACE: git push unproven"
  elif ! remote="$(git -C "$WORKSPACE" -c safe.directory="$WORKSPACE" remote get-url --push origin 2>/dev/null)"; then
    why="$why; $WORKSPACE has no origin remote: git push unproven"
  else
    rc=0
    out="$(GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never timeout 60 git -C "$WORKSPACE" \
      -c safe.directory="$WORKSPACE" -c core.hooksPath=/dev/null \
      push --dry-run --no-verify origin "HEAD:refs/heads/automata-probe-$$" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
      why="$why; git push --dry-run to ${remote%%\?*} SUCCEEDED: a write credential reached the review container"
    else
      out="$(printf '%s' "$out" | head -n 1 | sed -E 's#://[^/@ ]*@#://<redacted>@#g' | cut -c1-120)"
    fi
  fi
  if [ -n "$why" ]; then
    bad "$n" "$name" "${why#; }"
  else
    pass "$n" "$name" "sockets: daemon + egress proxy only; no token in env or files; git push failed (exit $rc: $out)"
  fi
}

# ── 7. concurrent runs cannot see each other ────────────────────────────────
probe_isolation() {
  local n=7 name=run-isolation why="" init f comm cmd hostish="" procs=0 extra_mounts="" mp tok hit
  local proc_text="" ns_text="" names="" contents="" self_cmd=""
  init="$(cat "$PROC/1/comm" 2>/dev/null || echo unreadable)"
  case "$init" in
    docker-init | tini | catatonit) ;;
    *) why="$why; pid 1 is '$init', not the container's init (host pid namespace?)" ;;
  esac
  for f in "$PROC"/[0-9]*; do
    [ -r "$f/comm" ] || continue
    procs=$((procs + 1))
    comm="$(cat "$f/comm" 2>/dev/null || true)"
    cmd="$(tr '\0' ' ' <"$f/cmdline" 2>/dev/null || true)"
    case "$comm" in
      systemd | dockerd | containerd* | rootlesskit | sshd | postgres | cloudflared | hatchet*) hostish="$hostish ${f##*/}:$comm" ;;
    esac
    case "$cmd" in *src/hello/worker.ts*) hostish="$hostish ${f##*/}:worker" ;; esac
  done
  [ -z "$hostish" ] || why="$why; host or worker processes visible:$hostish"
  # Mounts: only the run's own (ADR-013 I2) plus Docker's own plumbing.
  while read -r mp; do
    case "$mp" in
      / | "$WORKSPACE" | "$WORKSPACE"/* | /run/automata | /opt/automata-daemon/index.js | \
        /home/agent | /opt/flutter | /opt/somnio-ai-tools/agent-rules/adapters | /tmp | /dev/shm | \
        /etc/hosts | /etc/hostname | /etc/resolv.conf | /proc | /proc/* | /sys | /sys/* | /dev | /dev/*) ;;
      *) extra_mounts="$extra_mounts $mp" ;;
    esac
  done <<EOF
$(awk '{ print $5 }' "$PROC/self/mountinfo" 2>/dev/null)
EOF
  [ -z "$extra_mounts" ] || why="$why; mounts beyond the run's own:$extra_mounts"
  if [ -n "$self_token" ]; then
    [ "$(cat "$WORKSPACE/.automata-probe-token" 2>/dev/null || true)" = "$self_token" ] ||
      why="$why; $WORKSPACE/.automata-probe-token is not '$self_token' (not this run's workspace?)"
  fi
  if [ "${#peers[@]}" -eq 0 ]; then
    why="$why; no --peer given: a concurrent run's visibility is unproven"
  fi
  # Gather once, then match each token with `case` (see the pipefail note).
  if [ "${#peers[@]}" -gt 0 ]; then
    # This script's own argv carries the peer tokens, and so does every
    # process whose argv embeds it (its subshells, and a `docker run` init
    # that started it): those are skipped, nothing else.
    self_cmd="$(tr '\0' ' ' <"$PROC/$$/cmdline" 2>/dev/null || true)"
    for f in "$PROC"/[0-9]*; do
      cmd="$(tr '\0' ' ' <"$f/cmdline" 2>/dev/null || true)"
      if [ -n "$self_cmd" ]; then
        case "$cmd" in *"$self_cmd"*) continue ;; esac
      fi
      proc_text="$proc_text
${f##*/}: $cmd $(tr '\0' ' ' <"$f/environ" 2>/dev/null || true)"
    done
    ns_text="$(cat "$PROC/self/mountinfo" "$PROC/net/unix" 2>/dev/null || true)"
    names="$(find "$WORKSPACE" "${HOME:-/home/agent}" "$TMP_DIR" "$SOCK_DIR" -xdev \
      \( -name node_modules -o -name objects \) -prune -o -print 2>/dev/null || true)"
    contents="$(find "$WORKSPACE" "$TMP_DIR" "$SOCK_DIR" -xdev \( -name node_modules -o -name objects \) -prune \
      -o -type f -size -1024k -print0 2>/dev/null | xargs -0r cat 2>/dev/null || true)"
  fi
  for tok in ${peers[@]+"${peers[@]}"}; do
    hit=""
    case "$proc_text" in *"$tok"*) hit="$hit a process cmdline/env;" ;; esac
    case "$ns_text" in *"$tok"*) hit="$hit mountinfo/unix sockets;" ;; esac
    case "$names" in *"$tok"*) hit="$hit a path name;" ;; esac
    case "$contents" in *"$tok"*) hit="$hit file content;" ;; esac
    [ -z "$hit" ] || why="$why; peer '$tok' visible:$hit"
  done
  if [ -n "$why" ]; then
    bad "$n" "$name" "${why#; }"
  else
    pass "$n" "$name" "pid 1 $init, $procs processes all in-container; mounts the run's own; ${#peers[@]} peer token(s) not visible"
  fi
}

wanted 1 && probe_egress
wanted 2 && probe_engine
wanted 3 && probe_userns
wanted 4 && probe_caps
wanted 5 && probe_rofs
wanted 6 && probe_review
wanted 7 && probe_isolation
exit "$failed"
