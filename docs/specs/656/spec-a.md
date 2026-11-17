# #656 PR-A: the cell step lease and the attempt authority

Ticket: be-automata/automata#656 (S5 of #634). This is "PR-A" of the 7-PR plan. Branch `feat/656-a-lease-authority`, off `main` at `c596e47f`. That commit already holds PR-B (#665), PR-F (#666), PR-G (#669) and #652's control-effects ledger (#664).

It covers:

- Scope items 7 (the liveness read), 10 (the authority primitive the terminal read needs), 11 (the `last_seen_at` lease) and 12 (the server-assigned attempt);
- AC-5 (core: what counts as dead) and the authority half of AC-14;
- decisions R1, R2 and R3 of the decision record.

Out of this PR:

- **PR-C:** `cell-plan` calls `openNextAttempt` and drops `attempt` from its body; the label-safe `stepKey` format; wiring `isDead` into `runCellReconciler`;
- **PR-D:** the terminal read in `thread-status` (it calls `finishStep`) and `stampSeen` on each cell run's `thread-status` read;
- **PR-E:** the worker keeps the lease fresh during setup.

PR-A ships library code and one nullable column. Nothing calls the new functions in production until PR-C, so the deploy changes no behaviour.

## Ground truth (verified in this worktree at `c596e47f`)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                               |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------- |
| `cell_step` columns: `step_key` (PK, text), `organization_id`, `thread_id`, `current_attempt`, `step_timeout_ms`, `effect_budget`, `effects_used`, `allowed_ref`, `revoked_through`, `done_at`, `created_at`, `updated_at`. **No `last_seen_at`, and no other lease or heartbeat column**                                                                                                                                                                                                                                                         | `packages/shared/src/db/schema.ts:3313-3346`                                                        |
| Every `cell_step` timestamp is `timestamp` without a time zone (`mode: "date"`). `updated_at` has a JS-clock `$onUpdate`, so any drizzle `update(cellStep)` also bumps it                                                                                                                                                                                                                                                                                                                                                                         | `schema.ts:3335-3340`; `deploy/migrations/2026-11-13-cell-broker-authority.sql:18-21`               |
| Precedent for a nullable `timestamptz` added by `migrate:expand` with no backfill: `queued_at`, drizzle `timestamp("queued_at", { withTimezone: true })`                                                                                                                                                                                                                                                                                                                                                                                          | `deploy/migrations/2026-10-22-queued-at.sql:14-21`; `schema.ts:369`                                 |
| The last migration on main is `2026-11-18-control-effects.sql`. `2026-11-19-cell-step-last-seen` sorts after it                                                                                                                                                                                                                                                                                                                                                                                                                                   | `deploy/migrations/` listing                                                                        |
| `EXPECTED_MIGRATION_IDS` ends with `"2026-11-18-control-effects"`. The migrate tests derive every count from this list (`N pending`, `applied N`, ledger length)                                                                                                                                                                                                                                                                                                                                                                                  | `packages/migrate/src/expected-migrations.ts:5-32`; `packages/migrate/src/cli.test.ts:98-116`       |
| The migration lint rules are L1 (destructive DDL needs a contract), L2 (NOT NULL without DEFAULT), L3 (an index without CONCURRENTLY), L4, L5 (`ADD COLUMN` without `IF NOT EXISTS`) and L6 (`BEGIN`/`COMMIT`)                                                                                                                                                                                                                                                                                                                                    | `deploy/lint-migrations.ts:14-27`                                                                   |
| `openStep({db, step:{stepKey, organizationId, threadId, attempt, stepTimeoutMs, effectBudget, allowedRef}})` takes a **caller-supplied** attempt. It runs one `INSERT … ON CONFLICT (step_key) DO UPDATE SET current_attempt = <attempt>`, guarded by `current_attempt < attempt`, `done_at IS NULL`, `revoked_through < attempt`, the same org and thread, and `allowed_ref IS NOT DISTINCT FROM`. On an empty RETURNING, a follow-up select classifies the result as `conflict`, `step_done`, `revoked`, re-open no-op `ok`, or `stale_attempt` | `packages/shared/src/model/cell-authority.ts:82-171` (upsert `:114-140`, classification `:143-170`) |
| `openStep` validates `attempt` and `stepTimeoutMs` with `assertPositiveInt`, `effectBudget` (null or a non-negative integer) and `allowedRef` (null or `isBranchRef`)                                                                                                                                                                                                                                                                                                                                                                             | `cell-authority.ts:103-113`                                                                         |
| `mintBearer` refuses `unknown_step`, `step_done`, `revoked`, `fenced` (`currentAttempt !== attempt`) and a TTL above the step timeout                                                                                                                                                                                                                                                                                                                                                                                                             | `cell-authority.ts:178-237`                                                                         |
| `resolveBearer` checks in this order: revoked, expired, fenced, done. With `lock` it takes `FOR UPDATE OF cell_step`                                                                                                                                                                                                                                                                                                                                                                                                                              | `cell-authority.ts:244-298`                                                                         |
| `revokeAttempt` sets `revoked_through = greatest(coalesce(revoked_through,0), least(attempt, current_attempt))`, so it **never revokes a future attempt**                                                                                                                                                                                                                                                                                                                                                                                         | `cell-authority.ts:320-338` (`:333`)                                                                |
| **`markStepDone({db, token})` takes the attempt's bearer token**, not a step key. It resolves the bearer under the row lock and refuses a fenced or revoked one                                                                                                                                                                                                                                                                                                                                                                                   | `cell-authority.ts:480-496`                                                                         |
| The contract note says times use the database clock, never the caller's                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `cell-authority.ts:31`                                                                              |
| **What #664 changed in this file:** it removed the local `assertPositiveInt` (now imported from `../utils`, `packages/shared/src/utils.ts:5`) and nothing else. That shifted every line by −5, so the ticket's `:87`, `:183`, `:306`, `:325` and `:485` are now `:82`, `:178`, `:301`, `:320` and `:480`                                                                                                                                                                                                                                          | `git show 81481dbe -- packages/shared/src/model/cell-authority.ts`                                  |
| **Callers of `openStep`:** production has one, `cell-plan` (`apps/www/src/app/api/daemon/cell-plan/route.ts:136-148`). Tests: `createTestCellStep` (`packages/shared/src/model/test-helpers.ts:408-460`, `openStep` at `:437`), used by the broker tests (`apps/www/src/server-lib/cell-broker/{common,gh,git-push,git-read,real-gh}.test.ts`, plus `real-git.test.ts`), and `cell-authority.test.ts:37`, `:97`, `:116`                                                                                                                           | `git grep openStep`                                                                                 |
| `cell-plan` takes `attempt` from the body (`z.number().int().min(1).max(1000)`), derives `stepKey = "cell:" + apiKeyId`, opens with `stepTimeoutMs: CELL_RUN_TTL_MS`, `effectBudget: null` and `allowedRef: null`, and answers 409 with the refusal reason                                                                                                                                                                                                                                                                                        | `cell-plan/route.ts:51`, `:81`, `:136-149`                                                          |
| `cell-plan`'s tests depend on a caller-chosen attempt (`attempt 2 fences attempt 1 … stale_attempt`) and on the `cell:` prefix                                                                                                                                                                                                                                                                                                                                                                                                                    | `cell-plan/route.test.ts:127-128`, `:204-215`, `:316-318`                                           |
| `CELL_RUN_TTL_MS = 45 min` is already on main (PR-B shipped R6). The ticket's "2 h" is stale                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/types/src/cell.ts:94`                                                                     |
| The reconciler's `isDead?: (keys: CellKey[]) => Promise<Set<string>>` returns `stepKey#attempt` ids (`cellKeyId`) of keys **positively** known dead. A throw is logged and reaps nothing extra. `CellKey = {stepKey, attempt}`                                                                                                                                                                                                                                                                                                                    | `packages/sandbox/src/cell/reconcile.ts:21-23`, `:35-40`, `:58-61`, `:114-128`                      |
| The reconciler lists at most 5 pages of 100 cells, so `isDead` gets at most about 500 keys                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `reconcile.ts:18`, `:146-149`                                                                       |
| `runCellReconciler` passes **no** `isDead`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/www/src/server-lib/compute/cell-control.ts:83-102`                                            |
| `thread-status` takes `{threadId, threadChatId}` only, with **no attempt**. Its terminal branch revokes only the daemon token. It has no cell code                                                                                                                                                                                                                                                                                                                                                                                                | `apps/www/src/app/api/daemon/thread-status/route.ts:10`, `:32-46`, `:73-94`                         |
| The worker polls `thread-status` every 5–10 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `packages/worker/src/agent-run/config.ts:151`                                                       |
| `@terragon/shared` has `@terragon/sandbox` only as a devDependency, so shared code cannot import `cellKeyId` from sandbox. `@terragon/types` is a **regular** dependency of shared, but **only a devDependency of sandbox**                                                                                                                                                                                                                                                                                                                       | `packages/shared/package.json:41-64`; `packages/sandbox/package.json:32-49`                         |
| Drizzle's `sql` template expands a JS array into `($1,$2,…)`, which breaks `= ANY(...)`. The repo uses `inArray`                                                                                                                                                                                                                                                                                                                                                                                                                                  | `packages/shared/src/model/allowed-signups.ts:1`, `:17`                                             |
| `holdLock` in the control-effects tests always **rolls back** (`throw new Rollback()`), so it cannot model a committed fence                                                                                                                                                                                                                                                                                                                                                                                                                      | `control-effects.test.ts:94-120`                                                                    |
| `cell_step` is in the repo re-homing table list. Re-homing is keyed by `thread_id` and `step_key`, so a new column does not affect it                                                                                                                                                                                                                                                                                                                                                                                                             | `packages/shared/src/model/rehome-repos-to-org.ts:76`                                               |
| PR-G live finding: OpenSandbox metadata values must match `[A-Za-z0-9._-]` (at most 63 characters, alphanumeric at both ends), so `cell:<apiKeyId>` gets a 400 on create                                                                                                                                                                                                                                                                                                                                                                          | `docs/specs/656/gate-log-g.md:76`                                                                   |
| The authority treats `stepKey` as opaque text. Its tests use `run-<uuid>/agent` (`cell-authority.test.ts:35`; `test-helpers.ts:435`). **Nothing in the authority assumes the `cell:` prefix**; only `cell-plan` and its test do                                                                                                                                                                                                                                                                                                                   | as cited                                                                                            |
| A test helper that holds a row lock deterministically exists, as a local function: `holdLock`/`deferred`                                                                                                                                                                                                                                                                                                                                                                                                                                          | `packages/shared/src/model/control-effects.test.ts:86-120`                                          |
| Checked and not found: a lease or last-seen column anywhere in `cell_step`; a step-key-based "done" function; any read of attempt liveness (`liveAttempts`, `deadCellAttempts`, `isDead` implementation); `CELL_LEASE_STALE_MS`                                                                                                                                                                                                                                                                                                                   | `git grep`                                                                                          |

## Decisions taken in this spec

1. **`openStep` stays, and `openNextAttempt` is new.** `openStep` has one production caller, which PR-C moves to `openNextAttempt`. Six broker test files reach it through `createTestCellStep`, and they need caller-chosen attempts to set up fences. Rewriting them buys nothing. After PR-C, `openStep` is the fixture and spike primitive, and its doc comment says so. One change to it: when it **advances** to a newer attempt, it sets `last_seen_at = NULL` (see 3).
2. **`last_seen_at` is `timestamptz`,** following the `queued_at` precedent. Every read and write uses the database `now()`, so the column type cannot skew the comparison. `timestamptz` keeps it correct whatever the session's TimeZone is.
3. **`last_seen_at IS NULL` means "no lease to judge", and the attempt is kept.** NULL arises in two ways, and keeping the cell is correct for both:

   - **(a)** a row opened before this migration, or by `www` revisions between the migration and PR-C's deploy (migrate.yml applies the column first). Its worker runs old code that never stamps, so treating NULL as stale would reap live cells during the rollout.
   - **(b)** a step opened or advanced through `openStep`, which does not lease.

   Such a cell is still reaped by the other three rules and by `expiresAt` (45 min). This matches PR-B's contract: "an unknown key is kept".

4. **The stale rule can be switched off.** `deadCellAttempts` takes `staleMs: number | null`, where `null` disables the lease rule. PR-C can wire `isDead` with `null` before PR-D and PR-E stamp the lease. Without this, a cell opened by `openNextAttempt` and never stamped again would be reaped 5 minutes in. That is the most likely ordering bug in the 7-PR plan.
5. **`finishStep({db, stepKey})` is added here, because `markStepDone` cannot serve R1.** R1 has `thread-status` run "`revokeAttempt` and `markStepDone`". But `markStepDone` needs the attempt's bearer, and www stores only its hash (`cell-authority.ts:224-233`). The terminal read is the run's verdict: the thread is no longer working, so every attempt is dead. `finishStep` revokes through the current attempt and sets `done_at` in one statement. It is idempotent.
6. **`CellKey` and `cellKeyId` move to `@terragon/types/cell`.** Both shared and the reconciler then use one definition, with no duplicate structural type. `packages/sandbox/src/cell/reconcile.ts` imports them from there and does not re-export; its test imports from `@terragon/types/cell`. Because `cellKeyId` is a runtime value, `@terragon/types` moves from sandbox's `devDependencies` to `dependencies`. `deadCellAttempts` returns the `Set<string>` of `cellKeyId` ids, so PR-C's `isDead` passes it through.
7. **Attempt cap.** `openNextAttempt` refuses past `CELL_MAX_ATTEMPTS = 1000`, the bound `cell-plan`'s body schema enforces today (`route.ts:51`). A loop of `cell-plan` calls must not grow the integer without bound. With `retries: 0`, a real step sees a handful of attempts.

## Contract

### 1. Migration `deploy/migrations/2026-11-19-cell-step-last-seen.sql`

```sql
-- migrate:expand
--
-- #656 R2: the lease of a cell step's current attempt. Stamped (database now()) when
-- openNextAttempt opens an attempt and by each thread-status read of a cell run (PR-D);
-- the reconciler counts the current attempt dead once it is unseen for 5 minutes.
-- Nullable, no default, no backfill: rows opened before the deploy (or by openStep) keep
-- NULL and are judged by revocation, fence, done and expiresAt only. Apply BEFORE
-- deploying the www revision that writes it (migrate.yml does this on green main CI).
-- Names and types match packages/shared/src/db/schema.ts (cellStep.lastSeenAt).

