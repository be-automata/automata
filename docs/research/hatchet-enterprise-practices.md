# Hatchet Enterprise Best Practices → Automata `agent-run` Execution Plane

Research deliverable (2026-07-25) mapping Hatchet (hatchet.run, TS SDK v1) enterprise-grade
practices to Automata's remote agent-run plane. Sourced from primary docs (docs.hatchet.run) +
hatchet-dev GitHub. Feeds the enterprise-hardening roadmap and the system-architect review.

## Top 8 gaps to close (ranked, agent-run specific)

1. **Exactly-once GitHub review post** `[MUST]` — Hatchet is **at-least-once**; a redelivery or
   mid-run crash-retry can double-post a customer review. Structure the workflow as
   `[agent-review step] → [publish-review step]`, make publish the SOLE GitHub writer with a
   **verdict-aware idempotency key** (reuse the existing commit+verdict supersede-dismiss
   single-writer channel), and model the post as a durable checkpoint so replay skips it. Mark
   auth/PR-gone/permission failures `NonRetryableException`. Highest-visibility correctness risk.
2. **On-failure task → www terminal event + stuck-thread watchdog** `[MUST]` — add an on-failure
   task that calls back `/api/daemon-event` with a terminal failure so www marks the thread failed
   (+ posts a "review couldn't complete" comment) instead of a silent "working…" hang. Add a
   www-side watchdog for threads past SLA. Covers Hatchet's own "Running-with-no-step" footgun
   (GH #1085/#1147), dead workers, and the credits-exhausted stall (the #1 stalled-run cause).
   Hatchet has **no built-in DLQ** — the durable record must be in www/Neon, not the dashboard.
3. **Per-org fairness via `GROUP_ROUND_ROBIN` on `org_id`** `[MUST]` — today the pilot is a fixed
   concurrency=1 FIFO worker, so a big review head-of-line-blocks every tenant. Add a workflow
   concurrency key `expression: input.org_id` with per-org `maxRuns`, and stack a second key on
   `input.repo` (or `org:repo`). This is the direct product answer to "one org can't starve
   another," and it's missing today.
4. **≥2 workers + graceful SIGTERM drain** `[MUST]` — a single launchd worker means every
   deploy/restart drops the in-flight review. Run ≥2 workers so deploys roll one at a time;
   implement drain-on-SIGTERM (stop accepting, finish the minutes-long review, then exit) rather
   than `kickstart -k` mid-run. Watch for zombie/leaked workers (Hatchet's documented #1 worker
   bug) — ensure the launchd unit reaps the whole process group. Pin workflow version across a deploy.
5. **Fail-closed auth-enabled deploy gate** `[MUST]` — wire `assert-auth-enabled.sh` into
   worker/engine boot so a `-dev`/auth-disabled image (which embeds a **public/shared JWT signing
   key** → tenancy void) never launches. Known highest-severity tenancy footgun.
6. **Non-retryable classification** `[SHOULD]` — mark auth/PR-gone/permission errors
   `NonRetryableException` so they route to on-failure instead of burning 10× backoff of agent minutes.
7. **End-to-end OTel trace join** `[SHOULD]` — the TS OTel instrumentor IS supported (correct the
   "Python-only" myth). Turn it on with `enableHatchetCollector:false`, export to your own
   collector, and propagate `traceparent` from www dispatch → worker → `/api/daemon-event` →
   GitHub post. Dimension every SLO on `org_id`; alert on scheduling-timeout, heartbeat gap,
   credits-exhausted, P95 run latency, failure/retry rate.
8. **`CANCEL_IN_PROGRESS` on `org:thread:PR` + Task Slot Cost** `[SHOULD]` — a new push cancels the
   stale in-flight review instead of posting an outdated verdict; model agent-run memory weight with
   Task Slot Cost to scale off the concurrency=1 pin without an ENOMEM wall.

**Pre-GA fork (decide, not a gap):** Hatchet Cloud vs self-hosted `hatchet-ha`. Self-hosting means
owning partitioned Postgres + RabbitMQ — Hatchet's own documented scale cliff. For a small team,
Cloud likely wins; **worker HA (#4) matters far more than engine HA at pilot volume**. Note: CF
Workers can't do gRPC, so www must dispatch over REST — keep OLAP/analytics off the transactional engine.

## By area (mechanism → best practice → recommendation → priority)

### 1. Reliability & durability
- **Mechanism:** at-least-once delivery, Postgres-persisted transactional state; `retries=N` +
  `backoff_factor`/`backoff_max_seconds`; `ctx.RetryCount()`; `NonRetryableException`; **durable
  execution** (event log + replay-from-checkpoint → approaches exactly-once); child dispatch
  deduped by idempotency key even across parent retries. Docs: architecture-and-guarantees,
  retry-policies, durable-execution, idempotency.
- **Best practice:** treat platform as at-least-once; push the real exactly-once to the side-effect
  boundary (own idempotency key + durable checkpoint); retries only for idempotent steps.
- **For agent-run:** the GitHub-post exactly-once problem (gap #1). `[MUST]`

### 2. Concurrency & fairness
- **Mechanism:** CEL concurrency keys (`expression`,`maxRuns`); `GROUP_ROUND_ROBIN` /
  `CANCEL_IN_PROGRESS` / `CANCEL_NEWEST`; stacked expressions → hierarchical isolation; rate limits
  (separate); worker slots (default 100) + Task Slot Cost. Docs: home/concurrency, round-robin,
  cancel-in-progress, rate-limits, workers.
- **Best practice:** per-tenant fairness at the workflow concurrency layer (round-robin on tenant);
  slots are physical caps, concurrency keys are the fairness/isolation cap.
- **For agent-run:** gaps #3, #8. `[MUST]`/`[SHOULD]`

### 3. Failure handling
- **Mechanism:** on-failure task; **no DLQ** (dashboard record + bulk-retry is the DLQ);
  cancellation + bulk retry/cancel; known "Running-with-no-step, not retried" stuck state
  (GH #1085/#1147). Docs: on-failure-tasks, error-handling, retries/overview.
- **Best practice:** on-failure emits alert + records in YOUR store + transitions domain terminal;
  build a reconciler for the stuck-Running class.
- **For agent-run:** gap #2. `[MUST]`

### 4. Observability
- **Mechanism:** OTel instrumentor (TS supported); producer/consumer spans; attrs
  `hatchet.tenant_id`/`worker_id`/`workflow_run_id`/`step_run_id`/`action_name`; W3C traceparent
  auto-injected; `enableHatchetCollector:false` to use your own collector; dashboard + OLAP. Docs:
  home/opentelemetry.
- **Best practice:** ship spans to your own OTLP collector; alert on queue depth/scheduling
  latency/P95/failure+retry rate/heartbeat/SCHEDULING_TIMED_OUT; SLOs per-tenant.
- **For agent-run:** gap #7. `[SHOULD]`

### 5. Worker lifecycle & deploys
- **Mechanism:** slots cap in-flight; workers register tasks on connect; multiple workers can
  register the same task → horizontal scale; heartbeat liveness (zombie/leaked workers = #1 bug);
  workflow versioning (in-flight stays on its version — confirm before relying). Docs: workers,
  troubleshooting-workers.
- **Best practice:** N≥2 workers + rolling replacement + drain on SIGTERM; health-gate rollout;
  never hard-kill with a run in flight.
- **For agent-run:** gap #4 (weakest area today). `[MUST]`

### 6. Security & multi-tenancy
- **Mechanism:** tenant is first-class; tenant-scoped tokens; **`-dev`/auth-disabled images embed a
  public signing key → tenancy void** (confirmed footgun).
- **Best practice:** short-lived narrowly-scoped tokens; rotate signing keys; never run
  auth-disabled customer-facing; secrets out of logs.
- **For agent-run:** gap #5; token=org+thread+short-TTL, worker validates tenant_id vs run;
  per-run rotating tunnel is fine as long as the TOKEN (not URL) is the trust anchor. `[MUST]`/`[SHOULD]`

### 7. Self-hosting vs Cloud
- **Mechanism:** Postgres persistence + table partitioning; PGMQ or RabbitMQ; separated OLAP;
  `hatchet-ha` Helm (split gRPC/controllers/scheduler + Postgres HA + RabbitMQ ≥3). Docs:
  self-hosting, high-availability, postgres-partitioning blog.
- **Best practice:** start Postgres-only (PGMQ); managed Postgres HA; split engine/OLAP/scheduler;
  own partition+retention maintenance before volume.
- **For agent-run:** pilot self-hosted single engine is fine; decide Cloud-vs-HA pre-GA; worker HA
  first. `[NICE-TO-HAVE now / SHOULD pre-GA]`

## Verification caveats
- Per-subtask idempotency-key API + worker heartbeat-timeout constant were search-surfaced; read
  `/v1/idempotency` + the `home/` troubleshooting-workers page directly before building (v1 path 404'd).
- TS workflow-versioning "in-flight stays on version" is the standard model but confirm against the
  versioning doc before relying on it for zero-downtime deploys.

## Sources
architecture-and-guarantees · durable-execution · directed-acyclic-graphs · retry-policies ·
error-handling · home/concurrency (+round-robin, +cancel-in-progress) · rate-limits · workers ·
troubleshooting-workers · on-failure-tasks · retries/overview · opentelemetry · self-hosting
(+high-availability) · hatchet.run/blog/postgres-partitioning · github.com/hatchet-dev/hatchet
(issues #1085, #1147, #1158)
