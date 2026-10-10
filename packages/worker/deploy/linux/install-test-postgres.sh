#!/bin/bash
set -euo pipefail
umask 022
#
# Provision a loopback-only Postgres for the repo's DB-backed test suites on a
# Linux execution box that has no Docker for agent runs. Root required.
#
# @terragon/shared and @terragon/www tests normally start a docker compose
# Postgres. With TEST_DATABASE_ADMIN_URL set they skip compose and create/drop a
# throwaway database per vitest run over TCP instead (packages/dev-env
# test-global-setup). This script builds the server that URL points at.
#
# What it does (idempotent; a second run changes nothing and restarts nothing):
#   - installs Ubuntu's `postgresql` package (24.04 ships PG16);
#   - conf.d drop-in: listen on 127.0.0.1 ONLY, port 25432 (not 15432: that is
#     the port `pnpm docker-up-tests` publishes, should anyone run it here),
#     small memory, and per-session bounds (temp_file_limit, idle-in-transaction
#     timeout, dead-client checks) set in the FILE, where the test role cannot
#     undo them;
#   - systemd drop-in on the cluster unit: MemoryHigh/MemoryMax/CPUQuota. The
#     server runs outside every run's cgroup, so without this one run's
#     `SET work_mem = '4GB'` escapes that run's 1500M ceiling;
#   - replaces the cluster's pg_hba.conf: the postgres OS account over the local
#     socket (peer), and automata_test from 127.0.0.1/32 with scram-sha-256.
#     Nothing else, so no other role or address can log in;
#   - role automata_test: LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION
#     NOBYPASSRLS. CREATEDB is all the test harness needs: it owns the databases
#     it creates, and on PG15+ the owner may create tables in `public`. The
#     schema needs no extension (gen_random_uuid() is core since PG13);
#   - the role's password is generated ONCE into /etc/automata/test-postgres.password
#     (root:root 0600) and never printed. It never appears in a process argv:
#     SQL goes to psql on stdin and the client check reads a temp PGPASSFILE;
#   - installs and enables automata-test-postgres-sweep.{service,timer} (role
#     reset + aged session/database sweep every 15 min) and runs it once;
#   - verifies, as automata_test over TCP, that it can create and drop a
#     database and is not a superuser, and that nothing listens off loopback;
#   - then writes /etc/automata/agent-test-services.env, two lines:
#     TEST_DATABASE_ADMIN_URL=… (password included) and TEST_SERVICES_REPOS=…
#     (the comma-separated owner/repo list whose runs may use it; the login is
#     shared, so it is scoped), root:<worker group> 0640. The WORKER reads it
#     per run and injects the URL into task runs of a listed repo (never review
#     or self-heal runs) below the owner's repo env (packages/worker/src/
#     agent-run/box-test-services.ts). The agent uid is not in that group and cannot read
#     the file itself; it only ever sees the value in its run's env. The sweep
#     re-asserts the SAME password from PW_FILE, so the file stays valid.
#
# Restarts are guarded: when a restart is needed and automata_test has open
# sessions (a test run in flight) it refuses unless FORCE=1. A pg_hba-only
# change is applied with a reload, which drops nobody.
#
# Usage: [FORCE=1] install-test-postgres.sh
#   env: PG_VERSION (default 16), WORKER_GROUP (the worker unit's Group=,
#   default automata), TEST_SERVICES_REPOS (default be-automata/automata)

PG_VERSION="${PG_VERSION:-16}"
FORCE="${FORCE:-0}"
PORT=25432
ROLE=automata_test
PW_FILE=/etc/automata/test-postgres.password
CLUSTER_DIR="/etc/postgresql/${PG_VERSION}/main"
DROPIN="${CLUSTER_DIR}/conf.d/automata-test.conf"
HBA="${CLUSTER_DIR}/pg_hba.conf"
UNIT="postgresql@${PG_VERSION}-main"
LIMITS="/etc/systemd/system/${UNIT}.service.d/automata-limits.conf"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP_BIN=/usr/local/sbin/automata-test-postgres-sweep.sh
SWEEP_UNIT=automata-test-postgres-sweep
WORKER_GROUP="${WORKER_GROUP:-automata}"
AGENT_ENV_FILE=/etc/automata/agent-test-services.env
TEST_SERVICES_REPOS="${TEST_SERVICES_REPOS:-be-automata/automata}"

log() { echo "[test-postgres] $*"; }
fail() {
  echo "[test-postgres] FAIL: $*" >&2
  exit 1
}

[ "$(id -u)" = "0" ] || fail "must run as root"
command -v systemctl >/dev/null || fail "systemctl not on PATH"
getent group "$WORKER_GROUP" >/dev/null ||
  fail "no group ${WORKER_GROUP} (set WORKER_GROUP to the worker unit's Group=)"