ALTER TABLE "cell_step" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamptz;

-- Post-migration verification:
--   \d cell_step
--   pnpm exec tsx deploy/assert-schema-ready.ts
```

- The runner owns the transaction (no `BEGIN`), and the defaults (`lock_timeout` 5 s) apply.
- A nullable `ADD COLUMN` with no default is a catalog-only change, so the `ACCESS EXCLUSIVE` lock is held for milliseconds.
- Passes lint: L2 (nullable), L5 (`IF NOT EXISTS`) and L6.

### 2. Schema (`packages/shared/src/db/schema.ts`, in `cellStep` after `doneAt`)

```ts
    /**
     * The lease of the current attempt (#656 R2): database now() when the attempt was
     * opened by openNextAttempt or last seen by thread-status. NULL = no lease (opened
     * by openStep or before the column existed): judged by revocation, fence and done only.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
```

- Add `"2026-11-19-cell-step-last-seen"` as the last entry of `EXPECTED_MIGRATION_IDS`.
- The schema-drift CI job compares the migrated database with a `drizzle-kit push` of `schema.ts`. They agree on `timestamp with time zone`, nullable, no default.
- Never `drizzle-kit push` a migrated database.

### 3. Constants (`packages/types/src/cell.ts`, next to `CELL_RUN_TTL_MS`)

```ts
/** A cell attempt unseen this long is dead (#656 R2): ≥ 30 polls at the worker's 5-10 s cadence. */
export const CELL_LEASE_STALE_MS = 5 * 60 * 1000;
```

`CELL_MAX_ATTEMPTS = 1000` and `DEAD_READ_MAX_KEYS = 1000` stay module-private in `cell-authority.ts`.

Moved here from `packages/sandbox/src/cell/reconcile.ts:20-23` and `:58-61`, unchanged:

```ts
export interface CellKey {
  stepKey: string;
  attempt: number;
}
/** The dead-set key of a cell: `stepKey#attempt`. */
export function cellKeyId(key: CellKey): string {
  return `${key.stepKey}#${key.attempt}`;
}
```

`reconcile.ts` then does `export { cellKeyId, type CellKey } from "@terragon/types/cell";`.

### 4. Authority (`packages/shared/src/model/cell-authority.ts`)

Move the input validation at `:103-113` into a private `assertStepShape(step)` that both open functions call. It keeps the same `RangeError` messages.

**`openStep` (changed by one field).** Its `onConflictDoUpdate` `set` becomes `{ currentAttempt: step.attempt, lastSeenAt: null }`. An advance clears a lease that belonged to the previous attempt, so a stale stamp never condemns the new one. A first insert leaves the column NULL (no lease), and so does a same-attempt re-open (no write). Everything else in `openStep` is unchanged.

#### `openNextAttempt`

```ts
export async function openNextAttempt({
  db,
  step,
}: {
  db: DB;
  step: {
    stepKey: string;
    organizationId: string;
    threadId: string;
    stepTimeoutMs: number;
    effectBudget: number | null;
    allowedRef: string | null;
  };
}): Promise<
  | { ok: true; attempt: number }
  | { ok: false; reason: "step_done" | "conflict" | "attempt_limit" }
