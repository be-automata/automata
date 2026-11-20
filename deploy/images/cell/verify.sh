#!/bin/bash
set -euo pipefail
# verify.sh IMAGE: offline smoke test of a built cell image (#656 PR-F).
#
# One throwaway container with the cell's hardening: no network, no
# capabilities, no-new-privileges, --init. The rootfs stays writable, as in a
# cell. Checks identity, the baked bundle and scripts, absolute node, that no
# credential name or file is in the image, the CA config and the system CA
# store (#724: owned by the agent, and a Dart HTTPS fetch trusts a CA installed
# the way OpenSandbox's bootstrap does, across a rotation), the entry's
# refusals and a daemon start-and-message round trip.
# Exit 0 = every check passed; 1 = at least one failed; 2 = usage/docker error.
#
#   deploy/images/cell/verify.sh automata-cell:ci
#   deploy/images/cell/verify.sh ghcr.io/be-automata/automata-cell@sha256:<digest>
#
# Prints one line per check. Never needs a credential.
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 IMAGE" >&2
  exit 2
fi
image="$1"

if ! command -v docker >/dev/null 2>&1; then
  echo "verify: docker not found" >&2
  exit 2
fi

rc=0
docker run --rm -i --platform linux/amd64 --network none \
  --cap-drop ALL --security-opt no-new-privileges --init \
  --entrypoint /bin/bash "$image" -s <<'IN_CONTAINER' || rc=$?
set -uo pipefail
fail=0
NODE=/usr/local/bin/node
BUNDLE=/opt/automata/daemon.js
ENTRY=/opt/automata/cell-entry.sh
SEND=/opt/automata/cell-send.sh
CA=/home/agent/.opensandbox/merged-ca-certificates.pem

ok() { printf 'ok   %-22s %s\n' "$1" "$2"; }
bad() { printf 'FAIL %-22s %s\n' "$1" "$2"; fail=1; }

# assert NAME DETAIL COMMAND...: pass when COMMAND exits 0.
assert() {
  local name="$1" detail="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then ok "$name" "$detail"; else bad "$name" "$detail"; fi
}

# expect_exit NAME WANT CMD...: pass when CMD exits WANT.
expect_exit() {
  local name="$1" want="$2" got
  shift 2
  "$@" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then ok "$name" "exit $want"; else bad "$name" "want exit $want, got $got"; fi
}

# expect_refusal NAME ENVVAR=VALUE: the entry exits 78 for that env entry and
# never echoes the value (an `env` entry can carry any name, identifier or not).
expect_refusal() {
  local name="$1" entry="$2" out status
  out="$(env "$entry" "$ENTRY" --url https://example.org 2>&1)"
  status=$?
  if [ "$status" -ne 78 ]; then
    bad "$name" "want exit 78, got $status"
  elif printf '%s' "$out" | grep -qF "${entry#*=}"; then
    bad "$name" "the canary value was echoed"
  else
    ok "$name" "exit 78, canary not echoed"
  fi
}

# ── identity ────────────────────────────────────────────────────────────────
assert identity-uid "uid=$(id -u)" test "$(id -u)" -eq 10001
assert identity-home "HOME=$HOME" test "$HOME" = /home/agent

# ── the baked bundle ────────────────────────────────────────────────────────
assert bundle-mode "root-owned, 0444" test "$(stat -c '%U %a' "$BUNDLE")" = "root 444"
version="$($NODE "$BUNDLE" --version 2>&1)"
case "$version" in
  "Terragon Daemon v"[0-9]*) ok bundle-version "$version" ;;
  *) bad bundle-version "got: $version" ;;
esac

# ── absolute node ───────────────────────────────────────────────────────────
# PATH starts with an agent-writable dir, so the scripts must never resolve
# node through it.
assert node-owner "$NODE is root-owned, not writable by uid 10001" \
  bash -c "test -x $NODE && test \"\$(stat -c %U $NODE)\" = root && ! test -w $NODE"
assert scripts-mode "entry and send are root-owned, 0555" \
  bash -c "test \"\$(stat -c '%U %a' $ENTRY)\" = 'root 555' && test \"\$(stat -c '%U %a' $SEND)\" = 'root 555'"