REPO_RE='[A-Za-z0-9._-]+/[A-Za-z0-9._-]+'
[[ "$TEST_SERVICES_REPOS" =~ ^${REPO_RE}(,${REPO_RE})*$ ]] ||
  fail "TEST_SERVICES_REPOS must be comma-separated owner/repo names"
for f in test-postgres-sweep.sh "${SWEEP_UNIT}.service" "${SWEEP_UNIT}.timer"; do
  [ -r "${SRC_DIR}/${f}" ] || fail "missing ${SRC_DIR}/${f}"
done

if dpkg-query -W -f='${Status}' postgresql 2>/dev/null | grep -q 'install ok installed'; then
  log "postgresql package already installed"
else
  log "installing postgresql"
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends postgresql
fi

[ -d "$CLUSTER_DIR" ] || fail "no cluster at ${CLUSTER_DIR} (is PG_VERSION=${PG_VERSION} right? see pg_lsclusters)"
[ -d "${CLUSTER_DIR}/conf.d" ] || fail "${CLUSTER_DIR}/conf.d missing: the drop-in would be ignored"

# ── password: generated once, root-only, hex so it is safe inside a SQL literal ──
install -d -o root -g root -m 0755 /etc/automata
if [ ! -s "$PW_FILE" ]; then
  (
    umask 077
    od -An -tx1 -N24 /dev/urandom | tr -d ' \n' >"$PW_FILE"
  )
  log "generated ${PW_FILE}"
fi
chown root:root "$PW_FILE"
chmod 0600 "$PW_FILE"
PW="$(cat "$PW_FILE")"
[[ "$PW" =~ ^[0-9a-f]{32,}$ ]] || fail "${PW_FILE} is not the generated hex password; remove it to regenerate"

# ── desired config ───────────────────────────────────────────────────────────
DROPIN_CONTENT="# Managed by install-test-postgres.sh. Test-only cluster.
listen_addresses = '127.0.0.1'
port = ${PORT}
shared_buffers = 64MB
max_connections = 50
temp_file_limit = 2GB
client_connection_check_interval = 2s
idle_in_transaction_session_timeout = 10min"

HBA_CONTENT="# Managed by install-test-postgres.sh (original kept as pg_hba.conf.dist).
# TYPE  DATABASE  USER           ADDRESS        METHOD
local   all       postgres                      peer
host    all       ${ROLE}        127.0.0.1/32   scram-sha-256"

LIMITS_CONTENT="# Managed by install-test-postgres.sh. The server runs outside every
# test run's cgroup; bound it here so one session cannot take the box.
[Service]
MemoryHigh=768M
MemoryMax=1G
CPUQuota=200%"

differs() { [ ! -f "$1" ] || [ "$(cat "$1")" != "$2" ]; }

write_file() {
  local dest="$1" owner="$2" mode="$3" content="$4" tmp
  tmp="$(mktemp "${dest}.XXXXXX")"
  printf '%s\n' "$content" >"$tmp"
  chown "$owner" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
  log "wrote ${dest}"
}

# Decide BEFORE writing anything, so a refused restart leaves the files as they
# were and the next run still sees the change pending.
NEED_RESTART=0
NEED_RELOAD=0
differs "$DROPIN" "$DROPIN_CONTENT" && NEED_RESTART=1
differs "$LIMITS" "$LIMITS_CONTENT" && NEED_RESTART=1
differs "$HBA" "$HBA_CONTENT" && NEED_RELOAD=1
RUNNING_PORT=""
if systemctl is-active --quiet "$UNIT"; then
  RUNNING_PORT="$(pg_lsclusters -h "$PG_VERSION" main | awk '{print $3}')"
  [ "$RUNNING_PORT" = "$PORT" ] || NEED_RESTART=1
else
  NEED_RESTART=1
fi

if [ "$NEED_RESTART" = "1" ] && [ -n "$RUNNING_PORT" ]; then
  ACTIVE="$(runuser -u postgres -- psql -X -At -p "$RUNNING_PORT" -d postgres \
    -c "SELECT count(*) FROM pg_stat_activity WHERE usename = '${ROLE}'")"
  if [ "$ACTIVE" != "0" ] && [ "$FORCE" != "1" ]; then
    fail "a restart is needed but ${ROLE} has ${ACTIVE} open session(s) (a test run in flight); re-run when idle, or with FORCE=1"
  fi
fi

differs "$DROPIN" "$DROPIN_CONTENT" && write_file "$DROPIN" postgres:postgres 0644 "$DROPIN_CONTENT"
if [ ! -f "${HBA}.dist" ]; then
  cp -p "$HBA" "${HBA}.dist"
fi
differs "$HBA" "$HBA_CONTENT" && write_file "$HBA" postgres:postgres 0640 "$HBA_CONTENT"
if differs "$LIMITS" "$LIMITS_CONTENT"; then
  install -d -o root -g root -m 0755 "$(dirname "$LIMITS")"
  write_file "$LIMITS" root:root 0644 "$LIMITS_CONTENT"
  systemctl daemon-reload
