#!/usr/bin/env bash
# Push the OpenSandbox runc conformance evidence to a control plane (#634 S4).
#   PROFILE_EVIDENCE_SECRET=... push-evidence.sh <base-url>
# Reads $OPENSANDBOX_IT_STATE/opensandbox-runc-conformance.json (written by the IT
# only when every scenario passed) and POSTs measuredAt, platformSha,
# artifactDigest and checks to <base-url>/api/internal/profile-evidence/opensandbox.
# The secret is read from the environment and reaches curl on stdin as a header,
# never in argv. Prints the JSON reply.
set -euo pipefail

base_url="${1:?usage: push-evidence.sh <base-url>}"
: "${PROFILE_EVIDENCE_SECRET:?PROFILE_EVIDENCE_SECRET must be set}"
state="${OPENSANDBOX_IT_STATE:-${TMPDIR:-/tmp}/osbit}"
file="$state/opensandbox-runc-conformance.json"
header_name="x-automata-profile-evidence-token"

[ -f "$file" ] || { echo "push-evidence: no evidence file at $file" >&2; exit 1; }

platform_sha="$(jq -r '.platformSha' "$file")"
case "$platform_sha" in
  *-dirty) echo "push-evidence: refusing a -dirty platformSha" >&2; exit 1 ;;
esac

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
jq -c '{measuredAt, platformSha, artifactDigest, checks}' "$file" > "$body"

printf '%s: %s\n' "$header_name" "$PROFILE_EVIDENCE_SECRET" | curl -sS --fail-with-body \
  -X POST "${base_url%/}/api/internal/profile-evidence/opensandbox" \
  -H @- \
  -H 'content-type: application/json' \
  --data-binary "@$body"
echo
