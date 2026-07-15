# ADR-002: Per-org execution plane — control/execution split, BYO Anthropic credentials

- **Status:** Accepted (2026-07-15 — authored in the operator's multi-tenancy session;
  provenance confirmed by the operator; reviewed by the platform-convergence lead session)
- **Date:** 2026-07-15
- **Context source:** orch-agents `.planning/MULTI-TENANCY-ASSESSMENT.md` (W0/W4/W5),
  `.planning/PLATFORM-CONVERGENCE-OVERVIEW.md` §8.1, Hatchet tenant-scoping spike
  (hatchet-dev/hatchet @ `301391d`, v0.94.10)
- **Deciders:** operator + platform-convergence program
- **Relates to:** ADR-001 (tenant-scoping enforcement — the *query* layer; this ADR is the
  *execution* layer)
- **Supersedes / superseded by:** —

## Context

ADR-001 fixed where tenant rows are read. This ADR fixes **where agent processes run and whose
credentials they hold** — the half of tenancy that a query accessor cannot reach.

The orch-agents execution model we are migrating in is single-tenant by construction:

- **Agents run in-process.** In the deployed default (`AGENT_SPAWN_MODE=sdk`,
  `orch-agents/src/index.ts:511`), orchestration, permission evaluation, and event handling all
  run inside one Node process. There is **no OS-level isolation** — no containers, no cgroups,
  no namespaces, no per-run uid. Git worktrees separate **files**, not memory, network, or blast
  radius.
- **Untrusted branches execute code.** `sdk-query-factory.ts:331-337` sets `settingSources` to
  `user,project`; the code's own comment concedes `'project'` loads repo-controlled
  `.claude/settings.json` — **hooks and permissions** — from the checked-out, possibly untrusted
  PR branch. The bot reviews PRs **including from outside contributors**, so the attacker need
  not be a customer.
- **One key encrypts everything.** The secret store derives a single process-wide `masterKey`
  (`secret-store.ts:17-64`) covering every row for every repo.
- **The GitHub App private key sits next to the agent.** `/etc/orch-agents/github-app.pem`, owned
  by `orch` — the uid agents run as. `github-app-auth.ts:83-131` mints installation tokens
  in-process for **any** owner.
- **No memory ceiling exists anywhere.** No `--max-old-space-size`, no ulimit, no cgroup. Capacity
  is `max_concurrent_per_org: 6` on one 7.6GB VPS, viable only because an 8GiB swap file was
  provisioned to clear a `fork/posix_spawn` ENOMEM wall.

Composed, today's shape is: **an outside contributor opens a PR against Client A's repo → hooks
execute next to Client B's credentials.** Single-tenant that is a bad day. Multi-tenant it is a
breach of customers' credentials that we would have to disclose, and it will fail any client
security review.

**Inference credentials are a second, independent problem.** Prod authenticates agents with
`CLAUDE_CODE_OAUTH_TOKEN` (`provision.sh:605`, minted by `claude setup-token`) — a Claude Pro/Max
**subscription** credential, not an Anthropic API key. That single token means: one account's rate
limits shared by every tenant (already the cause of "credits exhausted" stalls at **two** orgs);
**no per-tenant cost attribution**, so usage cannot be metered or billed; and reselling subscription
capacity to third parties is a terms violation. Note there is **no `ANTHROPIC_*` reference in
orch-agents `src/` at all** — the SDK inherits credentials from ambient process env. That detail is
load-bearing below.

**The enabling spike result.** Hatchet workers are **tenant-scoped**, verified from source:
`ValidateTenantToken` derives tenantId from the JWT's **signed `sub` claim`** (audience, issuer,
issued-in-past all verified; `token_id` checked against the DB for revocation and expiry). The
AuthN middleware is chained on **every** unary and stream call (`grpc/server.go:264`), carries no
build tag, and sits outside the `if s.insecure` branch — `SERVER_GRPC_INSECURE` is transport-only.
Handlers read `ctx.Value("tenant")`, never a request field, and the data layer is compound-keyed:
`GetWorkerForEngine(ctx, tenantId, workerId)` (`dispatcher/server.go:200`) makes a worker naming
another tenant's `workerId` fail the lookup. Workers connect **outbound gRPC only**.

