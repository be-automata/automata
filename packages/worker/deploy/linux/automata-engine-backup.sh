#!/bin/bash
# Back up the Hatchet engine's Postgres, and PROVE the dump is restorable (#192).
#
# The engine's database is the only copy of this box's execution state: workflow
# versions, run history, the concurrency slots the box budget is enforced on, and
# the tenant the worker's token is scoped to. The box is a single Hetzner VM with
# no replica. Until this ran, losing it lost all of that.
#
# ── WHY THIS DOES MORE THAN `pg_dump > file` ───────────────────────────────
#
# The classic silent failure is a backup job that has been "succeeding" for
# months into a zero-byte or truncated file, discovered on the one day it is
# needed. So every run here:
#
#   1. dumps to a TEMP name, never over the previous good dump;
#   2. checks the dump is non-trivial and that `pg_restore --list` can read its
#      table of contents — a truncated or empty dump fails this;
#   3. only then renames it into place (rename is atomic on the same fs, so a
#      crash mid-write never leaves a half-file wearing a good name);
#   4. prunes by AGE but refuses to drop the last surviving dump, so a run of
#      bad days cannot end with nothing.
#
# A dump this script accepted has had its table of contents parsed. That is not
# the same as a restore rehearsal — do that separately, and see the runbook.
#
# Usage: automata-engine-backup.sh [dest-dir]
set -uo pipefail

DEST="${1:-/var/backups/automata}"
CONTAINER="${ENGINE_PG_CONTAINER:-automata-hatchet-postgres-1}"
DB_USER="${ENGINE_PG_USER:-hatchet}"
DB_NAME="${ENGINE_PG_DB:-hatchet}"
KEEP_DAYS="${ENGINE_BACKUP_KEEP_DAYS:-14}"
# A custom-format dump of an empty-ish schema is still a few KB; anything under
# this is a failure wearing a filename.
MIN_BYTES="${ENGINE_BACKUP_MIN_BYTES:-4096}"

log()  { echo "[engine-backup] $*"; }
fail() { echo "[engine-backup] FAIL: $*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker not on PATH"
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
  || fail "container $CONTAINER is not running"

install -d -m 0700 "$DEST" || fail "cannot create $DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="${DEST}/${DB_NAME}-${STAMP}.dump"
TMP="${FINAL}.partial"

# -Fc (custom) rather than plain SQL: it is what pg_restore can read selectively
# and verify a table of contents from, which step 2 depends on.
if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$TMP" 2>/tmp/engine-backup.err; then
  rm -f "$TMP"
  fail "pg_dump failed: $(head -c 300 /tmp/engine-backup.err)"
fi

SIZE="$(stat -c %s "$TMP" 2>/dev/null || echo 0)"
if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  rm -f "$TMP"
  fail "dump is only ${SIZE} bytes (< ${MIN_BYTES}) — refusing to keep it"
fi

# The verification that makes this a backup rather than a file. pg_restore reads
# the archive header and table of contents; a truncated or corrupt dump fails
# here rather than at recovery time.
if ! docker exec -i "$CONTAINER" pg_restore --list > /dev/null < "$TMP" 2>/tmp/engine-verify.err; then
  rm -f "$TMP"
  fail "dump failed pg_restore --list: $(head -c 300 /tmp/engine-verify.err)"
fi
TOC_ENTRIES="$(docker exec -i "$CONTAINER" pg_restore --list < "$TMP" 2>/dev/null | grep -c '^[0-9]' || true)"

chmod 0600 "$TMP"
mv -f "$TMP" "$FINAL"   # atomic within the same filesystem

# Prune by age, but NEVER leave the directory empty: a fortnight of failures
# followed by a successful prune is how a backup story ends with no backups.
REMAINING="$(find "$DEST" -maxdepth 1 -name "${DB_NAME}-*.dump" -type f | wc -l)"
if [ "$REMAINING" -gt 1 ]; then
  find "$DEST" -maxdepth 1 -name "${DB_NAME}-*.dump" -type f -mtime "+${KEEP_DAYS}" -print -delete \
    | while read -r gone; do log "pruned $(basename "$gone")"; done
fi

log "OK — ${FINAL} (${SIZE} bytes, ${TOC_ENTRIES} archive entries), $(find "$DEST" -maxdepth 1 -name "${DB_NAME}-*.dump" | wc -l) dump(s) retained"
