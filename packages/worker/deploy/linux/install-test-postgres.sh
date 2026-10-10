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
#   - conf.d drop-in: listen on 127.0.0.1 ONLY, port 15432, small memory
#     (shared_buffers 64MB, max_connections 50) so it fits next to runs held to
#     a 1500M ceiling;
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
#   - verifies, as automata_test over TCP, that it can create and drop a
#     database and is not a superuser, and that nothing listens off loopback.
#
# Usage: install-test-postgres.sh   (env: PG_VERSION, default 16)

PG_VERSION="${PG_VERSION:-16}"
PORT=15432
ROLE=automata_test
PW_FILE=/etc/automata/test-postgres.password
CLUSTER_DIR="/etc/postgresql/${PG_VERSION}/main"
DROPIN="${CLUSTER_DIR}/conf.d/automata-test.conf"
HBA="${CLUSTER_DIR}/pg_hba.conf"
UNIT="postgresql@${PG_VERSION}-main"

log() { echo "[test-postgres] $*"; }
fail() {
  echo "[test-postgres] FAIL: $*" >&2
  exit 1
}

[ "$(id -u)" = "0" ] || fail "must run as root"
command -v systemctl >/dev/null || fail "systemctl not on PATH"

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
if [ ! -d /etc/automata ]; then
  install -d -o root -g root -m 0755 /etc/automata
fi
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

# ── server config ────────────────────────────────────────────────────────────
CHANGED=0
write_if_changed() {
  local dest="$1" mode="$2" content="$3"
  if [ -f "$dest" ] && [ "$(cat "$dest")" = "$content" ]; then
    return 0
  fi
  local tmp
  tmp="$(mktemp "${dest}.XXXXXX")"
  printf '%s\n' "$content" >"$tmp"
  chown postgres:postgres "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
  CHANGED=1
  log "wrote ${dest}"
}

write_if_changed "$DROPIN" 0644 "# Managed by install-test-postgres.sh. Test-only cluster.
listen_addresses = '127.0.0.1'
port = ${PORT}
shared_buffers = 64MB
max_connections = 50"

if [ ! -f "${HBA}.dist" ]; then
  cp -p "$HBA" "${HBA}.dist"
fi
write_if_changed "$HBA" 0640 "# Managed by install-test-postgres.sh (original kept as pg_hba.conf.dist).
# TYPE  DATABASE  USER           ADDRESS        METHOD
local   all       postgres                      peer
host    all       ${ROLE}        127.0.0.1/32   scram-sha-256"

systemctl enable --quiet postgresql
if [ "$CHANGED" = "1" ] || ! systemctl is-active --quiet "$UNIT"; then
  log "restarting ${UNIT}"
  systemctl restart "$UNIT"
fi
for _ in $(seq 1 30); do
  runuser -u postgres -- pg_isready -q -p "$PORT" && break
  sleep 1
done
runuser -u postgres -- pg_isready -q -p "$PORT" || fail "${UNIT} is not accepting connections on ${PORT}"

# ── role: SQL on stdin, so the password never reaches a process argv ─────────
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PORT" -d postgres <<SQL
SELECT 'CREATE ROLE ${ROLE}' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}')
\gexec
ALTER ROLE ${ROLE} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${PW}';
SQL
log "role ${ROLE} is LOGIN CREATEDB NOSUPERUSER"

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

log "OK — PostgreSQL ${PG_VERSION} on 127.0.0.1:${PORT} only; ${ROLE} can create/drop databases and is not a superuser"
log "TEST_DATABASE_ADMIN_URL=postgresql://${ROLE}:<REDACTED, see ${PW_FILE}>@127.0.0.1:${PORT}/postgres"