## Decision

Adopt a **shared control plane / per-org execution plane** split.

1. **Control plane (shared, multi-tenant):** `apps/www` + Better Auth orgs, the Drizzle/Postgres
   application data, the Hatchet engine and its dedicated Postgres, and the webhook gateway. This
   tier — and **only** this tier — holds cross-tenant secrets: the GitHub App private key, the
   secret-store master key, and Hatchet's JWT signing keyset.

2. **Execution plane (one per org):** a Hatchet worker per tenant, registered with that org's
   `HATCHET_CLIENT_TOKEN`. Hatchet's tenant scoping (above) guarantees it receives only its own
   org's tasks. It holds **only that org's** credentials, and runs in a container with a cgroup
   memory limit.

3. **Credential placement rules — the load-bearing part.** Per-org workers are *theatre* unless:
   - The **GitHub App private key never leaves the control plane.** The control plane mints a
     short-lived, **installation-scoped** token per task and passes it as step input. A compromised
     worker then holds an expiring token for its own org only — not a key that mints tokens for
     every installation.
   - The **secret-store master key never leaves the control plane.** The control plane decrypts and
     injects only the resolved secrets that task needs.
   - The **Anthropic credential is the org's own**, present in that worker's env only.

4. **BYO Anthropic credentials — API keys only.** Store on the existing
   `agentProviderCredentials` table with `type = 'api-key'` (`apiKeyEncrypted`). **Reject
   `type = 'oauth'` for Claude**: that column shape fits a `claude setup-token` subscription
   credential, and accepting one inherits the client's terms violation, shares one account's rate
   limits, and takes custody of a credential granting access to their entire Claude account rather
   than a scoped API budget. Enforce at write time, not in documentation — the two are trivially
   confusable and the failure is silent.

5. **Never deploy Hatchet `-dev` images.** See "Deployment guard" below.

**Recommendation in three sentences:** Split the control plane from a per-org execution plane so
each tenant's agent runs in its own memory-capped container holding only its own credentials,
because that converts the untrusted-PR-branch execution path from a cross-tenant breach into a
tenant-local risk the customer already accepts by running Claude Code at all. Keep the GitHub App
key and the secret-store master key in the control plane and hand workers only short-lived,
org-scoped tokens, or the split buys nothing. Ship BYO API keys first — under this topology
ambient worker env is already per-org, so it needs near-zero executor code — and treat
platform-supplied inference as the same seam with a different key.

## Options considered

### Option A — Shared worker pool, per-task credential injection

One pool of workers serving all tenants; the control plane injects the right org's credentials per
task.

- **Pro:** Cheapest. No per-tenant idle cost, one deployment, no orchestration story needed.
- **Con — fatal:** A single process holds many tenants' credentials in memory over its lifetime.
  The untrusted-branch execution path (`settingSources: 'project'`) reaches all of them. This is
  today's architecture with extra steps; it does not survive a security review. **Rejected.**

### Option B — Per-org worker process on a shared host

One OS process per tenant, same host, same uid.

- **Pro:** Credentials are per-process; the common case is isolated. Cheap to operate.
- **Con:** Shared kernel, filesystem, and uid — a worker can read sibling workers' env, `/proc`,
  and worktrees. Still **no memory ceiling**, so one tenant's runaway SDK session ENOMEMs its
  neighbours (exactly the failure the prod swap file papers over). Better than A, not defensible.

### Option C — Per-org container (**chosen**)

One container per tenant: namespaces + cgroups, its own env, its own worktree volume.

- **Pro — the blast radius collapses to the tenant's own credentials.** An outside contributor's
  PR against Client B's repo reaches Client B's own Anthropic key and Client B's own repo. That is
  their key, their repo, their risk — the same exposure they already accept running Claude Code
  themselves. It stops being a cross-tenant breach.
