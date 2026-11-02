#!/usr/bin/env bash
# Installs run telemetry on a Linux execution box (spike 032): the OTel collector that
# strips account identity, and Maple local as the store. Idempotent. Run as root.
#
#   sudo packages/worker/deploy/linux/install-run-telemetry.sh
#
# Then opt the worker in (it refuses to boot on a malformed value):
#   WORKER_RUN_OTLP_URL=http://127.0.0.1:4320       # run containers export to the collector
#   WORKER_TOOL_FAILURE_STREAK_LIMIT=0              # #546: 0 = observe only; set a limit once
#                                                   # the observe logs show where working runs peak
# and restart it with automata-worker-safe-restart.
#
# Pinned releases, verified by sha256 before anything is extracted. Maple v0.3.2 is the
# version spike 032 validated (published 2026-11-01); it runs as the static automata-telemetry user bound to
# loopback with no network beyond localhost.
set -euo pipefail
code=000

OTELCOL_VERSION=0.162.0
OTELCOL_SHA256=fcc063749f730f8c21fe29f2d340ff174f5f1c5885bd3156fb6c985a3036fcc3
MAPLE_VERSION=v0.3.2
MAPLE_SHA256=ee026f2e68251a4ffd1367d45c3dbffae32be373f6bab6d5b6e4b79c9906cb51

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=/usr/local/lib/automata-telemetry

[ "$(id -u)" -eq 0 ] || { echo "install-run-telemetry: run as root" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "install-run-telemetry: x86_64 only (pinned builds)" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

fetch() { # url sha256 out
  curl -fsSL --proto '=https' --tlsv1.2 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet - || { echo "install-run-telemetry: checksum mismatch for $1" >&2; exit 1; }
}

install -d -m 0755 "$LIB" "$LIB/maple" /etc/automata
# Maple's static user (automata-maple.service): DynamicUser's symlinked state dir is refused.
id -u automata-telemetry >/dev/null 2>&1 ||
  useradd --system --no-create-home --home-dir /var/lib/automata-maple --shell /usr/sbin/nologin automata-telemetry

fetch "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_amd64.tar.gz" \
  "$OTELCOL_SHA256" "$work/otelcol.tar.gz"
tar -xzf "$work/otelcol.tar.gz" -C "$work" otelcol-contrib
install -m 0755 "$work/otelcol-contrib" "$LIB/otelcol-contrib"

fetch "https://github.com/MapleTechLabs/maple/releases/download/${MAPLE_VERSION}/maple-${MAPLE_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
  "$MAPLE_SHA256" "$work/maple.tar.gz"
tar -xzf "$work/maple.tar.gz" -C "$work"
install -m 0755 "$work/maple-${MAPLE_VERSION}-x86_64-unknown-linux-gnu/maple" "$LIB/maple/maple"
install -m 0644 "$work/maple-${MAPLE_VERSION}-x86_64-unknown-linux-gnu/libchdb.so" "$LIB/maple/libchdb.so"

install -m 0644 "$HERE/otel-collector.yaml" /etc/automata/otel-collector.yaml
"$LIB/otelcol-contrib" validate --config /etc/automata/otel-collector.yaml

install -m 0644 "$HERE/automata-maple.service" /etc/systemd/system/automata-maple.service
install -m 0644 "$HERE/automata-otel-collector.service" /etc/systemd/system/automata-otel-collector.service
systemctl daemon-reload
systemctl enable --now automata-maple.service automata-otel-collector.service

# Both ends must be up: the collector answers 200 even when it cannot export, so a crash-looping
# Maple would otherwise pass this check.
maple=000
for _ in $(seq 1 60); do
  maple="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4318/ || true)"
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/x-protobuf' --data-binary '' http://127.0.0.1:4320/v1/logs || true)"
  [ "$maple" = 200 ] && [ "$code" = 200 ] && break
  sleep 1
done
[ "$maple" = 200 ] || { echo "install-run-telemetry: Maple not serving on 127.0.0.1:4318 (last HTTP $maple; journalctl -u automata-maple)" >&2; exit 1; }
[ "$code" = 200 ] || { echo "install-run-telemetry: collector not accepting OTLP on 127.0.0.1:4320 (last HTTP $code)" >&2; exit 1; }
# One unit per call: with several units `is-active` exits 0 when ANY of them is active.
for unit in automata-maple automata-otel-collector; do
  systemctl is-active --quiet "$unit.service" ||
    { echo "install-run-telemetry: $unit is not active (systemctl status $unit)" >&2; exit 1; }
done
echo "install-run-telemetry: collector on 127.0.0.1:4320 -> Maple on 127.0.0.1:4318 (ssh -L 4318:127.0.0.1:4318 for the UI)"
