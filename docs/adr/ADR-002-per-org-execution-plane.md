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
- **Revision 2 (2026-07-15, operator):** the isolation tier changed **before any implementation
  began**. Option C (shared pool of per-org containers we host) is **withdrawn** in favour of
  Option D: the **customer supplies the VPS**, in both the dedicated-VPS and BYOC modes. The core
  decision below — the control/execution split and the credential-placement rules — is unchanged
  and is the reason the swap is cheap. Amended in place rather than superseded because nothing was
  built against rev 1. Rationale: see Options C (withdrawn) and D (chosen).

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

2. **Execution plane (one per org, on infrastructure the customer supplies).** A Hatchet worker per
   tenant, registered with that org's `HATCHET_CLIENT_TOKEN`. Hatchet's tenant scoping (above)
   guarantees it receives only its own org's tasks. It holds **only that org's** credentials. The
   customer provides the box — a VPS they provision, or their own cloud (BYOC). We ship an
   installer and a control plane; **we do not host or bill for execution compute.** This is the
   self-hosted-runner model (Buildkite agents, GitHub Actions self-hosted runners): a shape the
   dev-agency market already understands and trusts.

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

5. **Never deploy Hatchet `-dev` images.** See "Deployment guard" below. Note this risk lives in
   the **control plane** (the engine/api/dashboard images), not in customer-supplied workers, so
   customer-owned infrastructure does not widen it.

6. **A published capacity requirement, not a capacity product.** Because the customer buys the box,
   the tiers below are a **spec we ask them to meet**, sized by the only number they care about —
   how many pull requests can be reviewed at once. The reference tier is measured, not estimated:
   **7.6GB RAM + 10GiB swap = 6 concurrent sessions**, proven in production. Swap is part of the
   spec, not an optimisation: 6-on-7.6GB works only because swap lifted `CommitLimit` to ~13.8GB.
   Ship a box without it and the customer inherits the exact `fork`/`posix_spawn` ENOMEM already
   debugged in `.planning/debug/memory-pressure-capacity.md`.

   | Tier | Concurrent reviews | Confidence |
   |---|---|---|
   | 4GB + swap | ~2–3 | extrapolated |
   | **8GB + 8–10GiB swap** | **~6** | **measured in prod** |
   | 16GB + swap | ~12 | extrapolated, untested |

   The extrapolations assume commit scales linearly at ~1.1GB/session and are unverified above 6.

7. **Refuse stale workers loudly — a minimum-version gate at registration.** We no longer control
   upgrade cadence: the box is the customer's. Hatchet workers register their actions on connect,
   so a stale worker that has not registered an action the control plane dispatches makes that task
   **unassignable to anyone** — and it dies at `SCHEDULING_TIMED_OUT` five minutes later, silently,
   with nothing cold-starting to explain it. Either keep action names strictly backward-compatible
   or reject under-version workers at registration with a clear error. Cheap now, miserable to
   retrofit.

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

### Option C — Per-org container on a pool of hosts we operate (**withdrawn in rev 2**)

One container per tenant: namespaces + cgroups, its own env, its own worktree volume, scheduled
onto a shared pool of hosts we own.

> **Withdrawn.** Its isolation argument was sound and survives into Option D — but it bought that
> isolation with a container-orchestration dependency, a fleet we pay for and patch, and a
> cold-start deadline. Option D delivers the same blast-radius property with none of those. Two of
> its stated Pros also turned out weaker than written: cgroups cap **resident** memory but do not
> reserve **commit**, and `CommitLimit` is host-wide — so pooled containers would still have shared
> the wall that the swap file papers over. The retained insight is the Pro below about ambient env.

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
  (see "Worker availability and the 5-minute window"), so a tenant's worker need only exist while
  they have work. *Moot under rev 2 — the customer's box is always on and costs us nothing.*
- **Con:** N deployments with version-skew risk, and a real container-orchestration dependency the
  current www+broadcast+PG+Redis+MinIO compose stack does not have. Scale-to-zero trades the idle
  floor for a **cold-start deadline** (below).

### Option D — Customer-supplied VPS, or BYOC in the customer's own cloud (**chosen, rev 2**)

The customer provisions the box. Two delivery modes, one architecture: a VPS they rent and we
install onto, or their existing cloud. Both are "customer-supplied execution plane"; the difference
is only whose console provisions it.

- **Pro — strongest isolation, and the customer is the one enforcing it.** The tenant boundary is a
  machine they own. No shared kernel, no shared filesystem, no shared uid with another tenant.
- **Pro — their Anthropic key never reaches us at all.** Under BYO-key on customer infrastructure,
  the credential lives on their box and is never transmitted to, or stored by, the control plane.
  We stop being a custodian for it — that removes a liability class rather than mitigating it, and
  it is a materially better answer to a security review than "we encrypt it well."
- **Pro — execution compute cost goes to ~zero,** and infra is transparently the customer's line
  item rather than opaque margin in ours.
- **Pro — the cold-start deadline disappears.** Their box runs continuously, so the worker stays
  registered. The five-minute window stops being something a healthy tenant can miss.
- **Pro — `CommitLimit` becomes per-tenant and tractable.** The host *is* the tenant, so the swap
  arrangement already proven on the current 7.6GB box transfers unchanged, with no cross-tenant
  commit contention.
- **Pro — the never-built global session ceiling stops being a landmine.** `6 × N orgs` was only
  unbounded because orgs shared a box. One org per box makes the existing per-org gate the box-wide
  gate, so `memory-pressure-capacity.md`'s deferred global ceiling can stay deferred.