- **Pro — it closes W5's memory gap as a side effect.** Per-tenant cgroups supply the ceiling that
  does not exist today, and make one org unable to ENOMEM another. This is the mechanism that
  eventually retires the `max_concurrent_per_org: 6` + swap-file arrangement.
- **Pro — BYO-key becomes near-free.** Since orch-agents' SDK reads credentials from **ambient
  env**, and ambient env is now per-org, BYO-key is a provisioning concern rather than an executor
  change.
- **Pro — the idle floor is avoidable.** Hatchet queues tasks for a tenant with no live worker
  (see "Scale-to-zero" below), so a tenant's worker need only exist while they have work. This is
  what makes the per-tenant cost model viable rather than a standing rent.
- **Con:** N deployments with version-skew risk, and a real container-orchestration dependency the
  current www+broadcast+PG+Redis+MinIO compose stack does not have. Scale-to-zero trades the idle
  floor for a **cold-start deadline** (below).

### Option D — Per-org VM, or BYOC (worker in the client's own cloud)

- **Pro:** Strongest isolation. BYOC is the purest form of "bring your own token" — the credential
  never leaves the client's infrastructure — and outbound-only gRPC makes it genuinely feasible.
- **Con:** Highest cost and support burden.
- **Disposition:** not v1. Reserve BYOC as the **enterprise tier**; Option C's seam supports it
  unchanged. If offered, `SERVER_GRPC_INSECURE` **must** be false or the bearer token crosses the
  internet in plaintext.

## Scale-to-zero and the cold-start deadline

Verified from source: **Hatchet queues tasks for a tenant whose worker is offline — but only for
5 minutes by default.** At enqueue the task is stamped
`schedule_timeout_at = CURRENT_TIMESTAMP + convert_duration_to_interval(schedule_timeout)`, with
the duration coalescing to `'5m'` (`pkg/repository/sqlcv1/workflows.sql:303`;
`internal/services/shared/defaults/timeout.go:9` — `DefaultScheduleTimeout = 5 * time.Minute`).
A reaper sweeps slots `WHERE schedule_timeout_at < NOW() AND is_filled = FALSE`
(`pkg/repository/sqlcv1/concurrency.sql:241`) and the task reaches the terminal state
**`SCHEDULING_TIMED_OUT`**. It is configurable per task (`pkg/v1/workflow/declaration.go:304`).

Consequences for this ADR:

- **Per-org workers may scale to zero.** A tenant's worker need only run while they have work, so
  Option C carries no standing per-tenant idle cost. This is what makes the cost model viable.
- **But cold-start becomes a deadline, not a latency concern.** If a worker cannot register and
  pull within `schedule_timeout`, the task is **killed, not delayed**. Five minutes is generous
  against a warm container boot and *not* obviously safe against a cold node pulling a Node +
  Claude Agent SDK image, or cluster-level scale-from-zero.
- **Rules:** (a) raise `ScheduleTimeout` explicitly for agent tasks rather than inheriting `5m`;
  (b) keep worker images pre-pulled on candidate nodes; (c) trigger the worker wake at **ingress**
  (webhook arrival), not at first dispatch, to spend the window on boot rather than detection.
- **Interaction:** the timeout is on the **concurrency slot**, so it composes with per-tenant
  concurrency policies — a tenant at its cap burns the same window queued behind its own work.
  Per-tenant concurrency limits must therefore be set with `schedule_timeout` in view, or a busy
  tenant sheds its own tasks.

## Deployment guard — the `-dev` image prohibition

Hatchet v0.94.10 (2026-07-14) added `hatchet server start --disable-auth` and
`hatchet-{api,engine,admin,dashboard,lite}-dev` images. The mechanism is a Go **build tag**
(`//go:build authdisabled`), not a runtime flag — it **cannot** be tripped by env or config on a
production image, which is good design. But `pkg/authmode/authdisabled.go` `//go:embed`s
`keyset/private_ec256.key` — **the JWT signing private key is committed to the public repo** —
alongside a pre-minted token for the default tenant with `exp: 4102444800` (year 2100).

