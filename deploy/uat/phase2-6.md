# Phase 2 ticket 6 (#374) — per-org tenant map + engine provisioning: production UAT

- **Box:** `automata-exec-1`. Engine `automata-hatchet-hatchet-lite-1`, hatchet-lite v0.94.10,
  REST and gRPC published on loopback only (`127.0.0.1:8888`, `127.0.0.1:7077`, unchanged by
  the recreate below).
- **Code:** part A shipped in #524 (`b574a6a`); its migration ran in production through
  `migrate.yml` on 2026-10-25 (run for `b574a6a3`, success). Part B (`provision:tenant`) is this
  PR.
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

## UAT 2 / AC 4: `provision:tenant` on the live engine

Runs after this PR merges and the box carries it.

## UAT 2 / AC 7 (epic AC 11): two orgs, two tenants

Runs after AC 4: one low-traffic repo bound to the new tenant (repo row, not the org's `'*'`
row, because the new tenant has no worker until #375), a real PR there produces a run in the
new tenant, a PR from another org produces one in the default tenant, and each tenant's
windowed read shows only its own run. The bind runs on the operator's machine, which holds the
prod `DATABASE_URL` and `ENCRYPTION_MASTER_KEY`. The binding is deleted and the queued run
cancelled afterwards.
