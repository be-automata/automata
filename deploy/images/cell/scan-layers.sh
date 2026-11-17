#!/bin/bash
set -euo pipefail
# scan-layers.sh IMAGE GITLEAKS_BIN: secret-scan what the cell build ADDED to
# the batteries base: the image config (ENV, LABEL, history) and every layer
# above the base's layers. verify.sh sees a running container; a token baked
# into a layer and deleted again, or written outside the paths it checks, is
# only visible here. The base is scanned by its own workflow.
# Streams `docker save` twice instead of writing the ~8 GB tar to disk.
# Exit 0 = clean; 1 = a finding or an unexpected layer count; 2 = usage error.
if [ "$#" -ne 2 ] || [ -z "$1" ] || [ ! -x "$2" ]; then
  echo "usage: $0 IMAGE GITLEAKS_BIN" >&2
  exit 2
fi
image="$1"
gitleaks="$2"
work="$(mktemp -d)"
trap 'chmod -R u+rwX "$work" 2>/dev/null; rm -r "$work"' EXIT

base="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.base.name"}}')"
base_layers="$(docker image inspect "$base" --format '{{len .RootFS.Layers}}')"
docker save "$image" | tar -xf - -C "$work" manifest.json
total="$(jq '.[0].Layers | length' "$work/manifest.json")"
added=$((total - base_layers))
# The Dockerfile has three COPY layers; a handful is fine, a base-sized
# number means the base was not recognised and the scan would be meaningless.
if [ "$added" -lt 1 ] || [ "$added" -gt 10 ]; then
  echo "scan-layers: $added layers above the base ($total total, base $base_layers)" >&2
  exit 1
fi
mapfile -t layers < <(jq -r --argjson n "$base_layers" '.[0].Layers[$n:][]' "$work/manifest.json")
config="$(jq -r '.[0].Config' "$work/manifest.json")"
docker save "$image" | tar -xf - -C "$work" "$config" "${layers[@]}"

scan="$work/scan"
mkdir -p "$scan/config"
cp "$work/$config" "$scan/config/image-config.json"
i=0
for layer in "${layers[@]}"; do
  mkdir -p "$scan/layer-$i"
  tar -xf "$work/$layer" -C "$scan/layer-$i" --no-same-owner --no-same-permissions
  i=$((i + 1))
done
"$gitleaks" dir --redact --no-banner "$scan"
echo "scan-layers: config and $added layer(s) above the base are clean"
