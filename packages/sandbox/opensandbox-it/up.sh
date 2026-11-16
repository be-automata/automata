#!/usr/bin/env bash
# OPENSANDBOX_IT bring-up: OpenSandbox 1.2.1 inside a throwaway docker:dind daemon (#634 S3).
# Third-party code runs only inside osbit-dind's nested daemon. No host mounts, no host docker
# socket, no env passthrough; the only published port is 127.0.0.1:18091 (lifecycle API).
# The API key is generated per run into $STATE/api_key (0600) and is never printed.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${OPENSANDBOX_IT_STATE:-${TMPDIR:-/tmp}/osbit}"
mkdir -p "$STATE"
# An empty Docker config: no host credential helpers or registry auth reach the pulls.
export DOCKER_CONFIG="$STATE/dockercfg"
mkdir -p "$DOCKER_CONFIG"
echo '{}' > "$DOCKER_CONFIG/config.json"

# docker:29.0.1-dind
DIND=docker@sha256:ecac43e78380d9b9d3bd24f0ab42b370f6391a1a06a66065c10a00b9d6d57a3e
# opensandbox/server:release-1.2.1
SERVER=opensandbox/server@sha256:07f9b39adb8cadf68357dd1b86367068210e960fc4cb50e11b75176387557ea7
# opensandbox/execd:release-1.2.1
EXECD=opensandbox/execd@sha256:6b12d17844ac7167271488302c71934e47f76abb9ddab19ec8529bd1c1c56b23
# opensandbox/egress:release-1.2.1
EGRESS=opensandbox/egress@sha256:84b98d3b5989a87389c977f6433f8cd3c7998d03aa15aaae41ebcb15b7eb8000
# python:3.12-slim
PY=python@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

run_dind() {
  docker run -d --privileged --name osbit-dind --label osbit=1 \
    -p 127.0.0.1:18091:8090 -e DOCKER_TLS_CERTDIR= "$DIND" --host unix:///var/run/docker.sock >/dev/null
}

# -v: the old daemon's anonymous /var/lib/docker volume holds GBs of images.
docker rm -fv osbit-dind >/dev/null 2>&1 || true
run_dind
dind_ready=0
for _ in $(seq 1 60); do
  if docker exec osbit-dind docker info >/dev/null 2>&1; then dind_ready=1; break; fi
  sleep 1
done
if [ "$dind_ready" != 1 ]; then
  echo "dind did not become ready in 60 s" >&2
  docker logs osbit-dind 2>&1 | tail -20 >&2 || true
  exit 1
fi
D() { docker exec osbit-dind "$@"; }

for pair in "$SERVER osbit/server:1.2.1" "$EXECD osbit/execd:1.2.1" "$EGRESS osbit/egress:1.2.1" "$PY osbit/py:3.12"; do
  # shellcheck disable=SC2086
  set -- $pair
  # Anonymous Docker Hub pulls drop connections now and then: retry, by digest.
  for attempt in 1 2 3; do
    D docker pull -q "$1" >/dev/null && break
    [ "$attempt" = 3 ] && { echo "pull failed: $1" >&2; exit 1; }
    sleep $((attempt * 5))
  done
  D docker tag "$1" "$2"
  echo "pulled $1 -> $2 ($(D docker image inspect "$2" --format '{{.Architecture}}'))"
done

KEY="$(openssl rand -hex 16)"
printf '%s\n' "$KEY" > "$STATE/api_key"
chmod 600 "$STATE/api_key"
# The key goes through the environment, never an argv (visible in ps).
OSBIT_KEY="$KEY" awk '{ gsub("__API_KEY__", ENVIRON["OSBIT_KEY"]); print }' "$HERE/config.toml" > "$STATE/config.toml"
chmod 600 "$STATE/config.toml"
D mkdir -p /osbit
docker cp "$STATE/config.toml" osbit-dind:/osbit/config.toml >/dev/null
D docker run -d --name osb-server --network host --label osbit=1 \
  -v /var/run/docker.sock:/var/run/docker.sock -v /osbit:/etc/opensandbox:ro -v osbdata:/data \
  -e SANDBOX_CONFIG_PATH=/etc/opensandbox/config.toml osbit/server:1.2.1 >/dev/null

healthy=0
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:18091/health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
echo "health: $(curl -s http://127.0.0.1:18091/health || true)"
if [ "$healthy" != 1 ]; then
  echo "server did not become healthy" >&2
  D docker logs osb-server 2>&1 | tail -20 >&2 || true
  exit 1
fi
echo "OPENSANDBOX_IT_BASE_URL=http://127.0.0.1:18091"
echo "OPENSANDBOX_IT_STATE=$STATE (api key in $STATE/api_key)"