- **Con — support burden inverts.** Every incident starts with "what is on your box," and we cannot
  look. Requires worker-reported health surfaced in the dashboard (see "Worker availability").
- **Con — we do not control upgrade cadence.** Hence the minimum-version gate in Decision §7.
- **Con — a customer's outage is our support ticket** even though it is their infrastructure.
- **Requirement:** `SERVER_GRPC_INSECURE` **must** be false — the worker token crosses the public
  internet, and in plaintext transport it is sniffable.

## Worker availability and the 5-minute window

Verified from source: **Hatchet queues tasks for a tenant whose worker is offline — but only for
5 minutes by default.** At enqueue the task is stamped
`schedule_timeout_at = CURRENT_TIMESTAMP + convert_duration_to_interval(schedule_timeout)`, with
the duration coalescing to `'5m'` (`pkg/repository/sqlcv1/workflows.sql:303`;
`internal/services/shared/defaults/timeout.go:9` — `DefaultScheduleTimeout = 5 * time.Minute`).
A reaper sweeps slots `WHERE schedule_timeout_at < NOW() AND is_filled = FALSE`
(`pkg/repository/sqlcv1/concurrency.sql:241`) and the task reaches the terminal state
**`SCHEDULING_TIMED_OUT`**. It is configurable per task (`pkg/v1/workflow/declaration.go:304`).

**Rev 2 changes what this window means, and it is not good news — it is different news.** Under
rev 1 the risk was a cold container missing its deadline. Under rev 2 the customer's box runs
continuously, so a *healthy* tenant never races it. Instead the window becomes the **grace period
for the customer's own infrastructure**: their VPS reboots, their network drops, their worker
crashes — and five minutes later their reviews are being silently deleted, not delayed.

That is a worse failure mode than rev 1's, because it is invisible from their side and unfixable
from ours. Rules:

- **Raise `ScheduleTimeout` well above `5m` for agent tasks.** It should be a deliberate
  "how long may a customer's box be down before we drop work" decision, not an inherited default.
  A reboot window measured in tens of minutes is not unreasonable.
- **Surface worker health in the dashboard as a first-class state.** "Your runner is offline" must
  be visible to the customer *before* work is dropped, since we cannot see their host and they
  cannot see our queue. This is the single most important observability requirement of rev 2.
- **`SCHEDULING_TIMED_OUT` must be a loud, attributable outcome** — a dropped review that looks
  like silence will be read as our product failing, not their box being down.
- **Interaction:** the timeout is on the **concurrency slot**, so it composes with per-tenant
  concurrency policies — a tenant at its cap burns the same window queued behind its own work.
  Per-tenant concurrency limits must therefore be set with `schedule_timeout` in view, or a busy
  tenant sheds its own tasks. This is why Decision §6's capacity spec and the timeout must be
  chosen together: an under-provisioned box does not merely run slowly, it drops work.

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
4. **The installer.** A single-command install onto a customer-supplied box that takes a
   `HATCHET_CLIENT_TOKEN` and brings up a worker: `curl … | sh`, a compose file, or an image —
   whichever the first design customer will actually run. This replaces rev 1's orchestration
   workstream and is now the **primary onboarding surface** — the first thing a customer touches,
   and the thing that decides whether onboarding is ten minutes or a support call. Include the
   swap provisioning from Decision §6; do not assume the customer reads a prerequisites page.
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

- **Positive:** The cross-tenant blast radius is eliminated rather than mitigated, and under rev 2
  the boundary is a machine the customer owns — the strongest version of that claim. Their Anthropic
  key never reaches us at all, removing a custody liability instead of managing it. Execution
  compute cost goes to ~zero and no orchestration platform is needed. The cold-start deadline, the
  host-wide `CommitLimit` contention, and the missing global session ceiling all stop being
  problems, because the host is the tenant. BYO-key costs almost no executor code. Tenant
  offboarding is immediate via token revocation.
- **Negative / residual risk:** **The support model inverts** — every incident begins with a box we
  cannot see, and a customer's outage is our ticket regardless of whose fault it is. We no longer
  control upgrade cadence, so Decision §7's version gate is load-bearing rather than hygienic. The
  5-minute window becomes a grace period for customer infrastructure and will silently delete work
  if left at its default. Worker tokens default to **90-day expiry** (`token.go:196`), and rotation
  now requires the *customer* to act. **The design's security still rests entirely on the
  credential-placement rules in Decision §3** — and rev 2 raises the stakes: the box belongs to the
  customer, so anything shipped inside the worker is available to them by definition, not merely to
  an attacker who compromises it. Ship the GitHub App private key in the installer and any customer
  can mint tokens for every other customer's installation.
- **Follow-ups:** decide the pricing model, which rev 2 has decoupled from infrastructure — we no
  longer sell capacity, so revenue must come from the platform (seats, orgs, repos) and §8.1's
  deferred-billing decision needs re-examining against that. Specify the installer's supported OS
  and prerequisites, and whether it provisions swap or merely asks. Measure **peak RSS per agent
  session** so the Decision §6 tiers rest on measurement rather than commit-derived extrapolation
  above 6. Decide `agentProviderCredentials.organizationId` null-vs-set semantics for Claude
  (ADR-001 already flags user-personal vs org-shared as a real product decision). Confirm the
  published release image matches the source read here — the spike verified source at `301391d`,
  not the shipped artifact.
