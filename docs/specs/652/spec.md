# #652 spec: exactly-once control-plane effects (record the output, then the effect, reconcile by marker)

## Ticket

Mission spine slice 1 for #650 (a project's weekly KPI reports, run by Automata from one
Automation). Effects that leave Automata, such as a Drive upload or a run summary post, run only on
the control plane and run **exactly once**, even when the worker dies mid-effect. The design was
measured in a local evaluation (VALIDATED, 58/58, SIGKILL at 6 boundaries).

Decisions (2026-11-16, owner + TL, recorded on the issue body):

| #   | Decision                                                      | Outcome                                                                                                                                                          |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD1 | Reuse `cell_effect` or add a new table                        | **New `control_effects` table**, expand-only migration. `cell_effect.step_key` is a NOT NULL FK to `cell_step`, and the control plane has no cell step or bearer |
| OD2 | "Mission" for an Automation run                               | The parent run id, until #614 compiles declared missions (assumption)                                                                                            |
| A   | Scope while #647 (Drive tool via Nango) is blocked on ADR-011 | Ledger + `EffectTarget` + a marker-honouring fake target here; the Drive adapter, the Drive-fixture IT and UAT T1 move to #647                                   |
| B   | Code location                                                 | `packages/shared/src/model/` (assumption)                                                                                                                        |
| C   | Output digest source while #651 (artifacts store) is open     | The caller passes the digest; the ledger stores the digest, never the output (assumption)                                                                        |

## Ground truth (verified against `feat/652-control-effects` @ 2b8409e1 = origin/main, 2026-11-17)

| Claim                                                                                  | Where                                                                                                                                         | Status                                                                                                                                 |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Cell effect idempotency, keyed on a cell step bearer                                   | `packages/shared/src/model/cell-authority.ts` `beginEffect` / `completeEffect` / `releaseEffect`                                              | exists; **not reused**                                                                                                                 |
| `cell_effect` requires a cell step                                                     | `packages/shared/src/db/schema.ts:3371-3376` `cellEffect.stepKey` `.notNull().references(() => cellStep.stepKey, …)`                          | exists                                                                                                                                 |
| Self-heal effect outbox `audit_effects`                                                | `schema.ts:2463-2510`, `packages/shared/src/model/self-heal-outbox.ts:25-30,115`                                                              | exists; **not reused**: `run_id` is a NOT NULL FK to `audit_runs`, `action` is a GitHub-action union, lease-based, no marker reconcile |
| Hidden-marker convention in posted bodies                                              | `apps/www/src/server-lib/audit/render-issue.ts:37-50` (`<!-- automata-finding:v1 … -->`)                                                      | exists; the comment-tag marker `<!-- automata:effect <key> -->` follows it                                                             |
| Bounded transaction helper (`SET LOCAL` timeouts)                                      | `packages/shared/src/model/self-heal-tx.ts:47-60`                                                                                             | exists; same pattern used here                                                                                                         |
| A control-plane effect ledger, `control_effects`, `EffectTarget`, exported `effectKey` | grep in `apps/ packages/ deploy/` (`cell-authority.ts:61` has a private, unexported `effectKey` const)                                        | **none**                                                                                                                               |
| Shared model tests run against a throwaway Postgres                                    | `packages/shared/vitest.config.ts` (`globalSetup`, no `testTimeout` → 5 s default); `test-global-setup.ts:61` sets `process.env.DATABASE_URL` | exists                                                                                                                                 |
| `@terragon/env/pkg-shared` falls back to the dev DB via envsafe `devDefault`           | `packages/env/src/pkg-shared.ts:7-10`                                                                                                         | exists; the crash child must not import it                                                                                             |
| Spawning a TS child in tests                                                           | `packages/migrate/src/cli.test.ts:43-67` (`spawn(process.execPath, ["--import", "tsx", …])`)                                                  | exists; reused pattern                                                                                                                 |
| Test helper for an org                                                                 | `packages/shared/src/model/test-helpers.ts:295` `createTestOrg({ db })`                                                                       | exists                                                                                                                                 |
| `.for("update")` and `db.transaction` on both drivers                                  | `cell-authority.ts:281,469`; `packages/shared/src/db/index.ts:18-20,123-127`                                                                  | exists                                                                                                                                 |
| Migration id list checked by tests                                                     | `packages/migrate/src/expected-migrations.ts:5-30`; `files.test.ts:108`, `runner.test.ts:74-76`                                               | exists; must gain the new id                                                                                                           |
| Out-of-order migration files refused                                                   | `packages/migrate/src/runner.ts:309`                                                                                                          | exists → file is `2026-11-18-control-effects.sql` (sorts after `2026-11-17-execution-profile-seed-opensandbox-runc`)                   |
| Schema drift compares constraint and index names                                       | `packages/migrate/src/drift/catalog.ts:110-123`; `deploy/migrations/drift-allowlist.json` is `[]`                                             | exists                                                                                                                                 |
| Coverage tooling                                                                       | `@vitest/coverage-v8` in no package                                                                                                           | **none**; measured out of tree (`pnpm dlx` / scratch), never added                                                                     |

