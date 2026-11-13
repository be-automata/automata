Part of ADR-014, step 5: the Agent37 adapter needs the six remote-cell requirements. This is **L3 PR 1 of 4**: the authority model only. The design is a broker in automata-www plus Postgres. PR: #597.

## Reality check on be-automata/automata@80ce4154

- **No durable broker exists.** The git and gh brokers live in the box worker's heap (`packages/worker/src/agent-run/workflow.ts`, `startGitBroker`/`startGhBroker`). Their bearer is random per run, with no TTL and no attempt identity (`broker-common.ts`).
- **ADR-014 lists six remote-cell requirements** (`docs/adr/ADR-014-third-party-execution-compute.md`, Consequences): a TTL-bounded bearer, sweep revocation, an idempotency key per effect, an attempt fence, an effect budget per step, and a reconciler. None exists in code.
- **No effect budget or attempt fence anywhere in `packages/worker` or `packages/shared`.** The only related ledgers are `audit_effects` (outbox) and `addon_call_delivery` (create-only).
- **Rehome guard:** `rehome-repos-to-org.test.ts` requires every table with `organization_id` to be classified MOVE or EXCLUDE.
- **Migrate tests pin the migration list** (`packages/migrate/src/{runner,cli,files}.test.ts`).
- **Behavioural evidence:** spike 033 (local 65/65; real Agent37 14/14) proved the fence, budget and replay semantics with a file-backed broker.

## Contract

- **Tables** (migration `2026-11-13-cell-broker-authority`, expand-only):
  - `cell_step`: `step_key` pk, org and thread FKs (indexed), `current_attempt`, `step_timeout_ms`, `effect_budget` (null = unlimited), `effects_used`, `revoked_through`, `done_at`.
  - `cell_bearer`: `token_hash` pk (sha256 only), `step_key`, `attempt`, `expires_at`.
  - `cell_effect`: pk (`step_key`, `idempotency_key`), plus `attempt` and `result` jsonb.
- **Functions** in `@terragon/shared/model/cell-authority`:
  - `openStep` takes a monotone lease; an equal attempt is a no-op success. Refusals: `stale_attempt | step_done | conflict | revoked`.
  - `mintBearer` refuses `ttl_exceeds_step_timeout | fenced | unknown_step | step_done | revoked`, and throws `RangeError` on a TTL that is not a positive finite number.
  - `verifyBearer` returns `unknown_bearer | revoked | expired | fenced | step_done`.
  - `revokeAttempt` revokes the attempt and every older one, capped at the current attempt.
  - `beginEffect` returns `go | replay | refused`. It checks the bearer, the key claim and the budget in one transaction under the step lock. A pending claim left by an older attempt is taken over by the current attempt.
  - `completeEffect` and `markStepDone`.
- **No route and no caller.** Nothing in www or the worker calls these yet.

## Acceptance Criteria

- AC1: The lease is monotone. A newer attempt takes it; an equal or older (stale) redelivery never takes it back.
- AC2: `mintBearer` refuses a TTL longer than the step timeout, and a bearer for an attempt that is not current.
- AC3: `verifyBearer` refuses an unknown, revoked, expired or fenced bearer, and any bearer once the step is done.
- AC4: Once a newer attempt holds the lease, a fenced (zombie) attempt cannot begin any effect (spike 033 s4d).
- AC5: A redelivered attempt that repeats a completed key gets the stored result, and no second budget unit is spent (spike 033 s3).
- AC6: With an effect budget of 1, the first new key goes through and every further new key is refused `effect_budget_exhausted` (spike 033 s4b).
- AC7: Two concurrent requests with the same key: exactly one runs, and the other is refused `effect_in_progress`.
- AC8: A key claimed by an attempt that died before completing can be taken over by the current attempt. That attempt can then complete it, the budget is not spent twice, and a later repeat replays its result.
- AC9: Only the current attempt can mark the step done. After that, no bearer can act.
- AC10: `cell_step` is classified for rehome, the migrate tests pin the new migration, and the migration passes lint and schema-drift.

## Tests

- AC1: `cell-authority.test.ts` › "lease is monotone".
- AC2: `cell-authority.test.ts` › "refuses a bearer whose TTL exceeds the step timeout, or for a fenced attempt".
- AC3: `cell-authority.test.ts` › "revoked and expired bearers are refused" and "only the current attempt can finish the step".
- AC4: `cell-authority.test.ts` › "s4d".
- AC5: `cell-authority.test.ts` › "s3".
- AC6: `cell-authority.test.ts` › "s4b".
- AC7: `cell-authority.test.ts` › "two concurrent requests with the same key".
- AC8: `cell-authority.test.ts` › "a pending claim from a dead attempt is taken over".
- AC9: `cell-authority.test.ts` › "only the current attempt can finish the step".
- AC10: `rehome-repos-to-org.test.ts`, `packages/migrate` tests, `node deploy/lint-migrations.ts`, CI schema-drift.

## UAT

| Tier           | What                                                                                                                                              | Who |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :-- |
| T0 local stack | `pnpm -C packages/shared exec vitest run src/model/cell-authority.test.ts` against the throwaway Postgres, and the full shared and migrate suites | dev |
| T1a CI         | schema-drift and the full suites on the PR                                                                                                        | CI  |

---

## Corrections from the validate gate (2026-11-13)

- **Reality check:** "no attempt fence anywhere" was overstated. The worker and www already fence by **run generation**: `activeRunExternalId`, `x-run-external-id`, `decideThreadGeneration`, and the worker's on-disk `run-terminal-ledger.ts`. That fence refuses a stale _run's_ writes to www. The `cell_step` lease added here fences a stale _attempt's_ effects through the broker, and it holds when the cell outlives the worker. They are complementary. The per-run bearer is minted in `workflow.ts`; `broker-common.ts` holds only the timing-safe compare.
- **Contract notes:**
  - `stepKey` is globally unique, and a step is re-opened only by the same org and thread (`conflict` otherwise).
  - Re-opening with the current attempt is a no-op success, and a finished step refuses `step_done`.
  - Expiry uses the database clock.
  - Revocation is recorded on the step (`cell_step.revoked_through`): revoking attempt N revokes N and every older attempt, even ones that never minted a bearer, and a newer attempt is unaffected.
  - `beginEffect` and `markStepDone` resolve the bearer inside their transaction with the step row `FOR UPDATE`, so every check runs against the same locked row, and calls for one step run one at a time.
  - `done_attempt` was dropped (derivable from `current_attempt` once done).
  - A pending claim held by the _current_ attempt is not recoverable within that attempt. A new attempt takes it over, and the reconciler (L3 PR 3) is the backstop.
  - `completeEffect` takes no bearer; the route verifies with `beginEffect` first.
  - Remote-cell steps must get a non-null effect budget, derived from the run type by the broker routes (L3 PR 2). Null is for box steps only.
  - Inputs are validated (`RangeError`).

## Refinement and simplify (2026-11-13)

Applied:

- the bearer check moved under the step lock, removing the verify/transaction race and the test-only hook;
- revocation recorded on the step;
- `openStep` refuses a finished step and a cross-org/thread key;
- an equal attempt re-opens as a no-op;
- input validation and a TTL check before any query;
- `beginEffect` is one linear path;
- `done_attempt` and `cell_bearer.revoked_at` dropped;
- an index on `cell_step.organization_id` for the cascade delete.

Skipped, for a follow-up:

- moving the opaque-token mint/hash helpers, today duplicated in `apps/www/src/server-lib/audit/plan-self-heal-run.ts`, into a shared package. That is outside this diff.
- merging `mintBearer` into a single statement. The gain is marginal.