>;
```

It is one statement (drizzle `insert … onConflictDoUpdate … returning`), equivalent to:

```sql
INSERT INTO cell_step (step_key, organization_id, thread_id, current_attempt,
                       step_timeout_ms, effect_budget, allowed_ref, last_seen_at)
VALUES ($key, $org, $thread, 1, $timeout, $budget, $ref, now())
ON CONFLICT (step_key) DO UPDATE
   SET current_attempt = cell_step.current_attempt + 1, last_seen_at = now()
 WHERE cell_step.done_at IS NULL
   AND cell_step.organization_id = $org AND cell_step.thread_id = $thread
   AND cell_step.allowed_ref IS NOT DISTINCT FROM $ref
   AND cell_step.current_attempt < 1000
RETURNING current_attempt;
```

**Semantics:**

- **Returned row:** `{ ok: true, attempt: current_attempt }`.
- **Empty RETURNING:** select the row and classify it in this order:
  - a different org, thread or `allowedRef` → `conflict`;
  - `done_at` set → `step_done`;
  - `current_attempt >= 1000` → `attempt_limit`;
  - a missing row is impossible here (the insert would have succeeded), so it throws `Error`.
- **Revocation does not block the next attempt.** `revoked_through` is capped at `current_attempt` (`:333`), so `current_attempt + 1` is never revoked. This is why the terminal read uses `finishStep` and not `revokeAttempt` alone (R1).
- **Fixed at first open:** `stepTimeoutMs` and `effectBudget` are never changed by a later attempt (as with `openStep`). The effect budget stays per step and is shared by the attempts.
- **Fencing the previous attempt** needs no extra write. Its bearers fail `resolveBearer`'s `currentAttempt !== attempt` (`:283`), `mintBearer` refuses it (`:220`), and `stampSeen` matches nothing for it.

**Concurrency** (READ COMMITTED, the pool's default):

- **Two concurrent calls on one key always get distinct, consecutive attempts.** With a row present, the second `ON CONFLICT DO UPDATE` blocks on the row lock, then re-evaluates against the committed version and increments it again. With no row, the second blocks on the speculative insertion into the PK index, then takes the conflict path. N concurrent calls return exactly `{k+1 … k+N}`, and the step ends at `k+N`. The highest one holds the lease; every other one is fenced.
- **Against `finishStep` or `markStepDone`:** these lock the same row.
  - If done commits first, the open re-checks `done_at IS NULL`, matches nothing, and returns `step_done` (N4: a finished run cannot open a new attempt).
  - If the open commits first, done revokes through the new attempt and finishes the step. The new attempt's `mintBearer` then returns `step_done`.
- **Against `beginEffect`** (which holds `FOR UPDATE` for its transaction): the open waits, and the effect completes under the old attempt. It still commits (the at-least-once window already documented at `:349-350`).

#### `stampSeen`

```ts
export async function stampSeen({
  db,
  stepKey,
  attempt,
}: {
  db: DB;
  stepKey: string;
  attempt: number;
}): Promise<boolean>;
```

```sql
UPDATE cell_step SET last_seen_at = now()
 WHERE step_key = $key AND current_attempt = $attempt AND done_at IS NULL
   AND (revoked_through IS NULL OR revoked_through < $attempt)