## Contract

1. **Effect key.** `effectKey({ mission, step, effect, outputDigest })` =
   `sha256(mission + "|" + step + "|" + effect + "|" + outputDigest)` as hex, first 16 chars. Each
   part must be non-empty and must not contain `|` (rejects ambiguous joins). Pure function.
2. **Table `control_effects`** (decided column list; `org` follows the repo's `organization_id`
   naming), names exact for the schema-drift job:
   - `key text PRIMARY KEY` (constraint `control_effects_pkey`), `organization_id text NOT NULL`,
     `mission text NOT NULL`, `step text NOT NULL`, `effect text NOT NULL`,
     `output_digest text NOT NULL`, `intent_at timestamp DEFAULT now() NOT NULL`,
     `done_at timestamp` (null = intent only), `reconciled boolean DEFAULT false NOT NULL`.
   - FK `control_effects_organization_id_organization_id_fk` → `organization.id` ON DELETE cascade.
   - Index `control_effects_organization_id_index` on `organization_id`.
   - Migration: `-- migrate:expand`, `CREATE TABLE IF NOT EXISTS`, FK in a `DO $$ … duplicate_object`
     block, `CREATE INDEX IF NOT EXISTS`. No drift-allowlist entry.
   - `effect_intent` = a row with `done_at IS NULL`; `effect_done` = the row with `done_at` set.
3. **`interface EffectTarget<P>`** — injected, never imported by the ledger:
   `apply(key: string, payload: P, signal: AbortSignal): Promise<void>` carries `key` as the target's marker;
   `findByMarker(key: string, signal: AbortSignal): Promise<boolean>` (same deadline).
4. **`runEffect<P>(input: RunEffectInput<P>)`** → `{ key, outcome }` with
   `type RunEffectOutcome = "applied" | "reconciled" | "already_done"`. Input: `db: DB` (never a
   transaction handle: step 1 must commit on its own; `DB` has `$client`, a drizzle tx does not, so
   passing one fails to compile), `target`, `organizationId`, `mission`, `step`, `effect`,
   `outputDigest`, `payload`, optional `lockTimeoutMs` / `targetTimeoutMs` (bounded
   defaults).
   1. Insert the intent (`ON CONFLICT (key) DO NOTHING RETURNING key`) as its own statement, so it
      is committed **before** the effect.
   2. Open a transaction with `SET LOCAL lock_timeout` (pattern of `self-heal-tx.ts`), then
      `SELECT … FOR UPDATE` the row. This serializes concurrent deliveries of one key. The lock is
      held until `apply` returns or throws and is never released mid-effect; a killed holder's lock
      is released when its connection dies. A waiter's lock timeout throws; the intent stays; a
      later delivery reconciles. There is no idle-in-transaction timeout: exactly-once is preferred
      over liveness.
   3. The stored `organization_id` / `mission` / `step` / `effect` / `output_digest` differ from
      the call's → throw `ControlEffectKeyCollisionError` (never apply).
   4. `done_at` set → `already_done` (no target call).
   5. `done_at` null → always `findByMarker(key, signal)`: found → set `done_at`, `reconciled = true` →
      `reconciled`.
   6. Otherwise → `apply(key, payload, signal)` with the `signal = AbortSignal.timeout(targetTimeoutMs)` shared with `findByMarker`
      (default 60 s, a positive integer; the target must honour it), then set `done_at` → `applied`.
      A failing `apply` or `findByMarker` propagates; the intent stays, so the next delivery
      reconciles. Residual risk: a holder partitioned from the database but still reaching its
      target loses its connection (and the lock) while its `apply` may land late. The ledger never
      stores the payload or the output.
5. **Record the output first** is the caller's precondition (C): `outputDigest` names output
   already stored. Documented on `runEffect`; the ledger cannot check it.

## Acceptance criteria (against the fake target; ACs 1–2 rerun against Drive in #647)