In a `-dev` image the gRPC middleware still runs but validates against a **publicly known key**:
anyone can mint a valid token for any tenant `sub`. **Tenant isolation is void, not merely weaker.**
Deploying one to the shared control plane silently collapses every boundary this ADR depends on.

Therefore:
1. Pin non-dev image tags (`hatchet-engine`, never `hatchet-engine-dev`).
2. Adopt Hatchet's own CI assertion (`hack/ci/assert-auth-enabled.sh:36-50`) as a **deploy gate**:
   `GET /api/v1/meta` must not report `authDisabled: true`, and an unauthenticated
   `GET /api/v1/tenants/<uuid>/workers` must return 401/403.

## Rollout order

1. **W0 first — close the untrusted-branch path.** Drop `'project'` from `settingSources` (or gate
   it to a trusted-repo allowlist) and verify global skills still resolve via the `'user'` source.
   This is required **regardless of topology**, and is a prerequisite to accepting the first client
   credential.
2. **Control-plane credential custody.** Move App-key custody out of the executor: mint
   short-lived installation-scoped tokens in the control plane, pass as step input. Same for
   secret-store decryption.
3. **Org → Hatchet tenant provisioning.** On Better Auth `organization` create, provision a Hatchet
   tenant + worker token; on org delete, **revoke** it (revocation is checked per call, so
   offboarding is immediate).
4. **Per-org worker container** with a cgroup memory limit; one reference tenant end-to-end.
5. **BYO API key.** Wire `agentProviderCredentials` (`type='api-key'`, org-scoped) → worker env.
   Enforce the `oauth`-rejection rule at write time.
6. **Deploy gate.** Wire the `/api/v1/meta` assertion into deploy verification.
7. **Later:** platform-supplied inference (same seam, platform key) — requires migrating off
   `CLAUDE_CODE_OAUTH_TOKEN` to Console API keys and un-quarantining the credits/billing code
   (plan §8.1 #1 currently defers it).

**Exit gate:** extend ADR-001's **C10 cross-org isolation test** to the execution plane — org A's
worker cannot obtain org B's Anthropic key, GitHub token, or worktree, and a task dispatched to
org B is never delivered to org A's worker.

## Consequences

- **Positive:** The cross-tenant blast radius is eliminated rather than mitigated; the security
  story becomes sellable. The memory ceiling missing from W5 arrives as a side effect of
  containerisation, putting the `max_concurrent_per_org: 6` + swap arrangement on a path to
  retirement. BYO-key costs almost no executor code. Tenant offboarding is immediate via token
  revocation. BYOC remains reachable later with no rework.
- **Negative / residual risk:** Scale-to-zero replaces the idle-cost risk with a **cold-start
  deadline** — a worker that cannot boot within `schedule_timeout` causes `SCHEDULING_TIMED_OUT`,
  which surfaces to the customer as a dropped review, not a slow one. N deployments introduce
  version skew and a container-orchestration dependency (k8s/Nomad/Fly/ECS) that the current
  compose-shaped self-host stack lacks. Worker tokens default to **90-day expiry**
  (`token.go:196`), so rotation is standing ops work, not a one-time provision. **The design's
  security rests entirely on the credential-placement rules in Decision §3** — ship per-org workers
  while leaving the App key in the worker and we have paid the whole cost for none of the benefit.
- **Follow-ups:** measure real worker cold-start (image pull + register + listen) against the
  chosen `ScheduleTimeout` on a prod-shaped environment — this is now a **P1 gate**, since the
  whole cost model depends on scale-to-zero and the whole reliability story depends on beating that
  deadline. Decide `agentProviderCredentials.organizationId` null-vs-set semantics for Claude
  specifically (ADR-001 already flags user-personal vs org-shared as a real product decision).
  Confirm the published release image matches the source read here — the spike verified source at
  `301391d`, not the shipped artifact.
