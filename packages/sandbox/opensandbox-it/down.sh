#!/usr/bin/env bash
# Remove everything the OPENSANDBOX_IT bring-up created on the host daemon (the dind container and its volumes).
set -uo pipefail
docker rm -f -v osbit-dind >/dev/null 2>&1 || true
docker ps -a --filter label=osbit=1 --format '{{.Names}}'
echo "down: osbit-dind removed"
