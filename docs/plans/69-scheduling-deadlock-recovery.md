# Issue #69 — Hatchet scheduling deadlock recovery: concurrency-group rot + slot exhaustion

**Status:** SPEC (implementation not started)
**Blocks:** #125-F1. **Blocked-by:** none. **Adjacent:** #126 (per-PR concurrency, blocked on this), #128 (CI anti-rot E2E), #129 (thread-side terminal causes).
**Verified against the live pilot engine on 2026-08-23** (`automata-hatchet-postgres-1`, hatchet-lite `v0.94.10`). Every claim below cites a file:line I read or a query I ran; the live-query outputs are reproduced inline so a reviewer can re-run them.

---

## 1. Context & stakes

The execution plane runs one Hatchet workflow, `agent-run`, on a customer-supplied box. Its
global concurrency cap is **1** (`packages/worker/src/agent-run/workflow.ts:88`,
`GLOBAL_MAX_RUNS = 1`), justified by the single-box daemon memory budget
(`workflow.ts:80-87`). That means the box has exactly **one** slot for agent work.

Two independent engine-side defects can wedge that one slot:

1. **Concurrency-group rot** — after repeated worker re-registrations, hatchet-lite leaves
   the *active* strategy chain pointing at *superseded/nonexistent* strategy rows. Slot grants
   walk a chain that dead-ends, so tasks sit `QUEUED` forever with an idle, healthy worker.
   Documented in-tree at `workflow.ts:219-226`.
2. **SIGKILL slot exhaustion** — a worker killed without drain never releases its
   `v1_concurrency_slot` row. The slot stays `is_filled = true` forever; the cap is 1, so the
   next run queues indefinitely.

Either one is **100% throughput loss** until a human does manual SQL surgery on the engine
database. There is no automatic recovery today.

The stakes are made worse by a semantics detail that is easy to get wrong:

> **A task stuck `QUEUED` never started, so Hatchet's `onFailure` hook NEVER fires for it.**

`agentRunWorkflow.onFailure` exists (`workflow.ts:554`) and is the fast-path terminal callback
designed in `docs/plans/hatchet-enterprise-hardening.md:152-186`, but it only fires on a run
that **failed**, i.e. one that ran. A never-dispatched task produces no failure event at all.
Therefore **any stuck-run detection here must be SLA/time-based against dispatch time**, not
hook-based. This is the single most important design constraint in this document.

The current mitigation is a **rename**, not a fix. `workflow.ts:219-226` renamed the group from
`'agent-run-shared-daemon-socket'` to `'agent-run-global-memory-budget'` specifically to mint
fresh strategy state. That is now permanent config (`workflow.ts:227`) — and, as §2 shows with
live data, **the new group has already re-rotted**. The rename bought time; it did not fix
anything.

---

## 2. Verified current state

### 2.1 The workflow and its concurrency shape

`packages/worker/src/agent-run/workflow.ts:210-232`:

```ts
export const agentRunWorkflow = hatchet.workflow<AgentRunInput>({
  name: "agent-run",
  concurrency: [
    { expression: "input.orgId",                        maxRuns: PER_ORG_MAX_RUNS, limitStrategy: GROUP_ROUND_ROBIN },
    { expression: "'agent-run-global-memory-budget'",   maxRuns: GLOBAL_MAX_RUNS,  limitStrategy: GROUP_ROUND_ROBIN },
  ],
});
```

- `PER_ORG_MAX_RUNS = 1` — `workflow.ts:77`.
- `GLOBAL_MAX_RUNS = 1` — `workflow.ts:88`. The doc comment `workflow.ts:80-87` ties the cap to
  the ENOMEM wall; raising it is gated on #3b.
- `scheduleTimeout: "30m"` — `workflow.ts:236`. `executionTimeout: "30m"` — `workflow.ts:237`.
  `retries: 0` — `workflow.ts:245`.
- The rot comment: `workflow.ts:219-226`, verbatim: *"the old group's scheduler state deadlocked
  in hatchet-lite after repeated worker re-registrations (stale GROUP_ROUND_ROBIN strategy rows
  chain into active ones and the child slot is never granted — tasks sit QUEUED forever with
  idle workers)."*

### 2.2 The engine and how its database is reachable — **the brief's premise is wrong**

Engine substrate: `packages/worker/docker-compose.hatchet.yml`, service `postgres`
(`:19-20`, `postgres:15.6`), credentials `hatchet/hatchet/hatchet` (`:24-26`), healthcheck
`pg_isready` (`:29-34`), and `hatchet-lite:v0.94.10` (`:36`) pointed at it via
`DATABASE_URL: postgresql://hatchet:hatchet@postgres:5432/hatchet` (`:45`).
SDK: `@hatchet-dev/typescript-sdk ^1.26.0` (`packages/worker/package.json`).

The task brief states the worker plane "has engine-DB reach via the compose network". **It does
not.** Two verified facts:

1. The `postgres` service publishes **no host port**. `docker inspect
   automata-hatchet-postgres-1 --format '{{json .NetworkSettings.Ports}}'` →
   `{"5432/tcp":null}`. Only the `hatchet-lite` service publishes ports (8888, 7077 —
   `docker-compose.hatchet.yml:38-40`).
2. The worker is **not** on the compose network. It is a host process under launchd:
   `packages/worker/deploy/com.automata.worker.plist` runs `__HOME__/.automata/run-worker.sh`
   with `WorkingDirectory __REPO__/packages/worker`.

So today the *only* way anything in this repo reads the engine DB is by shelling into the
container — which is exactly what the existing UAT helper does
(`scripts/uat/lib.ts:60-66`, `docker exec ${P.HATCHET_PG} psql -U hatchet -d hatchet -tAc …`,
mirrored in `docs/uat/README.md:90-94`). **Establishing worker→engine-DB reach is therefore a
deliverable of this ticket, not a precondition.** See §3.0.

### 2.3 The rot is present in the live engine RIGHT NOW — cause NOT yet determined

`select id, parent_strategy_id, is_active, strategy, expression, max_concurrency, step_id from v1_step_concurrency order by id;`

```
 id | parent_strategy_id | is_active |     expression                   | max | step_id
----+--------------------+-----------+----------------------------------+-----+----------
  1 |             (null) | f         | 'agent-run-shared-daemon-socket' |   1 | f0b6612a…
  2 |                  1 | f         | 'agent-run-shared-daemon-socket' |   1 | f0b6612a…
  3 |             (null) | f         | input.orgId                      |   1 | 8b800eb8…
  4 |                  3 | f         | 'agent-run-shared-daemon-socket' |   1 | 8b800eb8…
  5 |                  4 | t         | input.orgId                      |   1 | 5c93e973…
  6 |                  5 | t         | 'agent-run-global-memory-budget' |   1 | 5c93e973…
```

Read this carefully. Rows 5 and 6 are the **current, active** chain for the current step
`5c93e973`. Rows 1–4 are superseded (`is_active = f`) and belong to **different** steps.

- Row 1 is the head of its step's chain → `parent_strategy_id = NULL`. Correct.
- Row 3 is the head of its step's chain → `parent_strategy_id = NULL`. Correct.
- **Row 5 is the head of the current step's chain, but `parent_strategy_id = 4`** — an
  `is_active = f` row belonging to a *different* `step_id`. **This is the rot.** The head
  of the live chain is parented to a dead strategy from a previous registration.

The same corruption appears mirrored in the workflow-level table
(`select * from v1_workflow_concurrency;`):

```
 id | workflow_version_id | is_active | child_strategy_ids |            expression
----+---------------------+-----------+--------------------+----------------------------------
  1 | 01fa6942…           | t         | {2}                | 'agent-run-shared-daemon-socket'
  2 | 9603cb2f…           | t         | {3}                | input.orgId
  3 | 9603cb2f…           | t         | {4}                | 'agent-run-shared-daemon-socket'
  4 | 75e03a6f…           | t         | {5}                | input.orgId
  5 | 75e03a6f…           | t         | {6}                | 'agent-run-global-memory-budget'
```

Row 5 is the **tail** of the current version's chain, yet `child_strategy_ids = {6}` — **and
there is no row with id 6.** Row 1's child `{2}` and row 3's child `{4}` likewise point across
`workflow_version_id` boundaries.

**What is established fact vs. what is not.**

*Fact (re-verified live 2026-08-23):* the current active chain head is parented to a dead,
foreign-step strategy, and the current workflow-level chain tail names a nonexistent strategy.
That corruption is real, present, and is exactly the shape `workflow.ts:219-226` describes as
deadlocking. **The detection predicates in §3.1.2/§3.1.4 rest only on this fact**, not on any
theory of how it got there.

