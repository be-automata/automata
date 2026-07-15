# UAT & Validation Matrix — Platform Convergence

**Date:** 2026-07-15
**Owner:** production-validator (convergence program)
**Source plan:** `orch-agents/.planning/PLATFORM-CONVERGENCE-OVERVIEW.md` (esp. §6 gates, §8 chassis triage)
**Scope:** OLD test baseline (orch-agents), NEW test baseline (terragon-oss chassis, cloned at `automata-platform/`), the combined-product UAT master matrix across the three pillars (Executed / Observed / Verified), and the "chassis triage done" pass/fail checklist.

Two products merge into one: orch-agents' bounded contexts move into the terragon-oss monorepo skeleton **with their tests ported, not rewritten** (§8), Hatchet becomes the durable-execution substrate under both. The OLD tests are the safety net that must stay green through migration; the NEW baseline is thin and localized; the UAT matrix is what the *combined* product must satisfy before any org is cut over.

---

## 1. OLD baseline — orch-agents (the migrating packages)

Full suite re-run today: **3543 pass / 3543, 860 suites, 0 fail** (`/tmp/orch-baseline-test.log`, 13.2s). Runner: `node:test` + `node:assert/strict` + `--experimental-test-module-mocks` (no Jest/Vitest). 308 test files.

These tests migrate **with** their source package into `automata-platform/packages/*` and are the green-bar gate for each package's port. Distribution by bounded context (case counts approximate; describe-nesting makes exact per-file totals ±3%):

| Bounded context | Files | ~Cases | What it covers | Migration disposition (§4/§8) |
|---|---:|---:|---|---|
| **execution** | 94 | ~1107 | SDK executor, worktree lifecycle, per-org concurrency gate, effects/orchestrator/runtime/task/workspace, symphony threads | Core loop. Executor + worktree-manager migrate as-is; **engine gate + symphony threads retire into Hatchet** — those tests re-home to workflow-step tests, not deleted blind |
| **integration** | 30 | ~342 | GitHub + Linear + Slack intake/adapters, post-execution actions | Migrate in (Terragon had no Linear); side-effect idempotency tests become P2b replay gate |
| **review** | 20 | ~260 | Verdict-aware idempotency (ADR-036), severity floors, verify-before-block, per-repo tolerance, review/state | **The differentiator — Terragon has zero of this.** Migrates wholesale; hardens in P4 |
| **intake** | 22 | ~243 | WORKFLOW.md routing, command registry, dedup/event-buffer, AgentSessionEvent path | Migrate in; dedup becomes durable (delivery-ID idempotency key) — needs new durable-dedup tests |
| **shared** | 18 | ~227 | Cross-cutting utils, types, work-tracker | Migrate as shared package |
| **web** | 15 | ~139 | Dashboard SSE, run-history projection, web notifications | Largely **retired** — superseded by `apps/www`; SSE/projection logic re-homes to run-history-projection tests |
| **web-api** | 8 | ~116 | BFF endpoints, run timelines/toolCalls | Retire thin BFF; keep run-timeline semantics as projection tests |
| **services** | 10 | ~115 | Compact, deferred-tools, tool services | Migrate with executor |
| **webhook-gateway** | 13 | ~109 | HMAC-SHA256 verification, 202 fast-ack, delivery parsing | Migrate in; **new durable-outbox tests required** (ingress rearchitecture, §3 correction 1) |
| **staging** | 5 | ~102 | Staging/artifact applier flows | Migrate with artifact applier |
| **query** | 5 | ~93 | Query/read-model surface | Fold into Drizzle projection |
| **setup** | 7 | ~76 | Setup commands, plugin paths | Migrate |
| **kernel** | 6 | ~71 | event-bus, run-history ring | Bus retained for observability fan-out; run-history **becomes a projection** — ring tests re-home |
| **transport** | 7 | ~65 | Transport layer | Migrate |
| **scheduling** | 5 | ~52 | Cron + automation machine | **Retire into Hatchet crons** — except `linear/stall-detector` (Linear SLA domain, stays) |
| **audit** | 7 | ~41 | Audit log, security audit trail | Migrate (enterprise requirement) |
| **coordinator** | 4 | ~39 | Coordination/dispatch | Rework onto Hatchet |
| **security** | 4 | ~38 | Secret store (AES-256-GCM), HMAC, token mint | Migrate; token-mint retires into Better Auth API keys (§8.1) |
| **tasks** | 2 | ~33 | Task/local-shell | Migrate |
| **agents** | 2 | ~33 | Agent tracker, fork | Migrate with executor |
| **events** | 3 | ~32 | Event taxonomy | Migrate; exclusive-publication invariant added |
| **config / settings / tunnel / eval / uat** | 10 | ~71 | Config store hot-reload, settings, CF tunnel, eval, UAT smoke | Migrate/retire per component |

**Load-bearing constraint:** contexts marked "retire into Hatchet" (execution gate, scheduling, kernel ring) must not simply drop their tests — the *behavior* (per-org fairness, run settlement, no stranded rows) becomes a Hatchet workflow-step assertion. The `execution` and `review` contexts alone are ~40% of the whole suite and are the two hottest surfaces (CONCERNS CH-3); they get their own regression corpus in P2/P4.

---

## 2. NEW baseline — terragon-oss chassis (static inventory)

Runner: **vitest** (87/88 files import `vitest`). **88 test files, ~1431 test cases.** Not as thin as feared in raw count, but **coverage is lopsided**: it concentrates on agent-execution mechanics and the Drizzle data model, and is nearly absent on the product surface (`apps/www` server actions, dashboard queries, live-broadcast) and on the sandbox provider implementations.

Where coverage actually lives:

