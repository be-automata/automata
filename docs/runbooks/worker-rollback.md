# Worker Deploy Rollback Runbook

_Last updated: 2026-04-10_

To roll back a bad `automata-www` Worker deploy:

1. List recent versions: `wrangler deployments list`.
2. Roll back to the previous version: `wrangler rollback`.
3. Verify: the probe `curl -s -o /dev/null -w "%{http_code}" <url>/api/review-settings` returns `401` and the site root returns `200`.
4. If the rollback does not resolve the incident, page the on-call engineer and open an incident channel.

## Post-deploy canary (added 2026-07-25)

After every deploy, run the canary before declaring success:

1. Confirm the new version id: `wrangler deployments list | head`.
2. Hit five health endpoints and assert 200/401 as documented above.
3. Watch the error rate in the dashboard for 10 minutes; if it climbs, roll back immediately per the steps above.
4. Record the deployed version id and canary result in the deploy log.