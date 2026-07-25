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
# Required env: HATCHET_API_TOKEN (or HATCHET_CLIENT_TOKEN), plus HATCHET_API_URL /
# HATCHET_TENANT_ID — either set explicitly or derivable from the token's JWT claims
# (`server_url` / `sub`), the SAME fallback the TS gate (assert-auth.ts) uses, so a
# token-only worker-box.env passes both gates identically. Unresolvable → exit 1.
set -euo pipefail

fail() { echo "[assert-auth-enabled] FAIL: $*" >&2; exit 1; }

GARBAGE_TOKEN="automata-auth-probe-invalid-token-do-not-accept"
REAL_TOKEN="${HATCHET_API_TOKEN:-${HATCHET_CLIENT_TOKEN:-}}"

[ -n "$REAL_TOKEN" ] || fail "no HATCHET_API_TOKEN/HATCHET_CLIENT_TOKEN set (fail-closed)"

# JWT-claim fallback (parity with assert-auth.ts loadAuthProbeConfig): decode the
# token's payload (base64url) and read `server_url` / `sub`. Never prints the token.
jwt_claim() {
  # $1 = claim name. Empty output when the token/claim can't be decoded.
  local payload
  payload="$(printf '%s' "$REAL_TOKEN" | cut -d. -f2 | tr '_-' '/+')" || return 0
  # Pad base64 to a multiple of 4 for strict decoders.
  while [ $(( ${#payload} % 4 )) -ne 0 ]; do payload="${payload}="; done
  printf '%s' "$payload" | base64 -d 2>/dev/null \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

HATCHET_API_URL="${HATCHET_API_URL:-$(jwt_claim server_url)}"
HATCHET_TENANT_ID="${HATCHET_TENANT_ID:-$(jwt_claim sub)}"

[ -n "${HATCHET_API_URL:-}" ] || fail "HATCHET_API_URL not set and not derivable from the token's server_url claim (fail-closed)"
[ -n "${HATCHET_TENANT_ID:-}" ] || fail "HATCHET_TENANT_ID not set and not derivable from the token's sub claim (fail-closed)"

API_URL="${HATCHET_API_URL%/}"
# `since` + `only_tasks` are REQUIRED query params on this endpoint (live-verified
# against hatchet-lite v0.94.10: omitting only_tasks → 400 even with a valid token,
# which would trip the positive probe). Keep in sync with assert-auth.ts.
SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ENDPOINT="${API_URL}/api/v1/stable/tenants/${HATCHET_TENANT_ID}/workflow-runs?since=${SINCE}&only_tasks=false&limit=1"

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
  # Match the `image:` pin, NOT the compose service-name line (`hatchet-lite:`).
  IMAGE_LINE="$(grep -E '^\s*image:.*hatchet-lite' "$COMPOSE" | head -1 || true)"
  [ -n "$IMAGE_LINE" ] || fail "no hatchet-lite image pin found in $COMPOSE"
  # Inspect only the TAG (after the last colon) — the repo path legitimately
  # contains "hatchet-dev" (the GitHub org), which a whole-line -dev grep would
  # false-positive on (live-caught 2026-07-25).
  IMAGE_TAG="${IMAGE_LINE##*:}"
  echo "$IMAGE_TAG" | grep -qE '^v[0-9]' \
    || fail "hatchet-lite image is not pinned to a versioned tag: $IMAGE_LINE"
  echo "$IMAGE_TAG" | grep -qi -- '-dev' \
    && fail "hatchet-lite image is a -dev tag (auth-disabled, public signing key): $IMAGE_LINE"
  # Ignore comment lines — the compose file's own "never add --disable-auth"
  # warning comment must not trip the gate (live-caught 2026-07-25).
  if grep -vE '^\s*#' "$COMPOSE" | grep -qiE -- '--disable-auth|SERVER_AUTH_CONFIG_DISABLE'; then
    fail "compose disables auth (--disable-auth / SERVER_AUTH_CONFIG_DISABLE)"
  fi
else
  echo "[assert-auth-enabled] note: $COMPOSE not found (worker box may not host the engine); skipping image assertion" >&2
fi

echo "[assert-auth-enabled] OK — auth enforced (garbage=$NEG, real=$POS) and image pin clean"