| Area | Files | Notable | Assessment |
|---|---:|---|---|
| `packages/sandbox` | 11 | `sandbox.test.ts` alone = 57 cases; setup, daemon, mcp-config, image render | **Best-covered area.** But tests exercise the sandbox *orchestration/config*, using `mock-provider` |
| `packages/shared/model` | ~16 | thread, credits, automations, github, slack, feature-flags, environments, sessions | Drizzle domain model well covered — **but user-scoped, not org-scoped** (tenancy audit target, §8.1) |
| `packages/daemon` | 7 | daemon, runtime, retry, per-CLI adapters (codex/gemini/opencode) | In-sandbox runner covered; adapters out of scope (Claude-SDK-only constraint) |
| `apps/www` server-lib/actions/lib | ~30 | new-thread, get-thread, stop-thread, credits, e2e, compact | Task **create/get/stop** paths tested; e2e.test.ts drives new-thread→follow-up |
| `apps/www` webhooks + proxy | 8 | github route/app-mention/utils, slack handlers, LLM proxy routes | GitHub intake has some coverage |
| `apps/www/agent/machine.ts` | 1 | 11 cases | Task-lifecycle **XState** machine (note: plan harvests transitions as *spec*, does **not** keep XState as a dep — this chassis code currently does) |

**Biggest untested areas (need characterization tests BEFORE we modify them):**

1. **Sandbox provider implementations — `packages/sandbox/src/providers/{docker,e2b,daytona,mock}-provider.ts` have ZERO direct tests.** This is the single largest untested surface and it is exactly the code Phase 5 (`ISandboxProvider`) hardens. `docker-provider.ts` (the P5a target) is untested. **Highest-priority characterization gap.**
2. **`apps/broadcast` (PartyKit live transcript) — 0 tests.** This is an OBSERVED-pillar surface (live streaming) and is being re-hosted onto Cloudflare Workers (§8). No safety net for the re-host.
3. **`apps/www/src/queries/*` (dashboard read layer) — 0 tests.** Every dashboard read (threads list, stats, credentials, automations) is untested; these get re-pointed at orch-agents domain packages (§8 cost 1).
4. **~45 of 51 server-actions untested** — only new-thread/get-thread/stop-thread/credits/all/admin-user have tests. Untested lifecycle mutations include `follow-up`, `retry-thread`, `redo-thread`, `fork-thread`, `approve-plan`, `mark-pr-ready`, `fix-github-checks`, `retry-git-checkpoint`, `scheduled-thread`, archive/delete. These are the frontend→domain seams that get re-pointed.
5. **No verification/review layer exists at all** — Terragon shipped none. Nothing to characterize; this is net-new from orch-agents' migrating `review` context.

**We must not run these** (`pnpm install`/scripts are permission-blocked on the untrusted dump; deps not installed) — this inventory is static (file/grep based). First CI bring-up under our conventions must decide per §8 whether migrated packages re-run under vitest or are ported to `node:test`; chassis-native `apps/www` tests stay vitest.

---

## 3. UAT master matrix (combined product)

Legend — **Coverage:** `OLD` = covered by a migrating orch-agents test; `NEW` = covered by a chassis vitest test; `UNCOVERED` = needs new UAT/integration test. **Gate:** convergence phase this case gates (P0.5 triage, P1 spike-gates, P2 executed, P3 observed, P4 verified, P5 isolated).

### Pillar A — EXECUTED (durable, isolated, fair)

