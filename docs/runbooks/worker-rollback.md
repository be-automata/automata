# Worker Deploy Rollback Runbook

_Last updated: 2026-04-10_

To roll back a bad `automata-www` Worker deploy:

1. List recent versions: `wrangler deployments list`.
2. Roll back to the previous version: `wrangler rollback`.
3. Verify: the probe `curl -s -o /dev/null -w "%{http_code}" <url>/api/review-settings` returns `401` and the site root returns `200`.
4. If the rollback does not resolve the incident, page the on-call engineer and open an incident channel.