RETURNING step_key;
```

- **Result:** `true` when the attempt is the current one and is unrevoked and undone; `false` otherwise, including an unknown step. `assertPositiveInt("attempt")`.
- **A fenced, revoked or finished attempt's poll never renews the lease.** `last_seen_at` is one column per step, and only the current attempt can write it, so it is always the current attempt's lease.
- **A stamp racing a fence:**

  - If the stamp commits first, the open then overwrites `last_seen_at` with its own `now()`.
  - If the open commits first, the stamp's `UPDATE` blocks on the row lock, then re-evaluates `current_attempt = $attempt` against the new version, matches nothing, and returns `false`.

  In neither order does a fenced attempt hold a renewed lease.

- **Clock:** `now()` is the statement's transaction start. Both functions run as one autocommit statement, so the value is the statement time. Do not call them inside a long transaction (the #664 `clock_timestamp` lesson).
- **Side effect:** drizzle's `$onUpdate` also bumps `updated_at` (JS clock). That is harmless and documented.

#### `finishStep`

```ts
/** The run is over (the terminal read, #656 R1): every attempt is revoked and the step is done. Idempotent. */
export async function finishStep({
  db,
  stepKey,
}: {
  db: DB;
  stepKey: string;
}): Promise<boolean>;
```

```sql
UPDATE cell_step
   SET revoked_through = greatest(coalesce(revoked_through, 0), current_attempt),
       done_at = coalesce(done_at, now())
 WHERE step_key = $key