bare=0
for s in "$ENTRY" "$SEND"; do
  grep -qF "$NODE" "$s" || bare=1
  grep -vE '^[[:space:]]*#' "$s" | grep -qE '(^|[[:space:];|&(])node([[:space:]]|$)' && bare=1
  # Every other external command (base64, mkdir, cat, env) must resolve
  # through root-owned dirs: PATH is reset before the first of them.
  pathline="$(grep -nE '^PATH=/usr/bin:/bin$' "$s" | head -n 1 | cut -d: -f1)"
  if [ -z "$pathline" ]; then bare=1; else
    head -n "$pathline" "$s" | grep -vE '^[[:space:]]*#' \
      | grep -vE '^(set -euo pipefail|orig_path=.*|PATH=/usr/bin:/bin)$' | grep -q . && bare=1
  fi
done
assert node-absolute "scripts name only $NODE, PATH is reset first" test "$bare" -eq 0

# ── no credential in the image ──────────────────────────────────────────────
allow=" $(sed -n 's/^allow="\(.*\)"$/\1/p' "$ENTRY") "
forbidden="$(sed -n "s/^forbidden='\(.*\)'\$/\1/p" "$ENTRY")"
# The raw environment, NUL-separated: `compgen -e` misses names that are not
# shell identifiers (npm_config_//r.org/:_authToken).
leaks=""
while IFS= read -r -d '' entry; do
  name="${entry%%=*}"
  case "$allow" in *" $name "*) continue ;; esac
  if printf '%s' "$name" | grep -qiE -- "$forbidden"; then leaks="$leaks $name"; fi
done < "/proc/$$/environ"
assert no-credential-env "no credential-shaped env name${leaks:+ (found:$leaks)}" test -z "$leaks"
assert allow-list-read "the entry's allow list and pattern are read" \
  test "${#allow}" -gt 10 -a "${#forbidden}" -gt 10
# Nothing a layer could hold that the agent would read at start.
for f in .npmrc .git-credentials .config/gh/hosts.yml .claude/settings.json .claude.json .claude/.credentials.json; do
  assert "no-$(basename "$f")" "no ~/$f" test ! -e "$HOME/$f"
done
assert root-dir-empty "/root is unreadable or empty" \
  bash -c 'test ! -r /root || test -z "$(ls -A /root 2>/dev/null)"'

# ── CA config for a non-root guest ──────────────────────────────────────────
assert ca-merged-path "OPENSANDBOX_MERGED_CA_PATH=$CA" test "${OPENSANDBOX_MERGED_CA_PATH:-}" = "$CA"
assert ca-git-cainfo "GIT_SSL_CAINFO=$CA" test "${GIT_SSL_CAINFO:-}" = "$CA"
assert ca-dir-creatable "uid 10001 can create ~/.opensandbox" mkdir -p "$(dirname "$CA")"
# GIT_SSL_CAINFO is only needed while git links libcurl-gnutls (it ignores
# SSL_CERT_FILE). If it does not, fix the Decisions text, not this check.
if ldd "$(git --exec-path)/git-remote-https" 2>/dev/null | grep -q libcurl-gnutls; then
  ok git-libcurl "git-remote-https links libcurl-gnutls"
else
  bad git-libcurl "git-remote-https does not link libcurl-gnutls: GIT_SSL_CAINFO is not needed"
fi

# ── the system CA store (#724) ──────────────────────────────────────────────
# OpenSandbox's bootstrap runs `update-ca-certificates` as uid 10001, and Dart
# and Flutter read only the system store. The image owns exactly two
# directories to the agent; everything else under the store stays root's.
assert ca-store-owner "/etc/ssl/certs and /usr/local/share/ca-certificates are agent-owned" \
  test "$(stat -c %U:%G /etc/ssl/certs /usr/local/share/ca-certificates | grep -cx agent:agent)" -eq 2
assert ca-store-rest-root "/etc/ssl, /etc/ssl/private, /usr/share/ca-certificates stay root" \
  test "$(stat -c %U /etc/ssl /etc/ssl/private /usr/share/ca-certificates | grep -cx root)" -eq 3
# update-ca-certificates runs /etc/ca-certificates/update.d hooks (a JDK's
# ca-certificates-java writes /etc/ssl/certs/java/cacerts) and only prints
# "E: ..." when one fails, so a hook or a store subdirectory brought in by a
# base bump would leave that client untrusted with the install still exiting 0.
# Both must stay absent until that client gets the same grant (OD-2).
assert ca-store-no-hooks "no update.d hook and no subdirectory under /etc/ssl/certs" \
  bash -c 'test -z "$(ls -A /etc/ca-certificates/update.d 2>/dev/null)" && test -z "$(find /etc/ssl/certs -mindepth 1 -type d)"'

