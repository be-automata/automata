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
# The base's layer count comes from the registry: BuildKit does not register
# the FROM image in the local store, and nothing is downloaded here.
base_layer_count() {
  local ref="$1" raw digest
  raw="$(docker buildx imagetools inspect --raw "$ref")"
  if jq -e '.manifests' <<<"$raw" >/dev/null; then
    digest="$(jq -r '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest // empty' <<<"$raw")"
    if [ -z "$digest" ]; then
      echo "scan-layers: no linux/amd64 manifest for the base" >&2
      return 1
    fi
    raw="$(docker buildx imagetools inspect --raw "${ref%@*}@$digest")"
  fi
  jq -e '.layers | length' <<<"$raw"
}
base_layers="$(base_layer_count "$base")"
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
"$gitleaks" dir --redact --no-banner --config "$(dirname "$0")/gitleaks-layers.toml" "$scan"
echo "scan-layers: config and $added layer(s) above the base are clean"