RETURNING step_key;
```

- `true` when the step exists. A second call changes nothing but the revision bump and still returns `true`.
- It does not touch the #386 terminal-redelivery guard. That guard lives in the worker and the engine; `finishStep` only makes every later `openNextAttempt` return `step_done`, which is the guard's intent.

#### `deadCellAttempts`

```ts
import type { CellKey } from "@terragon/types/cell";

/**
 * The keys positively known dead, for the reconciler's isDead (#656 scope 7).
 * Unknown steps, NULL leases and attempts above the current one are kept.
 * Throws on a database error (the reconciler catches it and reaps expired only).
 */
export async function deadCellAttempts({
  db,
  keys,
  staleMs,
}: {
  db: DB;
  keys: readonly CellKey[];
  staleMs: number | null;
}): Promise<Set<string>>;
```

- **Input:**
  - an empty `keys` returns `[]` without a query;
  - more than `DEAD_READ_MAX_KEYS = 1000` keys throws `RangeError`. That is an explicit bound, twice the reconciler's 500-key listing cap (`reconcile.ts:18`);
  - `assertPositiveInt` on every attempt;
  - `staleMs` is `null` or a positive finite number, otherwise `RangeError`;
  - step keys are deduplicated.
- **Query:** one `SELECT` by primary key, `where(inArray(cellStep.stepKey, uniqueStepKeys))`. It must be drizzle's `inArray`, never `` sql`step_key = ANY(${keys})` ``, because the template expands the array into `($1,$2,…)` (precedent `allowed-signups.ts:17`). It reads `current_attempt`, `revoked_through`, `done_at IS NOT NULL AS done`, and `last_seen_at IS NOT NULL AND last_seen_at < now() - make_interval(secs => staleMs/1000) AS stale`, with `stale` false when `staleMs` is null. The cutoff uses the database clock, and no `now` parameter exists (`:31`).
- **A key is dead when its row exists and any one of these holds:**
  1. **revoked:** `isRevoked(attempt, revoked_through)` (`:68`);
  2. **fenced:** `current_attempt > attempt`;
  3. **done:** `done_at` is set;
  4. **stale:** `attempt = current_attempt` and `stale`.
- **Kept, never returned:**
  - a missing row, for example when a thread deletion cascaded the step: bounded by `expiresAt`;
  - `attempt > current_attempt` (a tag naming a future attempt);
  - `last_seen_at IS NULL` on the current attempt with no other rule true.
- **Output:** a `Set<string>` of `cellKeyId(key)` for each dead input key (a duplicate key is one member).

## What is left to later PRs

| PR   | Item                                                                                                                                                                                                                                    | Constraint from this spec                                                                                                                                                                                                                                |
| :--- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-C | `cell-plan` calls `openNextAttempt` instead of `openStep`, drops `attempt` from the body (`route.ts:51`), maps `attempt_limit`/`step_done`/`conflict` to 409, and returns `attempt` in the response so the worker tags the cell with it | Rewrite `route.test.ts:204-215` (fencing now comes from two calls, not chosen numbers)                                                                                                                                                                   |
| PR-C | The label-safe `stepKey` (for example `cell-<apiKeyId>`, if the `apiKeyId` charset is label-safe)                                                                                                                                       | **The tag value must equal `cell_step.step_key` byte for byte.** A tag-only encoding would make every `deadCellAttempts` lookup miss. That fails safe, but the lease rule would silently never fire. No change in PR-A: the authority is format-agnostic |
| PR-C | `runCellReconciler` passes `isDead: async (keys) => deadCellAttempts({db, keys, staleMs})`                                                                                                                                              | `staleMs` is `null` until PR-D's and PR-E's stamps are live in the same deploy, then `CELL_LEASE_STALE_MS`                                                                                                                                               |
| PR-D | `thread-status` terminal read: `finishStep({db, stepKey})` for a cell run, next to the daemon-token revoke                                                                                                                              | Not `markStepDone` (it needs a bearer www does not hold)                                                                                                                                                                                                 |
| PR-D | `stampSeen` on each cell run's `thread-status` read                                                                                                                                                                                     | **`thread-status` has no attempt today** (`route.ts:32-46`). The worker must send it, for example an optional `cellAttempt` that is strictly validated. Stamping "whatever is current" would let a zombie's polls renew its successor's lease            |
| PR-E | The worker stamps (through PR-D's path) during create, clone and daemon start, at least every `CELL_LEASE_STALE_MS / 2`                                                                                                                 | —                                                                                                                                                                                                                                                        |

### Accepted behaviours

- **`openNextAttempt` is not idempotent.** A lost response plus a retry burns an attempt: N stays current with no owner, its lease goes stale, and the retry (N+1) fences it. Each retry counts toward the 1000 cap. Accepted; PR-C may add an optional request nonce.
- **`stampSeen` returns `false`** for an unknown, fenced, revoked, done or unleased (NULL `last_seen_at`) step; a stamp never grants a lease to a NULL row. PR-D only logs it.
- **`finishStep` tombstone:** a step finished before any open is stored with `current_attempt` 0, `revoked_through` 0, `done_at` set and a placeholder timeout. `openNextAttempt` then classifies it `step_done` (org/thread mismatch stays `conflict`). If the row vanishes between upsert and select, `openNextAttempt` returns `conflict`.

### Ticket changes to record

The orchestrator publishes these to #656:

- **Scope 10 / R1:** the terminal read calls `finishStep({db, stepKey, organizationId, threadId})` (it revokes through the current attempt and sets `done_at`, in one statement). This replaces "`revokeAttempt` and `markStepDone`": `markStepDone` needs the attempt's bearer, which www does not hold.
- **Scope 12 / R3:** "opens `currentAttempt + 1` through `openStep`" becomes "through `openNextAttempt`" (server-assigned). `openStep` stays as the caller-chosen fixture primitive.
- **Scope 11 / R2:** `thread-status` must carry the cell attempt for `stampSeen` (PR-D).
- **Scope 7:** the read is `deadCellAttempts` (dead keys only), not `liveAttempts`.

## Acceptance (this PR)

- **AC-5, core:**
  - `deadCellAttempts` names a revoked, superseded (fenced) or done attempt before its `expiresAt`, and never names a live current attempt, an unknown step or a NULL lease;
  - it throws on a database error. PR-B's `deadKeyIds` (`reconcile.ts:114-128`) already turns that into "reap expired only".
  - The reconciler wiring is PR-C.
- **AC-14, authority half:**
  - `finishStep` revokes the current attempt and blocks any new one (terminal read);
  - the current attempt becomes dead after `staleMs` without a stamp, and a fenced attempt's stamp does not renew it;
  - `openNextAttempt` gives a redelivery a higher attempt, and the old attempt's bearer is refused as `fenced`.

## Tests (`packages/shared/src/model/cell-authority.test.ts`, throwaway Postgres)

Backdate leases with `db.update(cellStep).set({ lastSeenAt: sql\`now() - interval '10 minutes'\` })`. Read them back with `lastSeenAt > now() - interval '1 minute'`. Never compare against the JS clock.

**`openNextAttempt`**

1. A new key opens attempt 1 with `last_seen_at` set. A second call opens 2, and attempt 1's bearer verifies as `fenced`; `mintBearer(1)` returns `fenced`.
2. **Concurrency:** 8 calls in `Promise.all` on a fresh key return exactly `{1…8}`, and `current_attempt = 8`.
3. **Negative control (N4):** after `finishStep`, `openNextAttempt` returns `step_done` and `current_attempt` is unchanged. The same holds after `markStepDone` with the current bearer.
4. After `revokeAttempt(current)`, `openNextAttempt` still opens `current + 1`. This pins the design that makes `finishStep` necessary.
5. A different org, thread or `allowedRef` (including null against a ref) returns `conflict`, with no change to the row.
6. With `current_attempt` set to 1000, the result is `attempt_limit`.
   6a. **Race with the terminal read (N4), deterministic.** Use the same `holdAndCommit` helper as test 11. - For a step at attempt 1, the holder runs `finishStep`'s update inside its transaction (`revoked_through = current_attempt`, `done_at = now()`). - Start `openNextAttempt` without awaiting it. Prove it is blocked with the same `pg_stat_activity` poll as test 11. - Release, so the holder commits. `openNextAttempt` returns `step_done`, and `current_attempt` is still 1.
7. The validation `RangeError`s match `openStep`'s, through the shared helper. Existing `openStep` tests stay green.

**`stampSeen`**

8. Stamping the current attempt returns `true` and moves a backdated `last_seen_at` forward.
9. **Negative control:**
   - open 1, open 2, backdate;
   - `stampSeen(1)` returns `false` and `last_seen_at` stays backdated;
   - `deadCellAttempts([{2}], staleMs)` names attempt 2.
10. A stamp on a revoked current attempt, a done step or an unknown step returns `false`.
11. **Stamp racing a fence, deterministic, with a committing holder.** `holdLock` always rolls back (`control-effects.test.ts:94-120`), so this test needs a local `holdAndCommit(stepKey, write)` helper. It opens a transaction, runs `write(tx)`, signals that the lock is held, waits for `release()`, and then **returns normally, so it commits**.
    - The holder runs `tx.update(cellStep).set({ currentAttempt: 2, lastSeenAt: sql\`now()\` })` for a step at attempt 1, without committing.
    - Start `stampSeen(1)` and do not await it.
    - **Prove that it blocked** before releasing: poll (every 20 ms, 5 s timeout) `select count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database() and query ilike '%last_seen_at%'` until it is 1. Equivalently, poll for a `pg_locks` row with `granted = false` on `cell_step`. A timeout fails the test.
    - Release, so the holder commits. `stampSeen(1)` returns `false`, and `current_attempt = 2`.

**`finishStep`**

12. `finishStep` sets `revoked_through = current_attempt` and `done_at`, and the current bearer then verifies as refused. A second call returns `true` and keeps the first `done_at`.

**`deadCellAttempts`**

13. One matrix call, returning exactly the dead set:
    - a fresh current attempt: kept;
    - a fenced attempt: dead;
    - a revoked attempt: dead;
    - a done step: dead;
    - a backdated current attempt: dead;
    - **a NULL lease (opened by `openStep`, backdating has no effect): kept**;
    - an unknown step: kept;
    - an attempt above the current one: kept;
    - a duplicate key: one member of the set.
14. With `staleMs: null`, the backdated current attempt is kept; the other dead keys are unchanged.
15. Empty `keys` returns `[]`. A zero attempt or a `NaN` `staleMs` throws `RangeError`. **1001 keys throws `RangeError`, while 1000 keys runs the query.**
    15a. **A database error propagates.** Pass a `db` whose `select` throws, for example a stub `{ select: () => { throw new Error("db down") } }` cast to `DB`. `deadCellAttempts` rejects with that error: it neither returns `[]` nor swallows it. AC-5's fail-safe ("reap expired only") lives in `deadKeyIds` (`reconcile.ts:114-128`), which needs the throw. Its catch is already covered by PR-B's reconciler tests.
    15b. **Sandbox:** the existing reconciler tests still pass after the move (`cellKeyId` is imported through the re-export).

**`openStep` and the migration**

16. `openStep` advancing over a stamped row sets `last_seen_at` to NULL, and the attempt is kept by test 13's rule.
17. **Migrate package:** the `EXPECTED_MIGRATION_IDS`-derived counts in `cli.test.ts` cover the new file. Lint: `node deploy/lint-migrations.ts` exits 0.

## Gates (worktree root)

| Command                                                                 | Proves                                                                              |
| :---------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --prefer-offline`                       | lockfile unchanged                                                                  |
| `node deploy/lint-migrations.ts`                                        | the new file passes L1–L6                                                           |
| `pnpm --filter @terragon/migrate test`                                  | ledger and runner tests with the new id                                             |
| `pnpm turbo tsc-check` / `pnpm turbo lint` / `pnpm turbo format-check`  | types, lint, formatting                                                             |
| `pnpm --filter @terragon/shared exec vitest run --no-file-parallelism`  | the tests above against the throwaway Postgres (schema pushed by the test setup)    |
| `pnpm --filter @terragon/www exec vitest run --no-file-parallelism`     | the broker tests through `createTestCellStep`/`openStep`, and `cell-plan` unchanged |
| `pnpm --filter @terragon/sandbox exec vitest run --no-file-parallelism` | the reconciler is untouched                                                         |
| CI `schema-drift`                                                       | migration equals `schema.ts`                                                        |

No database outside the throwaway test databases is touched. The migration reaches production only through `migrate.yml` after merge.

## Risks

- **A lease without stamps reaps live cells.** Mitigated by NULL = kept, by `staleMs: null` until the stamps ship, and by the ordering constraint in the PR-C row above.
- **The step key differs from the tag value.** Every lookup misses, and the system fails safe to expiry-only. The PR-C row makes byte-equality a requirement.
- **The zombie-poll renewal** in PR-D's naive design is ruled out by requiring the attempt.
- **Thread deletion cascades `cell_step`,** so such a cell is "unknown" and kept until `expiresAt` (at most 45 min). This is accepted, and it is PR-B's contract.
- **Rollback:** the migration is expand-only and nullable. Reverting the code leaves an unused column. No contract migration is needed now; a later `migrate:contract` drop is possible.

## Phases (5 files at most each)

1. **P1, schema:**

   - `deploy/migrations/2026-11-19-cell-step-last-seen.sql`;
   - `packages/shared/src/db/schema.ts`;
   - `packages/migrate/src/expected-migrations.ts`.

   Gates: lint-migrations, migrate tests, tsc.

2. **P2, shared cell types:**

   - `packages/types/src/cell.ts` (`CELL_LEASE_STALE_MS`, `CellKey`, `cellKeyId`);
   - `packages/sandbox/src/cell/reconcile.ts` (definitions removed, re-exported);
   - `packages/sandbox/package.json` (`@terragon/types` moves to `dependencies`);
   - `pnpm-lock.yaml` (the importer entry moves).

   Gates: install with `--frozen-lockfile` after the lock update, tsc, the sandbox tests.

3. **P3, authority:**

   - `packages/shared/src/model/cell-authority.ts` (`assertStepShape`, `openNextAttempt`, `stampSeen`, `finishStep`, `deadCellAttempts`, `openStep`'s NULL on advance, header comment rows 4 and 6 updated);
   - `packages/shared/src/model/cell-authority.test.ts`.

   Gates: the full table.

## Validate history

| Round | Verdict            | Folded in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| :---- | :----------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | PASS_WITH_WARNINGS | (1) `inArray`, not `= ANY(${keys})`, in `deadCellAttempts`; (2) test 11 uses a committing holder and proves the stamp blocked (`pg_stat_activity` `wait_event_type = 'Lock'`, or `pg_locks` `granted = false`); (3) the deterministic `finishStep`-versus-`openNextAttempt` race (test 6a); (4) `deadCellAttempts` rethrows a database error (test 15a); (5) `CellKey` and `cellKeyId` move to `@terragon/types/cell` with a re-export from `reconcile.ts`. Correction found while folding: `@terragon/types` is only a devDependency of sandbox, so it moves to `dependencies` (P2 also covers `package.json` and the lockfile); (6) "Ticket changes to record"; (7) an explicit 1000-key bound with a test |
