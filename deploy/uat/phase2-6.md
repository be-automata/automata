# Phase 2 ticket 6 (#374) — per-org tenant map + engine provisioning: production UAT

- **Box:** `automata-exec-1`. Engine `automata-hatchet-hatchet-lite-1`, hatchet-lite v0.94.10,
  REST and gRPC published on loopback only (`127.0.0.1:8888`, `127.0.0.1:7077`, unchanged by
  the recreate below).
- **Code:** part A shipped in #524 (`b574a6a`); its migration ran in production through
  `migrate.yml` on 2026-10-25 (run for `b574a6a3`, success). Part B (`provision:tenant`) shipped in #536 (`7acb351`).
- **Restart rule:** the worker was drained through `scripts/drain-for-restart.ts` (pause, wait
  until no slot is busy) before the engine was touched, and restarted only after the engine
  answered `/api/ready`. No run was interrupted.

## UAT 3 / AC 6: public registration closed, admin login works — 2026-10-26

The prod overlay has set `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS: beautomata.com` since #377,
but the running container predated it: its environment did not carry the variable, and the
seed admin was still `admin@example.com`. Applied with the README's "Engine dashboard
hygiene" steps 2 and 3:

| Time (UTC) | Step                                                                                                           | Result                                                |
| :--------- | :------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------- |
| 22:02:06   | drain the worker                                                                                               | `drained`, waited 6 ms (no run in flight)             |
| 22:02:43   | rename the seed admin to `ops@beautomata.com`; delete every `UserSession`                                      | 1 user row renamed                                    |
| 22:02:43   | `docker compose -f docker-compose.hatchet.yml -f docker-compose.hatchet.prod.yml up -d --no-deps hatchet-lite` | recreated; `/api/ready` 200 after 4 s                 |
| 22:02:47   | container env                                                                                                  | `SERVER_AUTH_RESTRICTED_EMAIL_DOMAINS=beautomata.com` |
| 22:02:57   | `systemctl restart automata-worker`                                                                            | active, `NRestarts=0`, listening for actions          |

Probes, on loopback:

| Probe                                                                | HTTP    | Expected |
| :------------------------------------------------------------------- | :------ | :------- |
| `POST /api/v1/users/register` with `x@invalid.test`                  | **500** | ≠ 200    |
| `User` rows for `x@invalid.test` afterwards                          | 0       | 0        |
| `POST /api/v1/users/login` as `ops@beautomata.com`, rotated password | **200** | 200      |
| `POST /api/v1/users/login` as `admin@example.com`, same password     | 400     | refused  |

The engine answers an out-of-domain registration with 500, not 4xx; what the criterion asks
is that it is not 200 and no user is created, and both hold. The worker was paused from
22:02:06 to 22:02:57 (51 s); a paused worker takes no new assignment, so a run dispatched in
that window waits in the engine queue rather than failing.

**Pass.**

## UAT 2 / AC 4: `provision:tenant` on the live engine — 2026-10-26

The box was fast-forwarded to `7acb351` (#536) and `pnpm install` ran as root. Run from
`/opt/automata-platform` as root, stdout to a root-only file so the token is never printed:

```
pnpm -s --filter @terragon/worker provision:tenant --name "BeAutomata UAT 374" \
  --slug beautomata-uat-374 --token-name www --expires-in 720h > /root/.automata/tenant-uat-374.json
```

| Time (UTC) | Check                                                       | Result                                              |
| :--------- | :---------------------------------------------------------- | :-------------------------------------------------- |
| 23:47:00   | exit code                                                   | 0; stderr `tenant a76d9a6e-… created; minting`      |
| 23:47:00   | output file                                                 | `-rw------- root root`, one JSON line               |
| 23:47:00   | `Tenant` rows                                               | `internal`, `default`, `beautomata-uat-374`, all V1 |
| 23:47:00   | token `exp`                                                 | 2026-11-25T23:47:00Z (720 h)                        |
| 23:47:01   | new token, windowed read of **its own** tenant              | **200**, 0 rows                                     |
| 23:47:01   | new token, windowed read of the default tenant `707d0855-…` | **403**                                             |
| 08:09:53   | the box's default-tenant token, read of the new tenant      | **403**                                             |

The tenant id is `a76d9a6e-7cbd-46a8-a821-0f8c24586427`. **Pass.**

## UAT 2 / AC 7 (epic AC 11): two orgs, two tenants — 2026-10-27, deferred to #375

`be-automata/self-heal-bench-3` (onboarded, last PR 10-14) was bound to the new tenant with a
repo row (`deploy/bind-hatchet-tenant.ts beautomata be-automata/self-heal-bench-3 a76d9a6e-…`),
then a probe PR (self-heal-bench-3#33) was opened.

| Time (UTC) | Step                                    | Result                                                                               |
| :--------- | :-------------------------------------- | :----------------------------------------------------------------------------------- |
| 08:07      | bind                                    | `Bound org 'BeAutomata' … repo 'be-automata/self-heal-bench-3' -> tenant a76d9a6e-…` |
| 08:08:39   | PR opened; webhook delivered            | 200; www created the review thread                                                   |
| 08:08:43   | dispatch                                | thread failed `sandbox-creation-failed`; no `hatchet_run` row; 0 engine requests     |
| 08:12:08   | push to the PR, `wrangler tail` on www  | `dispatch failed after retries … "Decryption failed: Authentication failed"`         |
| 08:13      | binding deleted                         | 1 row deleted, 0 bindings left; the repo is back on the default tenant               |
| 08:14:18   | direct REST trigger into the new tenant | **500** after 10 s (`rawWorkflowRun not populated`), 0 tasks created                 |

Two findings, both blocking a run from ever landing in the new tenant before #375:

1. **The binding's token was encrypted with a key www does not hold.** The resolver decrypts
   per dispatch and failed closed: the thread errored, nothing went to the default tenant and
   nothing reached the engine. The bind tool cannot tell a wrong `ENCRYPTION_MASTER_KEY` from
   the right one.
2. **A tenant with no registered workflows cannot accept a trigger.** Workflows are registered
   by a worker on connect; the new tenant has none until #375 enrolls one. The engine answers
   the trigger with a 500 after a 10 s wait, so "a run queues in the new tenant" is not
   reachable with no worker, whatever the key.

What did hold in production: the repo row routed the dispatch (the failure is the bound
token's decrypt, not the env tenant), a bad binding fails closed rather than falling back,
the delete restored default routing, and every other org's and repo's runs in the window
landed in the default tenant with `hatchet_run.tenant_id` stamped (`707d0855-…`, PR #530).

**Deferred to #375**, whose worker enrollment registers the workflows in the tenant: bind
again with www's own key, then rerun this section unchanged. The tenant and its token stay on
the box (`/root/.automata/tenant-uat-374.json`, expires 2026-11-25) for that run. Both
findings are filed as bind-tool preflights in #538.
