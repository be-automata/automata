#!/usr/bin/env bash
# Mint a short-lived (one hour) installation token for the `automata-pr-agent`
# GitHub App and print ONLY the token, for agent sessions that open PRs (#697):
#
#   GH_TOKEN=$(deploy/github/agent-app-token.sh) gh pr create --repo be-automata/automata ...
#
# Inputs (none of the ids is a secret):
#   AUTOMATA_AGENT_APP_ID, AUTOMATA_AGENT_INSTALLATION_ID, else the APP_ID= and
#   INSTALLATION_ID= lines of ${AUTOMATA_AGENT_CONFIG:-~/.config/automata-pr-agent/app.env}
#   (read line by line, never sourced).
#   The App's private key comes from the macOS keychain:
#     security find-generic-password -s automata-pr-agent-app-key -a automata -w
#   stored base64-encoded on one line (a raw PEM, or the hex that `security -w`
#   prints for a multi-line value, also work). AUTOMATA_AGENT_APP_KEY_FILE
#   replaces the keychain (tests, Linux).
#   AUTOMATA_AGENT_REPO (default automata): the one repository the token is
#   scoped to, with contents/pull_requests/issues write, checks/metadata read.
#   GITHUB_API_URL overrides https://api.github.com.
#
# Flags: --jwt prints the App JWT instead (no network call). -h prints this help.
#
# The key never touches disk or argv: it lives in a shell variable and reaches
# openssl through a file descriptor. The JWT reaches curl on stdin (-H @-).
# Nothing but the token is written to stdout, and neither the token nor the JWT
# is ever written to stderr.
#
# Exit codes: 0 ok, 1 GitHub refused or the key is unusable, 2 usage or config.
# Runbook: docs/runbooks/agent-github-app.md.
set -euo pipefail

readonly KEYCHAIN_SERVICE="automata-pr-agent-app-key"
readonly KEYCHAIN_ACCOUNT="automata"
readonly PERMISSIONS='{"contents":"write","pull_requests":"write","issues":"write","checks":"read","metadata":"read"}'
# base64url('{"alg":"RS256","typ":"JWT"}')
readonly JWT_HEADER="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"

die() {
  local code=$1
  shift
  printf 'agent-app-token: %s\n' "$*" >&2
  exit "$code"
}

mode=token
case "${1:-}" in
  "") ;;
  --jwt) mode=jwt ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *) die 2 "unknown argument: $1 (see --help)" ;;
esac

# Read KEY=value from the config file without sourcing it.
config_value() {
  local wanted=$1 file=$2 key value
  [[ -f $file ]] || return 0
  while IFS='=' read -r key value || [[ -n $key ]]; do
    key=${key//[[:space:]]/}
    if [[ $key == "$wanted" ]]; then
      value=${value%%#*}
      value=${value//[[:space:]\"\']/}
      printf '%s' "$value"
      return 0
    fi
  done <"$file"
}

config_file=${AUTOMATA_AGENT_CONFIG:-$HOME/.config/automata-pr-agent/app.env}
app_id=${AUTOMATA_AGENT_APP_ID:-$(config_value APP_ID "$config_file")}
installation_id=${AUTOMATA_AGENT_INSTALLATION_ID:-$(config_value INSTALLATION_ID "$config_file")}

[[ $app_id =~ ^[0-9]+$ ]] ||
  die 2 "no numeric App id: set AUTOMATA_AGENT_APP_ID or APP_ID= in $config_file"
if [[ $mode == token && ! $installation_id =~ ^[0-9]+$ ]]; then
  die 2 "no numeric installation id: set AUTOMATA_AGENT_INSTALLATION_ID or INSTALLATION_ID= in $config_file"
fi

if [[ -n ${AUTOMATA_AGENT_APP_KEY_FILE:-} ]]; then
  [[ -r $AUTOMATA_AGENT_APP_KEY_FILE ]] || die 2 "AUTOMATA_AGENT_APP_KEY_FILE is not readable"
  raw_key=$(<"$AUTOMATA_AGENT_APP_KEY_FILE")
else
  command -v security >/dev/null 2>&1 ||
    die 2 "no 'security' command (not macOS?): set AUTOMATA_AGENT_APP_KEY_FILE"
  raw_key=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null) ||
    die 2 "no keychain item: service $KEYCHAIN_SERVICE, account $KEYCHAIN_ACCOUNT (runbook step 2)"
fi
# The PEM, from any of the three stored forms.
compact=${raw_key//[[:space:]]/}
if [[ $raw_key == -----BEGIN* ]]; then
  key=$raw_key
elif [[ $compact =~ ^[0-9a-fA-F]+$ ]]; then
  key=$(printf '%s' "$compact" | xxd -r -p) || die 1 "the stored key is not valid hex"
else
  key=$(printf '%s' "$compact" | openssl base64 -d -A) || die 1 "the stored key is not valid base64"
fi
unset compact
[[ $key == -----BEGIN*PRIVATE\ KEY-----* ]] || die 1 "the stored value does not decode to a PEM private key"
[[ $key == *-----END*PRIVATE\ KEY-----* ]] ||
  die 1 "the stored key has no END line: the keychain item is truncated (runbook section 2)"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

now=$(date +%s)
header=$JWT_HEADER
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$app_id" | b64url)
signature=$(printf '%s.%s' "$header" "$payload" |
  openssl dgst -sha256 -binary -sign <(printf '%s\n' "$key") | b64url) ||
  die 1 "openssl could not sign with the stored key"
[[ -n $signature ]] || die 1 "openssl produced an empty signature"
jwt="$header.$payload.$signature"
unset key raw_key

if [[ $mode == jwt ]]; then
  printf '%s\n' "$jwt"
  exit 0
fi

repo_name=${AUTOMATA_AGENT_REPO:-automata}
[[ $repo_name =~ ^[A-Za-z0-9_.-]+$ ]] || die 2 "AUTOMATA_AGENT_REPO must be a repository name"
request=$(jq -cn --arg repo "$repo_name" --argjson perms "$PERMISSIONS" \
  '{repositories: [$repo], permissions: $perms}')
api=${GITHUB_API_URL:-https://api.github.com}
status=0
response=$(printf 'Authorization: Bearer %s\n' "$jwt" | curl --silent --show-error --fail-with-body \
  --request POST \
  --header @- \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --data "$request" \
  "$api/app/installations/$installation_id/access_tokens") || status=$?
unset jwt

token=$(printf '%s' "$response" | jq -r '.token // empty' 2>/dev/null || true)
if [[ $status -ne 0 || -z $token ]]; then
  message=$(printf '%s' "$response" | jq -r '.message // empty' 2>/dev/null || true)
  die 1 "GitHub refused the token request (curl exit $status): ${message:-no message}"
fi
# Refuse a token GitHub widened beyond the one repository and the permissions asked for.
printf '%s' "$response" | jq -e --arg repo "$repo_name" --argjson perms "$PERMISSIONS" '
  .repository_selection == "selected"
  and ([.repositories[]?.name | ascii_downcase] == [$repo | ascii_downcase])
  and ((.permissions // {}) | to_entries
       | all(.value as $got | $perms[.key] as $asked
             | $asked != null and ($got == "read" or $got == $asked)))' >/dev/null ||
  die 1 "GitHub minted a token wider than one repository ($repo_name) and the requested permissions; not using it"
printf '%s\n' "$token"
