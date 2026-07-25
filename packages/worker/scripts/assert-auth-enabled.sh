#!/usr/bin/env bash
#
# Fail-closed auth-enabled deploy gate (enterprise-hardening #5). Shell equivalent of
# packages/worker/src/agent-run/assert-auth.ts, for the operator's run-worker.sh to
# call BEFORE `exec ... pnpm run worker`. Exits non-zero on ANY failure so a
# -dev / auth-disabled hatchet-lite engine (which embeds a PUBLIC signing key →
# tenancy void) never gets a worker.
#
# Two REST probes + one image assertion, all fail-closed:
#   1. NEGATIVE: a garbage bearer token MUST be rejected 401/403 (2xx ⇒ auth off).
#   2. POSITIVE: the real token MUST be accepted (2xx).
#   3. IMAGE:    docker-compose.hatchet.yml pins a non-`-dev` hatchet-lite tag and
#                sets no --disable-auth / SERVER_AUTH_CONFIG_DISABLE.
#
# Required env: HATCHET_API_URL, HATCHET_TENANT_ID, and HATCHET_API_TOKEN (or
# HATCHET_CLIENT_TOKEN). Any missing → exit 1.
set -euo pipefail

fail() { echo "[assert-auth-enabled] FAIL: $*" >&2; exit 1; }

GARBAGE_TOKEN="automata-auth-probe-invalid-token-do-not-accept"
REAL_TOKEN="${HATCHET_API_TOKEN:-${HATCHET_CLIENT_TOKEN:-}}"

[ -n "${HATCHET_API_URL:-}" ] || fail "HATCHET_API_URL is not set (fail-closed)"
[ -n "${HATCHET_TENANT_ID:-}" ] || fail "HATCHET_TENANT_ID is not set (fail-closed)"
[ -n "$REAL_TOKEN" ] || fail "no HATCHET_API_TOKEN/HATCHET_CLIENT_TOKEN set (fail-closed)"

API_URL="${HATCHET_API_URL%/}"
ENDPOINT="${API_URL}/api/v1/stable/tenants/${HATCHET_TENANT_ID}/workflow-runs?limit=1"

http_status() {
  # $1 = bearer token. Prints the HTTP status code (000 on connection failure).
  curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $1" "$ENDPOINT" || echo "000"
}

# 1. NEGATIVE probe — garbage token must be rejected.
NEG="$(http_status "$GARBAGE_TOKEN")"
case "$NEG" in
  2??) fail "a GARBAGE token was ACCEPTED ($NEG) — engine is auth-DISABLED (tenancy void)" ;;
  401|403) : ;; # good — auth enforced
  *) fail "negative probe returned unexpected status $NEG (expected 401/403)" ;;
esac

# 2. POSITIVE probe — real token must be accepted.
POS="$(http_status "$REAL_TOKEN")"
case "$POS" in
  2??) : ;; # good
  *) fail "the REAL token was REJECTED ($POS) — box misconfigured" ;;
esac

# 3. IMAGE assertion (defense-in-depth) — the compose pin must not drift to a
# -dev/auth-disabled image.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${SCRIPT_DIR}/../docker-compose.hatchet.yml"
if [ -f "$COMPOSE" ]; then
  IMAGE_LINE="$(grep -E 'hatchet-lite:' "$COMPOSE" | head -1 || true)"
  [ -n "$IMAGE_LINE" ] || fail "no hatchet-lite image pin found in $COMPOSE"
  echo "$IMAGE_LINE" | grep -qE 'hatchet-lite:v[0-9]' \
    || fail "hatchet-lite image is not pinned to a versioned tag: $IMAGE_LINE"
  echo "$IMAGE_LINE" | grep -qi -- '-dev' \
    && fail "hatchet-lite image is a -dev tag (auth-disabled, public signing key): $IMAGE_LINE"
  if grep -qiE -- '--disable-auth|SERVER_AUTH_CONFIG_DISABLE' "$COMPOSE"; then
    fail "compose disables auth (--disable-auth / SERVER_AUTH_CONFIG_DISABLE)"
  fi
else
  echo "[assert-auth-enabled] note: $COMPOSE not found (worker box may not host the engine); skipping image assertion" >&2
fi

echo "[assert-auth-enabled] OK — auth enforced (garbage=$NEG, real=$POS) and image pin clean"