fi

systemctl enable --quiet postgresql
if [ "$NEED_RESTART" = "1" ]; then
  log "restarting ${UNIT}"
  systemctl restart "$UNIT"
elif [ "$NEED_RELOAD" = "1" ]; then
  log "reloading ${UNIT} (pg_hba only)"
  systemctl reload "$UNIT"
fi
for _ in $(seq 1 30); do
  runuser -u postgres -- pg_isready -q -p "$PORT" && break
  sleep 1
done
runuser -u postgres -- pg_isready -q -p "$PORT" || fail "${UNIT} is not accepting connections on ${PORT}"

# ── role: SQL on stdin, so the password never reaches a process argv; a failing
#    statement is kept out of the server log (log_min_error_statement) ────────
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PORT" -d postgres <<SQL
SET log_min_error_statement = panic;
SELECT 'CREATE ROLE ${ROLE}' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}')
\gexec
ALTER ROLE ${ROLE} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40 PASSWORD '${PW}';
SQL
log "role ${ROLE} is LOGIN CREATEDB NOSUPERUSER"

# ── sweep: role reset + aged sessions/databases, every 15 minutes ────────────
UNITS_CHANGED=0
if ! cmp -s "${SRC_DIR}/test-postgres-sweep.sh" "$SWEEP_BIN"; then
  install -o root -g root -m 0755 "${SRC_DIR}/test-postgres-sweep.sh" "$SWEEP_BIN"
  log "installed ${SWEEP_BIN}"
fi
for f in "${SWEEP_UNIT}.service" "${SWEEP_UNIT}.timer"; do
  if ! cmp -s "${SRC_DIR}/${f}" "/etc/systemd/system/${f}"; then
    install -o root -g root -m 0644 "${SRC_DIR}/${f}" "/etc/systemd/system/${f}"
    log "installed /etc/systemd/system/${f}"
    UNITS_CHANGED=1
  fi
done
[ "$UNITS_CHANGED" = "1" ] && systemctl daemon-reload
systemctl enable --quiet --now "${SWEEP_UNIT}.timer"
"$SWEEP_BIN"

# ── verify as the role, over TCP ─────────────────────────────────────────────
PGPASSFILE="$(mktemp)"
trap 'rm -f "$PGPASSFILE"' EXIT
chmod 0600 "$PGPASSFILE"
printf '127.0.0.1:%s:*:%s:%s\n' "$PORT" "$ROLE" "$PW" >"$PGPASSFILE"
export PGPASSFILE
CONN="host=127.0.0.1 port=${PORT} user=${ROLE} dbname=postgres"

IS_SUPER="$(psql -X -At "$CONN" -c "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")"
[ "$IS_SUPER" = "f" ] || fail "${ROLE} is a superuser"
PROBE_DB="test_install_probe_$$"
psql -X -q -v ON_ERROR_STOP=1 "$CONN" -c "CREATE DATABASE ${PROBE_DB}"
psql -X -q -v ON_ERROR_STOP=1 "$CONN" -c "DROP DATABASE ${PROBE_DB} WITH (FORCE)"

LISTENERS="$(ss -ltnH "sport = :${PORT}" | awk '{print $4}' | sort -u)"
[ -n "$LISTENERS" ] || fail "nothing listens on ${PORT}"
if [ "$LISTENERS" != "127.0.0.1:${PORT}" ]; then
  fail "port ${PORT} is listening beyond loopback: ${LISTENERS//$'\n'/ }"
fi

# ── the worker's copy of the URL, written only once the server is proven ─────
# The password is hex (checked above), which is URL-safe as is: no encoding
# needed. The content holds the secret, so it only ever goes through bash
# string compares and the printf builtin — never a process argv, never stdout.
AGENT_ENV_CONTENT="TEST_DATABASE_ADMIN_URL=postgresql://${ROLE}:${PW}@127.0.0.1:${PORT}/postgres
TEST_SERVICES_REPOS=${TEST_SERVICES_REPOS}"
if differs "$AGENT_ENV_FILE" "$AGENT_ENV_CONTENT"; then
  write_file "$AGENT_ENV_FILE" "root:${WORKER_GROUP}" 0640 "$AGENT_ENV_CONTENT"
fi
chown "root:${WORKER_GROUP}" "$AGENT_ENV_FILE"
chmod 0640 "$AGENT_ENV_FILE"

log "OK — PostgreSQL ${PG_VERSION} on 127.0.0.1:${PORT} only; ${ROLE} can create/drop databases and is not a superuser"
log "TEST_DATABASE_ADMIN_URL=postgresql://${ROLE}:<REDACTED, see ${PW_FILE}>@127.0.0.1:${PORT}/postgres"
log "task runs of ${TEST_SERVICES_REPOS} get it from ${AGENT_ENV_FILE} (root:${WORKER_GROUP} 0640), injected by the worker"
