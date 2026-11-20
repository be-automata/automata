# #709 — the OpenSandbox conformance evidence: runbook, weekly renewal, expiry alert

Ticket: be-automata/automata#709 (parent #634). Saved verbatim in `docs/specs/709/ticket.md`.
Decisions (owner, 2026-11-19): **OD-1** the alert is a GitHub issue labelled `cell-evidence`, one
open at a time, like `synthetic-failure`; **OD-2** weekly cadence.

## Why

`cell-plan` refuses every cell with `egress_not_enforced` unless `opensandbox/runc` has unexpired
`conformance` evidence (30 days, from an `OPENSANDBOX_IT` run pushed by `push-evidence.sh`). Nothing
documents the push before cells are turned on, nothing renews it, and nothing opens an issue before
it lapses. The evidence pushed on 2026-11-19 expires **2026-12-19**.

## Ground truth (verified in this worktree, `main` = `34c43ad8`, 2026-11-19)

| Claim                                                                                                                                                                                                                                                                                          | Where                                                                                                                                       | State                       |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------- |
| Guard: refuses unless `evidence.source == conformance` and `expires_at > now`; reasons `evidence_missing`, `evidence_not_from_conformance`, `evidence_invalid`, `evidence_expired`, plus the egress/allowlist ones                                                                             | `packages/shared/src/model/cell-egress-guard.ts:13-24,52-102`                                                                               | exists                      |
| `cell-plan` reads the profile row + `getCurrentProfileEvidence`, folds with `profileRecordForPolicy`, runs the guard; `!profileRow` → `unknown_profile`; a guard throw → `refuse("egress_not_enforced", 409, {reason})`, which logs `[daemon cell-plan] {threadId, stepKey, attempt, outcome}` | `apps/www/src/app/api/daemon/cell-plan/route.ts:106-127,141-161`                                                                            | exists                      |
| `profileRecordForPolicy`: evidence summary = EARLIEST `expires_at` of the current rows; source `conformance` only when every row is                                                                                                                                                            | `packages/shared/src/model/execution-profiles.ts:103-135`                                                                                   | exists                      |
| `opensandboxConfigured()` (URL + key set, Access pair complete over https) and `OPENSANDBOX_RUNC_PROFILE_ID`                                                                                                                                                                                   | `apps/www/src/server-lib/compute/cell-gate.ts:14,70-72`                                                                                     | exists                      |
| Ingest route: `PROFILE_EVIDENCE_SECRET` header auth, `measured_at` within 24 h past / 5 min future, `unknown_profile` 409 when the row is missing, returns `{recorded, rows, expiresAt}`                                                                                                       | `apps/www/src/app/api/internal/profile-evidence/opensandbox/route.ts:41-43,77-84,106-110,137-148`                                           | exists                      |
| The profile row is seeded by a migration                                                                                                                                                                                                                                                       | `deploy/migrations/2026-11-17-execution-profile-seed-opensandbox-runc.sql:16`                                                               | exists                      |
| Push script: reads `$OPENSANDBOX_IT_STATE/opensandbox-runc-conformance.json`, refuses `-dirty`, secret from env to curl on stdin, prints the JSON reply                                                                                                                                        | `packages/sandbox/opensandbox-it/push-evidence.sh`                                                                                          | exists                      |
| The IT writes that file (0600) only on a full pass; `platformSha` = `git rev-parse HEAD`, `-dirty` when `git status --porcelain` is non-empty; `up.sh` runs a privileged `osbit-dind` on the host's default Docker, label `osbit=1`, state in `$OPENSANDBOX_IT_STATE`                          | `packages/sandbox/src/providers/opensandbox-cell.integration.test.ts:68,83-94,1081-1131`; `packages/sandbox/opensandbox-it/up.sh:8-9,27-29` | exists                      |
| Cell tag the adapter sets and the reconciler lists by: metadata `automata=cell`; the server answers `GET /sandboxes?metadata=automata%3Dcell` with `{"total":N,...}` (#656 UAT comment: `{"total":0}` after teardown)                                                                          | `packages/sandbox/src/providers/opensandbox-cell.test.ts:155`; README `:1243`                                                               | exists                      |
| The OpenSandbox server: `127.0.0.1:8090`, key in `/etc/automata/opensandbox.env` (`OPENSANDBOX_API_KEY=<hex>`), header `OPEN-SANDBOX-API-KEY` via a 0600 header file                                                                                                                           | `packages/worker/deploy/linux/install-opensandbox.sh:39-52,207-217`                                                                         | exists                      |
| `/etc/automata/profile-evidence.env` (`AUTOMATA_WWW_URL`, `PROFILE_EVIDENCE_SECRET`), root 0600, installed by hand                                                                                                                                                                             | `packages/worker/deploy/README.md:666-690`                                                                                                  | documented                  |
| Precedent unit pair + script: `automata-box-evidence.{service,timer}` (oneshot, no `Restart=`, weekly Sun 04:00 UTC, `RandomizedDelaySec=1800`, `Persistent=true`), `box-evidence-probes.sh --dry-run`, `git -c safe.directory` because systemd gives root no HOME                             | `packages/worker/deploy/linux/automata-box-evidence.*`, `box-evidence-probes.sh:65-69`                                                      | exists                      |
| Bash hygiene test: `#!/bin/bash`, line 2 `set -euo pipefail`, mode 100755, `bash -n`, shellcheck clean                                                                                                                                                                                         | `packages/worker/src/agent-run/deploy-assets.test.ts:276-336`                                                                               | exists                      |
| The daily ops-alert expiry check over ALL profiles (webhook `OPS_ALERT_WEBHOOK_URL`, 13:00 UTC, 7 days); its text says "Renew with the box probes", wrong for `opensandbox/runc`                                                                                                               | `apps/www/src/server-lib/compute/profile-evidence-expiry.ts:19-20,53-65`; `cron.ts:409-413,537-561`                                         | exists (not a GitHub issue) |
| `synthetic.yml` opens one `synthetic-failure` issue, comments while open, closes on recovery; uses `vars.SMOKE_BASE_URL`, `github.token` with `issues: write`                                                                                                                                  | `.github/workflows/synthetic.yml`                                                                                                           | exists                      |
| A GitHub secret that can read the prod DB from a scheduled workflow: only `PROD_DATABASE_URL` on the `production` environment, scoped to `migrate.yml`'s migrate steps (AGENTS.md: "scoped to the migrate steps only")                                                                         | `.github/workflows/migrate.yml:65-111`                                                                                                      | exists, **not for reuse**   |
| A cell-evidence status endpoint, a `cell-evidence` workflow job, a cell-evidence timer/script, a README evidence step                                                                                                                                                                          | grep `cell-evidence`, `cell evidence`                                                                                                       | **none**                    |
| `docs/specs` is committed in this repo                                                                                                                                                                                                                                                         | `git ls-files docs/specs`                                                                                                                   | yes                         |

## Alert mechanism (decision)

A scheduled workflow cannot read the database without `PROD_DATABASE_URL`, whose scope must stay the
migrate steps. www cannot open issues in the platform repo without new GitHub App configuration. So:

1. **www computes the status** (pure classification over the same inputs `cell-plan` uses), and
   - the hourly cron logs it every tick: `console.error("[cron:cell-evidence] ...")` when it is
     `expiring` or `refused`, `console.log` with `ok` otherwise (nothing when unconfigured);
   - a **public, read-only** `GET /api/health/cell-evidence` returns
     `{status, reason?, expiresAt?, daysLeft?}`, `Cache-Control: no-store`, no secret, no ids
     other than the profile id. The facts it shows (cells on, the expiry date) are already public
     in this repository's issues.
2. **`synthetic.yml` gets a second job, `cell-evidence`** (schedule and dispatch only), which reads
   that endpoint at `vars.SMOKE_BASE_URL` and opens one `cell-evidence` issue when the status is
   `expiring` or `refused` and none is open (no comment spam: an open issue is left alone), and
   comments "Recovered" and closes it on `ok`. `unconfigured` touches nothing. A non-200 or a body
   without `status` fails the job (the smoke job already reports www being down).

No new secret anywhere. The existing ops-alert check stays; its hint names both renewal paths.

## Status classification (pure, unit-tested)

`classifyCellEvidence({ configured, profile, now })` in
`apps/www/src/server-lib/compute/cell-evidence-status.ts`:

- `configured === false` → `{ status: "unconfigured" }`;
- `profile === null` (no row) → `{ status: "refused", reason: "unknown_profile", expiresAt: null }`;
- `assertCellEgressEnforced({profile, now})` throws `CellEgressNotEnforcedError` →
  `{ status: "refused", reason: error.reason, expiresAt: profile.evidence?.expires_at ?? null }`
  (so expired evidence is `refused / evidence_expired`, exactly what `cell-plan` refuses with);
- passes and `expires_at - now < 7 days` → `{ status: "expiring", expiresAt, daysLeft }`;
- else `{ status: "ok", expiresAt, daysLeft }`. `daysLeft` = floor of whole days remaining.

`readCellEvidenceStatus({ db, now, configured })` does the two reads `cell-plan` does
(`getExecutionProfile`, `getCurrentProfileEvidence`), folds with `profileRecordForPolicy` and
classifies; it skips the reads when unconfigured. `cellEvidenceNeedsAttention(s)` is true for
`expiring` and `refused`. The cron line and the issue body name the refusal
`egress_not_enforced` and the log line to count (`[daemon cell-plan] outcome egress_not_enforced`).

## Box renewal

`packages/worker/deploy/linux/opensandbox-evidence-renew.sh [--dry-run]`, root, run by
`automata-cell-evidence.service` (oneshot, no `Restart=`, `StateDirectory=automata-cell-evidence`
mode 0700, `TimeoutStartSec=2400`, `Nice=10`, journal, `SyslogIdentifier=automata-cell-evidence`)
from `automata-cell-evidence.timer` (`OnCalendar=Wed *-*-* 04:00:00 UTC`, `RandomizedDelaySec=1800`,
`Persistent=true`; Wednesday so it never overlaps the Sunday box-evidence run).

Order:

1. root, `flock -n` on `/run/automata-cell-evidence.lock` (a second run logs `skip` and exits 0);
2. config: read `AUTOMATA_WWW_URL` (must be `https://`) and `PROFILE_EVIDENCE_SECRET` (non-empty)
   with `grep`, never `source`, never echo;
3. preflight: the checkout at `/opt/automata-platform` is clean (`git -c safe.directory=…
status --porcelain` empty; a dirty tree is refused by the ingest anyway); the host Docker answers;
4. **idle check**: `GET http://127.0.0.1:8090/sandboxes?metadata=automata%3Dcell` with the key from
   `/etc/automata/opensandbox.env` as a 0600 header file; `total > 0` → log
   `skip: N cell(s) live` and exit 0; an unreachable server or an unparsable reply fails. Also skip
   when an `osbit=1` container exists on the host Docker (a hand-run IT; `up.sh` would remove it);
5. `--dry-run`: print the plan (the IT command, the push target host) and exit 0, change nothing;
6. remove a stale evidence file, run
   `OPENSANDBOX_IT=1 OPENSANDBOX_IT_STATE=$STATE_DIRECTORY pnpm --filter @terragon/sandbox exec
vitest run --no-cache --no-file-parallelism src/providers/opensandbox-cell.integration.test.ts`
   in the checkout under `timeout 1800`, `GIT_CONFIG_COUNT/KEY_0/VALUE_0` = `safe.directory` for
   the IT's own git calls; its output goes to `$STATE/last-it.log` (0600), never the journal; then
   chown any root-owned file the run left under `packages/sandbox` back to the checkout owner;
7. fail when the evidence file is missing; else run `push-evidence.sh "$www"` with the secret in
   its environment only; parse the reply with `jq`; log `renewed: rows=N expiresAt=…`; on a
   refusal log only the reply's `error`/`reason` enum and exit 1.

The journal sees only fixed lines, counts, the host, `expiresAt` and enums. Never a secret, never
the IT output.

**Installed by** `install-opensandbox.sh` (the provisioning path that already owns every
OpenSandbox unit): it installs both units with its `install_changed`, `daemon-reload`, and
`enable --now` the timer when `/etc/automata/profile-evidence.env` exists (else one warning line
and the timer stays disabled). `--check` adds `cell-evidence-units` (files match the repo) and
`cell-evidence-timer` (enabled) lines; either failing fails the check.

## Runbook

`packages/worker/deploy/README.md`, "OpenSandbox cells": a new **step 8 "Conformance evidence
(before `OPENSANDBOX_URL`)"** with the one-off push, the renewal rule (re-run within 30 days; push
within 24 h of the run) and the timer; the www-secrets step becomes 9 and Worker 10; the
cross-references ("step 8", "step 7") are updated. Rollback gains "disable the timer". The
box-evidence section's alert sentence names the GitHub issue too.