*Hypothesis (NOT established — deliberately demoted):* an initial reading of these rows suggested
hatchet-lite assigns chain pointers by naive id arithmetic (`child = {id+1}`, `parent = id-1`)
without respecting step/version boundaries. **This is falsified by the same table.** Row 3 (step
`8b800eb8`, registration #2) has `parent_strategy_id = NULL` even though row 2 exists — naive
`id-1` would have parented it to row 2. So registration #1 minted a correct head, registration #2
minted a correct head, and registration #3 minted a **rotted** head. *The differentiator between
registration #2 and #3 is unknown and is not determined by this document.* Candidate explanations
worth testing (none confirmed): the shape change at #3 reused a step id or version in a way #2 did
not; a partially-completed registration left an id allocated but no row; a concurrent
two-worker registration race (this box runs two launchd units) interleaved id allocation.

The consequence for this spec is deliberate and load-bearing: **root-cause determination is folded
into the §3.1.4 upstream-source verification, and the §7.2.1 reproduction is empirical** (register
until the detector fires, bounded) rather than asserting that any particular number of
registrations produces rot. A repairer that fixes a corruption predicate does not need to know the
provenance of the corruption; a *preventer* would, and this ticket does not ship one.

What *is* safe to say about the rename at `workflow.ts:219-226`: it minted rows 5/6, and row 5 is
rotted. **The rename did not prevent rot.**

The rot is currently latent because nothing is queued. The next deadlock is one dispatch away.

### 2.4 `v1_concurrency_slot` has **no** `worker_id` — dead-generation must be derived

`\d v1_concurrency_slot` columns: `sort_id, task_id, task_inserted_at, task_retry_count,
external_id, tenant_id, workflow_id, workflow_version_id, workflow_run_id, strategy_id,
parent_strategy_id, priority, key, is_filled, next_parent_strategy_ids, next_strategy_ids,
next_keys, queue_to_notify, schedule_timeout_at`. **There is no worker column.**

The workflow-level counterpart `\d v1_workflow_concurrency_slot` has: `sort_id, tenant_id,
workflow_id, workflow_version_id, workflow_run_id, strategy_id, completed_child_strategy_ids,
child_strategy_ids, priority, key, is_filled` — also no worker column. Both column lists are used
by the quiescence preconditions in §3.1.3/§3.1.4.

Note also what `v1_concurrency_slot` does **not** have: any `created_at` / `filled_at`. The only
time column is `schedule_timeout_at`, which is derived from the task's `scheduleTimeout` — a fact
that materially constrains §3.2.2.

Two facts that make reclamation possible anyway:

- `v1_task_runtime` **does** carry `worker_id uuid` (plus `task_id, task_inserted_at,
  retry_count, tenant_id, timeout_at, evicted_at`), and its PK
  `(task_id, task_inserted_at, retry_count)` joins exactly onto the slot's
  `(task_id, task_inserted_at, task_retry_count)`.
- `v1_concurrency_slot` has an `AFTER DELETE … FOR EACH STATEMENT EXECUTE FUNCTION
  after_v1_concurrency_slot_delete_function()` trigger (verified in `\d`). **Deleting a slot row
  is the engine's own release path** — the same one that fires on normal completion. Reclamation
  is therefore not a raw poke at internals; it invokes the engine's sanctioned release logic.

### 2.5 `Worker.isActive` is unreliable — heartbeat is the only usable liveness signal

`select id, "lastHeartbeatAt", "isActive", "isPaused" from "Worker" order by "createdAt" desc;`
returned rows such as:

```
 07a8ef9a… | 2026-08-21 00:23:32 | isActive=t | isPaused=f
 fc050304… | 2026-08-21 00:23:28 | isActive=t | isPaused=f
 92ded677… | 2026-08-22 05:22:18 | isActive=t | isPaused=t
```

Workers whose last heartbeat was **two to three days ago** still carry `isActive = t`. Live
workers (`a1f70ad3…`, `2124b3ea…`) heartbeat within seconds of `now()`. **Conclusion: define
"dead generation" from `"lastHeartbeatAt"` staleness only. Never from `isActive`.**

### 2.6 `SCHEDULING_TIMED_OUT` is an event type, not a status — brief correction #2

`select unnest(enum_range(null::v1_readable_status_olap));` →
`QUEUED, RUNNING, CANCELLED, FAILED, COMPLETED, EVICTED`. **There is no
`SCHEDULING_TIMED_OUT` status.**

It exists as an `event_type` in `v1_task_events_olap`. Live counts:

```
 STARTED 322 | SENT_TO_WORKER 322 | ASSIGNED 322 | QUEUED 319 | FINISHED 280 | SKIPPED 209
 CANCELLED 200 | FAILED 23 | REASSIGNED 14 | REQUEUED_NO_WORKER 10 | SCHEDULING_TIMED_OUT 3 | TIMED_OUT 2
```

So a scheduling timeout surfaces as a **`CANCELLED` status plus a `SCHEDULING_TIMED_OUT`
event** — 3 have already occurred on this box, alongside 10 `REQUEUED_NO_WORKER`. Both are
first-class signals for §3.3.

Current status distribution in `v1_tasks_olap`: `COMPLETED 424, FAILED 21, CANCELLED 18`, zero
`QUEUED`; `v1_concurrency_slot` and `v1_task_runtime` are both empty (0 rows). **The box is
healthy right now**, which makes it the correct baseline for the "remediator is a no-op on a
healthy system" acceptance criterion (§6.1).

Single tenant: `707d0855-80ab-4e1f-a156-f1c4546cbf52` (all 463 OLAP rows).

### 2.7 Existing worker-side machinery this design reuses

- `packages/worker/src/hello/worker.ts:20-37` — `claimNamespaceAndReclaim()`, called at
  `worker.ts:59`, **before** `hatchet.worker(...)` at `worker.ts:60-63` (`slots: 5`), with
  `await worker.start()` at `worker.ts:78`. This is the exact boot hook mechanism 2 attaches to.
- `packages/worker/src/hello/worker.ts:65-76` — the graceful-drain contract: **no custom signal
  handler**, restart is SIGTERM + wait, never `launchctl kickstart -k`. This is what makes SIGKILL
  an *abnormal* event rather than routine — and therefore what makes a leaked slot a real but
  bounded-frequency failure.
- `packages/worker/src/agent-run/reclaim.ts` — the *process-side* analogue of what we are
  building engine-side. `isPidDead` (`reclaim.ts:34-47`) treats `ESRCH` as dead, `EPERM` and
  everything else as **alive**; ambiguous state is skipped (`reclaim.ts:80`). This
  "positively confirm dead, else skip" doctrine is carried over verbatim to slot reclamation.
- `packages/worker/src/agent-run/config.ts:106` — `loadWorkerConfig(env)`, the single place
  worker knobs are parsed, with the established "only the exact string opts in / opts out"
  pattern at `config.ts:134-140` (`credentialBroker`) and `config.ts:115-123` (`boxTrust`). The
  *fail-closed boot gate* doctrine these knobs echo lives separately in
  `packages/worker/src/agent-run/assert-auth.ts` (invoked at `worker.ts:49`).
- `packages/worker/src/registry.ts:14` — `export const workflows = [hello, agentRunWorkflow]`.
- `packages/worker/package.json` — `test: "vitest --no-file-parallelism --passWithNoTests"`.
  **File-parallelism is already off**, which the integration tests in §7.2 depend on.

### 2.8 Adjacent work — confirmed non-overlapping

- `docs/research/hatchet-enterprise-practices.md:16-19` proposes a **www-side** watchdog for
  threads past SLA, covering *"Running-with-no-step"*, dead workers, and credits-exhausted
  stalls — i.e. runs that **started**. It explicitly pairs with an on-failure task. It does
  **not** cover a task that never left `QUEUED`, and it lives in a different plane. Relevant,
  not subsuming.
- `docs/plans/hatchet-enterprise-hardening.md:152-186` (§1.2) is the `onFailure` + hourly
  `runStalledTasksCron` design. Same conclusion: fires only on failures/started runs.
  Confirmed **no overlap** with this scope.

---

## 3. Design

### 3.0 Prerequisite: worker → engine-DB reach

Because §2.2 established there is none, this ticket must create it. Two options were considered:

| | (A) loopback-published port + `pg` client | (B) `docker exec … psql` shell-out |
|---|---|---|
| Transactions / advisory locks | native | fragile (each exec is its own session — advisory locks cannot span statements) |
| Parameter binding | native `$1` binding | string interpolation into a shell command |
| New dependency | `pg` (already in the monorepo at `apps/www/package.json:103`, `^8.16.0`; `@types/pg` at `:138`) | none |
| Coupling | connection string | container name + docker CLI presence |
| Attack surface | one loopback-bound port on the box | docker socket access (already required) |

**Decision: (A).** The advisory-lock requirement (§3.4) alone rules out (B).

**The port publish MUST NOT go in the base compose file.** `packages/worker/package.json:9`
defines `hatchet:up` as `docker compose -f docker-compose.hatchet.yml up -d`. Editing the base
file would mean **every** box that redeploys via `hatchet:up` — including boxes that never opt
into maintenance — starts exposing the engine database on a host port. That contradicts the
opt-in claim below, and it would immediately falsify the file's own header at
`docker-compose.hatchet.yml:5-6` ("internal to this compose network — no host port").

So the publish ships as a **separate opt-in overlay file**,
`packages/worker/docker-compose.hatchet.maintenance.yml`:

```yaml
# Opt-in overlay (#69): publishes the engine Postgres on LOOPBACK ONLY so the
# host-resident worker can run scheduling-deadlock maintenance. Never merge this
# into docker-compose.hatchet.yml — `hatchet:up` must stay port-free by default.
# NEVER change 127.0.0.1 to 0.0.0.0: the engine DB is the tenancy root.
services:
  postgres:
    ports:
      - "127.0.0.1:55433:5432"
```

Brought up with a new script `hatchet:up:maintenance`:
`docker compose -f docker-compose.hatchet.yml -f docker-compose.hatchet.maintenance.yml up -d`.
Plain `hatchet:up` (`package.json:9`), `hatchet:down` (`:10`) and `hatchet:logs` (`:11`) are
**unchanged**, and a box that never runs the new script is byte-for-byte identical to today.

The base file's header comment at `docker-compose.hatchet.yml:5-6` is amended (2 lines) from
"no host port" to "no host port **by default** — see docker-compose.hatchet.maintenance.yml for
the opt-in loopback publish (#69)", so the header does not go stale.

`55433` is chosen to sit beside the `:3100` self-host stack's `55432`, which that same header
documents; verified free on this box (`lsof -nP -iTCP:55433 -sTCP:LISTEN` → empty).

**Security note for the customer-box installer:** the bind is `127.0.0.1`-scoped, so it is
reachable only by local users of the box — the same trust boundary as the docker socket the
operator already holds. It must **never** be published on `0.0.0.0`. Add this to the installer
checklist alongside the existing `SERVER_GRPC_INSECURE` caveat
(`docker-compose.hatchet.yml:12-15`) and the non-`-dev`-image rule (`:8-10`).

**Master gate:** everything in this document is disabled unless `HATCHET_ENGINE_DATABASE_URL`
is set. A box that never runs `hatchet:up:maintenance` has no port to point it at and never sets
the URL, so all three mechanisms are inert no-ops. **No change to the default deployment path.**

```
HATCHET_ENGINE_DATABASE_URL   default: unset  → all mechanisms OFF (hard gate)
                              pilot value: postgresql://hatchet:hatchet@127.0.0.1:55433/hatchet?sslmode=disable
```

Connection hygiene, applied to every maintenance connection:

```sql
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout      = '1s';
SET LOCAL idle_in_transaction_session_timeout = '10s';
```

A `pg.Pool` with `max: 2` is more than enough; the maintenance loop is single-flight.

Tenant scoping: resolved once at boot via
`SELECT id FROM "Tenant"` / or simply carried as `HATCHET_ENGINE_TENANT_ID` (default: the single
row observed at §2.6). Every query in §3.1–§3.3 is `tenant_id`-scoped. A multi-tenant engine
must not have one tenant's maintenance touch another's rows.

### 3.1 Mechanism 1 — concurrency-group rot: detect + auto-remediate

#### 3.1.1 Decision: **prune (repair pointers), NOT auto-rotate the group name**

Auto-rotating the constant group key (e.g. suffixing a build hash so each registration mints a
fresh group) was seriously considered — it is the mechanised version of what `workflow.ts:219-226`
did by hand. **Rejected**, for three reasons:

1. **It breaks the memory budget, which is the cap's entire purpose.** `GLOBAL_MAX_RUNS = 1`
   exists because N concurrent `claude` processes hit an ENOMEM wall (`workflow.ts:80-87`).
   During a rolling restart of the two launchd units, an old-name group and a new-name group
   would each independently admit `maxRuns: 1` — **two concurrent agent-runs on a box budgeted
   for one.** Rotation trades a scheduling deadlock for a memory crash. Unacceptable.
2. **It accelerates the disease.** Each rotation appends two more strategy rows, and §2.3 shows
   rows are born rotted. Rotating makes rot accumulate at registration rate rather than fixing it.
3. **It makes #128 untestable.** An anti-rot E2E that asserts "N≥50 ephemeral groups do not
   deadlock" is meaningless if the production behaviour is to never reuse a group.

Pruning keeps **one stable, semantically-correct group name** and repairs the corrupted pointers
that are the actual defect. It is also strictly smaller: it **never deletes a strategy row, never
changes a link between two strategies of the same `(workflow_id, workflow_version_id)` (or, at
step level, the same `step_id`), and never flips `is_active`** — and it is a pure no-op on a
correctly-registered chain.

**Precision correction — the claim is *not* "never changes an active→active link".** In
`v1_workflow_concurrency` *every* row is `is_active = t`, including rows belonging to superseded
workflow versions (§2.3: rows 1–3 are active but belong to versions `01fa6942` / `9603cb2f`).
The §3.1.4 repair strips row 1's child `{2}` and row 3's child `{4}`, and rows 2 and 4 are
themselves `is_active = t`. So the repair **does** cut links between two active rows. What it
never cuts is a link **within one workflow version** — the only kind a live chain can traverse.
Live row 4 → `{5}` (both version `75e03a6f`) is preserved, which is the assertion that matters
(AC-3). This distinction is added to the §3.1.4 implementation-verify step because the whole
repair depends on it.

#### 3.1.2 Detection — step-level

```sql
-- rot: an ACTIVE strategy whose parent pointer leads outside its own live chain.
SELECT c.id, c.step_id, c.expression, c.parent_strategy_id,
       p.id IS NULL          AS parent_missing,
       COALESCE(p.is_active, false) AS parent_is_active,
       p.step_id             AS parent_step_id
FROM v1_step_concurrency c
LEFT JOIN v1_step_concurrency p
       ON p.id = c.parent_strategy_id
      AND p.tenant_id = c.tenant_id
WHERE c.tenant_id = $1::uuid
  AND c.is_active
  AND c.parent_strategy_id IS NOT NULL
  AND (p.id IS NULL OR NOT p.is_active OR p.step_id <> c.step_id)
ORDER BY c.id
LIMIT $2;
```

On the live engine this returns **exactly row 5** (parent 4: inactive, foreign step). On a
freshly-registered engine it returns 0 rows.

#### 3.1.3 Remediation — step-level

```sql
UPDATE v1_step_concurrency c
   SET parent_strategy_id = NULL
 WHERE c.tenant_id = $1::uuid
   AND c.id = ANY($2::bigint[])
   AND c.is_active
   AND c.parent_strategy_id IS NOT NULL
   AND NOT EXISTS (                      -- re-check the predicate inside the write
        SELECT 1 FROM v1_step_concurrency p
         WHERE p.id = c.parent_strategy_id
           AND p.tenant_id = c.tenant_id
           AND p.is_active
           AND p.step_id = c.step_id)
   -- QUIESCENCE PRECONDITION: no live slot is mid-traversal of this strategy.
   AND NOT EXISTS (
        SELECT 1 FROM v1_concurrency_slot s
         WHERE s.tenant_id = c.tenant_id
           AND (    s.strategy_id             =    c.id
                 OR s.parent_strategy_id      =    c.id
                 OR s.next_strategy_ids        @> ARRAY[c.id]
                 OR s.next_parent_strategy_ids @> ARRAY[c.id]
                 OR s.strategy_id             =    c.parent_strategy_id
                 OR s.parent_strategy_id      =    c.parent_strategy_id
                 OR s.next_strategy_ids        @> ARRAY[c.parent_strategy_id]
                 OR s.next_parent_strategy_ids @> ARRAY[c.parent_strategy_id]))
RETURNING c.id, c.step_id, c.expression;
```

Two independent safety layers:

1. **The rot predicate is re-evaluated inside the `UPDATE`'s own `WHERE`**, so a concurrent
   legitimate re-registration between detect and repair cannot cause a wrong write — the row
   simply isn't matched.
2. **The quiescence precondition** (the second `NOT EXISTS`) is the fix for the gap the earlier
   draft left open: the safety argument previously only covered a system with *zero* findings, not
   a system that is **rotted and busy**. Re-pointing a strategy that some in-flight
   `v1_concurrency_slot` is currently traversing — via `strategy_id`, `parent_strategy_id`,
   `next_strategy_ids` or `next_parent_strategy_ids` (all four verified present in the §2.4
   column list) — could strand that slot. The precondition simply declines to repair such a
   strategy this tick; the next tick retries. Deferral **costs one tick (60 s) when the
   referencing slot is not the blocked one** — an unrelated in-flight run clears and the next tick
   repairs. **It may be permanent in exactly the deadlock case**, where the slot that references
   the rotted strategy *is* the blocked slot and will never clear on its own. That is not a
   hypothetical: it is §10 risk 2, it is why §3.1.3 specifies a boot-only fallback path, and it is
   why §7.2.1 step 6 is instrumented to report which path actually fires. Do not read this
   precondition as "safe and always eventually effective" — it is "safe, and effective except in
   the case that needs the boot path".

   **On `is_filled`:** the precondition deliberately does **not** filter on `s.is_filled`. An
   unfilled slot is a *waiting* task — precisely the one blocked by the rot — and it still carries
   the strategy pointers the repair would move underneath it. Filtering to `is_filled = true`
   would narrow the guard to running work only and would let a repair race the grant path of a
   queued task. Since deferral is the conservative outcome and the boot-only fallback exists to
   break the resulting tie, the wider (no-`is_filled`) form is correct here.

   The `@>` array-containment tests require no index to be correct; at pilot volumes
   (`v1_concurrency_slot` currently holds 0 rows, §2.6) the sequential scan is trivial, and the
   5 s `statement_timeout` bounds it regardless.

Setting the head's parent to `NULL` restores the shape rows 1 and 3 already have (§2.3), i.e. it
makes the chain look like a correctly-registered one.

**Belt-and-braces alternative** if the quiescence check ever proves too conservative to fire on a
real deadlock (i.e. the blocking slot *itself* references the rotted strategy, so the precondition
permanently defers): restrict rot repair to **boot only**, before `hatchet.worker(...)`
(`worker.ts:60`) and while this process holds no slots. That trades recovery latency (one worker
restart) for unconditional safety. The §7.2.1 harness must report which of the two paths actually
fires, so this choice is made on evidence rather than guessed — see AC-4.

#### 3.1.4 Detection + remediation — workflow-level

```sql
-- rot: an ACTIVE strategy whose child array names a strategy that does not exist
-- in the same (workflow_id, workflow_version_id).
SELECT c.id, c.workflow_version_id, c.expression, c.child_strategy_ids, x.child_id
FROM v1_workflow_concurrency c
CROSS JOIN LATERAL unnest(COALESCE(c.child_strategy_ids, '{}'::bigint[])) AS x(child_id)
LEFT JOIN v1_workflow_concurrency k
       ON k.id = x.child_id
      AND k.workflow_id = c.workflow_id
      AND k.workflow_version_id = c.workflow_version_id
WHERE c.tenant_id = $1::uuid
  AND c.is_active
  AND k.id IS NULL
ORDER BY c.id
LIMIT $2;
```

Live result: rows 1 (`{2}` → foreign version), 3 (`{4}` → foreign version), 5 (`{6}` →
nonexistent).

```sql
UPDATE v1_workflow_concurrency c
   SET child_strategy_ids = COALESCE((
         SELECT array_agg(x ORDER BY x)
           FROM unnest(c.child_strategy_ids) x
          WHERE EXISTS (SELECT 1 FROM v1_workflow_concurrency k
                         WHERE k.id = x
                           AND k.workflow_id = c.workflow_id
                           AND k.workflow_version_id = c.workflow_version_id)
       ), '{}'::bigint[])
 WHERE c.tenant_id = $1::uuid
   AND c.id = ANY($2::bigint[])
   AND c.is_active
   -- QUIESCENCE PRECONDITION (same rationale as §3.1.3): no live workflow-level
   -- slot is mid-traversal of this strategy or any id in its child array.
   AND NOT EXISTS (
        SELECT 1 FROM v1_workflow_concurrency_slot s
         WHERE s.tenant_id = c.tenant_id
           AND (    s.strategy_id = c.id
                 OR s.strategy_id = ANY(c.child_strategy_ids)
                 OR s.child_strategy_ids           && c.child_strategy_ids
                 OR s.completed_child_strategy_ids && c.child_strategy_ids))
RETURNING c.id, c.child_strategy_ids;
```

(`v1_workflow_concurrency_slot`'s `strategy_id`, `child_strategy_ids` and
`completed_child_strategy_ids` columns are all verified present — see the `\d` output cited in
§2.4's companion query.)

Note the array survives correctly: live row 4 (`{5}`, same version) is **kept**; rows 1, 3, 5
strip to `{}`.

**Explicitly NOT done:** deactivating superseded-version rows (`is_active = f`), and deleting
inactive strategy rows. Both are tempting garbage-collection but risk orphaning an in-flight
slot that still references them, and neither is required to break the deadlock. If disk pressure
ever motivates GC, it belongs in a separate ticket, gated on "no `v1_concurrency_slot` row
references the strategy".

**Implementation-verify step (must be done before flipping the repair to `on`).** This step also
**owns root-cause determination**, which §2.3 explicitly declines to settle. Confirm against the
hatchet-lite `v0.94.10` engine source that:

- **(a)** a chain head is expected to carry `parent_strategy_id IS NULL`;
- **(b)** a chain tail is expected to carry an empty `child_strategy_ids`;
- **(c)** a `child_strategy_ids` entry pointing at a **different `workflow_version_id`** is never
  legitimate. This is the invariant the §3.1.4 repair depends on and it was missing from the
  earlier draft — see the §3.1.1 precision correction, since the stripped links are between two
  `is_active = t` rows and are only safe to cut *because* they cross versions. If (c) turns out to
  be false, the workflow-level repair must be dropped and only the step-level repair ships;
- **(d)** what actually assigns `parent_strategy_id` / `child_strategy_ids` at registration —
  i.e. why registration #2 in §2.3 minted a correct head and #3 a rotted one. The
  `registrationsToRot` datum from §7.2.1 is an input here. A finding either way is recorded in
  this document; it is **not** a prerequisite for the repair (which keys off the corruption
  predicate, not the cause), but it is a prerequisite for ever writing a preventer.

The live data in §2.3 is strong evidence for (a) and (b) (rows 1 and 3 head with `NULL`; row 4
tails within its version), but this design mutates engine-internal state and the invariants
deserve source-level confirmation, not inference. Command:
`docker run --rm --entrypoint sh ghcr.io/hatchet-dev/hatchet/hatchet-lite:v0.94.10 -c 'ls /'`
plus the upstream `hatchet-dev/hatchet` queries at tag `v0.94.10`
(`pkg/repository/v1/sqlcv1/*concurrency*.sql`).

#### 3.1.5 Health signal

On any non-zero detection the maintenance tick emits one structured line (§3.5) with
`event: "scheduling.rot_detected"`, the rot row ids, and whether repair ran or was suppressed by
dry-run. On a successful repair: `event: "scheduling.rot_repaired"`, `rowsTouched: N`.

### 3.2 Mechanism 2 — SIGKILL slot reclamation

#### 3.2.1 Definition of a dead generation, and the network-partition hazard

Per §2.5, `isActive` is unusable. `"Worker"` carries `id, tenantId, lastHeartbeatAt (NULLABLE),
deletedAt, isActive, isPaused` (verified `\d "Worker"`). A worker generation `W` is **DEAD** iff:

```
W."tenantId" = <tenant>                                     -- §3.0 invariant, see §3.2.3
AND W."lastHeartbeatAt" IS NOT NULL
AND W."lastHeartbeatAt" < now() - HATCHET_WORKER_DEAD_AFTER_S   (default 600 seconds)
AND W.id <> <this process's own worker id, when known>
```

`lastHeartbeatAt IS NOT NULL` is explicit and deliberate: a worker that never heartbeated is
**ambiguous, therefore treated as alive**, exactly as `reclaim.ts:34-47` treats `EPERM`. Same for
`deletedAt` — a soft-deleted worker is not used as a death signal. Only a positive, *observed*
heartbeat that has since gone stale counts.

**The partition hazard (this is the serious one).** A worker that is alive but network-partitioned
from the engine for > the threshold gets classified DEAD. Its slot is deleted, a second agent-run
is admitted — and the partitioned worker's `claude` process is **still resident, still consuming
memory**. That is precisely the ENOMEM double-admission that §3.1.1 calls Unacceptable when
arguing against group rotation. It would be incoherent to reject rotation on that ground and then
reintroduce the same failure here. Four mitigations, applied together:

1. **Threshold is raised from 300 s to a default of 600 s**, and the reasoning is made explicit
   rather than asserted: live workers heartbeat within seconds of `now()` (§2.5 — the two live
   rows were 2 s and 3 s stale against a `now()` in the same minute). At an SDK heartbeat interval
   on the order of 5 s, 600 s is **~120 consecutive missed heartbeats**. A partition that survives
   120 heartbeats is not a blip; it is an outage the operator is already paging on.
2. **A no-recent-progress requirement** (the real guard, not just a bigger number). A slot is only
   dead-owned-reclaimable if its task has emitted **no `v1_task_events_olap` row** within the same
   dead window. A partitioned-but-live worker that reconnects intermittently, or that is
   progressing at all, produces events and is therefore never reclaimed. This converts the test
   from "did we hear a heartbeat" to "is this task demonstrably making no progress", which is the
   question we actually mean.
3. **Bounded blast radius even if all guards are wrong.** The victim task's own
   `executionTimeout: "30m"` (`workflow.ts:237`) caps how long a wrongly-reclaimed run can
   double-occupy memory, and the process-side reaper (`reclaim.ts:59`) SIGKILLs the orphan daemon
   group on the next worker boot. So the worst case is bounded, not unbounded.
4. **Residual risk is stated, not hidden.** With guards 1–3 the remaining window is: a worker
   partitioned > 600 s, emitting zero task events, whose agent is nonetheless alive and
   allocating. This is possible. It is judged acceptable **only because `WORKER_SLOT_RECLAIM`
   ships `dry-run`** (§8) and is promoted separately, a day after rot repair, on observed evidence
   that `slots.reclaimable` is 0 on a healthy box. An operator who considers the residual
   unacceptable for their box leaves it at `dry-run` permanently and reclaims by hand from the
   runbook; detection still works.

#### 3.2.2 Definition of a reclaimable slot — and the recovery-latency bound

A `v1_concurrency_slot` row is reclaimable iff `is_filled = true` **and** either:

- **(a) orphan** — no `v1_task_runtime` row exists for its
  `(task_id, task_inserted_at, task_retry_count)`; the runtime was cleaned but the slot leaked. An
  orphan has no worker to test for liveness, so it needs its own staleness floor: `task_inserted_at
  < now() - HATCHET_SLOT_MIN_AGE_S` (default 600 s). **or**

  > **Note — the `evicted_at` sub-case, and it is intended.** The `LEFT JOIN` in §3.2.3 carries
  > `AND r.evicted_at IS NULL` in its `ON` clause, so a slot whose runtime row **exists but has
  > been evicted** produces `r.task_id IS NULL` and therefore classifies as an *orphan*, reclaimed
  > on the `minSlotAge` floor alone without any heartbeat or no-progress test. This is
  > deliberate: `evicted_at` is the engine's own record that it has already given up on that task
  > attempt, so there is no live execution to protect and no worker whose liveness is meaningful —
  > the filled slot left behind is exactly the leak this mechanism exists to clear. The 600 s
  > `HATCHET_SLOT_MIN_AGE_S` floor is what keeps it from racing an eviction that is still being
  > processed. Flagged explicitly because the behaviour is a side effect of join placement rather
  > than an obvious reading of the predicate; if the §3.1.4-style source check shows the engine
  > re-uses evicted runtime rows on retry, move `evicted_at IS NULL` from the `ON` clause into the
  > case-(b) branch so evicted rows stop being treated as orphans.
- **(b) dead-owned** — the joined `v1_task_runtime.worker_id` belongs to a dead generation per
  §3.2.1 (`evicted_at IS NULL`), **and** the task has emitted no `v1_task_events_olap` row within
  the dead window (guard 2 above).

Case (c) — runtime row present with `worker_id IS NULL` — is deliberately **excluded**: that is a
task mid-assignment, and reclaiming it would race a healthy scheduler.

**Correction: the `schedule_timeout_at < now()` floor from the earlier draft is REMOVED.** It was
wrong in a way that silently defeated the whole mechanism. `schedule_timeout_at` is derived from
the task's `scheduleTimeout`, which for `agent-run` is **30 minutes** (`workflow.ts:236`). Gating
reclamation on it would have meant the box stays wedged for the victim's full 30-minute schedule
window regardless of the advertised dead-worker threshold — i.e. the mechanism would have
advertised ~5-minute recovery and delivered ~30-minute recovery, and the §7.2.2 repro ("R2 RUNNING
within 30 s") could never have passed. Staleness is instead enforced by the two *parameterized*,
separately-justified guards above: the heartbeat threshold for case (b), and
`HATCHET_SLOT_MIN_AGE_S` on `task_inserted_at` for case (a). Both are function parameters, not
constants, precisely so §7.2.2 can drive them to small values.

**Stated recovery-latency bound.** Worst-case time from SIGKILL to the next run being admitted:

```
HATCHET_WORKER_DEAD_AFTER_S (600 s)  +  HATCHET_MAINT_INTERVAL_S (60 s)  ≈ 11 minutes  [nominal]
                                     +  one further tick (60 s)          ≈ 12 minutes  [alertable]
```

The **nominal** figure is 11 minutes. The **alertable** figure is ~12 minutes, and that is the one
the runbook and any ops alert threshold must use: with two launchd units ticking, the tick that
would have fired can lose the `pg_try_advisory_lock` race and skip (§3.4), costing one further
interval. Publishing the nominal figure as the alert threshold would page on healthy contention.

It is **not** 5 minutes, and it is **not** bounded by `scheduleTimeout`. An operator who needs
faster recovery lowers
`HATCHET_WORKER_DEAD_AFTER_S`, accepting a proportionally larger partition hazard (§3.2.1) — the
trade-off is explicit and one knob wide.

#### 3.2.2b Primary invocation path is the periodic tick, not boot

The earlier draft presented boot-time reclamation as the headline path. That is wrong for this
deployment. `packages/worker/deploy/com.automata.worker.plist` sets `KeepAlive` `true` with
`ThrottleInterval` `15`, so launchd **relaunches a SIGKILLed worker within ~15 seconds**. At that
moment the dead generation's `lastHeartbeatAt` is ~15 s stale — far inside a 600 s threshold — so
**boot-time reclamation will normally find nothing.** It is retained as a cheap belt-and-braces
sweep for the case where the box was down long enough to matter (a reboot, a stopped launchd unit,
a manual `hatchet:down`), and because at boot the self-exclusion parameter is trivially safe.

**The periodic tick is the primary and load-bearing path**, and it is what the latency bound above
describes: the relaunched worker keeps ticking, and ~10 minutes after the SIGKILL its own
maintenance loop observes the prior generation as dead and frees the slot. §7.2.2 tests the
periodic path; §7.2.3 covers boot.

#### 3.2.3 SQL

Parameters: `$1` tenant, `$2` `deadAfterSeconds`, `$3` self worker id (nullable), `$4` batch
limit, `$5` `minSlotAgeSeconds`.

```sql
WITH dead_workers AS (
  SELECT id FROM "Worker"
   WHERE "tenantId" = $1::uuid                        -- §3.0 tenant-scope invariant
     AND "lastHeartbeatAt" IS NOT NULL                -- never-heartbeated = ambiguous = alive
     AND "lastHeartbeatAt" < now() - make_interval(secs => $2::int)
     AND ($3::uuid IS NULL OR id <> $3::uuid)         -- never this process's own generation
),
candidates AS (
  SELECT s.task_id, s.task_inserted_at, s.task_retry_count, s.strategy_id,
         s.key, s.workflow_run_id, r.worker_id,
         (r.task_id IS NULL) AS orphan
    FROM v1_concurrency_slot s
    LEFT JOIN v1_task_runtime r
           ON r.task_id          = s.task_id
          AND r.task_inserted_at = s.task_inserted_at
          AND r.retry_count      = s.task_retry_count
          AND r.evicted_at IS NULL
   WHERE s.tenant_id = $1::uuid
     AND s.is_filled
     AND (
           -- (a) orphan: no runtime row; needs its own age floor.
           ( r.task_id IS NULL
             AND s.task_inserted_at < now() - make_interval(secs => $5::int) )
           -- (b) dead-owned AND demonstrably making no progress (§3.2.1 guard 2).
           OR ( r.worker_id IN (SELECT id FROM dead_workers)
                AND NOT EXISTS (
                     SELECT 1 FROM v1_task_events_olap e
                      WHERE e.tenant_id        = s.tenant_id
                        AND e.task_id          = s.task_id
                        AND e.task_inserted_at = s.task_inserted_at
                        AND e.event_timestamp  > now() - make_interval(secs => $2::int)) )
         )
   ORDER BY s.sort_id
   LIMIT $4                                            -- bounded: default 100
)
DELETE FROM v1_concurrency_slot s
 USING candidates c
 WHERE s.task_id          = c.task_id
   AND s.task_inserted_at = c.task_inserted_at
   AND s.task_retry_count = c.task_retry_count
   AND s.strategy_id      = c.strategy_id
RETURNING s.task_id, s.strategy_id, s.key, s.workflow_run_id;
```

The `DELETE` fires `after_v1_concurrency_slot_delete_function()` (§2.4) — the engine's own
release path, which notifies `queue_to_notify`. Dry-run mode runs only the `candidates` CTE as a
`SELECT` and reports what *would* be deleted.

#### 3.2.4 Where it runs

Two invocation points, in order of importance (see §3.2.2b — this ordering is the opposite of the
earlier draft's):

1. **Periodic — PRIMARY.** The maintenance tick (§3.4), with `$3` set to this process's registered
   worker id. This is the path that actually recovers a SIGKILL, because launchd's `KeepAlive`
   relaunch (~15 s) means the dead generation is nowhere near stale at boot. It also recovers a
   *sibling* unit's SIGKILL without waiting for this worker's own restart. The §3.2.2
   latency bound describes this path.
2. **Boot, before registration — SECONDARY / belt-and-braces.** In `worker.ts:main()`, immediately
   after `claimNamespaceAndReclaim()` (`worker.ts:59`) and **before** `hatchet.worker(...)`
   (`worker.ts:60`). At that instant this process owns no worker id and no slots, so `$3` is
   `NULL` and the query is trivially safe. It fires meaningfully only when the box was down long
   enough for the prior generation to go stale (reboot, stopped unit, `hatchet:down`). It is
   nonetheless the literal answer to "on worker (re)registration, reclaim dead-generation slots",
   and it costs one query.

Ordering note: reclamation must run **before** `hatchet.worker(...)` so that the fresh
registration (which is what mints the possibly-rotted strategy rows, §2.3) is not itself the
thing being scanned. Rot repair (§3.1) runs **after** registration for the symmetric reason: it
must see the rows this registration just created.

### 3.3 Mechanism 3 — stuck-`QUEUED` health signal

Detection only. **No thread transition, no terminal cause, no cancellation** — those are #129.

```sql
SELECT external_id, workflow_run_id, workflow_id, inserted_at, schedule_timeout,
       EXTRACT(epoch FROM (now() - inserted_at))::int AS queued_for_s
  FROM v1_tasks_olap
 WHERE tenant_id = $1::uuid
   AND readable_status = 'QUEUED'
   AND inserted_at <  now() - make_interval(secs => $2::int)
   AND inserted_at >= now() - interval '7 days'      -- bound the partition scan
 ORDER BY inserted_at
 LIMIT $3;
```

The `>= now() - 7 days` clause is not cosmetic: `v1_tasks_olap` is `RANGE (inserted_at)`-
partitioned with 26 daily partitions today (§2.6), and the bound lets the planner prune.

**Threshold:** `HATCHET_STUCK_QUEUED_S`, default **900 s** = `scheduleTimeout / 2`
(`scheduleTimeout: "30m"`, `workflow.ts:236`). Half the window means the signal fires with 15
minutes of head-room before the engine gives up, which is the whole point — an operator can act
before work is lost.

**Secondary signal** (§2.6 correction — `SCHEDULING_TIMED_OUT` is an event, not a status):

```sql
SELECT event_type, count(*)
  FROM v1_task_events_olap
 WHERE tenant_id = $1::uuid
   AND event_type IN ('SCHEDULING_TIMED_OUT', 'REQUEUED_NO_WORKER')
   AND event_timestamp > now() - make_interval(secs => $2::int)   -- default 3600
 GROUP BY 1;
```

A non-zero `SCHEDULING_TIMED_OUT` count means work was **already dropped** — this is the
"you missed it" alarm, distinct from the "act now" stuck-`QUEUED` alarm.

**Surfacing.** The worker has no HTTP server today (verified: no `createServer` anywhere under
`packages/worker/src`), and the launchd unit already captures stdout to
`__HOME__/.automata/worker.log` (`com.automata.worker.plist`, `StandardOutPath`). So:

1. **Structured log line** on every tick with a non-empty finding (§3.5). Zero new surface.
2. **Snapshot file** — the tick atomically writes
   `<runNamespaceRoot>/scheduling-health.json` (`runNamespaceRoot` from `config.ts:69`, default
   `/tmp/automata-agent-run`) via write-temp-then-`rename`. Shape:

```jsonc
{
  "ts": "2026-08-23T18:00:00.000Z",
  "engineReachable": true,
  "stuckQueued":  { "count": 0, "oldestQueuedForS": 0, "externalIds": [] },
  "schedulingTimedOut1h": 0,
  "requeuedNoWorker1h": 0,
  "rot":  { "stepLevel": 0, "workflowLevel": 0, "repaired": 0, "mode": "dry-run" },
  "slots":{ "filled": 0, "reclaimable": 0, "reclaimed": 0, "mode": "dry-run" },
  "healthy": true
}
```

3. **Optional loopback endpoint** — if `WORKER_HEALTH_PORT` is set (default **unset**), serve
   `GET /healthz` on `127.0.0.1:<port>` returning that JSON with `200` when `healthy`, `503`
   otherwise. Off by default so nothing new listens on an unmodified box.

### 3.4 Failure behaviour of the remediator itself

This is the part that must not become the next outage. Five properties, each with its mechanism:

| Property | Mechanism |
|---|---|
| **Safe on a healthy system** | Every predicate is a *corruption* predicate, not a heuristic. On the healthy live box (§2.6) all five detection queries return 0 rows, so the remediator issues 0 writes. This is AC-1 (§6). |
| **Safe on a rotted-but-BUSY system** | The healthy case is the easy one; this is the case the earlier draft did not cover. Rot repair carries a **quiescence precondition** (§3.1.3/§3.1.4) that declines to re-point any strategy an in-flight slot is traversing, and slot reclamation carries the **no-progress guard** (§3.2.1) that declines to free a slot whose task is still emitting events. Both defer rather than act. Deferral costs one 60 s tick when the referencing slot is not the blocked one; it **may be permanent in exactly the deadlock case**, which is why §3.1.3 keeps a boot-only fallback (see §10 risk 2). AC-8b, AC-8d. |
| **Idempotent** | Repairs are convergent writes (`parent_strategy_id → NULL`, array → filtered array, slot row → deleted). Re-running immediately finds 0 rows. This is AC-6. |
| **Bounded** | Every query carries an explicit `LIMIT` (`HATCHET_MAINT_BATCH`, default 100) and every connection carries `statement_timeout = '5s'` / `lock_timeout = '1s'`. A tick can never run long or take a heavy lock. Rows beyond the batch are simply picked up next tick. |
| **Safe concurrently** | Two launchd units run simultaneously (`deploy/com.automata.worker-2.plist`). Each tick opens with `SELECT pg_try_advisory_lock(16725, 69)`; **if not acquired the tick skips entirely** (logs `event: "scheduling.tick_skipped_locked"` at debug and returns). The lock is released in a `finally`. Detect-and-repair happen in one transaction under that lock, and every repair re-checks its predicate in the write's own `WHERE` (§3.1.3). |
| **Never fails a run** | The maintenance loop is entirely outside the workflow. It is `try/catch`-wrapped end-to-end; a thrown error logs `event: "scheduling.tick_error"` and the tick returns. An unreachable engine DB sets `engineReachable: false` and disables that tick — it must never crash the worker or block `worker.start()`. Modelled on the audit batcher's "delivery can NEVER fail the run" contract (`workflow.ts:163-169`). |

**Dry-run is a first-class mode, not a debug flag.** In `dry-run` the code path is identical
except that the mutating statement is replaced by its `SELECT` counterpart. Unit tests assert
that a fake client in dry-run mode receives **zero** statements matching `/^\s*(UPDATE|DELETE)/i`
(AC-7).

### 3.5 Config knobs

All parsed in `loadWorkerConfig` (`config.ts:106`) using the established exact-string-opt-in
pattern (`config.ts:134-140`).

| Env var | Type | Default | Meaning |
|---|---|---|---|
| `HATCHET_ENGINE_DATABASE_URL` | string | **unset** | Master gate. Unset → all three mechanisms are inert. |
| `HATCHET_ENGINE_TENANT_ID` | uuid | auto-resolve single tenant | Scope for every query. |
| `WORKER_SCHEDULING_MAINTENANCE` | `off`\|`dry-run`\|`on` | **`dry-run`** | Global mode for mechanisms 1 & 2. |
| `WORKER_CONCURRENCY_ROT_REPAIR` | `off`\|`dry-run`\|`on` | inherit | Per-mechanism override (mech 1). |
| `WORKER_SLOT_RECLAIM` | `off`\|`dry-run`\|`on` | inherit | Per-mechanism override (mech 2). |
| `WORKER_STUCK_QUEUED_DETECT` | `off`\|`on` | **`on`** | Mechanism 3. Read-only, so on by default. |
| `HATCHET_STUCK_QUEUED_S` | int | `900` | `scheduleTimeout`/2 (`workflow.ts:236`). |
| `HATCHET_WORKER_DEAD_AFTER_S` | int | `600` | Dead-generation heartbeat threshold ≈120 missed heartbeats (§3.2.1). Also the no-progress event window. |
| `HATCHET_SLOT_MIN_AGE_S` | int | `600` | Age floor for **orphan** slots only (§3.2.2 case (a)). |
| `HATCHET_MAINT_INTERVAL_S` | int | `60` | Maintenance tick period. Adds to the §3.2.2 latency bound. |
| `HATCHET_MAINT_BATCH` | int | `100` | Per-query `LIMIT`. |
| `WORKER_HEALTH_PORT` | int | **unset** | Optional loopback `/healthz`. |

Anything not exactly `on` / `off` / `dry-run` falls back to the safe value, per the
`config.ts:134-140` doctrine.

---

## 4. What is deliberately NOT changed

- **`GLOBAL_MAX_RUNS` and `PER_ORG_MAX_RUNS` stay at 1** (`workflow.ts:77`, `:88`). This ticket
  makes the single slot *recoverable*; raising it is #3b and gated on the memory validation
  described at `workflow.ts:80-87`.
- **The group name stays `'agent-run-global-memory-budget'`** (`workflow.ts:227`). No rotation —
  §3.1.1. Only the stale half of the comment at `workflow.ts:219-226` is updated to say the
  rename is now backed by a repairer.
- **`scheduleTimeout` stays 30m and `executionTimeout` stays 30m** (`workflow.ts:236-237`);
  `retries: 0` stays (`workflow.ts:245`).
- **No thread-state transitions.** A stuck-`QUEUED` detection produces a log line, a JSON field,
  and (optionally) a 503. It does **not** mark a thread failed, does not post a daemon event,
  does not cancel the Hatchet run. **Typed terminal causes and the state-machine sweep are #129.**
- **No `onFailure` changes** (`workflow.ts:554`). It is structurally incapable of covering this
  failure mode (§1) and is correct as-is for the mode it does cover.
- **No www / control-plane changes.** Zero files under `apps/www`.
- **No strategy-row garbage collection** — §3.1.4.
- **No migration off hatchet-lite** — §9 is an evaluation paragraph and nothing else.
- **No CI E2E anti-rot job.** That is #128; §7.3 explains how it reuses this ticket's helpers.
- **No per-PR concurrency key.** That is #126, which is blocked on this landing.

---

## 5. File-by-file change list

> **⚠ FLAG: 13 files, over the 10-file threshold. This is the file set; there is no alternative
> set.** The earlier draft offered "merge `scheduling-maintenance.ts` into `scheduling-health.ts`"
> as a way to come in under the cap. **That option is withdrawn** — it directly contradicts item
> 2's purity contract (no timers, no `process.env`, no fs), which §7.3 makes #128's import
> contract. A merged module would either break that contract or need the same split under a
> different name. The implementer must not have to choose between two inconsistent file sets, so
> the cap is exceeded knowingly and the justification stands on its own honest count: **three of
> the thirteen are edits of one to five lines** (compose header comment, package.json dep +
> script, workflow comment). Three more are substantive but conventional edits (config knobs,
> config test, README runbook section), two are test files, one is an 8-line compose overlay, and
> one is a two-line insertion into `worker.ts`. The genuinely new production surface is
> **three modules**.

**New (6):**

1. `packages/worker/src/agent-run/engine-db.ts` — ~90 LOC. `pg.Pool` factory from
   `HATCHET_ENGINE_DATABASE_URL`; the `SET LOCAL` hygiene preamble; tenant resolution; a
   `PgLike { query(text, params) }` interface so every consumer is unit-testable against a fake;
   `withAdvisoryLock(fn)`; `close()`.
2. `packages/worker/src/agent-run/scheduling-health.ts` — ~260 LOC. The five detection queries and
   two remediation queries of §3.1–§3.3, each as an exported function
   `(db: PgLike, opts: { tenantId, mode, limit, … }) => Promise<Finding>`. **Pure**: no timers, no
   `process.env`, no fs. This is the module #128 imports.
3. `packages/worker/src/agent-run/scheduling-maintenance.ts` — ~140 LOC. `runMaintenanceTick()`
   (advisory lock → mechanisms in order → snapshot write → structured logs, all `try/catch`),
   `startMaintenanceLoop()` (`setInterval` + `.unref()`, mirroring the batcher at
   `workflow.ts:183-185`), the snapshot writer, and the optional `/healthz` server.
4. `packages/worker/src/agent-run/scheduling-health.test.ts` — unit tests (§7.1).
5. `packages/worker/src/agent-run/scheduling-health.integration.test.ts` — dockerized tests (§7.2).
6. `packages/worker/docker-compose.hatchet.maintenance.yml` — **NEW, 8 lines.** The opt-in
   loopback port overlay of §3.0. The base compose file's `services`/`ports` are **not** edited.

**Edited (7):**

7. `packages/worker/src/hello/worker.ts` — two insertions in `main()`: `await
   reclaimEngineSlots({selfWorkerId: null})` after `claimNamespaceAndReclaim()` (`worker.ts:59`)
   and before `hatchet.worker(...)` (`worker.ts:60`); `startMaintenanceLoop(...)` after
   `hatchet.worker(...)` returns (`worker.ts:63`) and **before `await worker.start()` at
   `worker.ts:78`**. Both fully `try/catch`-guarded — neither may prevent boot.
8. `packages/worker/src/agent-run/config.ts` — the 12 fields of §3.5 on `WorkerConfig` (after
   `config.ts:79`) and their parsing in `loadWorkerConfig` (`config.ts:106`), following the
   exact-string pattern at `config.ts:134-140`.
9. `packages/worker/src/agent-run/config.test.ts` — cases for each new knob: default, valid
   value, garbage-value-falls-back-safe.
10. `packages/worker/docker-compose.hatchet.yml` — **header comment only, 2 lines.** Amend
    `:5-6` from "no host port" to "no host port **by default** — see
    docker-compose.hatchet.maintenance.yml for the opt-in loopback publish (#69)". **No change
    to any `services:` block**, so `hatchet:up` behaviour is byte-identical.
11. `packages/worker/package.json` — `pg: ^8.16.0` to `dependencies`, `@types/pg: ^8.15.2` to
    `devDependencies` (versions matched to `apps/www/package.json:103,138`), plus one new script
    `hatchet:up:maintenance` (§3.0). Existing `hatchet:up` (`:9`), `hatchet:down` (`:10`),
    `hatchet:logs` (`:11`) untouched.
12. `packages/worker/deploy/README.md` — a new **"Scheduling deadlock: diagnosis and recovery"**
    runbook section: the diagnosis queries in copy-pasteable
    `docker exec automata-hatchet-postgres-1 psql -U hatchet -d hatchet -c '…'` form (matching
    the existing convention at `scripts/uat/lib.ts:60-66` and `docs/uat/README.md:90-94`), how to
    read `scheduling-health.json`, **the §3.2.2 recovery-latency bounds (~11 min nominal, ~12 min
    alertable — alert on the latter, not on 5)**, the
    `hatchet:up:maintenance` opt-in, the flip-to-`on` promotion procedure, and the kill switches.
13. `packages/worker/src/agent-run/workflow.ts` — **3 lines.** Update the now-stale rot comment at
    `:219-226`: the rename did not prevent rot (§2.3), and a repairer now backs it. No code change.

---

## 6. Acceptance criteria

Each is pass/fail and independently checkable.

1. **Healthy system is a strict no-op.** Against the current live engine state (§2.6: 0
   `v1_concurrency_slot` rows, 0 `v1_task_runtime` rows, 0 `QUEUED` tasks), a full maintenance
   tick in mode `on` reports `rot.repaired = 0`, `slots.reclaimed = 0`, `stuckQueued.count = 0`,
   `healthy: true`, and **0 rows are touched** — asserted by comparing `xact_commit`-adjacent row
   counts before/after: `SELECT count(*) FROM v1_step_concurrency`, `v1_workflow_concurrency`,
   `v1_concurrency_slot` are identical, and no row's `parent_strategy_id`/`child_strategy_ids`
   changed. **PASS = zero writes.**
2. **Rot detection finds the live corruption.** Run the §3.1.2 query against the pilot engine as
   it stands today → returns exactly **1** row (`id = 5`, `parent_strategy_id = 4`). Run §3.1.4 →
   returns exactly **3** rows (ids 1, 3, 5). Any other count is a regression in the predicate.
3. **Rot repair is correct and complete.** After a repair pass on that state: §3.1.2 returns 0
   rows; §3.1.4 returns 0 rows; row 4's `child_strategy_ids` is still `{5}` (a valid same-version
   link was **not** clobbered); no row was deleted (`count(*)` unchanged in both tables); no row's
   `is_active` changed.
4. **Rot repair unblocks a real dispatch.** In the §7.2.1 harness: with rot present *and a
   demonstrably live worker registered*, a triggered run sits `readable_status = 'QUEUED'` for
   ≥ 30 s; after `repairConcurrencyRot`, the same run reaches `RUNNING` within 30 s. **This is the
   criterion that proves the fix, not the query.** The harness reaches the rotted state
   **empirically** — it re-registers with changed concurrency shapes in a bounded loop until the
   §3.1.2 or §3.1.4 detector fires — and **fails loudly** if the bound is exhausted without rot.
   It must NOT assert that any particular number of registrations produces rot (§2.3: the
   registration-#2-vs-#3 differentiator is unknown). The harness must also **record which repair
   path fired** — in-place under the §3.1.3 quiescence precondition, or the boot-only fallback —
   so that choice is made on evidence.
5. **Slot reclamation frees a SIGKILLed slot.** In the §7.2.2 harness, driving
   `deadAfterSeconds` and `minSlotAgeSeconds` as *parameters* (not env constants): after SIGKILL
   of a stub worker holding a filled slot, a second trigger sits `QUEUED`; `reclaimEngineSlots`
   deletes exactly **1** row and the second run reaches `RUNNING` within 30 s. The stub workflow
   carries an explicit `scheduleTimeout` long enough that the queued run cannot itself time out
   during the test. **No assertion in this AC may depend on `schedule_timeout_at`** — that floor
   was removed (§3.2.2).
5b. **Production recovery latency matches the documented bound.** With production defaults
   (`HATCHET_WORKER_DEAD_AFTER_S=600`, `HATCHET_MAINT_INTERVAL_S=60`), a unit-level assertion
   confirms the **nominal** bound is ~11 minutes (`dead + interval`) and the **alertable** bound
   the runbook publishes is ~12 minutes (`dead + 2 × interval`, allowing one lost advisory-lock
   tick under two launchd units). Both figures in `deploy/README.md` must match the constants in
   `config.ts`, and the ops alert threshold must use the **alertable** figure. Guards against the
   spec's own earlier error of advertising a latency the query could not deliver.
6. **Idempotent.** Immediately re-running any remediator after a successful pass touches **0**
   rows and logs no `*_repaired`/`*_reclaimed` event.
7. **Dry-run issues no writes.** With mode `dry-run` against the *corrupted* fixture, the fake
   `PgLike` records **0** statements matching `/^\s*(UPDATE|DELETE)/i`, while the findings report
   the same row counts as AC-2. Unit-level.
8. **A live worker's slot is never reclaimed** — five sub-cases, all must pass:
   a. Slot whose `v1_task_runtime.worker_id` heartbeated within `HATCHET_WORKER_DEAD_AFTER_S`
      ⇒ candidate query returns **0** rows.
   b. `$3` = self worker id ⇒ a slot owned by self is excluded **even if its heartbeat is stale**.
   c. `"Worker"."lastHeartbeatAt" IS NULL` (never heartbeated) ⇒ **0** rows (ambiguous = alive).
   d. **Partition guard.** Worker's heartbeat is stale past the threshold, **but** the task has a
      `v1_task_events_olap` row inside the dead window ⇒ **0** rows. This is the ENOMEM
      double-admission guard of §3.2.1 and is the most important assertion in this AC.
   e. Worker belongs to a **different `tenantId`** ⇒ **0** rows (§3.0 tenant-scope invariant).
8b. **Rot repair defers on a busy chain.** With a rotted strategy that a live
   `v1_concurrency_slot` references via any of `strategy_id`, `parent_strategy_id`,
   `next_strategy_ids`, `next_parent_strategy_ids` ⇒ the §3.1.3 repair touches **0** rows and
   logs a deferral; the detector still reports the finding. Same for the workflow-level repair
   against `v1_workflow_concurrency_slot`.
8c. **Same-version links are preserved.** After any workflow-level repair, no row whose child id
   belongs to the **same** `(workflow_id, workflow_version_id)` was stripped — specifically live
   row 4's `{5}` survives (§3.1.1 precision correction).
9. **Bounded.** Every emitted statement contains a `LIMIT`; asserted by a unit test that
   inspects the recorded statements. A fixture of 500 rot rows with `HATCHET_MAINT_BATCH = 100`
   repairs exactly 100 per tick.
10. **Concurrency-safe.** Two maintenance ticks started simultaneously against the corrupted
    fixture: exactly one performs the repair; the other logs `scheduling.tick_skipped_locked`
    and touches 0 rows. Final state identical to a single-tick run.
11. **Stuck-`QUEUED` detector fires at threshold and not before.** With
    `HATCHET_STUCK_QUEUED_S = 5` and a task queued 2 s → 0 findings; at 6 s → 1 finding carrying
    `external_id` and `queued_for_s ≥ 5`. The finding appears in `scheduling-health.json` and in
    exactly one structured log line per tick.
12. **No thread side-effects.** Grep proof: the diff contains no `fetch(` / `postRunFailed` /
    `daemon-event` reference in any new file, and touches zero files under `apps/www`. (#129
    boundary.)
13. **Master gate holds.** With `HATCHET_ENGINE_DATABASE_URL` unset, the worker boots normally,
    no pg connection is attempted, no snapshot file is written, and `worker.start()` is reached
    — verified by a boot test with the env var absent.
14. **Boot is never blocked.** With `HATCHET_ENGINE_DATABASE_URL` pointed at a dead
    host:port, the worker logs `scheduling.tick_error` / `engineReachable: false` and still
    reaches `worker.start()` within the normal boot budget.
15. `pnpm -C packages/worker test` and `pnpm tsc-check` are green.

---

## 7. Testing plan

### 7.1 Unit — pure, no docker (`scheduling-health.test.ts`)

Everything in `scheduling-health.ts` takes a `PgLike`. The fake records `{text, params}` and
returns canned `rows`. This layer proves the *decisions*, not the SQL semantics:

- **Healthy fixture** (all detection queries → `rows: []`) ⇒ every remediator returns
  `{touched: 0}` and issues zero mutating statements. (AC-1)
- **Corrupted fixture** — literally the live rows of §2.3, hard-coded — ⇒ step-level detector
  flags id 5 only; workflow-level flags ids 1, 3, 5; **id 4 is not flagged** (its child `{5}` is
  same-version). (AC-2)
- **Dry-run** on the corrupted fixture ⇒ 0 `UPDATE`/`DELETE` statements recorded. (AC-7)
- **Boundedness** ⇒ every recorded statement matches `/\bLIMIT\b/`. (AC-9)
- **Self-exclusion / tenant-scope / NULL-heartbeat** ⇒ the generated candidate SQL contains the
  `id <> $3`, `"tenantId" = $1` and `"lastHeartbeatAt" IS NOT NULL` clauses, and the fake returns
  0 candidates for each of the AC-8a–e fixtures. (AC-8)
- **No `schedule_timeout_at` gate** ⇒ an explicit negative assertion that no generated
  reclamation statement references `schedule_timeout_at`. This locks in the §3.2.2 correction so a
  future edit cannot silently reintroduce the 30-minute floor.
- **Quiescence precondition present** ⇒ every generated rot-repair statement references all four
  of `strategy_id`, `parent_strategy_id`, `next_strategy_ids`, `next_parent_strategy_ids`.
  (AC-8b)
- **Latency bounds** ⇒ nominal equals `HATCHET_WORKER_DEAD_AFTER_S + HATCHET_MAINT_INTERVAL_S`
  and alertable equals `HATCHET_WORKER_DEAD_AFTER_S + 2 × HATCHET_MAINT_INTERVAL_S`, both
  computed from the actual defaults. (AC-5b)
- **Threshold arithmetic** ⇒ default `stuckQueuedS` is 900 and equals half of the 30m
  `scheduleTimeout` at `workflow.ts:236` (a literal assertion so the two can't drift silently).
- **Tick resilience** ⇒ a `PgLike` that throws ⇒ `runMaintenanceTick()` resolves, does not
  reject, and reports `engineReachable: false`. (AC-14)
- **Advisory lock** ⇒ a fake whose `pg_try_advisory_lock` returns `false` ⇒ zero subsequent
  statements. (AC-10)

### 7.2 Integration — against dockerized hatchet-lite (`scheduling-health.integration.test.ts`)

Gated on `HATCHET_IT=1` (skipped otherwise, so CI and `pnpm -C packages/worker test` stay fast
and docker-free). `packages/worker/package.json` already runs vitest with
`--no-file-parallelism`, which these tests **require** — two suites mutating one engine DB would
be nondeterministic.

Shared fixture: `docker compose -f docker-compose.hatchet.yml down -v && up -d`, wait for the
`pg_isready` healthcheck (`docker-compose.hatchet.yml:29-34`), mint a tenant + worker token.
`down -v` is what makes each scenario start from provably empty tables.

#### 7.2.1 Reproducing concurrency-group rot deterministically

**The repro must be empirical, because §2.3's root cause is a demoted hypothesis.** The pilot box
rotted somewhere across three registrations, but registration #2 minted a *correct* head and #3 a
rotted one, and the differentiator is unknown. A test that hard-codes "three registrations produce
rot" would encode a guess and would fail confusingly the day the guess is wrong. So the harness
**loops until the detector fires**, with a bound:

```
1. Fresh engine (down -v; up -d), wait for the pg_isready healthcheck.
2. shapes = a generator of DISTINCT concurrency shapes for workflow `rot-probe`:
     [{'k1'}], [{orgId},{'k1'}], [{orgId},{'k2'}], [{'k2'},{orgId}], [{orgId},{'k3'}], …
3. FOR i IN 1..MAX_REGISTRATIONS (bound: 12):
     spawn child process Wi registering `rot-probe` with shapes[i];
     wait until its rows appear in v1_step_concurrency; SIGTERM Wi; await exit.
     IF detectStepConcurrencyRot() OR detectWorkflowConcurrencyRot() is non-empty:
        record `registrationsToRot = i`; BREAK.
4. ASSERT rot was observed within the bound. If the loop exhausts, FAIL with the
   full dump of both strategy tables — that is a genuine finding (the corruption
   no longer reproduces on this engine version) and must not be silently skipped.
   Log `registrationsToRot` on success: it is the empirical datum §2.3 lacks, and
   feeds the §3.1.4 upstream-source verification.
5. Spawn W_live with the CURRENT active shape, so a healthy worker is registered.
   Trigger a `rot-probe` run.
   ASSERT it stays readable_status='QUEUED' for >=30s WHILE W_live is
   demonstrably alive (Worker."lastHeartbeatAt" within 10s of now()).
                                     <- deadlock reproduced; the real repro
6. Run repairConcurrencyRot(mode:'on').
   ASSERT both detectors now return 0 rows; ASSERT no strategy row was deleted
   and no is_active flipped; ASSERT same-version child links survived.   (AC-3, AC-8c)
   RECORD whether the in-place repair fired or the quiescence precondition
   deferred it (AC-4's path-recording requirement).
7. ASSERT the run from step 5 reaches readable_status='RUNNING' within 30s.  (AC-4)
8. Run repairConcurrencyRot again. ASSERT 0 rows touched.                    (AC-6)
```

Step 5 is the load-bearing one. If the trigger *doesn't* deadlock there, the repro is incomplete
and the test must fail loudly rather than silently asserting only on the SQL predicate — a
detector that matches rows nobody is blocked by is worthless. Step 4 alone is not sufficient to
pass.

**Anticipated interaction with the quiescence precondition (§3.1.3).** At step 6 there *is* a
queued slot, and it may reference the rotted strategy — in which case the in-place repair
correctly defers and step 7 fails. That is not a test bug; it is the harness discovering that
in-place repair cannot serve this case, and it selects the boot-only fallback that §3.1.3 already
specifies. The harness must therefore run step 6 in both modes and report which one unblocks step
7. **Choosing between them is an implementation output of this ticket, not a spec assumption.**

*If step 5 proves flaky across hatchet-lite patch versions*, the fallback is to assert the
corrupted-pointer state (step 4) plus a **synthetic** deadlock: hand-insert the rotted
`parent_strategy_id` into a freshly-registered chain via SQL, deterministic by construction, and
keep step 5 as a separate `it.skipIf(!process.env.HATCHET_IT_STRICT)` case. Taking this fallback
weakens AC-4 and must be recorded as a conscious decision (§10).

#### 7.2.2 Reproducing SIGKILL slot exhaustion deterministically

Two things make this deterministic and fast, and **both are consequences of §3.2.2's corrections**:

1. **Every staleness input is a function parameter**, never an env constant read inside the query
   builder: `deadAfterSeconds`, `minSlotAgeSeconds`, `selfWorkerId`. The test passes
   `deadAfterSeconds: 2` and never waits 600 seconds.
2. **There is no `schedule_timeout_at` gate.** The earlier draft's floor would have forced this
   test to wait out the victim's full schedule window; with it removed, reclamation is gated only
   by the two parameters above. The stub still sets an explicit `scheduleTimeout: "10m"` so that
   R2 cannot itself schedule-time-out mid-test — a *test-hygiene* choice, not a gate the
   mechanism depends on.

```
1. Fresh engine. Register stub workflow `slot-hog`:
     concurrency:      [{ expression: "'hog'", maxRuns: 1, GROUP_ROUND_ROBIN }]
     scheduleTimeout:  "10m"      // so R2 survives the test window
     executionTimeout: "10m"
     task fn: await sleep(10 * 60_000)   // never completes during the test
2. Spawn stub worker P1 as a CHILD PROCESS (must be a real OS process — the point
   is to SIGKILL it; an in-process worker cannot be killed without killing vitest).
3. Trigger run R1. Poll until:
     v1_concurrency_slot has a row with is_filled = true, AND
     v1_task_runtime has worker_id = <P1's worker id>.
4. process.kill(P1.pid, 'SIGKILL')   <- no drain, so the engine never sees a release.
5. ASSERT the filled slot row still exists (the leak).
6. Spawn stub worker P2 (a live, healthy worker for the same workflow).
   Trigger run R2. ASSERT R2 stays readable_status='QUEUED' for >=30s.
                                                        <- exhaustion reproduced
7. PARTITION GUARD, asserted BEFORE the happy path (AC-8d). While R1's task still
   has a recent v1_task_events_olap row inside the window, call
   reclaimEngineSlots({ deadAfterSeconds: 2, ... }).
   ASSERT 0 rows deleted — the no-progress guard refuses to reclaim a task that
   looks like it is still doing something. Then wait until no event for R1 is
   newer than 2s.
8. Run reclaimEngineSlots({ deadAfterSeconds: 2, minSlotAgeSeconds: 0,
                            selfWorkerId: <P2's id>, mode:'on' }).
   ASSERT exactly 1 row deleted, and that row's key = 'hog'.
9. ASSERT R2 reaches readable_status='RUNNING' within 30s.                  (AC-5)
10. ASSERT P2's own slot is NOT reclaimed by a second call with the same args
    (self-exclusion + live heartbeat).                                      (AC-8a/b)
11. Re-run reclaimEngineSlots. ASSERT 0 rows deleted.                       (AC-6)
```

Steps 7 and 10 are the safety assertions and matter more than step 9: a reclaimer that frees live
slots turns a stall into an ENOMEM crash (§3.2.1) — a strictly worse outcome than the deadlock
being fixed. If the harness can only make some of these pass, **the safety ones win and the
mechanism stays at `dry-run`.**

Note the test exercises the **periodic** reclaim path (§3.2.2b), which is the primary one; it
calls `reclaimEngineSlots` directly rather than restarting a worker, because launchd's ~15 s
`KeepAlive` relaunch means the boot path would find nothing at these timescales anyway.

#### 7.2.3 Concurrency and no-op cases

- **AC-10**: `Promise.all([runMaintenanceTick(), runMaintenanceTick()])` against the corrupted
  fixture ⇒ one repairs, one skips; final state equals the single-tick result.
- **AC-1**: run a full tick against a *freshly registered, never re-registered* engine ⇒ snapshot
  `healthy: true`, all counters 0, and `count(*)` of all three tables unchanged.
- **AC-11**: insert a `v1_tasks_olap` row with `readable_status='QUEUED'` and a backdated
  `inserted_at`; assert the detector fires only past `HATCHET_STUCK_QUEUED_S`.
- **AC-8f (boot path)**: bring the engine up with a stale dead generation (heartbeat backdated
  past the threshold via direct SQL), then run the **boot-time** reclaim with `selfWorkerId: null`
  ⇒ the slot is freed. Paired with the negative case that gives §3.2.2b its teeth: with the dead
  generation's heartbeat only ~15 s stale (simulating launchd's `KeepAlive` relaunch), boot
  reclaim finds **0** rows — confirming the periodic tick, not boot, is the load-bearing path.
- **AC-8e**: insert a `"Worker"` row with a *different* `tenantId` holding a stale heartbeat ⇒
  reclaim returns 0 rows.

### 7.3 Reuse contract for #128

`scheduling-health.ts` exports its detectors as pure `(db, opts) => Promise<Finding[]>` functions
with **no** env reads, no timers, no fs, and no logging. #128's CI E2E can therefore
`import { detectStepConcurrencyRot, detectWorkflowConcurrencyRot } from
"@terragon/worker/agent-run/scheduling-health"` — the package's `exports` map already exposes
`"./*": "./src/*.ts"` (`packages/worker/package.json`) — register N≥50 ephemeral groups, and
assert `detect*(…) === []` at the end. That is the entire integration surface; **#128 needs no
change in this ticket.**

The `docker compose down -v` / register-until-rot harness of §7.2.1 is deliberately *shaped* so
#128 can reuse it (fresh-engine fixture, shape generator, detector call), and §7.2.1's
`registrationsToRot` datum directly informs #128's threshold choice. **Extracting it into a shared
exported helper is #128's work, not this ticket's** — scheduling the extraction here would commit
this ticket to an API for a consumer that does not exist yet, and #128 is better placed to know
what shape it needs. This ticket ships the detectors under the purity contract above and stops.

---

## 8. Rollback

Every mechanism is behind an env-var kill switch, and the **master gate is absence of
configuration**, which is the strongest possible rollback: an operator who does nothing gets
today's behaviour exactly.

| Switch | Ship default | Rationale |
|---|---|---|
| `HATCHET_ENGINE_DATABASE_URL` | **unset** | Nothing runs. A box that keeps using plain `hatchet:up` (`package.json:9`) has no published port to point it at, so it is untouched by this ticket. |
| `WORKER_SCHEDULING_MAINTENANCE` | **`dry-run`** | On a box that *does* set the URL, mechanisms 1 & 2 **detect and log but do not write**. |
| `WORKER_CONCURRENCY_ROT_REPAIR` | inherit (`dry-run`) | Per-mechanism escape hatch. |
| `WORKER_SLOT_RECLAIM` | inherit (`dry-run`) | Per-mechanism escape hatch. |
| `WORKER_STUCK_QUEUED_DETECT` | **`on`** | Read-only; cannot corrupt anything. Ships enabled. |
| `WORKER_HEALTH_PORT` | **unset** | No new listener by default. |

**Ship state: dry-run.** This is deliberate: it matches the fail-closed boot-gate doctrine in
`packages/worker/src/agent-run/assert-auth.ts` (invoked at `worker.ts:49`) and the exact-string
degrade-to-safe parsing pattern at `config.ts:134-140` — a misconfigured box degrades to the
*safe* mode. Rot repair and
slot reclamation mutate engine-internal state; they earn `on` only after the §3.1.4
implementation-verify step and after a dry-run tick on the pilot box has reported the §2.3
findings *and nothing else*.

**Promotion procedure** (documented in the `deploy/README.md` runbook, item 12 of §5):
1. Bring the engine up with the overlay: `pnpm --filter @terragon/worker hatchet:up:maintenance`
   (§3.0). Set `HATCHET_ENGINE_DATABASE_URL`. Restart the worker with SIGTERM + wait — never
   `launchctl kickstart -k`, which is SIGKILL (`worker.ts:65-76`).
2. Observe ≥24 h of `scheduling-health.json`; confirm the reported rot rows match §2.3 exactly
   and `slots.reclaimable = 0` on a healthy box.
3. Flip `WORKER_CONCURRENCY_ROT_REPAIR=on`, restart, confirm the one-time repair, confirm
   subsequent ticks report 0. **Prerequisite: the §3.1.4 upstream-source verification is done.**
4. Flip `WORKER_SLOT_RECLAIM=on` separately, **at least a day later**, and only after the partition
   guard (§3.2.1) has been reviewed for this box's network topology. A box on flaky connectivity
   should stay at `dry-run` indefinitely — detection still works, and the runbook's manual
   reclaim command covers the rare real case.

**Rollback procedure:** unset one env var and SIGTERM-restart. To roll back a *repair that
already happened*: the repair only NULLs a pointer and strips dangling array ids, so the "undo"
is to restart the worker, which re-registers the workflow and mints a fresh chain. There is no
state to restore — this is a consequence of choosing pointer repair over row deletion (§3.1.1).

---

## 9. Migration-off-hatchet-lite: evaluation criteria

`hatchet-lite:v0.94.10` is pinned deliberately (`docker-compose.hatchet.yml:8-10` — the `-dev`
images embed a public JWT signing key and void tenant isolation), and this ticket does not
propose moving off it. But §2.3 documents a real corruption of the engine's own concurrency-chain
pointers whose **cause is not yet known** (the naive-id-arithmetic explanation is falsified by row
3), and the honest framing is that this ticket ships a **repairer for someone else's bug that we
cannot yet explain**. That is acceptable while the repair is small, provable, and idempotent, and
while the alternative costs more than it saves. The lever should be pulled when any of the
following becomes true: **(a)** the repair surface grows — if a third or fourth engine table
needs surgery, or if the repair must start deleting rather than re-pointing, we are maintaining a
fork of the engine's scheduler semantics in TypeScript and should stop; **(b)** the pointer
invariant proves version-unstable — if the §3.1.4 source verification has to be redone on each
hatchet-lite bump, or a bump silently changes the chain representation, the repairer becomes a
correctness hazard tied to a version we don't control — a risk that is materially higher for as
long as §3.1.4(d) remains unanswered, since a repairer whose target defect we cannot explain is
one whose version-stability we cannot predict either; **(c)** an upstream fix lands — the
cheapest possible migration is a version bump, so a hatchet-lite release that fixes chain
assignment retires §3.1 entirely and should be taken immediately (this is the *most likely* exit
and argues strongly for keeping the repair minimal and easy to delete); **(d)** the capacity story
changes — the moment `GLOBAL_MAX_RUNS` rises above 1 (#3b), a wedged slot stops being a 100%
outage and the urgency of engine-internal surgery drops, while the *other* direction — needing
real multi-node scheduling, priority classes, or a DLQ (which hatchet-lite has none of, per
`docs/research/hatchet-enterprise-practices.md:16-19`) — argues for full Hatchet or a different
substrate on its own merits; **(e)** operational cost exceeds the migration cost — if this
repairer plus #128's anti-rot suite plus the runbook consume more than roughly a week of
engineering per quarter, the ~2-3 week cost of standing up full self-hosted Hatchet (separate
engine/API/dashboard containers, a real migration of the tenant + worker tokens, and re-doing the
`assert-auth-enabled.sh` gate at `packages/worker/scripts/assert-auth-enabled.sh:79-89`) is the
cheaper line. Until at least two of these hold, repairing in place is correct: it is ~400 LOC
behind a kill switch against a multi-week substrate migration on a pilot box.

---

## 10. Effort per component

| Component | Est. | Notes |
|---|---|---|
| §3.0 engine-db reach (`engine-db.ts`, compose overlay + script, `pg` dep) | **0.5 d** | Mechanical; the advisory-lock helper is the only subtlety. |
| §3.1 rot detect + repair (`scheduling-health.ts`, both tables) | **1.25 d** | SQL written and verified against live rows. Includes the §3.1.4 upstream-source verification (which now also owns root-cause determination, §2.3) and the quiescence preconditions. |
| §3.2 slot reclamation | **1.0 d** | SQL written; the dead-generation predicate, the no-progress partition guard, and the AC-8a–e negative cases are the whole of it. |
| §3.3 stuck-QUEUED detector | **0.5 d** | Two read-only queries + threshold plumbing. |
| §3.4/§3.5 maintenance loop, snapshot, config knobs, optional `/healthz` | **0.75 d** | Timer + fs + `loadWorkerConfig` fields + `config.test.ts`. |
| §7.1 unit tests | **0.75 d** | Fixtures are the §2.3 live rows; fast to write, high value. |
| §7.2 integration harness | **2.25 d** | **The dominant cost and the main risk.** Spawning real child-process workers, the `down -v` fixture, the bounded register-until-rot loop, and proving the QUEUED-with-live-worker deadlock are all fiddly. Budget a spike if step 5 of §7.2.1 doesn't reproduce. |
| §5 items 12–13 runbook + comment fix | **0.5 d** | Diagnosis queries in copy-paste form; promotion + rollback; the ~11-min latency bound. |
| **Total** | **~7.5 d** | Roughly 40% is the integration harness. |

**Three risks, in order, each with its recorded decision point:**

1. **§7.2.1 step 5 — proving the *deadlock*, not merely the corrupted pointers, reproduces
   deterministically in a fresh container.** The fallback (synthetic rot injection + a
   strict-mode-only live deadlock test) exists so this cannot block the ticket, but taking it
   weakens AC-4 and must be a conscious, recorded decision.
2. **In-place rot repair may be permanently deferred by its own quiescence precondition**
   (§3.1.3) in exactly the deadlock case it exists to fix — because the blocking slot is the thing
   referencing the rotted strategy. §7.2.1 step 6 is instrumented to detect this. If it holds, the
   ticket ships the **boot-only** repair path instead, which costs a worker restart of recovery
   latency and should be stated plainly in the runbook rather than quietly adopted.
3. **The §2.3 root cause is unresolved.** This ticket ships a repairer, not a preventer, and that
   is a deliberate scope choice — but it means rot will keep recurring at whatever rate
   registration produces it, and the repairer is load-bearing indefinitely until either the
   §3.1.4 source verification explains the mechanism or an upstream fix lands (§9 criterion (c)).