DART=/opt/flutter/bin/dart
cad="$(mktemp -d)"
# mkca GEN: a CA and a localhost leaf it signs (EC P-256). Both generations
# share one subject, so a rotation replaces the CA the way the sidecar's does.
mkca() {
  local key=(-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1)
  openssl req -x509 "${key[@]}" -keyout "$cad/$1-ca.key" -out "$cad/$1-ca.pem" -subj /CN=verify-probe-ca \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign &&
    openssl req -x509 "${key[@]}" -keyout "$cad/$1-leaf.key" -out "$cad/$1-leaf.pem" -subj /CN=localhost \
      -CA "$cad/$1-ca.pem" -CAkey "$cad/$1-ca.key" -addext basicConstraints=critical,CA:FALSE \
      -addext subjectAltName=DNS:localhost -addext extendedKeyUsage=serverAuth
}
# The response is not drained on purpose: a drain hangs against s_server -www.
cat >"$cad/fetch.dart" <<'DART'
import 'dart:io';

Future<void> main() async {
  final r = await (await HttpClient().getUrl(Uri.parse('https://localhost:8443/'))).close();
  exit(r.statusCode == 200 ? 0 : 3);
}
DART
srv=""
serve() {
  openssl s_server -accept 127.0.0.1:8443 -www -quiet -cert "$cad/$1-leaf.pem" -key "$cad/$1-leaf.key" >/dev/null 2>&1 &
  srv=$!
  for _ in $(seq 1 50); do
    (: </dev/tcp/127.0.0.1/8443) 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}
unserve() {
  if [ -n "$srv" ]; then kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null; srv=""; fi
}
trap unserve EXIT
# Each fetch is its own Dart process, so no TLS state carries across checks.
fetch() { timeout 60 "$DART" run "$cad/fetch.dill" >"$cad/out.txt" 2>&1; }
# install_ca GEN: as bootstrap.sh does (_sudo falls back to a direct call). A
# failing update.d hook only prints "E: ..." and still exits 0, so that fails too.
install_ca() {
  { mkdir -p /usr/local/share/ca-certificates &&
    cp "$cad/$1-ca.pem" /usr/local/share/ca-certificates/opensandbox-mitmproxy-ca.crt &&
    update-ca-certificates; } >"$cad/install-$1.txt" 2>&1 && ! grep -q '^E: ' "$cad/install-$1.txt"
}
# dart_check NAME GEN pass|fail DETAIL: serve GEN's leaf and fetch it with Dart.
# `fail` holds only for a certificate verification error, not any failure.
dart_check() {
  local name="$1" want="$3" detail="$4" got=fail
  if ! serve "$2"; then
    bad "$name" "s_server did not start"
  else
    fetch && got=pass
    if [ "$got" = "$want" ] && { [ "$want" = pass ] || grep -q CERTIFICATE_VERIFY_FAILED "$cad/out.txt"; }; then
      ok "$name" "$detail"
    else
      bad "$name" "$detail: $(head -c 200 "$cad/out.txt" | tr '\n' ' ')"
    fi
  fi
  unserve
}

if mkca g1 >/dev/null 2>&1 && mkca g2 >/dev/null 2>&1 &&
  "$DART" compile kernel "$cad/fetch.dart" -o "$cad/fetch.dill" >"$cad/compile.txt" 2>&1; then
  dart_check dart-trust-control g1 fail "a Dart fetch of an unknown CA fails CERTIFICATE_VERIFY_FAILED"
  if ! install_ca g1; then
    bad dart-trust-install "update-ca-certificates failed: $(tail -n 3 "$cad/install-g1.txt" | tr '\n' ' ')"
  else
    ok dart-trust-install "mkdir, cp and update-ca-certificates exit 0 as uid 10001"
    dart_check dart-trust g1 pass "a Dart fetch trusts the installed CA"
    if ! install_ca g2; then
      bad dart-trust-rotation "the rotation install failed: $(tail -n 3 "$cad/install-g2.txt" | tr '\n' ' ')"
    else
      dart_check dart-trust-rotation g2 pass "after a rotation the new generation is trusted"
      dart_check dart-trust-rotation-old g1 fail "after a rotation the old generation is refused"
    fi
  fi
else
  bad dart-trust-setup "could not generate the probe CAs or compile the probe"
fi

