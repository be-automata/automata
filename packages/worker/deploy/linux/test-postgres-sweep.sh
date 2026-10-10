#!/bin/bash
set -euo pipefail
#
# Undo what one test run can do to the next on the box's test Postgres
# (install-test-postgres.sh). Root required; driven every 15 minutes by
# automata-test-postgres-sweep.timer.
#
# automata_test is not a superuser, but as itself it can still:
#   - ALTER ROLE automata_test PASSWORD …  -> every later run fails to log in;
#   - ALTER ROLE automata_test SET search_path / statement_timeout / … ->
#     every later session inherits it;
#   - leave databases behind (a killed vitest never runs its teardown) and
#     sessions open, eating disk and connection slots.
# So every sweep:
#   1. ALTER ROLE … RESET ALL, and re-asserts the attributes, a CONNECTION LIMIT
#      and the password from the root-only file;
#   2. terminates the role's backends older than 3 hours;
#   3. drops every database the role owns whose PG_VERSION file (written at
#      CREATE DATABASE) is older than 3 hours. A test run that takes 3 hours is
#      already dead.
#
# The SQL goes to psql on stdin (never argv), and the session first sets
# log_min_error_statement = panic, so a failing statement is not written to the
# server log with the password in it.

PORT=25432
ROLE=automata_test
PW_FILE=/etc/automata/test-postgres.password

log() { echo "[test-postgres-sweep] $*"; }
fail() {
  echo "[test-postgres-sweep] FAIL: $*" >&2
  exit 1
}

[ "$(id -u)" = "0" ] || fail "must run as root"
[ -r "$PW_FILE" ] || fail "cannot read ${PW_FILE} (run install-test-postgres.sh)"
PW="$(cat "$PW_FILE")"
[[ "$PW" =~ ^[0-9a-f]{32,}$ ]] || fail "${PW_FILE} is not the generated hex password"

runuser -u postgres -- psql -X -q -At -v ON_ERROR_STOP=1 -p "$PORT" -d postgres <<SQL
SET log_min_error_statement = panic;
ALTER ROLE ${ROLE} RESET ALL;
ALTER ROLE ${ROLE} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40 PASSWORD '${PW}';
SELECT 'terminated ' || count(*) || ' session(s) older than 3h'
FROM (
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE usename = '${ROLE}' AND backend_start < now() - interval '3 hours'
) t;
CREATE TEMP TABLE aged AS
SELECT d.datname
FROM pg_database d
JOIN pg_roles r ON r.oid = d.datdba
WHERE r.rolname = '${ROLE}'
  AND (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification
      < now() - interval '3 hours';
SELECT 'dropping ' || datname FROM aged ORDER BY 1;
SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM aged
\gexec
SQL

log "OK — ${ROLE} reset; aged sessions and databases swept"