## Files

1. `apps/www/src/server-lib/compute/cell-evidence-status.ts` (new)
2. `apps/www/src/server-lib/compute/cell-evidence-status.test.ts` (new, pure unit tests)
3. `apps/www/src/app/api/health/cell-evidence/route.ts` (new)
4. `apps/www/src/server-lib/cron.ts` (the hourly cell check), `cron.test.ts` if it pins the chain
5. `apps/www/src/server-lib/compute/profile-evidence-expiry.ts` (the hint text)
6. `.github/workflows/synthetic.yml` (the `cell-evidence` job)
7. `packages/worker/deploy/linux/opensandbox-evidence-renew.sh` (new, 0755)
8. `packages/worker/deploy/linux/automata-cell-evidence.service`, `.timer` (new)
9. `packages/worker/deploy/linux/install-opensandbox.sh`
10. `packages/worker/src/agent-run/deploy-assets.test.ts` (hygiene + unit/timer/installer assertions)
11. `packages/worker/deploy/README.md`
12. `docs/specs/709/*` (spec, ticket, gate log, acceptance matrix)

## Acceptance criteria → proof

1. README step before `OPENSANDBOX_URL` + renewal rule → the README diff; a deploy-assets test pins
   the step order (evidence heading before the `OPENSANDBOX_URL` line).
