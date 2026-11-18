#!/usr/bin/env bash
# Apply, preview or delete the `main` ruleset kept in deploy/github/ruleset-main.json (#697).
#
#   deploy/github/apply-ruleset.sh --dry-run   # read-only: prints what it would do and the payload
#   deploy/github/apply-ruleset.sh             # creates the ruleset, or updates the one with its name
#   deploy/github/apply-ruleset.sh --delete    # rollback: deletes the ruleset with its name
#
# Options: --repo OWNER/REPO (default be-automata/automata), --file PATH.
# Writes need a `gh` login with admin on the repo; the acting login is printed
# first. The dry run only lists the repo's rulesets (GET) and changes nothing.
# Order and break-glass: docs/runbooks/agent-github-app.md.
set -euo pipefail

die() {
  printf 'apply-ruleset: %s\n' "$*" >&2
  exit 2
}

repo="be-automata/automata"
file="$(cd "$(dirname "$0")" && pwd)/ruleset-main.json"
action=apply
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --delete) action=delete ;;
    --repo)
      [[ $# -ge 2 ]] || die "--repo needs OWNER/REPO"
      repo=$2
      shift
      ;;
    --file)
      [[ $# -ge 2 ]] || die "--file needs a path"
      file=$2
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be OWNER/REPO, got: $repo"
[[ -r $file ]] || die "cannot read $file"
name=$(jq -er '.name | select(type == "string" and length > 0)' "$file") ||
  die "$file is not JSON with a non-empty .name"

existing_id=""
if listing=$(gh api "repos/$repo/rulesets?includes_parents=false" 2>/dev/null); then
  existing_id=$(printf '%s' "$listing" | jq -r --arg n "$name" '[.[] | select(.name == $n) | .id][0] // empty')
elif [[ $dry_run == false ]]; then
  die "cannot list rulesets of $repo (gh auth? admin on the repo?)"
else
  printf 'note: could not list rulesets of %s; the plan assumes none exists\n' "$repo"
fi

if [[ $action == delete ]]; then
  if [[ -z $existing_id ]]; then
    printf 'no ruleset named "%s" on %s: nothing to delete\n' "$name" "$repo"
    exit 0
  fi
  method=DELETE
  endpoint="repos/$repo/rulesets/$existing_id"
elif [[ -n $existing_id ]]; then
  method=PUT
  endpoint="repos/$repo/rulesets/$existing_id"
else
  method=POST
  endpoint="repos/$repo/rulesets"
fi

if [[ $dry_run == true ]]; then
  printf 'dry run: would %s %s (ruleset "%s")\n' "$method" "$endpoint" "$name"
  if [[ $method != DELETE ]]; then
    jq . "$file"
  fi
  exit 0
fi

login=$(gh api user --jq .login) || die "no gh login"
printf 'acting as %s: %s %s (ruleset "%s")\n' "$login" "$method" "$endpoint" "$name" >&2
if [[ $method == DELETE ]]; then
  gh api --method DELETE "$endpoint" >/dev/null
  printf 'deleted ruleset %s from %s\n' "$existing_id" "$repo"
else
  gh api --method "$method" "$endpoint" --input "$file" --jq '"ruleset \(.id) on \(.source): \(.enforcement)"'
fi