# ── PATH ────────────────────────────────────────────────────────────────────
case "$PATH" in
  /home/agent/.automata-run/flutter-pin:*) ok path-shim-first "PATH starts with the shim dir" ;;
  *) bad path-shim-first "PATH=$PATH" ;;
esac

# ── the entry's refusals ────────────────────────────────────────────────────
expect_exit entry-no-args 64 "$ENTRY"
expect_exit entry-http 64 "$ENTRY" --url http://x
expect_exit entry-bad-host 64 "$ENTRY" --url 'https://a;b'
expect_exit entry-no-home 66 env -u HOME "$ENTRY" --url https://example.org
canary="canary-$$-$RANDOM"
expect_refusal entry-env-refusal "DAEMON_TOKEN=$canary"
# A name that is not a shell identifier still reaches children of bash.
expect_refusal entry-nonident-refusal "npm_config_//r.org/:_authToken=$canary"

# ── the test database (#707): Postgres 16 runs as uid 10001 on loopback ─────
# The worker's own steps (cell-test-db.ts) run in a live cell (IT-E1 f); here
# the image only has to carry a server uid 10001 can init, start and use.
PG=/usr/lib/postgresql/16/bin
assert pg-server "Postgres 16 server binaries" test -x "$PG/initdb" -a -x "$PG/pg_ctl" -a -x "$PG/psql"
assert pg-no-cluster "no default cluster baked in" test ! -e /var/lib/postgresql/16/main
assert pg-no-snakeoil "no snakeoil private key in the image" test ! -e /etc/ssl/private/ssl-cert-snakeoil.key
pgd="$(mktemp -d)"
pg_start=$(date +%s%N)
if "$PG/initdb" -D "$pgd/data" -U agent --auth-local=peer --auth-host=scram-sha-256 -E UTF8 --locale=C.UTF-8 --no-sync --no-instructions >/dev/null 2>&1 &&
  "$PG/pg_ctl" -D "$pgd/data" -l "$pgd/server.log" -w -t 30 -o "-c listen_addresses=127.0.0.1 -c port=25432 -c unix_socket_directories=$pgd -c fsync=off" start >/dev/null 2>&1; then
  ok pg-start "initdb and start in $(( ($(date +%s%N) - pg_start) / 1000000 ))ms"
  assert pg-loopback-only "listens on 127.0.0.1:25432 only" \
    bash -c "$PG/psql -X -At -h $pgd -p 25432 -d postgres -c 'show listen_addresses' | grep -qx 127.0.0.1"
  assert pg-createdb "create and drop a database" \
    "$PG/psql" -X -q -v ON_ERROR_STOP=1 -h "$pgd" -p 25432 -d postgres -c 'create database t1' -c 'drop database t1'
  "$PG/pg_ctl" -D "$pgd/data" -m immediate stop >/dev/null 2>&1
else
  bad pg-start "initdb or start failed: $(tail -n 5 "$pgd/server.log" 2>/dev/null)"
fi

# ── Python (#716) ───────────────────────────────────────────────────────────
# pip and venv are there, a venv gets its own pip offline, and a system
# `pip install` is still refused (PEP 668).
assert pip "pip --version" pip --version
assert python3-venv "python3 -m venv, then the venv's pip" \
  bash -c 'v="$(mktemp -d -p "$HOME")/venv" && python3 -m venv "$v" && "$v/bin/pip" --version'
assert pep668 "a system pip install is refused (externally-managed-environment)" \
  bash -c '! out="$(pip install --no-index automata-probe 2>&1)" && printf "%s" "$out" | grep -q externally-managed-environment'

# ── round trip: the daemon starts and accepts a message ─────────────────────
"$ENTRY" --url https://example.org >/dev/null 2>&1 &
daemon=$!
sock="$HOME/.automata-run/daemon.sock"
for _ in $(seq 1 100); do
  [ -S "$sock" ] && break
  sleep 0.1
done
assert daemon-socket "socket appears within 10s" test -S "$sock"
msg="$(printf '{"type":"ping"}' | base64 -w0)"
expect_exit send-roundtrip 0 "$SEND" "$msg"
kill "$daemon" 2>/dev/null
wait "$daemon" 2>/dev/null

if [ "$fail" -eq 0 ]; then echo "verify: all checks passed"; fi
exit "$fail"
IN_CONTAINER
# 0 and 1 are the checks' own verdict; any other code is docker failing.
case "$rc" in 0 | 1) exit "$rc" ;; *) echo "verify: docker run failed (exit $rc)" >&2; exit 2 ;; esac