2. Timer runs on the box and `expires_at` moves forward → **post-merge** (box install + first run,
   main session); pre-merge: unit/timer/script tests and the dry run on this machine.
3. Skip and log when a cell is live → the script's idle branch; a local run with a stub server
   answering `{"total":1}` prints `skip` and exits 0 (gate log).
4. Alert fires once while one is open; not on fresh evidence → unit tests of the classification
   (fresh / within 7 days / expired / unconfigured); the workflow job exercised locally with a
   fake `gh` (gate log); `actionlint` clean.
5. No secret in the journal or the alert → a deploy-assets test: every printed string of the
   script carries no `$secret`/`$key` expansion; the endpoint returns only the status fields; the
   issue body is built from the status JSON only.

## Tests

- `pnpm --filter @terragon/www exec vitest run src/server-lib/compute/cell-evidence-status.test.ts`
  (pure; no DB), plus the existing `profile-evidence-expiry` and `cron` tests.
- `pnpm --filter @terragon/worker exec vitest run src/agent-run/deploy-assets.test.ts`.
- `bash -n`, `shellcheck`, `actionlint`.

## Out of scope

Tightening IT verdicts (#654); Kata profiles; changing the ops-alert channel; installing on the box.

## Validator round 1 (PASS_WITH_WARNINGS) and what changed

These override the sections above where they differ.

- **Idle check reads the adapter's page shape, not `total`.** `GET /sandboxes?metadata=automata%3Dcell&page=1&pageSize=100`;
  count `items[]` whose `metadata.automata == "cell"` (the adapter re-checks the same way,
  `packages/sandbox/src/providers/opensandbox-cell.ts:609-657`). A non-array `items`, or zero
  matches with `pagination.hasNextPage == true`, fails closed. The `{"total":N}` claim above came
  from a #656 comment only.
- **Overridable paths** for a hand run and the pre-merge test: `CELL_EVIDENCE_CONFIG`,
  `_OSB_KEY_FILE`, `_OSB_URL`, `_PLATFORM`, `_LOCK`, `_IT_TIMEOUT_S`, `_MIN_FREE_GB`;
  `STATE_DIRECTORY` defaults to `/var/lib/automata-cell-evidence`. The behavioural run is a
  throwaway Linux container (Docker on the dev machine, root inside, stub OpenSandbox server,
  stub host `docker`, stub `pnpm` as the IT, stub `push-evidence.sh`); the dev Mac has no `flock`.
- **Concurrency:** the `cell-evidence` job has its own `concurrency` group, so an overlapping
  dispatch cannot open a second issue.
- **`GIT_OPTIONAL_LOCKS=0`** for every git call (the preflight and the IT's own), so root never
  rewrites the automata-owned `.git/index`. `CI=1`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` and
  `HOME=$STATE` for the IT.
- **Disk preflight:** fail under `CELL_EVIDENCE_MIN_FREE_GB` (default 10) free in the host
  Docker root.
- **Teardown:** `down.sh` always runs after the IT (a timed-out run can skip its own `afterAll`;
  a leftover `osbit=1` container would make every later run skip).
- **Endpoint memo:** the public route memoises the status for 60 s per isolate.
- **One window constant:** `EVIDENCE_ALERT_WINDOW_DAYS` (7) is reused, not redefined.
- **Wording:** the cron line and the issue name `unknown_profile` for the missing-row case.
- **Cross-reference:** `packages/env/src/apps-www.ts:119` "steps 3-8" becomes "steps 3-9".
- Line ref fix: the header-file read is `install-opensandbox.sh:221-228`.
- Readings stated on purpose: "newest evidence expires" is read as the EARLIEST `expires_at` among
  the newest row per capability (what `cell-plan` enforces); "while `OPENSANDBOX_URL` is set" is
  read as `opensandboxConfigured()` (a half-set Access pair is cells-off, so no alert). An issue
  left open when cells are turned off stays open until the next `ok`.
- The idle check is point-in-time: a cell can start during the run. The IT runs in its own dind,
  separate from the cell server, so that cell is unaffected; the README says so.