1. Kill after `effect_intent`, before the upload, then restart: the file is uploaded exactly once.
2. Kill after the upload, before `effect_done`, then restart: found by marker,
   `effect_done { reconciled: true }` written, nothing uploaded again.
3. Two deliveries of the same output produce one effect (sequential **and** concurrent).
4. A changed output (new digest) produces a new key and a new effect.
5. Negative control: with reconcile disabled — a target whose `findByMarker` always answers
   false — AC 2's crash uploads a second copy, proving the test reaches the window. (No
   production switch disables reconcile.)

## Tests

- **Unit** (`control-effects.test.ts`, DB-backed like `cell-authority.test.ts`): key derivation
  (stable, 16 hex, digest-sensitive, rejects empty and `|`); state machine with an in-memory
  target: applied → already_done; pre-existing intent + marker found → reconciled (row:
  `reconciled = true`, `done_at` set); pre-existing intent + no marker → applied once (covers the
  window between insert and lock); concurrent `Promise.all` of two deliveries → one apply (AC 3);
  new digest → new key and a second apply (AC 4); a key collision throws before any target call; a
  throwing `apply` leaves the intent; a delivery behind a held lock fails within `lockTimeoutMs`.
- **Crash drill** (`control-effects.crash.test.ts`): the driver spawns
  `spawn(process.execPath, ["--import", "tsx", "src/model/__fixtures__/control-effects-crash-child.ts"])`
  with `cwd` = the shared package, env `{ ...process.env, DATABASE_URL }`, a temp directory as the
  **file-backed fake target** (one file per apply holding its marker; durable across SIGKILL), and
  a kill point. The child reads `process.env.DATABASE_URL` directly, throws if unset, and never
  imports `@terragon/env`. Kill points live only in the child's target wrapper (no test seams in
  `runEffect`): `before-apply` (AC 1), `after-apply` (ACs 2 and 5); the child SIGKILLs itself
  (`process.kill(process.pid, "SIGKILL")`). The driver treats `signal === "SIGKILL"` or exit code
  **137** as "killed, redeliver" and spawns a clean delivery. Covers ACs 1, 2 (+ row read-back),
  5, AC 3 sequential (two clean deliveries → one file) and AC 4. Per-test `timeout: 60_000` and a
  timeout on each spawn.

## Phases (from the validator)

1. **Schema and migration:** `packages/shared/src/db/schema.ts`,
   `deploy/migrations/2026-11-18-control-effects.sql`, `packages/migrate/src/expected-migrations.ts`.
   Gates: `node deploy/lint-migrations.ts deploy/migrations`; `pnpm --filter @terragon/migrate exec vitest run --no-file-parallelism`; `pnpm turbo tsc-check`; the CI schema-drift steps locally.
2. **Ledger:** `packages/shared/src/model/control-effects.ts`,
   `packages/shared/src/model/control-effects.test.ts`. Gates: the shared vitest file; `pnpm turbo lint`; `pnpm turbo format-check`.
3. **Crash drill:** `packages/shared/src/model/__fixtures__/control-effects-crash-child.ts`,
   `packages/shared/src/model/control-effects.crash.test.ts`. Gate: the shared vitest file.
4. **Full gates:** `pnpm install --frozen-lockfile --prefer-offline`; `pnpm turbo tsc-check lint format-check`; the shared and migrate vitest suites; `node --test 'deploy/*.test.ts'`; coverage
   of `control-effects.ts`, measured out of tree.

## Out of scope

The Drive `EffectTarget`, Drive fixtures, UAT T1 (#647); wiring a caller (the summary post, the
Automation run); a restart sweep that lists pending intents without a redelivery; `cell_effect`;
`audit_effects`; worker changes (none, so the worker suite is not a gate).

## Risks

- `runEffect` holds a row lock across the target call and never releases it mid-effect. A hung
  holder only delays waiters, who throw at `lock_timeout` and leave the intent for a later
  delivery; `apply` gets an `AbortSignal` after `targetTimeoutMs` and the target must honour it. The
  residual risk is a holder partitioned from the database but still reaching its target: its
  connection may drop while `apply` lands late. Documented on the function.
- Drive's `files.list` search on `appProperties` may be eventually consistent: a `findByMarker`
  false right after an upload would duplicate. #647 measures it.
- `deploy/assert-schema-ready.ts:113-126` requires every declared column: the www and worker deploys
  fail the gate until `migrate.yml` applied the file — the intended order (migration first).
