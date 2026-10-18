#!/usr/bin/env bash
# Spike 002 setup: seed repo from GitHub, start bare forge (:3301) and Forgejo (:3300).
# Usage: ./setup.sh [seed|bare|forgejo|reset-bare|reset-forgejo|down]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/work"; mkdir -p "$WORK"
IMG=codeberg.org/forgejo/forgejo:15.0.8
SEED="$WORK/seed.git"

seed() { [ -d "$SEED" ] || git clone -q --bare --single-branch --branch main https://github.com/be-automata/astro-web.git "$SEED"; }

reset_bare() {
  rm -rf "$WORK/bare-root"; mkdir -p "$WORK/bare-root"
  git clone -q --bare "$SEED" "$WORK/bare-root/bench.git"
  git -C "$WORK/bare-root/bench.git" config http.receivepack true
}

bare() {
  pkill -f "bare-server.mjs" 2>/dev/null || true
  FORGE_ROOT="$WORK/bare-root" PORT=3301 nohup node "$HERE/bare-server.mjs" > "$WORK/bare-server.log" 2>&1 &
  sleep 1; cat "$WORK/bare-server.log"
}

forgejo() {
  # Throwaway admin password for the local container, generated per setup (never committed).
  FJ_PASS="$(openssl rand -hex 16)"; echo "$FJ_PASS" > "$WORK/forgejo-pass"
  docker rm -f forge-spike >/dev/null 2>&1 || true
  docker run -d --name forge-spike -p 3300:3000 \
    -e FORGEJO__security__INSTALL_LOCK=true -e FORGEJO__database__DB_TYPE=sqlite3 \
    -e FORGEJO__server__ROOT_URL=http://localhost:3300/ -e FORGEJO__server__DISABLE_SSH=true \
    -e FORGEJO__repository__DEFAULT_BRANCH=main "$IMG" >/dev/null
  for i in $(seq 1 60); do curl -sf http://localhost:3300/api/healthz >/dev/null && break; sleep 1; done
  docker exec -u git forge-spike forgejo admin user create --admin --username spike --password "$FJ_PASS" \
    --email spike@forge.local --must-change-password=false >/dev/null
  curl -sf -u "spike:$FJ_PASS" -H 'content-type: application/json' \
    -d '{"name":"bench","scopes":["write:repository","write:user"]}' \
    http://localhost:3300/api/v1/users/spike/tokens | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).sha1))' > "$WORK/forgejo-token"
  reset_forgejo
}

reset_forgejo() {
  T=$(cat "$WORK/forgejo-token")
  curl -s -o /dev/null -X DELETE -H "authorization: token $T" http://localhost:3300/api/v1/repos/spike/bench || true
  curl -sf -H "authorization: token $T" -H 'content-type: application/json' \
    -d '{"name":"bench","default_branch":"main","private":false}' http://localhost:3300/api/v1/user/repos >/dev/null
  git -C "$SEED" -c credential.helper= push -q "http://spike:$T@localhost:3300/spike/bench.git" main:main
  echo "forgejo ready (token in work/forgejo-token)"
}

case "${1:-all}" in
  seed) seed ;; bare) bare ;; forgejo) forgejo ;; reset-bare) reset_bare ;; reset-forgejo) reset_forgejo ;;
  down) docker rm -f forge-spike; pkill -f bare-server.mjs || true ;;
  all) seed; reset_bare; bare; forgejo ;;
esac
