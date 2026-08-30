#!/usr/bin/env bash
# Ready-to-run: deploy the review-tolerance + draft-PR feature to the pilot www
# and drive the live GitHub-PR UAT. Prereq (operator): apps/www/.env.production.local
# present (full prod build env), OR run your normal deploy and skip step 1.
#
# Usage:
#   REPO=be-automata/automata bash scripts/uat/deploy-and-live-uat.sh [--skip-deploy]
#
# The DB is already migrated (repo_review_settings) and the pilot worker is up,
# so this is just: build+deploy the www, then run the UAT cases.
set -euo pipefail

URL="https://automata-www.dark-water-9247.workers.dev"
REPO="${REPO:-be-automata/automata}"
ENVFILE="apps/www/.env.production.local"

probe() { curl -s -o /dev/null -w "%{http_code}" "$URL/api/review-settings"; }

if [[ "${1:-}" != "--skip-deploy" ]]; then
  if [[ ! -f "$ENVFILE" ]]; then
    echo "ERROR: $ENVFILE missing — cannot build the prod bundle (envsafe requires the full server secret set)."
    echo "Either place it, or re-run with --skip-deploy after deploying via your own pipeline."
    exit 1
  fi
  echo "==> Building OpenNext bundle with the prod env..."
  ( cd apps/www && pnpm exec dotenv -e .env.production.local -- opennextjs-cloudflare build )
  echo "==> Deploying automata-www (runtime secrets already set on the Worker are preserved)..."
  ( cd apps/www && pnpm exec dotenv -e .env.production.local -- opennextjs-cloudflare deploy )
fi

echo "==> Waiting for the deploy to serve the feature (404->401)..."
for i in $(seq 1 20); do
  c=$(probe); echo "  probe: $c"
  [[ "$c" == "401" ]] && { echo "FEATURE LIVE"; break; }
  [[ "$i" == "20" ]] && { echo "ERROR: still $c after wait — deploy did not land. (wrangler rollback reverts if needed.)"; exit 1; }
  sleep 20
done

echo
echo "==> LIVE UAT — execute docs/uat/review-tolerance-and-drafts.md against $REPO."
echo "    Set tolerances (via the migrated DB or the dashboard), open PRs with the"
echo "    described findings, and assert the posted verdict via:"
echo "      gh api repos/$REPO/pulls/<n>/reviews --jq '.[-1].state'"
echo "    Cases: TOL-1 (warning blocks by default), TOL-2 (error tolerance -> COMMENT,"
echo "    no restart), TOL-3 (info -> everything blocks), DRAFT-1 (drafts SKIPPED by"
echo "    default, engage on ready), DRAFT-2 (repo opt-in reviewDraftPrs=true -> engage,"
echo "    then null -> inherit -> skip), DRAFT-3 (org sentinel opt-in, repo override wins)."
echo
echo "Post-run: hand the PR#/SHA/verdict evidence to the production-validator for the"
echo "live-tier sign-off, mirroring docs/triage/UAT-VALIDATION-MATRIX.md."