| # | Acceptance case | Pass condition | Coverage | Gate |
|---|---|---|---|---|
| E1 | Webhook → task → agent → PR happy path | HMAC-verified webhook yields a task, agent runs in isolated worktree, opens a PR | OLD (execution+integration) + NEW (e2e.test.ts partial) | P2 |
| E2 | Durable intake survives engine/Postgres down | Webhook still 202s from SQLite outbox write; forwarder drains into Hatchet on recovery; no lost intake | UNCOVERED (new outbox component) | P2 |
| E3 | Crash mid-execute → replay | `kill -9` mid-run → Hatchet replay proves SDK-session resume **or** clean checkpoint-restart (fresh agent sees prior commits) | UNCOVERED (P1 gate #3 spike) | P1 |
| E4 | Forced step-retry does not double-post | Replayed publish step posts PR comment / Linear activity / Check Run exactly once (idempotency key `(runId, stepName, contentKey)`) | Partially OLD (review idempotency ADR-036) + UNCOVERED (comments/Linear/checks not idempotent) | P1/P2 |
| E5 | Concurrency fairness (per-org round-robin) | N orgs each with M queued runs → no org starves; Hatchet CEL concurrency key `org` | UNCOVERED (Hatchet-native; today's gate is a single counter) | P2 |
| E6 | Memory ceiling never breached | 6 concurrent real SDK runs + Postgres + engine + dashboard on 7.6GB-shaped box, 30 min, MemAvailable ≥ 1.5GB sustained | UNCOVERED (P1 gate #1 load test) | P1 |
| E7 | Stop signal aborts in-flight run | Stop command aborts live SDK `query()` via AbortController; final response emitted; Linear stop-SLA met | OLD (stop paths, WorkCancelled) + NEW (stop-thread.test.ts) + UNCOVERED (AbortController→Hatchet wiring) | P3 |
| E8 | Passive-burst debounce / no stranded rows | Rapid duplicate deliveries coalesce; run-history never stranded in `running`; settlement via WorkCancelled preserved | OLD (execution coalesce tests) + UNCOVERED (must re-home onto Hatchet dedup) | P2 |
| E9 | Latency budget (Linear 10s thought SLA) | webhook→agent-start through outbox→Hatchet→worker keeps margin vs in-process path | UNCOVERED (P1 gate #4) | P1 |
| E10 | Duplicate webhook delivered twice → executed once | `X-GitHub-Delivery` as Hatchet idempotency key; durable dedup (in-memory TTL insufficient once queue is durable) | OLD (event-buffer dedup, in-memory only) + UNCOVERED (durable) | P2 |
| E11 | Anthropic credit-exhaustion pause | Durable retries do not hammer a credit-starved account; run pauses, not spins | UNCOVERED | P2 |
| E12 | Sandbox isolation (Docker provider) | Agent runs in a Docker sandbox via `ISandboxProvider`, worktree-manager ported behind the port | NEW (sandbox orchestration, mock-provider only) + UNCOVERED (docker-provider has 0 tests) | P5 |

### Pillar B — OBSERVED (end-to-end visibility)

| # | Acceptance case | Pass condition | Coverage | Gate |
|---|---|---|---|---|
| O1 | One run timeline webhook→merged-PR | Single timeline spans intake→execute→verify→publish, sourced from Hatchet lifecycle via the bridge | OLD (run-history/web-api timelines) + UNCOVERED (bridge projection) | P3 |
| O2 | Live transcript streaming to dashboard | `putStream` relays agent transcript into SSE at human pace; visible in `apps/www` | OLD (web SSE) + UNCOVERED (`apps/broadcast` PartyKit has 0 tests; re-host to CF Workers) | P3 |
| O3 | Boot substatus telemetry | Boot substatus enum surfaces provisioning stages to the UI | NEW (chassis has the enum) + UNCOVERED (no test) | P3 |
| O4 | Run-history is a projection, not the record | run-history rebuilds from bridge events; empty-on-restart fragility gone | OLD (ring tests, in-memory today) + UNCOVERED (projection) | P3 |
| O5 | Metrics endpoint (OBS-01) | Prometheus/OTel exposed; Hatchet dashboard bound loopback/CF-Access | UNCOVERED (deferred item folds into P3) | P3 |
| O6 | Desktop/web notifications on completion | SSE→Notification glue fires on WorkCompleted/Blocked | OLD (web-notifications tests) | P3 |
| O7 | Exclusive publication during dual-path | Exactly one path emits lifecycle events per work item (else review double-runs; GitHub can't dismiss COMMENTED reviews) | UNCOVERED (dual-path invariant) | P2 |

### Pillar C — VERIFIED (independent review gate)

| # | Acceptance case | Pass condition | Coverage | Gate |
|---|---|---|---|---|
| V1 | Review gate blocks a bad diff | A diff with a real blocking finding gets CHANGES_REQUESTED; merge blocked | OLD (review context, 260 cases) | P4 |
| V2 | Severity floor honored | Per-repo tolerance (error/warning/info) applied; sub-floor findings don't block | OLD (per-repo tolerance, `feat/repo-review-tolerance`) | P4 |
| V3 | Idempotent re-review | Re-review on same commit+verdict does not duplicate; verdict change supersede-dismisses (ADR-036); APPROVED/CHANGES_REQUESTED only (COMMENTED can't be dismissed, 422) | OLD (review/state idempotency) | P4 |
| V4 | Verify-before-block (no hallucinated blocks) | Blocking finding whose quote is absent at HEAD is downgraded (PR #235 guard) | OLD (verify-before-block tests) | P4 |
| V5 | Review gate is unskippable | ReviewGate as a mandatory Hatchet workflow step; no agent can skip fixes (fixes #236 skip-the-gate class structurally) | UNCOVERED (net-new workflow-step wiring) | P4 |
| V6 | Verify runs worker-side on the worktree | Verify step reads diff from `WorkArtifactRef.worktreePath`; sticky-assigned to the worktree's worker | OLD (review-pipeline reads worktree) + UNCOVERED (worker-side/sticky) | P4 |
| V7 | Check Run publication | Customer-visible GitHub Check Run published from the verify step | UNCOVERED (net-new, verify step doesn't exist yet) | P4 |

### Cross-cutting — MULTI-TENANCY / ISOLATION (v1 requirement, §8.1)

| # | Acceptance case | Pass condition | Coverage | Gate |
|---|---|---|---|---|
| T1 | Org A cannot see org B's tasks | Every thread/task query is org-scoped; cross-org read returns nothing | UNCOVERED (chassis model is **user-scoped**; tenancy audit needed) | P0.5 |
| T2 | Org A cannot see org B's repos | Repo/workspace config org-scoped | UNCOVERED | P0.5 |
| T3 | Org A cannot read org B's secrets | Secret store partitioned by org; AES-256-GCM at rest | OLD (secret store) + UNCOVERED (org partitioning) | P0.5/P5 |
| T4 | Tenant boundary = Better Auth `organization` → Hatchet tenant → org-scoped rows | 1:1 mapping enforced across auth, substrate, DB | UNCOVERED | P0.5 |
| T5 | Untrusted-branch `settingSources` blocker (W0) | A malicious PR branch cannot inject settings/skills into the agent (MULTI-TENANCY-ASSESSMENT W0, size S, blocks everything) | UNCOVERED (P0 security pre-work) | P0 |
| T6 | Per-tenant HOME / config isolation (HRD-07) | `CLAUDE_CONFIG_DIR` scoping so agents don't share one HOME (MT-01/02) | UNCOVERED | P0/P5 |
| T7 | Per-org concurrency neutral default | Terragon's subscription-tiered per-user caps replaced by a neutral org default (billing quarantined, §8.1) | UNCOVERED | P0.5 |

**Tally:** 33 UAT cases defined (12 Executed, 7 Observed, 7 Verified, 7 Tenancy). **Fully covered by existing tests (OLD or NEW): 6** (E1 partial→counted separately; strictly-covered = V1, V2, V3, V4, O6, and E7-core). **Partially covered (OLD/NEW + a required new slice): 11.** **Fully uncovered (need net-new UAT/integration): 16.** The uncovered set clusters on the three genuinely new things: the durable substrate (E2/E3/E5/E6/E9/E10/E11), multi-tenant isolation (T1–T7), and the workflow-ized review step (V5/V7).

---

## 4. "Chassis triage done" validation checklist (plan §8)

Concrete pass/fail gate for **P0.5 — chassis triage + repo merge**. Every item is a hard pass/fail; the phase is not "done" until all pass. Reminder: `pnpm install`/scripts are currently permission-blocked on the dump — these steps run only **after** triage lifts that block in a trusted checkout.

| # | Step | Pass condition | Fail signal |
|---|---|---|---|
| C1 | Dead-SaaS excision compiles | After quarantining Stripe/credits/PostHog/Upstash/E2B-Daytona behind flags (deferred, **not** deleted — §8.1), `tsc-check` passes across the workspace | Type errors from dangling imports of quarantined modules |
| C2 | Boots with no billing/analytics env | App boots with Stripe/PostHog/Upstash env **absent**; billing path takes neutral default; task lifecycle never blocked on a missing credit check | Boot crash or lifecycle stall when billing env unset |
| C3 | Dependency/security patch level | Next 15 / React 19 at a clean patch level; `pnpm audit` shows no unpatched criticals in the retained dependency set | Known critical CVE in a retained dep |
| C4 | docker-compose boot | `docker-compose up` brings up app + Postgres (+ Hatchet engine when wired); health endpoint green | Any service unhealthy / restart loop |
| C5 | Signup | A new user can sign up via Better Auth | Signup 500 / session not minted |
| C6 | Org create | A user can create an `organization`; it maps to a Hatchet tenant and org-scoped Drizzle rows | Org creation not persisted / no tenant mapping |
| C7 | Task create | Authenticated user in an org creates a task (thread) via the UI/server-action | Task not persisted / not org-scoped |
| C8 | Stubbed run streams to dashboard | A stubbed/mock-provider run produces transcript events that stream to the dashboard live view | No stream / dashboard shows nothing |
| C9 | Migrated packages compile + green | At least one orch-agents package (start with `review` — the differentiator) mounted as a workspace package, compiles, and its **ported tests run green** under the chosen runner | Ported package won't build or tests red |
| C10 | Tenancy smoke (T1 minimal) | Two orgs created; org A's task list does not include org B's task | Cross-org leakage — **blocks all further phases** |
| C11 | CI bring-up | CI runs the migrated-package suite + chassis vitest suite on PR; both required to pass | No CI gate / suite not wired |
| C12 | Characterization tests for P5-critical untested code | Before any modification to `docker-provider.ts` / sandbox providers, a characterization test pins current behavior (§2 gap #1) | Modifying untested provider code with no safety net |

**Exit criterion:** C1–C11 pass and C10 (cross-org isolation smoke) is demonstrably green. C12 is a standing rule for the isolation phases, not a one-time P0.5 gate, but the *first* characterization test (docker-provider) should land in P0.5 to prove the pattern.

---

## 5. Standing invariants the matrix enforces (do not relax)

Carried from the plan; every phase inherits them (§8 cost 4):
- Durable SQLite outbox at ingress — webhook always 202s from a local write (E2).
- Reference-only step payloads — no prompts/secrets transit Hatchet/Postgres (security-grade; renders in the Hatchet dashboard otherwise).
- Side-effect idempotency keys on every externally-visible effect (E4) — a correctness invariant, **not** a code-review convention.
- Per-org (never per-repo) admission flag at cutover — a per-repo split breaches the memory ceiling.
- Parity criterion before legacy deletion: N=50 consecutive flagged runs per route, zero stranded rows, zero duplicate posts, ceiling never breached, identical review verdicts on replayed fixtures over a 2-week window.
- P1 go/no-go gates 1–4 (memory, replay safety, resume semantics, latency) are unconditional — the chassis change does not relax any gate.

---

## Measured NEW baseline (2026-07-15, local macOS, deps installed with --ignore-scripts)

Supersedes the static estimates above. `tsc-check`: **green across all 21 packages** (e2b
patch failed to apply at install — no type-check impact).

| Suite | Result | Failure cause classification |
|---|---|---|
| packages/agent | 20/20 pass | — |
| packages/utils | 31/31 pass | — |
| packages/sandbox-image | 2/2 pass | — |
| packages/daemon | 129/133 pass (4 fail) | Host-env artifact: shell-profile noise (`$HOME must be set to run brew`) trips empty-stderr spies in `runtime.test.ts spawnCommandLine`. Expect green on Linux/clean env. Pin env in WI-6. |
| packages/sandbox | 66/66 tests pass; 4 files failed collection on first run (not reproduced on re-run — timing/env sensitive) | **Docker provider tests ran and passed against local Docker, incl. hibernation round-trip** — major de-risk for P5a. |
| packages/shared | 397/447 pass (50 fail) | Missing seed data, not connections: dominated by `Feature flag "X" does not exist` (tests assume seeded flag rows) + a few data-dependent asserts. Fix = test-seed script (WI-6), not code. |
| apps/www | 782/792 pass, 9 skipped (1 fail) | Single failure: `server-actions/stop-thread.test.ts > should successfully stop a thread`. Needs root-cause in WI-6 — stop-signal is UAT case E-stop; do not wave through. |

**CI-shape finding (WI-7 hard requirement):** `apps/www`, `packages/shared`, and
`packages/sandbox` declare `"test": "vitest"` (watch mode) — a recursive `pnpm -r run test`
**silently skips them** while exiting 0. CI must invoke `vitest run` explicitly per package
or the three biggest suites (≈1,300 cases) vanish from the pipeline while looking green.

Totals measured: **1,427 executed / 1,372 pass / 55 fail (≈96%)** — all failure classes
identified and none indicate structural rot. Old baseline (orch-agents) remains 3543/3543.

**Baseline corrections (post WI-1/WI-2 verification):** (1) `apps/docs` tsc-check fails on
missing generated code (`@/.source`, Fumadocs codegen skipped by `--ignore-scripts`) — an
install-mode artifact, not source rot; CI (WI-7) must either run the fumadocs codegen step
explicitly or exclude apps/docs from the gate. All other packages remain tsc-green after the
WI-1/WI-2 commits. (2) packages/sandbox Docker-dependent tests are environment-conditional
(66 ran on first pass, 104 skipped on a later run with no Docker context) — CI needs a
Docker-enabled runner for them to count.

**Post-triage verification (2026-07-15, after commits bfe5d31…64c5067):** apps/www 787/796
pass 0 fail (sandbox-resource suite reconciled with Redis fail-open; stop-thread stable);
packages/shared 447/447; packages/sandbox 147 pass 0 fail (Docker-conditional cases skipped
without Docker context); tsc-check green in all packages except the known apps/docs codegen
artifact. Chassis quarantine work items WI-1–WI-4 complete; C1 (tsc) and the test-baseline
portion of C-checks now PASS.

---

# UAT Round 1 (2026-07-15)

**Executed against:** `feat/p05-chassis-triage` @ HEAD `64fe09a` (13 commits: quarantine WI-1–4, test-infra fixes, tenancy foundation ADR-001 + Better Auth `organization` plugin + org-scoped daemon tokens). Deps installed via `pnpm install --ignore-scripts` (operator-cleared). Suites/tsc/static run directly with per-package `node_modules/.bin/{vitest,tsc}` — no `pnpm install`.

**App-runtime status:** NOT confirmed listening this round. boot-coder is still standing up the compose; `deploy/docker-compose.selfhost.yml` provisions **postgres + redis + serverless-redis-http + minio only — there is no `app` service**, so the Next.js app runs out-of-band. Ports :3000/:8080 are occupied by unrelated local dev processes (plaintext 404 / 307, not Next). All app-runtime cases below are therefore **BLOCKED-pending-boot**; test/tsc/static cases were executed.

## R1.1 Measured test baselines at HEAD

| Package | Prior recorded (@ `64c5067`) | Round-1 measured (@ `64fe09a`) | Verdict |
|---|---|---|---|
| `packages/utils` | green | **31 pass / 0 fail** | PASS |
| `packages/agent` | green | **20 pass / 0 fail** | PASS |
| `packages/sandbox` | 147 pass, Docker-cond. skipped | **147 pass / 0 fail / 104 skipped** (image tests need `SANDBOX_IMAGE_TEST=true`) | PASS |
| `packages/daemon` | — | **129 pass / 4 fail / 133** | PASS-WITH-KNOWN — the 4 failures are `runtime.test.ts` `spawnCommandLine`/`spawnCommand` cases (spy never invoked); host-shell/env dependent, matches the "4 known host-env failures" note |
| `packages/shared` (`--no-file-parallelism`) | **447 / 447** | **385 pass / 68 fail / 453** | **FAIL — REGRESSION** |
| `apps/www` | **787 / 796, 0 fail** | **740 pass / 53 fail / 9 skipped / 802** | **FAIL — REGRESSION** |

**Headline: the tenancy-foundation commits (decdca1 / 0457891 / 796783f / 64fe09a) regressed two previously-green suites that were 447/447 and 787/796 at `64c5067`.** Both regressions are test-plumbing/fixture drift, not product-logic breakage — `tsc --noEmit` is clean in every package (incl. `apps/www`), and sandbox/agent/utils are fully green.

**Root cause — `packages/shared` (68 fail, isolated to 2 files):** `automations.test.ts` (46) and `feature-flags.test.ts` (14 + a few in setup). The test container came up healthy (`terragon_postgres_test` on :15432) and `test-global-setup.ts` ran `pnpm drizzle-kit-push-test`, but the push did **not create the `automations` and `user_feature_flags` tables** — both are still declared in `schema.ts:1025` / `schema.ts:933`. Every failure is `relation "automations"/"user_feature_flags" does not exist`; the feature-flag seed step then throws on the missing table. Mechanism: non-interactive `drizzle-kit push` silently skipping ambiguous create/rename statements. The other 385 shared tests pass, so it is a schema-push plumbing bug, not model-logic breakage.

**Root cause — `apps/www` (53 fail):** clustered in `e2e` (18), `handle-app-mention` (10), `credit-auto-reload` (4), `stop-thread` (4), `get-thread` (4), `slack/handlers` (4), `admin/user` (3), `auth-server` (3), `credits` (2), `stripe-credit-top-ups` (1). Signatures: FK violations `insert on {session,account,automations,user_settings,slack_account} violates *_user_id_user_id_fk`, plus `UserFacingError: Unauthorized` and `User is not part of this team`. The Better Auth `organization` plugin (`auth.ts:290`) + org-scoping landed **without updating the test fixtures** — `createTestUser`/`mockLoggedInUser` don't seed an organization/membership, so org-scoped reads return Unauthorized and dependent inserts FK against a missing user row; the shared missing-`automations`-table also bleeds through. Regressed the www floor from ~787 to 740.

**CI impact:** `.github/workflows/ci.yml` runs `pnpm turbo test` — it is **RED at HEAD** for the two reasons above. Separately, CI pins **Node 20** (`setup-node@v4`, `node-version: "20"`); the migrating orch-agents packages require **Node ≥22** (`node:sqlite`, worker_threads, `--env-file`) — flag before mounting them.

## R1.2 C1–C12 checklist status (this round)

| # | Item | Status | Evidence |
|---|---|---|---|
| C1 | Dead-SaaS excision compiles (`tsc-check`) | **PASS** | `tsc --noEmit` exit 0 in shared, sandbox, agent, utils, daemon, apps/www. apps/docs codegen artifact excluded per note |
| C2 | Boots with no billing/analytics env | **PASS (static) / runtime BLOCKED** | `isStripeConfigured()` gate present (`server-lib/stripe.ts`); no hardcoded PostHog key anywhere (`phc_…` grep empty); `selfhost.env.example` documents `STRIPE_*`/`POSTHOG`/`E2B`/`DAYTONA` empty = disabled, "lifecycle never blocks on credits". Runtime boot assertion needs the app |
| C3 | Dependency/security patch level | **NOT RUN** | `pnpm audit` deferred (would be run in a trusted pass); not executed this round |
| C4 | docker-compose boot (app + Postgres health) | **BLOCKED** | Compose provisions infra only (no `app` service); boot-coder owns bring-up |
| C5 | Signup | **BLOCKED** | App not listening |
| C6 | Org create → Hatchet tenant + org-scoped rows | **PASS (schema) / runtime BLOCKED** | `organization` pgTable (`schema.ts:117`) + `organization()` plugin (`auth.ts:290`) present. Live create needs app; Hatchet not in branch |
| C7 | Task create | **BLOCKED** | App not listening |
| C8 | Stubbed run streams to dashboard | **BLOCKED** | App not listening; `apps/broadcast` still untested |
| C9 | First migrated orch-agents package compiles + green | **NOT STARTED** | No `review`/`webhook`/`intake` package mounted in this branch — chassis triage + tenancy only |
| C10 | Cross-org isolation smoke (T1 minimal) | **OPEN (now also fixture-blocked)** | Accessor per ADR-001 not exercised; www org-membership fixtures currently broken (R1.1) |
| C11 | CI bring-up | **PARTIAL** | `ci.yml` wired (tsc-check, lint, format-check, `turbo test`) but RED at HEAD; Node pinned 20 (needs ≥22 for orch-agents pkgs) |
| C12 | Characterization test for P5-critical untested code | **PASS (docker-provider)** | Round-0's "docker-provider has ZERO tests" gap is **CLOSED** — `sandbox.test.ts` imports `DockerProvider`, defaults `providerName="docker"`, 147 provider/lifecycle cases green |

## R1.3 UAT case status updates (deltas from Round 0)

- **E12 (sandbox isolation / Docker provider):** uncovered → **now-partially-covered.** The Docker `ISandboxProvider` mechanics are exercised green under `sandbox.test.ts` (147 cases). End-to-end agent-in-sandbox still gated to P5.
- **T1 / T2 / T4 (org-scoped isolation) and C6:** uncovered → **now-partially-verifiable (schema level).** `organization` table + Better Auth org plugin exist statically; live cross-org enforcement (T1/C10) remains open and is currently blocked by the www fixture regression.
- **T7 (per-org concurrency neutral default):** uncovered → **partially-verifiable.** Billing quarantine (`isStripeConfigured` gate, empty-env = disabled) removes the subscription-tiered cap dependency at the config layer.
- **V1–V7 (Verified pillar):** **unchanged — 0% in-branch.** No review package migrated (C9 not started).
- **E2/E3/E5/E6/E9/E10/E11 (durable substrate):** **unchanged — uncovered.** Hatchet not in this branch.
- **O1–O7 (Observed pillar):** **unchanged — uncovered/blocked;** nothing observable until the app boots.
- All other cases retain their Round-0 status.

Rollup: of 33 cases, **3 moved uncovered→partially-covered/verifiable** (E12, T1/T2/T4 schema, T7), **0 newly fully-covered**, the rest unchanged. Net still ~13 uncovered / ~13 partial / ~7 covered, with the Verified pillar untouched.

## R1.4 Verdict — what Executed / Observed / Verified mean for this chassis today

- **EXECUTED:** chassis-only. Core packages (sandbox, daemon, agent, utils) compile and their unit suites are green, and the **Docker sandbox provider is now proven under test** (the biggest Round-0 untested gap). But the durable substrate (Hatchet) and every orch-agents execution package are absent from this branch, and the tenancy foundation **regressed the shared + www baselines** — so "executed" is chassis mechanics passing in isolation, on top of a currently-red integration baseline.
- **OBSERVED:** nothing observable this round. The app is not booted, the compose has no `app` service, and `apps/broadcast` (live transcript) remains untested. The entire pillar is blocked on app bring-up.
- **VERIFIED:** 0%. No verification/review layer exists in-branch (unmigrated). This is the differentiator and it has not started.

**Top 3 gaps to close next:**
1. **Fix the tenancy-foundation test regressions** — (a) make `test-global-setup` `drizzle-kit push` create `automations` + `user_feature_flags` (or switch to `drizzle-kit migrate`); (b) update `createTestUser`/`mockLoggedInUser` to seed an organization + membership so org-scoped paths authorize. CI is red until both land; the migrating baseline must be green before more packages stack on top.
2. **Boot the app** (add an `app` service to the self-host compose or publish a documented run recipe) so C4–C8 and live cross-org isolation (C10/T1) become executable — the whole OBSERVED pillar and half the tenancy cases are blocked on this.
3. **Mount the first orch-agents package — `review`, the differentiator** — to start the VERIFIED pillar and give C9 something to check; nothing is migrated yet. En route, resolve the CI Node 20 → ≥22 pin.

## R1b — App-runtime execution (2026-07-15, app confirmed UP)

boot-coder brought the app up: `next start` on **http://localhost:3100**, compose Postgres on **:55432** (`automata_selfhost_postgres`, 43 public tables). Ran the app-runtime cases that don't need a GitHub/agent run.

| Case | Status | Evidence |
|---|---|---|
| **C4 — compose boot / app serves** | **PASS** | `GET /` and `GET /login` → 200, real Next HTML (`_next/static` present). Postgres container healthy |
| **C2 — boots with deferred services unset** | **PASS (runtime)** | App booted from `smoke.env` with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_POSTHOG_KEY`, `E2B_API_KEY`, `DAYTONA_API_KEY` all **empty**, and still serves; no PostHog key in page HTML; no boot crash / no credit-gate on the lifecycle |
| **C6 — org/tenant schema in live DB** | **PASS (schema)** | Live DB has `organization`, `member`, `invitation`, `apikey`, `session`, `account`, `user`. Runtime "create org via UI" not driven (needs a session) |
| **C5 — signup** | **PARTIAL / BLOCKED on external auth** | Signup surface live; Better Auth mounted (`/api/auth/ok` → 200; `/api/auth/get-session` → 200 `null`, correct unauth response). But **email/password is disabled by design** (`EMAIL_AND_PASSWORD_SIGN_UP_IS_NOT_ENABLED`), **magic-link 500s** (no SMTP configured), and **GitHub OAuth** (configured) needs a real external handshake not drivable headlessly. **No account could be created this round** — 0 rows in `user` |
| **C8 — stubbed run streams to dashboard** | **BLOCKED** | Requires an authenticated session + a task; unreachable without a completed signup |
| **C10 — cross-org isolation smoke** | **OPEN** | Cannot create two orgs headlessly (signup blocked) and the org-scoping accessor (ADR-001) is not yet exercised |

**Corroborating finding (clarifies R1.1):** the **identical Drizzle schema pushed cleanly to the live self-host DB** — `automations` and `user_feature_flags` both exist there (`to_regclass` non-null). Since the same `schema.ts` produces those tables against the self-host Postgres but **not** against the vitest test container, the shared 68-failure regression is confirmed as a **test-harness defect** (non-interactive `drizzle-kit push` in `test-global-setup.ts` silently skipping statements), **not** a schema-definition defect. Fix is scoped to the test setup, not the model.

**Case-status deltas from R1:**
- **T1 / T2 / T4:** schema-level → **verified-in-live-DB** (tenant tables incl. the `member` join present in the running database). Enforcement (C10) still OPEN.
- **T7 (per-org concurrency neutral default):** → **partially-verified at runtime** — the booted app carries `MAX_CONCURRENT_TASKS_PER_USER` / `MAX_AUTOMATIONS_PER_USER` as plain env defaults (neutral, not subscription-tiered).
- **C5:** BLOCKED-pending-boot → **PARTIAL** (surface + Better Auth verified live; account creation still blocked on SMTP-or-OAuth).
- **C2 / C4 / C6:** BLOCKED-pending-boot → **PASS** (as above).

**Two new gaps surfaced this round:**
1. **No headless signup path in self-host.** Email/password off + magic-link 500 (no SMTP) + GitHub OAuth-only means a fresh self-host has **no way to create the first account without either configuring SMTP or completing a GitHub OAuth handshake.** This blocks C5/C7/C8/C10 and any UAT that needs a session. Needs an operator decision (enable email/password or a dev-only bootstrap admin, or wire SMTP) before the Observed pillar is testable.
2. **`next build` TS gate fails at `auth-server.ts:35`** (`activeOrganizationId` `string|null|undefined` vs `string|null`) — this is in the tenancy agent's **uncommitted working-tree edits**; committed HEAD `apps/www` `tsc --noEmit` was clean in R1. Flag so it lands green before the next baseline.

## R1b — coordination reconciliation (2026-07-15)

- **Round 1b was already executed against the running app on :3100** (not :3000 — the :3000/:8080 listeners were unrelated local dev processes). Results are recorded in the R1b table above and committed as `4c26389`. boot-coder's live DB (43 tables, org tables present) is the same state queried here; boot-coder re-pushed 40→43 before the query, so the C6/T1/T4 PASS reflects the synced schema.
- **The shared (68) / www (53) RED baseline vs the previously-recorded green counts at the same HEAD is under active root-cause by triage-tester** (nondeterministic Drizzle schema application — `drizzle-kit push` silently skipping relations in the vitest test container). **Per team-lead direction, those suites are NOT re-run here to avoid concurrent-run interference with that investigation.** This validator's corroborating datapoint stands: a clean `drizzle-kit push` of the current committed `schema.ts` against the live self-host Postgres creates all 43 tables including `automations` + `user_feature_flags`, so the failure surface is the **test harness's push path**, not the schema definition. Treat the R1 RED counts as provisional pending triage-tester's root cause.
- **CI Node 20→22 pin** is being fixed by team-lead directly (commit `fb1a797` already on branch).
- Signup/observed-pillar cases (C5/C7/C8/C10) remain gated on a headless signup path (email/password disabled, magic-link 500 without SMTP, GitHub-OAuth-only) — unchanged from the R1b table; awaiting boot-coder's dev-bootstrap/SMTP decision before Round 1c.

## R1c — pre-staged plan (pending signup path; 2026-07-15)

Signup enablement is owned by **tenancy-coder** (`AUTH_EMAIL_PASSWORD_ENABLED` bool env, default false → true in `deploy/selfhost.env.example`, login UI gated to show the form). As of this writing it is **in the working tree, uncommitted** (`apps/www/src/lib/auth.ts:152`, `app/login/page.tsx:25`, new `components/email-password-auth.tsx`, `packages/env/src/apps-www.ts:117`). Enablement requires a **rebuild** (new component + login-page changes are not in the running `.next` build) with `AUTH_EMAIL_PASSWORD_ENABLED=true` in the build+runtime env, then restart on :3100 — coordinated with boot-coder once tenancy-coder commits.

**Execution order when unblocked (scripting notes per team-lead):**
1. **Signup A** via `signUp.email` — `autoSignIn` defaults true, so this returns a session directly (no separate login); display name derives from the email local-part.
2. **Signup B** likewise (fresh session).
3. **Capture the intermediate "fresh user, no org yet" state** — the org plugin does **not** auto-create an organization on signup, so both accounts have `activeOrganizationId=null` until an org is created explicitly. Record what `/dashboard` does for a null-org user (renders? empty state? errors? forces org creation?) — that is itself a UAT-relevant state.
4. **Create org A** (as user A) and **create org B** (as user B) via the org-create client call (`authClient.organization.create`) — through the app UI/server action if reachable, else the auth API route.
5. **C7** task create (user A, org A) → **C8** stubbed run streams → **C10** cross-org isolation smoke.

**C10 methodology reality:** the data layer is **Next.js server actions, not REST GET routes** (the only `app/api/*` routes are auth/proxy/webhook/cron/internal). So cross-org isolation cannot be a curl-per-REST-endpoint check. Evidence will be gathered two ways, recorded per-resource:
1. **Browser-driven, user A's session against org-B resource IDs** (via the chrome automation tools) on the resource-view page routes:
   - `/task/[id]` — org-B thread id → expect 404 / redirect / empty, not org-B content
   - `/environments/[id]` and `/environments/global` — org-B environment id → expect denied/empty
   - `/settings/integrations` + `/cli/auth` (cli-api-token) — org-B API key must not be listed/usable
   - `/dashboard` (task list) — user A sees only org-A tasks (zero org-B rows)
2. **Data-layer assertion via `docker exec` psql** on `automata_selfhost_postgres`: confirm the read server-actions (`get-threads`, `get-environments`, `cli-api-token`) filter by the active organization — i.e., a direct query proves org-B rows exist but user A's scoped read returns none.

**C10 pass standard (per team-lead):** user A gets **zero rows / 403** on every reachable org-B resource (threads, environments, api keys), recorded per-endpoint in this matrix.

**Interpretation altitude (per team-lead, so we don't over-claim):** at this stage resources are still **USER-scoped** — the ADR-001 accessor sweep (WI-5, `threads.ts` first per the ADR rollout) has **not** run. So a passing smoke with 2 users in 2 orgs demonstrates **user-level isolation only**. Record the result as: **"C10-baseline: user-level isolation intact; org-level scoping semantics NOT yet exercised (pending WI-5 accessor sweep)."** The full C10 — org-shared resources correctly visible to co-members AND invisible cross-org — re-runs after the sweep. **Hard-FAIL override:** if any reachable path lets **user A read user B's data even now**, that is a hard FAIL regardless of the org layer (and regardless of the WI-5 caveat).

## R1c — cross-org/user isolation + task-create, EXECUTED (2026-07-15)

**Auth bootstrap:** boot-coder's `deploy/seed-selfhost.ts` (52c832d) seeded 2 org-scoped users with raw bearer session tokens (owner1@selfhost.local→`org_selfhost_1`, owner2@selfhost.local→`org_selfhost_2`) — this **seeds around** real self-serve signup (the better-auth `bearer` plugin authenticates a raw session row via `Authorization: Bearer <token>`). Verified both authenticate and are org-scoped (`/api/auth/get-session` returns the right `userId`+`activeOrganizationId`; no-auth → `null`).

**C6 — org create (runtime) → PASS.** `POST /api/auth/organization/create` with owner1's bearer created "UAT Runtime Org" and persisted the `organization` + `member(role=owner)` rows. Upgrades C6 from schema-only to runtime-verified.

**C7 — task create → PASS-TO-GATE (no run triggered, by design).** Self-minted a daemon-token via bearer (`POST /api/auth/api-key/create` → returns a Better Auth apiKey; note: any authenticated user can mint their own userId-bound daemon token — expected plugin behavior). Then `POST /api/cli/threads/create` (oRPC, `{"json":{...}}` envelope): the endpoint is reachable, authenticated (daemon token → userId context), rate-limit-checked, and input-validated; it rejected at the **GitHub-App/repo-access gate** ("Unable to access repository …") for the seeded fake repo, creating **no** thread and **no** sandbox (thread count for user1 unchanged). Task-create wiring is verified end-to-end up to the repo gate; a full create needs a real GitHub-App-installed repo.

**C8 — stubbed run streams to dashboard → BLOCKED.** Requires a real installed repo + a running sandbox provider + the `apps/broadcast` PartyKit relay (unconfirmed running, still untested). Not headlessly achievable this round; deferred.

**C10 — cross-org/user isolation smoke → PASS (C10-baseline, user-level).** Seeded `thr_uat_org1` (owner user1) and `thr_uat_org2` (owner user2); DB confirms both rows exist, one per user. Probed the **real CLI API read accessor** (`getThreads`, which filters `userId: context.userId`) per-endpoint:

| # | Probe (endpoint) | Identity | Result | Verdict |
|---|---|---|---|---|
| 1 | `threads/list` | owner1 | `[thr_uat_org1]` only | PASS |
| 2 | `threads/list` | owner2 | `[thr_uat_org2]` only | PASS |
| 3 | `threads/detail(thr_uat_org2)` | owner1 | `NOT_FOUND` 404 | PASS — cross-read denied |
| 4 | `threads/detail(thr_uat_org1)` | owner2 | `NOT_FOUND` 404 | PASS — cross-read denied |
| 5 | `threads/detail(thr_uat_org1)` | owner1 (control) | `OK` (own thread) | PASS — authorized read works |

**No path let user A read user B's data → the hard-FAIL override was NOT triggered.** Recorded per the approved altitude: **"C10-baseline: user-level isolation intact; org-level scoping semantics NOT yet exercised."** The accessor scopes by `userId`, not `organizationId` (WI-5 accessor sweep, `threads.ts`-first, has not run) — because each seeded user owns exactly one distinct org, user-level isolation here also happens to separate the two orgs, but this does **not** prove org-level semantics (co-member visibility of org-shared resources, cross-org invisibility of shared resources). Full C10 re-runs after WI-5.

**Still untested (needs the rebuild cutover, which has NOT happened — old build still returns `EMAIL_AND_PASSWORD_SIGN_UP_IS_NOT_ENABLED`):**
- **C5 real self-serve signup** — the seeded-session bootstrap deliberately bypasses it.
- **Fresh-user-no-org (`activeOrganizationId=null`) dashboard state** — both seeded users already have an org, so this intermediate UAT state was not observable.

**Pillar movement:** VERIFIED-adjacent tenant isolation now has real per-endpoint evidence at user-level (C10-baseline PASS); EXECUTED task-create path verified to the repo gate (C7); OBSERVED still 0 (C8 blocked on run streaming). Test artifacts left in the self-host DB (2 seeded threads, 1 runtime test org) — harmless, boot-coder can re-seed.
