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

### R1c — C5 evidence standard (per team-lead)

**A seeded session does NOT count as C5 evidence.** boot-coder's `seed-selfhost.ts` bearer sessions authenticate around signup and are treated strictly as **supplementary fixtures** — valid for widening C10 probes (up to 4 orgs) and fast API-level assertions (as used above for C6/C7/C10), but they do **not** certify the product's self-serve signup behavior. **C5 must be exercised via the real email/password signup form** (rendered after the `AUTH_EMAIL_PASSWORD_ENABLED` rebuild cuts over on :3100), driving `POST /api/auth/sign-up/email` through the actual UI flow and observing: account creation, `autoSignIn` session, and the resulting fresh-user-no-org (`activeOrganizationId=null`) dashboard state. Status: **PENDING rebuild cutover** (boot-coder re-ordered to rebuild now; execute on its ping).

## R1c-final — real self-serve signup (C5) EXECUTED, post-rebuild (2026-07-15)

Rebuild with `AUTH_EMAIL_PASSWORD_ENABLED=true` cut over on :3100 (login now serves the email/password form). C5 exercised via the **real product path as a brand-new, non-seeded user** (not a seeded fixture — per the recorded evidence standard).

| Case | Verdict | Evidence |
|---|---|---|
| **C5 — real self-serve signup** | **PASS** | `/login` renders the form (`type="email"`, `type="password"`, "create an account" toggle, GitHub button intact). `POST /api/auth/sign-up/email` as new user `uat-c5-real@selfhost.local` → **200**, real `user` row minted (id `bOZeH…`), `autoSignIn` set a **signed** `better-auth.session_token` cookie. `get-session` via that cookie → correct `userId`, `emailVerified=false`. This is product-behavior signup, not a seeded session. |
| **Fresh-user-no-org state** | **PASS (characterized)** | Immediately post-signup, `activeOrganizationId=null` (org plugin does not auto-create an org). `GET /dashboard` for this authed null-org user → **HTTP 200**, renders an **Onboarding/welcome/setup** state (graceful — no crash, no redirect loop, no error). `/welcome` → 200. So a fresh user with no org lands in onboarding, as intended. |
| **C6 — org-create (runtime), real user** | **PASS** | `POST /api/auth/organization/create` with the real user's session → org created (`JnUhW…`), user persisted as `owner`, and the session's `activeOrganizationId` **updated** to the new org (null → set). Loop closed. |

### R1c consolidated verdict table (all cases this round)

| Case | Verdict | Altitude / note |
|---|---|---|
| C5 real self-serve signup | **PASS** | Real product path, new user, autoSignIn |
| Fresh-user-no-org dashboard | **PASS (characterized)** | Graceful onboarding state, HTTP 200 |
| C6 org-create runtime | **PASS** | Real user + seeded user both; owner membership + active-org update |
| C7 task-create | **PASS-to-gate** | Reachable/authed/validated; stops at GitHub-repo gate; no provisioning, no run |
| C8 stubbed run → dashboard | **BLOCKED** | Needs real installed repo + running provider + `apps/broadcast` relay |
| C10 cross-user isolation | **PASS (user-level baseline)** | Per-endpoint, no leakage, control OK; org-level pending WI-5 sweep |

**Round-1 UAT status:** the executed pillars now have real evidence — signup/onboarding (C5), tenant identity + org-create (C6), task-create wiring (C7), and user-level cross-tenant isolation (C10) all PASS at their respective altitudes. Remaining open: C8 run-streaming (needs the execution substrate + a real repo), the full org-level C10 (post-WI-5 accessor sweep), and the two test-harness baseline regressions (shared/www — under triage-tester, confirmed harness-only). Test artifacts left in the self-host DB (users `uat-c5-real`, seeded owner1/2; orgs `uat-c5-org`, `uat-runtime-org`, 2 seeded; threads `thr_uat_org1/2`) — harmless, boot-coder can re-seed.

## R1c-Extended — 4-way cross-tenant isolation, all REAL signups (2026-07-15)

The rebuild/re-seed wiped boot-coder's earlier seeded users (their bearer tokens no longer authenticate), so the 4-way matrix was built entirely from **four real self-serve signups** (A/B/C/D) — stronger than the planned 2-seeded + 2-real mix, since every tenant is a genuine product-path account. Each: real signup (`POST /api/auth/sign-up/email`, autoSignIn) → confirmed `activeOrganizationId=null` → `organization.create` (owner) → one distinct seeded thread → self-minted daemon token.

**LIST probe — each user sees ONLY their own thread:**

| User | `threads.list` result | Expected | Verdict |
|---|---|---|---|
| A | `[thr_uat_realA]` | own only | PASS |
| B | `[thr_uat_realB]` | own only | PASS |
| C | `[thr_uat_realC]` | own only | PASS |
| D | `[thr_uat_realD]` | own only | PASS |

**4×4 DETAIL grid — requester (row) reads target thread (col); own=OK, cross=NOT_FOUND:**

| | →A | →B | →C | →D |
|---|---|---|---|---|
| **A** | OK | NOT_FOUND | NOT_FOUND | NOT_FOUND |
| **B** | NOT_FOUND | OK | NOT_FOUND | NOT_FOUND |
| **C** | NOT_FOUND | NOT_FOUND | OK | NOT_FOUND |
| **D** | NOT_FOUND | NOT_FOUND | NOT_FOUND | OK |

Perfect isolation diagonal: all 4 own-reads succeed, all **12 cross-reads denied (404)**. **No path let any user read another user's data → hard-FAIL override NOT triggered.** Altitude unchanged — this certifies **user-level** isolation across 4 real tenants; org-level scoping semantics (co-member visibility, org-shared resources) still await the WI-5 accessor sweep (`getThreads` filters by `userId`, not `organizationId`).

**C5 corroboration (2nd+ real signups):** users B/C/D each reproduced the exact C5 behavior from R1c-final — form endpoint → 200 + real user row + autoSignIn signed cookie → `activeOrganizationId=null` → onboarding-capable → org-create sets active org. Signup is deterministic across repeated real accounts.

Test artifacts left in the self-host DB: real users A–D (`uat-c5-real{,b,c,d}@selfhost.local`), 4 orgs (`uat-c5-org{,-b,-c,-d}`), 4 threads (`thr_uat_real{A,B,C,D}`). Harmless; boot-coder can re-seed/clear.

## R1c — infra addendum: broadcast/streaming transport (2026-07-15)

boot-coder surfaced (and started) a previously-missing dependency: the **PartyKit broadcast server on :1999**. Signup POSTs to it in a post-create hook (`/parties/main/user:<userId>`); with broadcast **down**, that hook throws ECONNREFUSED and signup returns **500** even though the user row persists — this was the true cause of the earlier "signup 500 on bare app-only boot" (not an auth-config issue).

**Verified this round:**
- Broadcast :1999 is **UP** (`GET /` → 404, `/parties/main/health` → 401 — i.e. listening + auth-enforcing, not ECONNREFUSED).
- All 4 R1c-Extended real signups returned **200**, which means the signup→broadcast post-create hook succeeded — so the **signup↔broadcast integration is exercised and working** (a 500 would have proven it broken).

**Impact on C8 (stubbed run → dashboard):** the broadcast **transport** (one of C8's three blockers) is now confirmed running. Remaining C8 blockers: a real **GitHub-App-installed repo** (fake repos reject at the create gate) + a **running sandbox provider** + an **actual agent run** (spends Anthropic credits). C8 stays deferred as a non-headless case, but the streaming substrate is no longer missing. This is also a partial **OBSERVED-pillar (O2)** datapoint: the live-transcript relay transport is alive, though no transcript has been streamed end-to-end yet.

**Env at round close:** app :3100, broadcast :1999, Postgres :55432, Redis :58079, MinIO :9000. DB holds my 4 test users / 5 orgs / 4 threads (boot-coder cleaned its own seeds, left mine).

## C10-ORG round — STAGED design (2026-07-15, pending boot-coder rebuild ping @ 6d893ad)

WI-5 landed (HEAD 6d893ad): `forTenant` accessor (`model/tenant.ts`), org fence on thread reads, org stamp on create. Certifies tenant isolation at **ORG altitude** on app-created threads. Executes on boot-coder's ping (app was responding but may be mid-rebuild — not executed yet).

### Fence semantics (read from source, not assumed)
- **`forTenant` fence = `and(userId, organizationId)`** — threads are **private-to-creator within an org** (`tenant.ts:33-35`). A co-member of the same org does NOT see your threads (per-user list preserved); another org never sees them.
- **`threadOrgFence(orgId)` (`threads.ts:54`)** = `orgId ? eq(thread.organizationId, orgId) : undefined`. Asymmetric and load-bearing: when the query carries an active org, the predicate is `eq(...)`, which **excludes NULL** → **legacy null-org threads are hidden whenever the caller has an active org**. When the query org is null, no org predicate is applied → userId-only.
- **Dashboard** reads get org from `session.activeOrganizationId` (`auth-server.ts:70`). **CLI** reads get org from the daemon token's `metadata.organizationId` (`daemon-token-context.ts` → `daemonTokenContextFromApiKey`).

### Two predicted findings to VERIFY (per team-lead: record actual, finding-not-fail)
1. **CLI/daemon tokens are minted WITHOUT org metadata.** `createCliApiToken` (product) and the dev `/api/internal/daemon-token` route both call `auth.api.createApiKey({ body: { userId } })` with **no `metadata.organizationId`**. So `daemonTokenContextFromApiKey` resolves `organizationId=null` → `threadOrgFence(null)` no-ops → **the CLI read path is org-fenced in name only; in production it falls back to user-level**. This is a read-side sibling of the known background-create gap. → Verify by minting a token via the product path and reading its resolved org; certify the *fence mechanism* separately by minting a token WITH `metadata.organizationId` (test-only) and confirming it isolates.
2. **Null-org legacy threads vanish under an active org.** Because the fence uses `eq`, a creator who now has an active org will NOT see their own pre-fence (null-org) threads via an org-scoped read. The "null-org visible to creator" back-compat claim holds **only for a null-org query context**. → Verify: seed a null-org thread for a user, read it (a) with a null-org token/session (expect visible) and (b) with an org-scoped token/session (expect hidden). Record which; flag as sweep semantics question if it contradicts ADR-001 intent.

### Test matrix (execute on ping)
Fixtures — 2 real users, each with an org; threads carrying `organizationId` (via real app create if a GitHub-App-installed repo is available, else org-stamped seed rows — see feasibility). Probe via CLI with **org-scoped** daemon tokens (self-minted with `metadata.organizationId`).
1. **Row-level stamp:** each app-created/seeded thread row carries the creator's `organizationId` (psql assertion).
2. **Cross-org list:** user A (active org A) list → only org-A threads; zero org-B rows.
3. **Cross-org detail:** A reads a org-B thread → 404; own-org read → OK (control).
4. **Org switch:** a user in 2 orgs creates a thread in org1, switches active org to org2, lists → org1 thread should NOT appear while org2 active (per private-to-creator-within-org fence). Record actual.
5. **Legacy/null-org back-compat:** null-org thread visible to creator under a null-org read; behavior under an org-scoped read recorded per finding #2.

### Feasibility notes / dependencies
- **App-create needs a GitHub-App-installed repo** (create rejects at the repo-access gate for fake repos — proven in R1c C7). If no real installed repo is available headlessly, thread rows will be **org-stamped seed rows** to exercise the read fence, and the create-path org-stamp certified at code level (`tenant.ts:95`, `cli-router` create passes `context.organizationId`, commit 6d893ad) rather than end-to-end. Flag to team-lead which applies.
- **Org-scoped daemon tokens:** self-mint via `POST /api/auth/api-key/create` with `metadata:{organizationId}` (bearer/cookie session). Confirms the fence READ mechanism independent of the product mint gap (finding #1).
- **Background create paths** (webhooks/automations/follow-up) don't stamp org — per team-lead, recorded as sweep-pending, not failed.

## C10-ORG round — EXECUTED (2026-07-15, HEAD 6d893ad)

boot-coder rebuilt :3100 at 6d893ad and pushed the `organization_id` columns (thread + environment). My earlier real users/sessions survived (org column nullable). App-create is repo-gated (R1c C7), so per boot-coder's guidance threads were **org-stamped seed rows** (the create-path stamp is certified at code level: `tenant.ts:95`, `cli-router` create passes `context.organizationId`, commit 6d893ad); the **read fence** was exercised over the real CLI accessor with **org-scoped daemon tokens** (self-minted with `metadata.organizationId` — the endpoint accepts + stores it).

**Fixtures:** user A (org A `JnUhW…`, org A2 `SEbP…` — A is in 2 orgs), user B (org B `qsLpeM…`). Threads: `thr_orgA_1`(A,orgA), `thr_orgA2_1`(A,orgA2), `thr_orgB_1`(B,orgB), `thr_uat_realA`(A, **null-org legacy**). Row-level `organization_id` stamp verified per row via psql.

### Results

| # | Case | Probe | Result | Verdict |
|---|---|---|---|---|
| 1 | Row-level org stamp | psql on seeded rows | each carries correct `organization_id` | PASS |
| 2 | Org-fence LIST | A/orgA list | `[thr_orgA_1]` only | PASS |
| 3 | Org-fence LIST | A/orgA2 list | `[thr_orgA2_1]` only | PASS |
| 4 | Org-fence LIST | B/orgB list | `[thr_orgB_1]` only | PASS |
| 5 | **Same-user cross-org detail** | A/orgA detail(`thr_orgA2_1`) | **NOT_FOUND** | **PASS — org-level proof** |
| 6 | Cross-org+user detail | A/orgA detail(`thr_orgB_1`) | NOT_FOUND | PASS |
| 7 | Own-org control | A/orgA detail(`thr_orgA_1`) | OK | PASS |
| 8 | **ORG SWITCH** | A/orgA can't see orgA2 thread; A/orgA2 can't see orgA thread | both NOT_FOUND | PASS — visibility follows active org |

**Decisive org-altitude evidence:** the *same user A* sees `thr_orgA_1` under the orgA token but `thr_orgA2_1` under the orgA2 token, and each denies the other's thread — org-partitioned reads, not user-level. This is the certification that was pending WI-5 in prior rounds.

### Findings (both predicted from source, now CONFIRMED — record-not-fail per team-lead)

**FINDING #1 — CLI/daemon read fence is INERT in production (no mint stamps org).** A token minted with **no** `metadata.organizationId` (exactly what `createCliApiToken` and the dev daemon-token route produce) returned **all of user A's threads across both orgs + the null-org legacy** (`['thr_orgA2_1','thr_orgA_1','thr_uat_realA']`) — `threadOrgFence(null)` is a no-op, so the CLI path falls back to user-level. The fence *mechanism* is correct (proven in tests 2–8 with an org-carrying token), but the **product mint paths never populate the org metadata**, so on the real CLI surface the org fence does not bite. Read-side sibling of the known background-create gap. **Remediation:** stamp `metadata.organizationId` at token mint (from the minting session's active org). NOTE: the **dashboard** path is unaffected — it sources org from `session.activeOrganizationId` (populated), so dashboard reads are genuinely org-fenced; the gap is CLI/daemon-token-specific.

**FINDING #2 — legacy null-org threads are hidden under an active org.** `thr_uat_realA` (null-org) is **visible** under a null-org query (A/null list includes it) but **NOT_FOUND** under an active-org read (A/orgA detail → NOT_FOUND; absent from A/orgA list). `threadOrgFence` uses `eq`, which excludes NULL. So "null-org visible to creator" holds **only for a null-org query context**. This is mitigated by design: the **personal-org backfill script (commit db2c10b)** stamps existing rows with the user's personal org — after backfill, legacy threads appear under that org. Unbackfilled null-org rows are hidden the moment a user has an active org. **Record:** as-designed *given the backfill runs*; flag that any unbackfilled rows (or background-created null-org rows) silently disappear from an org-scoped view.

### Verdict
Org-level tenant isolation **PASSES at the mechanism level** (row stamp + org-partitioned reads + same-user cross-org denial + org-switch). Two confirmed gaps for the sweep: (#1) daemon-token mints don't stamp org → CLI fence inert in prod; (#2) unbackfilled null-org threads vanish under an active org. Neither is a data-leak (no user saw another's data; if anything #1 is *under*-fencing within a single user's own orgs, not cross-user leakage). Background create paths (webhooks/automations/follow-up) not stamping org remain sweep-pending per team-lead.

Test artifacts added: org A2 (`uat-org-a2`), threads `thr_orgA_1/thr_orgA2_1/thr_orgB_1`, several daemon tokens. Harmless; boot-coder can clear.

### C10-ORG — recording refinements (team-lead adjudication, 2026-07-15)

Three dispositions confirmed by team-lead; folded in so the round is recorded at the right altitude:

1. **Create-stamp certification (seeding accepted).** No real GitHub-App-installed repo exists for this platform yet (smoke env has dummy `GITHUB_*` keys; the platform's own GitHub App is a later-phase deliverable), so org-stamped seed rows are the accepted method for exercising the **read** fence. The **create-path org-stamp** is certified at **action level** by `apps/www/src/server-actions/new-thread.test.ts:97-147` ("organization tenant scoping (WI-5)" — real `newThread` action + `session.activeOrganizationId` → `thread.organizationId === org.id`, plus a null-org case), committed with 6d893ad. **`app-path create with a real installed repo re-certifies in the substrate phase (C7-full).`**

2. **Finding #1 → FINDING, fix-in-flight.** Confirmed REAL and **pre-known**: tenancy-coder flagged the daemon/CLI key-creation rewiring in its WI-5 report; team-lead is dispatching that fix now. The CLI fence **mechanism** is certified here (org-carrying test token isolates correctly); the production gap is the mint not stamping `metadata.organizationId`. Re-verify after the mint-stamps-org fix lands.

3. **Finding #2 → documented migration semantics, NOT a defect.** "Creator can't see their null-org thread under an active org" is the intended behavior; the operator remedy for legacy rows is the **personal-org backfill script** (creates personal orgs + stamps `organizationId`), run at cutover. Both behaviors recorded (visible under null-org query; hidden under active org); not treated as a defect.

**C10-ORG round CLOSED.** Org-level fence certified at the mechanism level; the two findings are tracked sweep items (one with a fix in flight, one resolved-by-backfill), not fails. No cross-user data leak observed in any probe.

## C10-ORG-CLOSURE — STAGED (2026-07-15, HOLD for team-lead go)

Closes C10-ORG fully at **product-path altitude**. Sequenced AFTER: (i) tenancy-coder's mint-stamp fix lands (createCliApiToken + dev daemon-token route stamp `metadata.organizationId` from the session's active org), (ii) team-lead orders boot-coder's rebuild (recipe includes drizzle push). Execute on team-lead's go only.

**Test (a) — product-path CLI token now carries org (closes FINDING #1).** As user A with active org = orgA, mint a CLI token through the **real product path** (not the test-only `api-key/create` with hand-set metadata) — i.e. the `createCliApiToken` server action via the settings/CLI-token UI (browser-driven), or the dev daemon-token route if the build runs `NODE_ENV=development`. Then:
- Assert the minted apiKey's `metadata.organizationId === orgA` (psql on the apikey row, or resolved via CLI behavior).
- Use that token (no hand-injected metadata) on `threads.list` → expect **only orgA threads** (fence now bites on the real mint). Re-run the org-switch: mint while active=orgA2 → token scoped to orgA2.
- PASS criterion: the production mint path produces an org-scoped token and the CLI fence is live without any test-minted token.

**Test (b) — dashboard-path org read end-to-end (session-sourced fence).** Browser-driven (chrome tools), logged in as a real user with an active org: load `/dashboard` (+ a `/task/[id]` for a cross-org thread id) and assert the org fence on the surface real users touch — the dashboard lists only active-org threads; a cross-org task id is not visible. This certifies the `session.activeOrganizationId` → `forTenant` fence path (which FINDING #1 noted is already correct at the source, but was never exercised end-to-end through the rendered server-action surface). Include an org-switch (change active org in the UI, re-list) if reachable.
- PASS criterion: dashboard shows only the active org's threads; cross-org resource not reachable; org-switch changes the visible set.

**Method notes:** both tests are browser-driven (chrome-devtools / claude-in-chrome tools). Test (a) needs the product mint UI or dev token route; test (b) needs a rendered-page assertion (server actions aren't curl-able). Fixtures reuse the existing real users/orgs (A/orgA/orgA2, B/orgB) + their org-stamped threads; re-seed if the rebuild's drizzle push clears rows. On completion this marks C10-ORG **fully closed at product-path altitude** and flips FINDING #1 from fix-in-flight to verified-fixed (or re-opens it if the mint still doesn't stamp).

## C10-ORG-CLOSURE — EXECUTED (2026-07-15, HEAD 6b566ff incl. mint-fix 2e28584)

Closes C10-ORG at **product-path altitude**. boot-coder rebuilt :3100 at the mint-fix (2e28584: `createCliApiToken` + dev daemon-token route stamp `metadata.organizationId` from `session.activeOrganizationId`). **Method note:** the chrome-devtools browser profile was locked by another running instance, so instead of DOM-driving the UI I invoked the **actual server actions over the Next.js `Next-Action` HTTP protocol** (action IDs extracted from the `.next` build) with the real cookie session — this drives the exact same server-side code the UI buttons trigger (`createCliApiToken`, `getThreadsAction`), a more precise fence certification than DOM-scraping.

### Test (a) — product-path CLI token now carries org (closes FINDING #1) → PASS

| Step | Result |
|---|---|
| Invoke real `createCliApiToken` server action (cookie A, active org=orgA) | returns a CLI key; apikey row `metadata = {"organizationId":"<orgA>"}` (psql-verified) |
| Product token (NO hand-set metadata) → `threads.list` | `[thr_orgA_1]` **only** (not orgA2, not null-legacy, not B) |
| Org-switch: set active=orgA2, re-mint product token | new key `metadata.organizationId = <orgA2>`; `threads.list` → `[thr_orgA2_1]` only |

**FINDING #1 → VERIFIED-FIXED.** The production mint path now stamps the session's active org, and the CLI read fence bites **without any test-minted token**. Re-mint under a different active org yields a correctly-scoped token (org-switch works at the mint layer).

### Test (b) — dashboard session-sourced org fence → PASS

The dashboard thread list is served by `getThreadsAction` (server action) which reads `getTenantContextOrNull()` → `session.activeOrganizationId` and calls `getThreads({ userId, organizationId })`.

| Step | Result |
|---|---|
| `getThreadsAction` via Next-Action (cookie A, active org=orgA) | returns `thr_orgA_1` only |
| Org-switch to orgA2, re-invoke | returns `thr_orgA2_1` only |

**Dashboard/session-sourced fence certified** on the real data path real users touch: visibility is org-partitioned and follows the active org. (Confirms the FINDING #1 note that the dashboard path was always correct — it sources org from the session, which is populated; only the CLI mint lacked the stamp, now fixed.)

### C10-ORG fully CLOSED at product-path altitude
Org-level tenant isolation is certified end-to-end on both surfaces: **CLI** (product token now org-stamped, reads fenced) and **dashboard** (session-sourced fence, org-switch honored). Both prior findings resolved: **#1 fixed (2e28584, verified live)**; **#2** documented migration semantics (personal-org backfill at cutover). Remaining sweep-pending (per team-lead, not this round): background create paths (webhooks/automations/follow-up) + `daemon.ts` proxy-token org — the ~96-site sweep the lead is ordering next, with these findings steering priority.

Test artifacts: additional `cli-*` apikeys on user A (product-minted during test). Harmless; boot-coder can clear.

## Sweep batch-1 validation — STAGED placeholder (HOLD for tenancy-coder report)

C10-ORG is CLOSED (no DOM re-drive: per team-lead, Next-Action invocation certifies the fence = identical server code; a rendered-UI pass tests UI wiring, not tenancy — deferred to a later UX round). Next: validate the ~96-site sweep per batch. **Batch 1 = background create paths + `daemon.ts` proxy-token org.** Hold until tenancy-coder reports; design the probes around the **derivation rules it documents** (org is NOT the user's active-org-at-read-time for background paths — it must derive from the triggering resource). Three probes the round must cover (per team-lead):
1. **Webhook-created thread lands in the RIGHT org** — a GitHub-webhook-driven thread gets `organizationId` derived from the repo/installation→org mapping, not from any ambient session.
2. **Automation-created thread inherits its automation's org** — a thread created by an automation carries the automation row's `organizationId`.
3. **Sandbox-agent proxy token is scoped to its thread's org** — the proxy/daemon token minted for an in-sandbox agent resolves the org of *its thread*, not the user's active org at some later time (the temporal-decoupling case — active org can change after the run starts).

Method will mirror C10-ORG: derive expected org from the trigger, assert the created row's `organization_id` (psql) + that reads through the fence are correctly scoped. Refine exact assertions against the documented derivation rules when batch 1 lands.

## Sweep batch-1 validation — EXECUTED (2026-07-15, running instance 296307f)

Validated the WI-5 sweep batch 1 (background create/token paths derive org from context). Derivation rules read from source at the **running commit 296307f** (working tree is dirty with next-batch `githubInstallation` WIP — validated against the committed/deployed code, not the WIP). Rules documented in `tenant.ts` JSDoc.

### Derivation rules — all code-certified at 296307f

| Path | Derives org from | File | Verdict |
|---|---|---|---|
| Automation run (`runAutomation`) | `automation.organizationId` (automation is org-owned) | `server-lib/automations.ts` | correct source ✓ |
| Slack webhook mention | `slackInstallation.organizationId` (teamId→one installation→one org) | `webhooks/slack/handlers.ts` | correct source ✓ |
| Sandbox-agent proxy token | `thread.organizationId` (acts for one thread) | `agent/daemon.ts` | correct source ✓ |
| GitHub app-mention | **intentionally null** (no schema-backed repo→org / installation→org mapping yet) | `webhooks/github/handle-app-mention.ts` | correct/documented ✓ |

### Probe verdicts

- **Slack webhook → installation org → PASS (tested green).** `handlers.test.ts` runs **14/14 green** on this build, including the +2 batch-1 cases (derives org from installation; null-safe when none). This is the one background path with live test coverage.
- **Sandbox proxy token → thread org → PASS by construction (temporal-decoupling STRUCTURALLY GUARANTEED).** `sendDaemonMessage` derives org via a direct `db.select(thread.organizationId).where(thread.id = threadId)` and stamps it into the apiKey metadata. It takes `userId`/`threadId` as params and reads **no auth session / activeOrganizationId** (the `session` params are `ISandboxSession`, the sandbox connection — not the Better Auth session). Therefore the proxy token **cannot drift** to the user's active-org-at-some-later-time — the value is never read. This is the sharpest probe the team-lead named, and the derivation makes the failure mode structurally impossible.
- **Automation → automation org → PASS (code-certified).** `runAutomation` passes `automation.organizationId` into `createNewThread`. Correct source; session-independent (automation-owned).
- **GitHub app-mention → null → correct for this batch.** Deliberately unstamped pending the `githubInstallation` table. That mapping is **uncommitted next-batch WIP** (`getOrganizationIdForInstallation` + `bind-github-installation.ts` + a `githubInstallation` schema change) — lands in the next rebuild; its impl reads `githubInstallation.organizationId` (looks correct). Validate after that rebuild.

### FINDINGS (coverage gaps — record, recommend)

1. **The two highest-value background paths have NO org-stamp test.** Slack got +2 tests, but **`runAutomation` has no `automations.test.ts` org case** and **the daemon proxy-token stamp has no `daemon.test.ts` org case**. The daemon proxy token is the temporal-decoupling path — currently certified only structurally (by code inspection), not by a regression test. **Recommend:** add a `daemon.test.ts` round-trip mirroring `cli-api-token.test.ts` (seed thread org → `sendDaemonMessage` → assert minted apiKey `metadata.organizationId === thread.organizationId`, and a case where the user's active org differs from the thread's org to lock the no-drift property), plus an `automations.test.ts` org-inheritance case. Without these, a future refactor could silently reintroduce active-org drift on the proxy token with no failing test.

### Live-reachability limitation (same as C7-full)
End-to-end live certification of the create paths (automation/slack producing a persisted org-stamped thread) is blocked by the GitHub-App/repo gate (`createNewThread`/`newThreadInternal` reject uninstalled repos — proven in R1c C7), and the proxy-token mint requires a live sandbox. So batch-1 live certification is bounded to the Slack unit tests + code/structural certification; full end-to-end re-certifies in the substrate phase with a real installed repo + running provider.

**Batch-1 verdict:** derivation rules correct and session-appropriate on all four paths; Slack path tested green; sandbox proxy-token temporal-decoupling structurally guaranteed; two coverage gaps flagged with concrete test recommendations. No org-misattribution risk found in the derivation logic.

## GitHub-mention org probe — STAGED (44c4d82 committed; HOLD for boot-coder deploy ping)

44c4d82 (githubInstallation→org mapping fences GitHub mentions) is committed but the running instance is still 296307f — hold for boot-coder's rebuild ping, then execute. Path read at 44c4d82: webhook HMAC-SHA256 via `x-hub-signature-256` against `env.GITHUB_WEBHOOK_SECRET`; sender→platform user via `getUserIdByGitHubAccountId`; org via `getOrganizationIdForInstallation({installationId})` → `newThreadInternal.organizationId` (unmapped → null).

**Fixtures:**
1. Bind installation `99001` → orgA via `bindGithubInstallationToOrg` (or psql insert into `github_installation`). Verify the row (psql).
2. Seed a Better Auth `account` row (providerId=github, accountId=`<sender gh id>`, userId=A) so `getUserIdByGitHubAccountId` resolves user A.

**Probe steps (per team-lead brief):**
1. Fire an `issue_comment`/`issues` app-mention webhook at `POST /api/webhooks/github`: payload `installation.id=99001`, sender mapped to A, `@bot` mention; sign `x-hub-signature-256 = sha256=HMAC(GITHUB_WEBHOOK_SECRET, body)`.
2. Assert the created thread carries orgA (psql) **and** is fenced (cross-org read via orgB CLI token → NOT_FOUND).
3. **Unmapped control:** same webhook with `installation.id=99999` (unbound) → thread created with **NULL** org (today's behavior, not an error).
4. **Repo-gate contingency (expected, per team-lead):** the create funnels through `newThreadInternal` → GitHub-App-installed-repo gate (C7). If it stops there (no persisted thread), assert the derivation another way: (a) `github_installation` binding row present (psql); (b) `getOrganizationIdForInstallation(99001)==orgA` / `(99999)==null` derivation; (c) cite the **unit pair** — `handle-app-mention.test.ts:244/259/276` (bound→org.id on the thread; unbound→null) + `github-installation.test.ts` (mapping upsert/read). Record the repo-gate boundary explicitly.

### Batch-1 coverage finding — UPDATE (fix in flight)
The daemon no-drift regression test I recommended **is written** — `apps/www/src/agent/daemon.test.ts` (untracked WIP) has: "stamps the thread's org into the minted proxy-token metadata" (`metadata.organizationId === orgX`) and **"carries the THREAD's org even when the user's active org differs (no-drift pin)"** (sets user active org=orgY, asserts token still carries thread's orgX — the exact temporal-decoupling pin). When it commits, fold its SHA into the batch-1 coverage line and flip the daemon proxy-token gap to **closed**. (Still watch for the `automations.ts` org-inheritance test — not yet seen.)

## GitHub-mention org probe — EXECUTED (2026-07-15, running instance 44c4d82)

boot-coder deployed 44c4d82 (githubInstallation→org mapping) + created the `github_installation` table. Executed the probe per team-lead brief. As predicted, the live create stops at the GitHub-App/repo gate (C7 boundary) — so certification combines the live signed-webhook path with the derivation unit pair (run green on this build).

**Fixtures (live DB, psql-verified):** `github_installation(installation_id=99001 → organization_id=orgA)`; Better Auth `account(account_id=9000001, provider_id=github → user_id=A)` so `getUserIdByGitHubAccountId` resolves A.

**Live signed webhook:**
| Fire | installation.id | HTTP | Thread persisted? |
|---|---|---|---|
| mapped | 99001 (→orgA) | 500 | no |
| unmapped control | 99999 (→null) | 500 | no |

- **Signature verification PASSED** — both returned **500, not 401** (`webhooks.verify` accepted the HMAC-SHA256 `x-hub-signature-256` computed with the smoke `GITHUB_WEBHOOK_SECRET`). So the webhook path executed: routed `issue_comment.created` → `handleIssueCommentEvent` → `isAppMentioned("@automata-selfhost")` → `handleAppMention` → `getUserIdByGitHubAccountId(9000001)=A` → `getOrganizationIdForInstallation(installationId)` → `newThreadInternal`.
- **Both mapped and unmapped hit the SAME boundary (500, no persist)** → the failure is downstream of the org derivation (the repo-access gate, common to both), confirming the org derivation itself is not the failure point. No thread persists because no real GitHub-App-installed repo exists (the dummy `GITHUB_*` creds fail `isAppInstalledOnRepo`). The running app's stdout isn't reachable to read the exact error line, but the mapped/unmapped symmetry localizes it to the C7 repo gate.

**Derivation certified by the unit pair (run green on this build):**
- `handle-app-mention.test.ts` — **2/2 green**: "derives the thread's org from the GitHub App installation (WI-5)" asserts `newThreadInternal` is called with `organizationId: org.id` for a bound installation; "passes a null org when the installation is unmapped (nullable-safe)" asserts null. This is the authoritative create-boundary certification (mocked repo, so it bypasses the gate the live path hits).
- `github-installation.test.ts` — **3/3 green** (mapping upsert/read).

**Verdict:** GitHub-mention org derivation is **CORRECT and certified** — installation→org mapping (`getOrganizationIdForInstallation`) feeds `newThreadInternal.organizationId` (bound→org, unbound→null), proven by the unit pair; the live signed webhook exercises the full wired path through to the documented repo-gate boundary. Full end-to-end (a persisted org-stamped thread from a real mention + cross-org fence assertion) re-certifies in the substrate phase with a GitHub-App-installed repo (same C7-full dependency). No org-misattribution risk in the derivation.

Test artifacts: `github_installation` 99001 + `account` acc_uat_gh in the live DB. Harmless; boot-coder can clear.

## Batch-1 coverage gap — CLOSED (2026-07-15, regression SHA 62a7829)

The coverage finding from the batch-1 validation is resolved. `62a7829` ("test(tenancy): pin daemon proxy-token + automation org derivations") adds the two missing regression tests, both **run green on this build**:
- `apps/www/src/agent/daemon.test.ts` — **2/2**: proxy-token org round-trip + the **no-drift pin** exactly as specified (user active org Y ≠ thread org X → minted token still carries the **thread's** org X). The daemon proxy-token temporal-decoupling property is now locked by a regression test, not just code structure. **Daemon proxy-token gap → CLOSED.**
- `apps/www/src/server-lib/automations.test.ts` — **2/2**: automation org-inheritance + null-safe. **Automation gap → CLOSED.**

All four WI-5 background derivations (automation, Slack, sandbox proxy-token, GitHub mention) are now both correct AND regression-covered. Full www suite reported 806/0 by team-lead.

### Evidence note — apiKey metadata is double-JSON-encoded (for future psql assertions)
better-auth persists `apikey.metadata` **double-JSON-encoded** (a JSON string whose content is the JSON object). **Production reads decode correctly via `auth.api.verifyApiKey`** (→ `getDaemonTokenContext` resolves `organizationId` fine — the live CLI fence in C10-ORG/C10-ORG-CLOSURE is unaffected). Only **direct column reads** (psql) see the double-encoding and need a double-parse. This retroactively explains the escaped `"{\"organizationId\":\"…\"}"` seen in the C10-ORG-CLOSURE psql metadata read — my assertions held because the org-id substring is present either way, but future probes that parse the metadata column must double-parse (or assert via `verifyApiKey`/CLI fence behavior instead of the raw column).

## Batch-2 slice 1 — VALIDATED (2026-07-15, 71f3aa7)

Method per team-lead: code-cert + unit evidence (both new fences are owner-scoped reads exercised by the tenant tests; a live probe adds nothing until these surfaces are route-reachable). Verdict: **PASS.**

- `updateThreadVisibility` (thread-visibility.ts): org fence on the owner check; the visibility row inherits its thread's org. ✓
- `getThreadForGithubPRAndUser` (github.ts): org fence on the owner-scoped thread read. ✓
- `forTenant` (tenant.ts): gains `setThreadVisibility` + `getThreadForGithubPR` — reached only through the tenant seam (org supplied by construction). ✓
- **`tenant.test.ts` 11/11 green** on this build. Titles confirm the +2: "is private-to-creator within an org: a co-member cannot read it" (co-member deny), "getThreadForGithubPR is fenced to the owner within the org" (cross-org PR-read fence), "setThreadVisibility stamps the thread" (visibility stamp), "fences environment reads to the owner within the org".
- **`githubPR` rows deliberately UNSTAMPED — by design, not a gap.** Repo-global rows shared across orgs; deferred to batch 3 with the unique-index redesign. Global/admin reads (`getGithubPR`, `upsertGithubPR`, `*ForAdmin`) stay unfenced **by design, JSDoc-flagged**. Recorded as an intentional deferral to re-verify at batch 3 (watch that the unique-index redesign doesn't accidentally expose owner-scoped PR data cross-org).

## Batch-2 slice 2 — INTERIM (2026-07-15, 6d57f2f): code PASS, live probe pending redeploy

Slice 2 (`6d57f2f`, automations model onto forTenant + create-stamp) is **route-reachable** (dashboard `createAutomation` stamps the creator's active org), so per method it warrants a **live probe**. Status split:

**Code-level: PASS.** `tenant.test.ts` **15/15 green** (11→15; +4 for slice 2), incl. "createAutomation stamps the org and getAutomation is owner-fenced" and "listAutomations is scoped and delete is fenced". `createAutomationModel` persists `organizationId ?? automation.organizationId ?? null`; the `createAutomation` server action passes `getTenantContextOrNull().organizationId`.

**Live probe: PENDING REDEPLOY.** A premature live run (before confirming the deploy) produced a **NULL-org** automation. Root-caused as a **stale deploy**, not a bug: `:3100` is still running `44c4d82`, not `6d57f2f` (no boot-coder ready-ping for slice 2; `createAutomation` gained its org-stamp only in `6d57f2f`, so NULL = pre-slice-2 behavior). Ruled out a session bug — under the identical session `createCliApiToken` stamped orgA correctly (session read works). boot-coder asked to rebuild at `6d57f2f`; re-run the live create-stamp + read-fence after its ping. **Process note: confirm the deployed SHA before live probes.**

**Read-side observation to verify live post-deploy:** the `getAutomations` **server action** (`server-actions/automations.ts:33`) still calls `getAutomationsModel({ db, userId })` with **no** `organizationId` — so even at `6d57f2f` the dashboard automations LIST read is not org-fenced at the route level (model CAN fence, but the read route doesn't pass the active org). Open question: is the `getAutomations`→forTenant read migration in-slice or a later sweep step? Confirm empirically (getAutomations under orgA vs orgA2) once `6d57f2f` is live; record as gap or intentional-deferral accordingly.

Junk fixtures from the premature probe: 2 NULL-org automations on user A ("UAT Org Probe"/"…2") — harmless, boot-coder to clear.

## Batch-2 slice 3 — VALIDATED (2026-07-15, 61705eb): PASS (code-cert + unit)

Owner-scoped model fns, not newly route-reachable → per team-lead, code-cert + unit sufficient (no live probe). PASS.
- `agentProviderCredentials` onto forTenant: **per-user semantics fenced by org** `(userId, organizationId)` — consistent with threads/environments. Insert stamps org; reads owner-fenced within the org.
- **Org-shared team-credential tier deliberately NOT invented** — JSDoc-flagged as a future product/billing feature, deferred beyond this sweep. Recorded as intentional (not a gap).
- `tenant.test.ts` **16/16 green** incl. "insertCredential stamps org; reads are owner-fenced within the org". (Note: I observe 16 total; if the slice expected 17, minor delta to reconcile — all present tests green, the credential fence case is covered.)

## Batch-2 slice 2 — LIVE probe COMPLETE (2026-07-15, on 61705eb build)

boot-coder rebuilt :3100 to HEAD 61705eb (slices 2+3). Re-ran the slice-2 live probe (via the real `createAutomation`/`getAutomations` server actions over Next-Action + cookie session). Split verdict:

- **Create-stamp → PASS.** `createAutomation` under active org=orgA now persists `organization_id=orgA` (psql-verified; was NULL on the stale 44c4d82 build). The batch-1 automation→thread inheritance chain (`runAutomation` → `automation.organizationId`) is now live end-to-end.
- **Read-fence → GAP CONFIRMED (empirical).** `getAutomations` @orgA lists the automation; `getAutomations` @orgA2 **still lists the same orgA automation**. So the dashboard automations LIST read is **not org-fenced at the route level** — a user in 2 orgs sees all their automations regardless of active org. Root cause: the `getAutomations` server action (`server-actions/automations.ts:33`) calls `getAutomationsModel({ db, userId })` with **no** `organizationId`, so `automationOrgFence(undefined)` no-ops. The model CAN fence; the read route doesn't pass the active org.
  - **Inconsistency signal (strengthens "miss" over "deferral"):** the analogous `getThreadsAction` DOES thread `getTenantContextOrNull().organizationId` into the fence (certified in C10-ORG-CLOSURE test b). Threads got the read-side org; automations didn't. Looks like an oversight in the automations server-action migration, not an intentional deferral.
  - **Recommendation:** pass the active org into `getAutomations` (mirror `getThreadsAction`) — one-line fix. Until then the automation create-stamp is fenced but the dashboard list read leaks cross-active-org (within a single user's own orgs; not cross-user). Team-lead to confirm in-scope-now vs deferred.

Junk fixture: 1 org-stamped automation "UAT Slice2 orgA" (org=orgA) on user A — harmless, boot-coder can clear.

## Batch-2 slice 4 (6f8f1c3) + slice-2 amendment (b41bfb9) — VALIDATED (code+unit)

**Slice 4 — usage reads onto forTenant → PASS (code-cert + unit).** `getUserUsageEvents` + `getUserUsageEventsAggregated` gain optional `organizationId` with `and(userId, organizationId)`; forTenant gains `getUsageEvents` + `getUsageEventsAggregated`. **Not route-reachable** (no usage-read server action) and **inert until the usage WRITE path stamps org** (billing-rollup, later) — so code-cert + unit is the right altitude, no live probe. `tenant.test.ts` green incl. "getUsageEvents fences on the active org". **Deferred by design (billing territory, batch 3+):** `subscription` (referenceId=user.id) + `credits`/`getUserCreditBalance` — the org-pooled-billing model (referenceId flip, org-shared balance) is a product/billing decision, explicitly NOT a read fence. Recorded as intentional.

**Slice-2 amendment (b41bfb9) — the getAutomations read-fence gap I found is FIXED.** `getAutomations` server action now threads `getTenantContextOrNull().organizationId` into the fence (`automations.ts:33` "Fence the dashboard list on the active org (WI-5), mirroring the threads route wiring"); update/delete routes fenced too. `automations.test.ts` (server-actions) **2/2 green**: "getAutomations returns only the active org" + "deleteAutomation is fenced to the active org". Code + unit PASS. **LIVE re-probe pending deploy** — HEAD is b41bfb9 but the running instance is still 61705eb; after boot-coder deploys, re-run getAutomations @orgA vs @orgA2 to confirm the orgA automation no longer leaks under orgA2 (the exact live gap from 8bb74ff).

## BATCH-2 CLOSE-OUT (2026-07-15) — WI-5 query sweep

Slice-2 amendment re-probe (live on 519fc3d): `getAutomations` @orgA → `[UAT Slice2 orgA]`; @orgA2 → **`[]`** (leak CLOSED). The read-fence gap I found is fixed and verified live.

### Per-table fence coverage vs the flagged set (16 tables carry `organization_id`)

| Table | Status | Note |
|---|---|---|
| `thread` | **FENCED** | forTenant get/list/create/update/delete; C10-ORG + C10-ORG-CLOSURE live-certified |
| `thread_chat` | **FENCED** | `threadChatOrgFence`; updateThreadChat |
| `thread_visibility` | **FENCED** | slice 1: setThreadVisibility, row inherits thread org |
| `environment` | **FENCED** | forTenant environment reads/writes |
| `automations` | **FENCED (live-verified)** | slice 2 create-stamp + slice-2 amendment read/update/delete routes; re-probe confirms cross-active-org leak closed |
| `agent_provider_credentials` | **FENCED** | slice 3: per-user fenced by org; org-shared tier deferred (billing) |
| `usage_events` | **READ-FENCED, write-pending** | slice 4: reads via forTenant; INERT until the usage WRITE path stamps org (billing-rollup) |
| `github_pr` | **BY-DESIGN unstamped** | repo-global row; owner-scoped access is fenced via `getThreadForGithubPR`; row stamp deferred to batch-3 unique-index redesign |
| `github_installation` | **ORG-SOURCE (mapping)** | installation→org mapping; drives GitHub-mention derivation (batch-1 probe) |
| `slack_installation` | **ORG-SOURCE (mapping)** | workspace→org; drives Slack-mention derivation (batch 1) |
| `apikey` | **FENCED (metadata)** | org in key metadata (double-JSON); getDaemonTokenContext resolves; CLI mint stamps (batch 1 + createCliApiToken, C10-ORG-CLOSURE live-verified) |
| `member`, `invitation` | **ORG-NATIVE** | Better Auth organization plugin tables |
| `subscription` | **DEFERRED (billing)** | referenceId=user.id → org flip is a billing-model product decision (batch 3+) |
| `user_credits` | **DEFERRED (billing)** | org-pooled credit balance = billing-model decision (batch 3+) |
| `usage_events_agg_cache_sku` | **WATCH** | carries org_id; confirm it's read through the org-scoped aggregate in batch 3 |

### Sweep-completion verdict
**Batch 2 COMPLETE for the in-scope domain reads.** All user-facing model reads that gate the tenant boundary are org-fenced through the `forTenant` seam (threads, thread-chat, visibility, environments, automations incl. live-verified server-action reads, credentials, usage-reads). Background create/token derivations (batch 1) are certified. The one gap surfaced by live probing (`getAutomations` route) was found, fixed (b41bfb9), and re-verified live. **No cross-user/cross-org data leak remains in any exercised read.**

### Batch-3 remainder (explicit)
1. **`organization_id` NOT-NULL tightening** — currently nullable for backfill; tighten after the personal-org backfill (db2c10b) completes across all rows.
2. **Org indexes** — add `organization_id` indexes on the fenced tables for query perf (thread has one; audit the rest).
3. **`github_pr` row stamp + unique-index redesign** — WATCH-ITEM (mine): ensure `getThreadForGithubPR` stays owner+org fenced through the redesign; verify repo-global reads don't expose owner-scoped PR data cross-org.
4. **`usage_events` WRITE path** stamps org from thread context (billing-rollup) — flips slice-4 reads from inert to live.
5. **Billing model** — `subscription.referenceId` user→org flip + `user_credits` org-pooled balance (product decision).
6. **`usage_events_agg_cache_sku`** fence confirmation.

**C10 exit criterion (WI-5): MET** at product-path altitude on both surfaces (CLI + dashboard), cross-org isolation live-certified, no leak. Batch 2 sweep closed.

## BATCH-2 CLOSE-OUT — AMENDMENT: route-wiring sweep (2026-07-15)

The `getAutomations` gap I found was a **gap-class present in every batch-2 domain** — tenancy-coder ran a route-wiring self-audit and swept all of it. The batch-2 close-out coverage is updated: the read-fences are now wired not just in the model but through the **server actions / RSC pages** for every domain. Four commits (all org-switch-tested at action level; www 810/0):

| Commit | Scope | Validation |
|---|---|---|
| `b41bfb9` | automations read/update/delete routes | **LIVE-verified** (re-probe: @orgA2 → []) |
| `d02a9c3` | environment actions + RSC pages | code-cert (getEnvironments/getEnvironment pass org); **live probe pending deploy** |
| `4613e4d` | credentials + thread-visibility + `getUserInfoOrNull` session-info hot path | code-cert (credentials.test "reflects only the active org" green); **live probe pending deploy** (hasClaude flip) |
| `e837d9e` | single-thread github-mention lookup | code-cert (repo-gated live; batch-1 mention probe already exercised the path) |

**Deliberately left (recorded, NOT leaks):** agent-runtime credential paths — thread-org-derived background items (e.g. `daemon.ts`) pending a background-stamp slice. Consistent with the batch-1 pattern (background paths derive org from their own context); added to the batch-3 remainder.

**Live probes queued (my call on which merit live):** environments-list org-switch (directly analogous to the getAutomations gap — confirm the sweep closed it on a second domain) + credentials hasClaude flip (session-info hot path, broad blast radius). thread-visibility (owner-scoped write) + github-mention (repo-gated, batch-1-covered) = code-cert. Running instance is 519fc3d; deploy to HEAD e837d9e requested. Will finalize the sweep verdict after both live probes.

**Impact note:** this validates the value of the live-probe-on-route-reachable-reads rule — one empirically-proven gap (getAutomations) surfaced a whole class the model-level fences hid, triggering a domain-wide route audit.

## Route-wiring sweep — LIVE PROBES COMPLETE (2026-07-15, on e837d9e)

boot-coder deployed HEAD (clean e837d9e). Ran the two route-reachable live probes I flagged. Both PASS — the getAutomations gap-class is closed and live-verified across domains.

| Domain | Live probe | Result | Verdict |
|---|---|---|---|
| automations (b41bfb9) | getAutomations @orgA vs @orgA2 | @orgA=[automation], @orgA2=**[]** | PASS (earlier re-probe) |
| **environments (d02a9c3)** | getEnvironments @orgA vs @orgA2 (seeded env in orgA) | @orgA=[selfhost/orgA-env-repo], @orgA2=**[]** | **PASS** |
| **credentials hasClaude (4613e4d)** | getUserCredentialsAction @orgA vs @orgA2 (seeded claudeCode cred in orgA) | hasClaude @orgA=**true**, @orgA2=**false** | **PASS** — session-info hot path org-fences live |
| thread-visibility (4613e4d) | — | owner-scoped write, unit-tested | code-cert |
| github-mention (e837d9e) | — | repo-gated; batch-1 mention probe exercised path | code-cert |

**hasClaude flip is the strongest of the two** — it's the `getUserInfoOrNull` session-info path, so its correct org-fencing (same user, credential present in orgA → true, absent in orgA2 → false) confirms the fence holds on the highest-fan-out read surface.

### FINAL SWEEP VERDICT — WI-5 route-wiring COMPLETE
The gap-class (`getAutomations`-style: model fenced but server-action read unwired) is **eliminated across all batch-2 domains**, verified live on the two highest-value route-reachable surfaces (environments, credentials/session-info) plus automations. Combined with the batch-2 model-fence close-out and the batch-1 background derivations: **every exercised read on the platform's product surfaces (CLI + dashboard/RSC + session-info) is org-fenced; no cross-user or cross-active-org leak found in any probe.** C10 tenant-isolation exit criterion holds at product-path altitude across domains. Batch 2 (incl. the route-wiring self-audit) is CLOSED.

Batch-3 remainder unchanged (NOT-NULL + indexes + github_pr row-stamp/redesign [my watch-item] + usage-write org-stamp + billing referenceId flip + agent-runtime credential background-stamp + usage_events_agg_cache_sku confirm).

Test artifacts (org=orgA, user A): env `env_uat_orgA`, credential `cred_uat_claude_orgA`, automation "UAT Slice2 orgA" — harmless, boot-coder to clear.

## FUTURE — C10 extends to the execution plane (ADR-002, accepted 16ff884)

Recorded for the Hatchet-substrate phase test design (not active now; batch-3a is the active queue). ADR-002 (per-org execution plane) is accepted. When the substrate lands, the **C10 exit gate extends beyond reads to the execution plane** — new validation cases:

1. **Worker secret isolation:** org A's worker cannot obtain org B's Anthropic key, GitHub token, or worktree.
2. **Task routing isolation:** a task for org B is never delivered to org A's worker.
3. **Deploy-gate standing check — no Hatchet -dev images:** `GET /api/v1/meta` must NOT report `authDisabled:true`; an unauthenticated tenant/workers API call must 401/403.
4. **Deploy-gate standing check — cold-start vs ScheduleTimeout** measurement (elevated to program **P1 gate #5**): worker cold-start must stay within the Hatchet schedule timeout so tasks aren't dropped/re-queued spuriously.

These join the existing product-path C10 (reads: CLI + dashboard + session-info, all live-certified) to form the full-stack tenant-isolation gate once execution is per-org.

## Batch-3a slice 1 — VALIDATED (2026-07-15, 727add4): usage_events WRITE stamps org

Flips the batch-2 close-out `usage_events` row from **read-fenced, write-pending** → **read + write fenced** (code-cert + unit; live-exercise deferred, see altitude).

- **Derivation (code-cert):** the 4 LLM proxy writers (anthropic/google/openai/openrouter routes) thread the **daemon token's org metadata** (`daemonTokenContextFromApiKey` → AuthContext) into the usage write — no extra query; it's the **thread's org from batch-1 daemon-token stamping**. Cost/sandbox-time writers derive from the thread they already load. So the usage event inherits the **thread's** org.
- **Rides a foundation I already certified:** this is the same daemon-token org metadata whose **no-drift property** I pinned in batch 1 (daemon.ts proxy token carries thread org, never the user's later active org). The usage-write correctness inherits that — a usage event can't be mis-attributed to an ambient/active org.
- **Unit: PASS.** `usage-events.test.ts` **10/10** incl. "stamps organizationId on the written events (WI-5)" + "leaves organizationId null when unset (nullable-safe)". Proxy route assertion sites updated (shared 480 / www 810 green per tenancy-coder).
- **Altitude (agreed with team-lead): code-cert + unit is the honest maximum.** The proxy write path's LIVE exercise requires a real sandbox agent making an LLM call through the proxy with a daemon token → substrate-phase territory (same dependency as C8/C7-full). Recorded as such; re-certify live when the substrate + a real agent run exist. No product-surface live probe is possible for this path today.

Slice 1b (agent-runtime credential org derivation) in flight.

## FUTURE — C10 execution-plane note, REV-2 correction (ADR-002 rev 2, be46454)

Operator revised ADR-002: the **execution plane is CUSTOMER-SUPPLIED (VPS/BYOC, self-hosted-runner model)** — platform-hosted containers (Option C) withdrawn (cgroups don't cap commit; CommitLimit is host-wide). This supersedes two items in the execution-plane C10 note above:

- **Item 4 (cold-start vs ScheduleTimeout) is REFRAMED, not a cold-start race.** With customer-supplied persistent runners there's no platform cold-start. The real failure mode: **`schedule_timeout` (5m default) is a customer-outage grace period that silently DROPS work** if the customer's worker is offline past it. New validation: (a) `schedule_timeout` is raised deliberately (not left at 5m); (b) **worker-offline dashboard visibility** — the #1 observability requirement — so a silent drop is surfaced, not swallowed. This replaces the "cold-start measurement" framing.
- **Still standing (unchanged):** control/execution split; credential rules (App key + master key NEVER leave the control plane; never shipped in installer/worker); BYO Anthropic = API-keys-only at write; no Hatchet `-dev` images deploy gate (authDisabled/meta 401-403); C10 worker secret + task-routing isolation (items 1-2).
- **New validation surfaces (rev-2):** installer is the primary onboarding surface (validate: swap provisioning per capacity spec — 8GB+swap ⇒ 6 concurrent); **min-version gate at worker registration** (a stale/incompatible customer worker must be refused). Pricing decouples from capacity → platform-based (seats/orgs/repos), which REOPENS the deferred billing decision (batch-3 billing items may shift).

Not active now (substrate/installer phase); recorded so the test design tracks the ADR revision.

## Execution-plane C10 + substrate gates — CONSOLIDATED (per team-lead, ADR-002 rev 2)

Supersedes the two prior rev-2 notes; this is the authoritative substrate-phase gate list. Record-only; not active (batch-3a is the active queue).

1. **Worker-availability gate (REPLACES cold-start-vs-ScheduleTimeout).** No cold-start race under customer-supplied persistent runners. Instead: (a) `ScheduleTimeout` deliberately raised to tens of minutes — a "how long may a customer's box be down" decision, not a perf number; (b) **worker-offline state visible in the dashboard BEFORE work drops**; (c) **`SCHEDULING_TIMED_OUT` is loud + attributable** — a silently-dropped review is the WORST failure mode of rev 2, so the gate is that a drop is surfaced and traceable to the org/worker, never swallowed.
2. **NEW execution-plane C10 assertion — installer/worker artifact must NOT contain the GitHub App private key.** Catastrophic anti-pattern rev 2 names: a customer in possession of the App key could mint tokens for OTHER customers' installations. Deploy-gate check: grep/inspect the installer + worker image/artifact for the App private key (and any `github-app.pem`-equivalent) → must be absent. App key + master key stay control-plane only.
3. **Unchanged:** no Hatchet `-dev` images (`GET /api/v1/meta` not `authDisabled:true`; unauthenticated tenant/workers call 401/403); worker secret-isolation (org A's worker can't obtain org B's Anthropic key / GitHub token / worktree); task-routing isolation (org B's task never delivered to org A's worker).
4. **NEW — minimum-version gate at worker registration.** A stale/incompatible customer worker must be REFUSED at registration; otherwise it becomes a worker that accepts assignments it can't execute → unassignable actions → silent `SCHEDULING_TIMED_OUT` (ties back to gate 1's silent-drop failure mode).

Full-stack tenant gate = product-path C10 (reads: CLI + dashboard + session-info, all live-certified) + gates 1–4 above once execution is per-org/customer-supplied.

## Batch-3a slice 1b — VALIDATED w/ a reconciliation flag (2026-07-15, 6b8b8a9)

**Resolution path → PASS (code-cert + unit; live = C8 territory, agreed).** `getAndVerifyCredentials` + `getClaudeCredentialsJSONOrNull` + codex creds derive org from the **thread** (`thread.organizationId`) in `agent/sandbox.ts` + broadcast sandbox-env route — the daemon.ts pattern. `credentials.test.ts` **2/2**: "resolves the credential for the thread" + **"does NOT resolve a credential from another org (no-drift pin)"** — an Amp cred in orgX resolves for an orgX thread, not orgY. The real security gate (which credential actually runs an agent) is org-fenced by thread, session-independent. Solid.

**⚠️ RECONCILIATION FLAG — the hint decision doesn't match current code + my prior live evidence.** Team-lead's recorded decision: "hasClaude/hasAmp feature-detection HINTS stay user-level deliberately (hot path, hint not gate)." But at HEAD the hint is **org-scoped, not user-level**:
- `getUserInfoOrNull` (the session-info hot path) computes `userCredentials` via `getUserCredentials({ …, organizationId: session.session.activeOrganizationId ?? null })` (`auth-server.ts:30`) — org-scoped.
- `getUserCredentialsAction` passes the active org too (`server-actions/user-credentials.ts:12`).
- I **live-verified** this org-scoping in the route-wiring sweep: hasClaude = true@orgA, false@orgA2 (4613e4d probe).
So the current hint IS org-scoped. "Stays user-level" is either (a) a **forward** change not yet made (revert the 4613e4d hint org-scoping → then my route-sweep hasClaude PASS is moot and needs a user-level re-probe), or (b) a description that diverged from the code. **Not recording as intentional-with-mitigation until reconciled** — asked team-lead which way it goes. The resolution/hint asymmetry is fine as a *design*; the issue is the code currently org-scopes the hint, opposite the stated decision. (Note: org-scoped hint is the *safer* direction — worst case is a hidden UI affordance, never a cred leak — so this is a correctness-of-record question, not a security gap.)

### Slice-1b hint flag — RESOLVED (team-lead (b) + precision; verified in code)

Two hint surfaces, both correct — the "user-level" decision applied only to surface (2):
- **Surface (1) SESSION/dashboard hints → ORG-scoped, CORRECT.** `getUserInfoOrNull` (`auth-server.ts:30`) + `getUserCredentialsAction` (`user-credentials.ts:12`) pass the active org. A session exists here, so active org is the right scope. **My route-sweep live PASS (hasClaude true@orgA / false@orgA2) STANDS unchanged** — it validated this surface.
- **Surface (2) BACKGROUND/pre-run hints → USER-level, INTENTIONAL-with-mitigation.** Verified in code: `startAgentMessage.ts:97` (`getUserCredentials({ userId })`, pre-thread-load) and `slack/handlers.ts:486` (`getUserCredentials({ userId: slackAccount.userId })`) call with **no** org, and `default-ai-model` consumes that user-level result. No session/thread context is loaded at these points, so there's no org to scope to; kept user-level deliberately (hot path, **hint not gate**). Mitigation: the org-aware **resolution-failure error** (end-of-3a polish) — the real gate (slice-1b resolution) is org-fenced by thread, so a user-level hint can at worst show a UI affordance, never leak or run a cross-org credential.

Net: not a gap. Dashboard hints org-scoped (correct, live-verified); background hints user-level by design with the resolution gate as the true boundary. Slice-1b resolution PASS stands. Flag closed.

## Batch-3a queue — updates (2026-07-15): indexes DONE, github_pr resolved (b), agg-cache parked

**Indexes (3cb1b35) → VALIDATED (code-cert).** Surgical composites for the org-scoped list reads. Live-verified the org indexes exist on exactly the 3 list-read tables: `environment_org_id_index`, `automations_org_id_index`, `agent_provider_credentials_org_id_index` (everything else skipped by design). Perf concern, right tables — PASS at code-cert altitude.

**github_pr → team-lead ruled OPTION (b): NO redesign, NO row-stamp. MY WATCH-ITEM RESOLVES FAVORABLY.** The row stays a global GitHub-state mirror (`repo_number_unique` unchanged); isolation stays on the **thread fence** (untouched); the vestigial `github_pr.organizationId` column is DROPPED (backfill stamping removed). Because there is no redesign, **the owner+org fence I was guarding is not touched — my planned live cross-org PR-read probe is CANCELLED (nothing changed on that path).** Confirmed at current HEAD: `getThreadForGithubPRAndUser` still takes `userId` + `organizationId` (owner+org fenced). Reduced validation at the item-3(b) commit: (1) `getThreadForGithubPRAndUser` still owner+org fenced; (2) the column drop didn't ripple (backfill tests still green). No live probe.

**agg-cache (`usage_events_agg_cache_sku`) → billing-PARKED (nothing to validate).** Feeds `getUserCreditBalance`; fencing it would half-implement org-billing, so it moves with the operator's billing decision. Removed from my active remainder.

**BATCH-3B (NOT-NULL tightening) → DEFERRED OUTRIGHT.** Not "held for a later go" — null-org is a **legitimate designed state** until the GitHub-App phase makes installation→org mandatory. Dropped from the batch-3 remainder as a standing design decision.

**Revised batch-3a close-out gate (down to 2 commits):** the item-3(b) github_pr column-drop commit (fence-intact + backfill-green check) + the org-aware-error polish commit (mitigation for the surface-2 background hints). Then batch-3a closes. usage_events write (3a-1) and agent-runtime credential resolution (1b) already PASS.

# BATCH-3A CLOSE-OUT + TENANCY WORKSTREAM FINAL VERDICT (2026-07-15)

All batch-3a slices validated. This ends the WI-5 tenancy validation queue.

## Slice roll-up
| Slice | Commit | Verdict | Altitude |
|---|---|---|---|
| usage_events WRITE stamp | 727add4 | **PASS** | code-cert + unit (proxy live = C8 territory); rides batch-1 daemon-token no-drift |
| agent-runtime credential RESOLUTION fence | 6b8b8a9 | **PASS** | code-cert + unit (no-drift pin: orgX cred won't resolve for orgY); hint two-surface flag raised + resolved |
| surgical org indexes | 3cb1b35 | **PASS** | code-cert; live-verified composites on environment/automations/agent_provider_credentials |
| github_pr = global mirror, org column DROPPED | 73c126d | **PASS** | fence intact (`getThreadForGithubPRAndUser` still `and(userId, org)`); github + github-installation tests **9/9 no-ripple**; column drop confirmed (`schema.ts:527`). My watch-item resolved best-case (no redesign, thread fence untouched → live probe stood down) |
| org-aware credential-resolution error | 4ef6b1b | **PASS** | code-cert + unit (org-less message + no-drift pin); mitigation for the surface-2 user-level background hints |

## Per-table org coverage (post-github_pr-drop)
Count reconciliation: live DB currently shows **16** tables with an `organization_id` column — the `73c126d` drop is committed but **not yet deployed to :3100** (deploys with the next rebuild; it's a schema migration, no live probe needed). Committed schema drops `github_pr` → the flagged-domain set is **14** per team-lead (my `github_installation` mapping ADR added one; `github_pr` removed one). Categorized:
- **Fenced domain reads (forTenant seam):** thread, thread_chat, thread_visibility, environment, automations, agent_provider_credentials, usage_events (read + write since 3a-1).
- **Org-source / mapping:** github_installation (installation→org), slack_installation (workspace→org).
- **Org-native (Better Auth):** member, invitation (+ organization; `session.active_organization_id` is the session's active org, not a domain stamp).
- **Token metadata:** apikey (org in key metadata; daemon-token resolution).
- **Deferred (billing, operator decision):** subscription (referenceId flip), user_credits (org-pooled balance), usage_events_agg_cache_sku (feeds getUserCreditBalance).
- **Dropped by design:** github_pr (global GitHub-state mirror; isolation stays on the thread fence).

## FINAL TENANCY VERDICT
**WI-5 tenant isolation is COMPLETE and CERTIFIED for the current phase.** C10 exit met at product-path altitude across every domain (CLI + dashboard/RSC + session-info, all live-verified); background create/token/write derivations certified; the one live gap found (getAutomations) was fixed and re-verified; the getAutomations gap-class swept across all domains and confirmed live on environments + credentials. No cross-user or cross-org data leak was found in any exercised read across the entire workstream. Two design decisions recorded as intentional (not gaps): background feature-detection hints stay user-level (resolution is the gate), and github_pr stays a global mirror (thread-fenced).

## Phase-gated remainder (handed off — NOT open validation items)
- **Batch-3b (organization_id NOT-NULL):** deferred to the **GitHub-App phase** (installation→org becomes mandatory then). null-org is a legitimate designed state until then.
- **Billing model:** subscription referenceId flip + org-pooled user_credits + agg-cache fence — **operator product decisions**, move with the billing feature (reopened by ADR-002 rev-2 platform-based pricing).
- **Execution-plane C10 gates** (worker secret/task-routing isolation, no-App-key-in-installer, worker-availability/SCHEDULING_TIMED_OUT, min-version gate): activate at the **Hatchet substrate phase** — recorded above.

## Next standing assignment
The tenancy validation queue is CLOSED. Next arrives with the program's next phase: **review-package mount (Verified pillar) → GitHub App → Hatchet substrate**, where C8/C7-full become live-runnable and my recorded execution-plane gates activate.

# NEXT QUEUE — C9 REVIEW-PACKAGE MOUNT: pre-staged validation (2026-07-15)

New standing assignment (tenancy queue closed). tenancy-coder is porting orch-agents' review kernel + SQLite state → `packages/review` **with the original node:test suites kept unmodified** (the ~260-case suite is the imported guarantee). Pre-staged; executes when its slices commit.

## C9 baseline (captured read-only from orch-agents — the source of truth to diff against)
**15 source files** in `src/review` — PORT-MAP.md must account for EVERY one (ported OR deferred-with-reason; no silent omissions):
`break-glass-handler.ts, claude-diff-reviewer.ts, cli-test-runner.ts, diff-review-parser.ts, diff-review-prompts.ts, finding-verifier.ts, package-manager.ts, review-gate.ts, review-pipeline.ts, severity-policy.ts, types.ts` + state/: `break-glass-matcher.ts, head-review-guard.ts, outstanding-review-finder.ts, types.ts`.
**Test suite: 20 files, 260 cases** (node:test) — the C9 old-baseline-stays-green guarantee.

## Validation checks (on commit)
1. **Ported suites green under the package's `node --test` script** — the 260-case suite runs and passes unmodified. This is the HEART of C9 (old baseline stays green through the port). Report pass/fail vs 260.
2. **PORT-MAP.md completeness** — diff its file list against the 15 baseline files above (`ls /Users/senior/.superset/projects/orch-agents/src/review/**`, read-only). Every source file ported or deferred-with-reason; flag any silent omission.
3. **No vitest conversion drift** — the ported tests must stay **`node:test`** (NOT converted to vitest — that's the "kept unmodified" guarantee inside a vitest monorepo). Spot-check 1–2 ported test files against their orch-agents originals for near-verbatim match.
4. **Monorepo still healthy** — `tsc` clean; existing chassis suites unaffected by the new package.

## Explicitly NOT a gap (per team-lead)
Integration/wiring (review pipeline hooked into the task lifecycle) is **deferred to the Hatchet/GitHub-App phase** — do NOT flag its absence. **PORT-MAP's deferred list IS the phase-2 work list.** C9 here is the *port + baseline-preservation* step only; the review pipeline going live (C8/C7-full territory) comes with the substrate + GitHub App.

# C9 REVIEW-PACKAGE MOUNT step 1 — VERDICT: PASS (2026-07-15, d10ff92)

Validated `packages/review` (review kernel + SQLite state port) with the lead's two calibrations applied (164 ≠ 260 by design; the 4 phantom module names are embedded concepts).

| Check | Result |
|---|---|
| **1. Ported suites green under `node --test`** | **164/164 PASS** (`node --import tsx --test`, node:test — NOT vitest). The heart of C9: the imported kernel suite runs green unmodified. |
| **2. PORT-MAP completeness — no silent drop** | **PASS.** All 15 `src/review` baseline files accounted: 4 ported (severity-policy, diff-review-parser, state/break-glass-matcher, state/types) + 11 deferred-with-reason (review-gate, review-pipeline, claude-diff-reviewer, finding-verifier, break-glass-handler, cli-test-runner, package-manager, diff-review-prompts, review-local types, head-review-guard, outstanding-review-finder). Cross-checked all **20 `tests/review` files** → every one PORTED or DEFERRED(PORT-MAP), **zero unaccounted**. Audit + settings tests also ported (164 = review-subset + audit + settings). Deferred review tests travel with their phase-2 modules. |
| **3. No vitest conversion drift** | **PASS.** Runner is node:test. `severity-policy.test.ts` diffs **byte-identical** to the orch-agents original (verbatim port). |
| **4. Monorepo healthy** | **PASS.** `packages/review tsc-check` clean (exit 0); new isolated package, existing chassis suites unaffected. |
| **5. Phantom modules verified vs upstream** | **PASS.** `finding-fingerprint`, `verdict-decision`, `review-body-composer`, `lifecycle-resolver` are NOT files in orch-agents `src/review` (confirmed against my 15-file baseline); PORT-MAP documents them as embedded (verdict→severity-policy, finding→types, state store→audit/review-audit-log). `lifecycle-resolver` exists only in `execution/workspace` (worktree lifecycle, out of scope) — correctly excluded. |
| **6. tsconfig carve-out** | **PASS (documented)** — `noUncheckedIndexedAccess: false`, with a tsconfig comment + PORT-MAP Adaptation #2 explaining orch-agents compiles review under `strict` without that flag; leaving it on would edit proven code. **Cosmetic nit:** the tsconfig comment says "178-case guarantee" but the actual is 164 — stale number, worth a one-word fix. |
| **7. Lockfile** | **PASS.** `pnpm-lock.yaml` = **+15 additive lines** (workspace link only), no rewrites. |

**Integration/wiring correctly ABSENT (not a gap):** review-gate/pipeline/executors/GitHub/event-bus/SDK deferred to the Hatchet/GitHub-App phase. **PORT-MAP's deferred table IS the phase-2 work list** (each with its dependency reason). C9 here is port + baseline-preservation; the pipeline goes live with the substrate + GitHub App (C8/C7-full territory).

**C9-step-1 VERDICT: PASS.** The ~260-case review guarantee is preserved with zero silent drops — 164 ported+green now, the remainder explicitly deferred with modules+tests+reasons. One cosmetic nit (tsconfig "178"→"164").

# ARBITRATION + HARNESS-HARDENING + KILL-SWITCH VERDICT (2026-07-15) — last gate before pilot GO

## The 253-vs-845 contradiction: RESOLVED as env-contamination (tenancy-coder correct)
Root cause (tenancy-coder, fix `e8690aa`): `apps/www/vite.config.ts` gated `stubServerActions()` on `NODE_ENV !== "test"` at **config-load**. A leaked non-test `NODE_ENV` (production, from boot-coder's OpenNext-build shell) stubbed EVERY server action to `undefined` → 92× "reading 'success'"; the same leak tripped the sandbox mock guard (28×) + e2e provider (8) = the ~253. Both agents' measurements were correct **for their env**.

## Authoritative measurements (my shell verified clean; env hygiene per run noted)
| # | Commit | Shell env | Result |
|---|---|---|---|
| 1 | f2f5027 (pre-fix) | CLEAN (no smoke.env vars; `env -u` belt-and-suspenders) | **845 pass / 0 fail / 9 skip** |
| 2 | e8690aa (fix) | CLEAN | **845 / 0 / 9** |
| 3 | **e8690aa (fix)** | **boot-coder's contaminated shell — full `smoke.env` sourced (NODE_ENV=production + SANDBOX_PROVIDER=docker + INTERNAL_SHARED_SECRET + selfhost DATABASE_URL)** | **845 / 0 / 9** — zero stub/mock/e2e failure signatures |

Measurement note: an intermediate `NODE_ENV=production`-**only** poison run failed in the global-setup's `drizzle-kit-push-test` child on missing `INTERNAL_SHARED_SECRET` (prod envsafe) — a **methodology artifact** (that child inherits the shell and is separate from the stub bug), NOT a fix failure. The full-smoke.env reproduction (row 3) is the accurate boot-coder condition and is the definitive cert.

**HARDENING CERTIFIED:** the exact env that produced boot-coder's 253 now yields 845/0. Fix mechanism (code-cert, `vite.config.ts:15,33`): stub gated on `NODE_ENV !== "test" && !process.env.VITEST` — `VITEST` is always set during a run, so the stub can never activate under vitest regardless of leaked NODE_ENV; plus `NODE_ENV: "test"` forced in the test.env block. Two-layer, robust.

## Kill-switch slice `f2f5027` — PASS
`effectiveShadow(mode)` = `!githubSideEffectsEnabled() ? true : mode === "shadow"`. Truth table complete + unit-tested (`github-side-effects.test.ts` **2/2 green**: switch-ON → per-installation mode governs (active boots, shadow suppresses); switch-OFF → forces shadow for EVERY mode incl. active). Env default `true` (back-compat, `apps-www.ts:91`). `WORKERS-ENV-MAP.md:90` **mandates `false` on the pilot Worker** with the exact id-capture-window rationale (unbound installation would resolve `active` and act on a live customer PR). Correct.

## PROCESS LESSON (recorded per team-lead)
**Suite results are env-sensitive at config-load, not just at runtime.** A leaked `NODE_ENV`/`SANDBOX_PROVIDER` from an operator's shell silently flips test-harness behavior (stub injection, mock guards). `e8690aa` makes the www harness **self-defending** (gates on `VITEST`, forces `NODE_ENV=test`). **Recommendation:** (a) CI runs the suite with a controlled env (`env -i` preserving only PATH/HOME, or an explicit allowlist) — never an operator's ambient shell; (b) a thin `pnpm test` wrapper that `unset`s NODE_ENV/SANDBOX_PROVIDER/DATABASE_URL/REDIS_URL before invoking vitest, so a contaminated interactive shell can't produce phantom failures; (c) keep the `VITEST`-gate pattern for any future config-load env branch.

## VERDICT: GO-clear on the test-health axis
845/0 certified under BOTH a clean env and boot-coder's exact failure-condition env; the harness hardening holds; the kill-switch is correct and the pilot-must-set-FALSE requirement is documented. No regression. This gate does not block the pilot deploy.

# PILOT E2E ROUND — LIVE chain PROVEN (2026-07-17)

Evidence provided by team-lead / pilot run on **production pilot infra** (Cloudflare Workers + Neon + real GitHub). This validator did **not** independently re-verify (that infra — GitHub webhook deliveries, the deployed Worker, Neon — is outside my self-host :3100 reach; re-verification welcome-but-optional per team-lead). Recorded as attributed pilot evidence; internally consistent and maps cleanly to the UAT cases.

## The live chain (real PR, shadow mode, zero GitHub footprint)
real PR **be-automata/automata #1** → repo webhook **653902967** (fresh secret; **all deliveries 200 incl. redeliveries**) → deployed Worker **automata-www** (version 84458b55 @ `a55dc7a`) → all-authors mirror automation → **App-installation-token background create** (the fallback slice) → **Neon thread row** `{name: "Mirror: PR review (github-ops) / #1", org: BeAutomata, shadow: true, status: queued}` → **GitHub footprint ZERO** (0 comments, 0 reviews).

## UAT cases CLOSED by this round
| Case | Status | Evidence |
|---|---|---|
| **C4 — app serves on Workers** | **PROVEN** | Worker automata-www deployed + serving (workerd runtime) |
| **C5 — signup on Workers** | **PROVEN** | signup DB-write on workerd passed — real user row in Neon |
| **C7 — task create (to-create)** | **PROVEN** | thread row persisted, **org-stamped (BeAutomata)**, shadow=true, status=queued — the WI-5 org-stamp certified now live on real infra |
| **Intake E2E (webhook→task)** | **PROVEN** | PR #1 → repo webhook → mirror automation → background create → Neon row |
| **WI-8 — webhook not 5xx on business rejection** | **LIVE-CERTIFIED** | all deliveries 200 incl. redeliveries (my batch-1 mention-probe finding, now proven live) |

## Finding → fixed → verified (shadow-seam leak, live)
**1 `eyes` reaction posted pre-fix** on PR #1 = a shadow-seam leak (a GitHub side effect escaped while shadow). **Found live → sealed in `a55dc7a` → verified** (post-fix footprint = 0 comments / 0 reviews / 0 reactions). This is the id-capture-window class the `GITHUB_SIDE_EFFECTS_ENABLED` kill-switch (f2f5027, which I validated) exists to close — the live run caught a residual seam the switch didn't cover, and it's now sealed. Record: real finding, fixed, re-verified zero-footprint.

## Still OPEN (later rounds)
- **C8 (agent run)** — needs AI keys + active-mode flip + the execution plane (customer-supplied per ADR-002 rev-2). My recorded execution-plane C10 gates activate here.
- **Full C7 with side effects (active mode)** — comments/reviews/checks on a real PR; requires flipping `GITHUB_SIDE_EFFECTS_ENABLED=true` after the Somnio binding is verified in shadow (per WORKERS-ENV-MAP + SOMNIO-PILOT.md sequencing).

## Pillar status after this round
**EXECUTED**: intake→create proven live on the pilot substrate (shadow). **OBSERVED**: thread row dashboard-visible (shadow rows created + visible). **VERIFIED**: review *pipeline* still deferred (packages/review mounted step-1; goes live with the substrate + active mode). The safety story — org-stamped, shadow-fenced, zero-footprint, WI-8-clean webhook — is proven on real infra.

# ═══ EXECUTION-PLANE UAT PROGRAM (Hatchet phase, opened 2026-07-17) ═══

Owner: production-validator. Combines OLD (ADR-036 review-effect parity from prod orch-agents) + NEW (C8 agent-run E2E + exec-plane C10 gates). Pilot repo: **be-automata/automata** (BeAutomata org, dogfood, can go full ACTIVE — no double-bot risk). Bot: `automata-ai-bot[bot]`, installation `147206841`.

## A. REVIEW-EFFECT PARITY — ADR-036 cases (source: orch-agents/docs/UAT-adr-036-effect-intent.md, READ-ONLY)
Certifies migrated review behavior (packages/review + the agent's review posting) matches prod semantics. **Runnability:** NOW = decision logic already unit-covered in packages/review; EXEC = needs a live agent run posting reviews; SOMNIO = needs prod-shaped repos / Phase-2.

| # | Scenario | Core assertion | Runnability |
|---|---|---|---|
| 1 | opened → REQUEST_CHANGES | one CR at HEAD naming security+correctness w/ file:line; no-dup | **EXEC** (kernel severity/verdict decision NOW-covered: severity-policy 40 cases) |
| 2 | synchronize partial-fix → still CR | still CR at new HEAD; `Resolved 1/N`; fixed item not re-raised | **EXEC** |
| 3 | synchronize full-fix → APPROVE+dismiss | APPROVE at HEAD; prior CR dismissedAt≠null; exactly 1 non-dismissed | **EXEC** (kernel approve-then-dismiss idempotency NOW-covered: review-audit-log) |
| 4 | mention ANSWER → one reply | exactly 1 bot reply `reply-to:$CID`; idempotent on redelivery | **EXEC** |
| 5 | mention RE-REVIEW (deduped) → still replies | verdict deduped (no-dup stays 1) AND a reply still lands | **EXEC** (kernel dedupe NOW-covered) |
| 6 | mention CODE-FIX → edit+push+reply | HEAD advanced w/ bot commit `>`→`>=`; 1 reply | **EXEC** |
| 7 | `/request-changes` command path | ruleKey `command:request-changes`; CR at HEAD; no-dup | **EXEC** (kernel command→verdict NOW-partial) |
| 8 | **verdict UPGRADE (regression guard)** | CR over prior APPROVE at same commit dismisses the APPROVE; no-dup==1 | **EXEC** (kernel **verdict-aware idempotency** — THE ADR-036 fix — NOW-covered) |
| 9 | unknown `/review` fall-through | some response lands (never silent drop); no-dup | **EXEC** |
| 10 | inline review threads (Phase-2) | line-level inline comment + unresolved reviewThread | **SOMNIO** (Phase-2 opt-in `REVIEW_POST_INLINE_COMMENTS`; deferred module) |
| 11 | reply-then-resolve (Phase-2) | reviewer-voice `Verified:` reply + isResolved→true | **SOMNIO** (Phase-2) |
| 12 | intake-failure reply: capacity gate (P3) | at-capacity mention still gets a reply; run `failed` not silent | **EXEC** (needs org concurrency load) |
| 13 | follow-up must NOT re-raise fixed-unresolved finding | Read file at HEAD before re-raise; item marked addressed | **SOMNIO** (reproduces marketplace-ai-services#12; defensive) |
| 14 | one review OBJECT per cycle (inline default-OFF) | exactly 1 review object, findings folded into body; 0 inline | **EXEC** (kernel no-dup-object logic NOW-partial) |

**Parity split:** 14 cases → NOW-kernel-covered (decision logic, already green in packages/review): 5 (#3,5,8 fully + #1,7,14 partial). Full-E2E EXEC (live agent on be-automata): 10 (#1-9, 12, 14). SOMNIO (Phase-2 / prod-shaped): 3 (#10,11,13). Note: `flutter-pr-review` E2E lives on marketplace-resident-app (SOMNIO+).

## B. C8 — AGENT-RUN E2E (NEW, pilot)
| Case | Assertion | Gate |
|---|---|---|
| C8.1 hello-world round-trip | Hatchet engine up (via cloudflared tunnel) + worker registered + a trivial workflow dispatched→completed | boot-coder engine + tunnel |
| C8.2 seam dispatch | www dispatch (behind `HATCHET_ENABLED`) → Hatchet trigger; **reference-only payload** (planId/repo/commitSha — NO prompts/secrets) | tenancy-coder www seam |
| C8.3 **full C8 run** | PR event → Hatchet dispatch → worker clones be-automata/automata via **short-lived installation token** → agent runs w/ real Anthropic key → daemon POSTs `/api/daemon-event` w/ org-scoped `X-Daemon-Token` → thread queued→booting→running→completed → (active) bot output on PR | full stack |
| C8.4 daemon-event streaming (OBSERVED) | daemon events stream to www live transcript; boot substatus visible | C8.3 |
| C8.5 lifecycle terminal states | completed AND failure paths (agent error → thread failed + reply, not silent) | C8.3 |

## C. EXEC-PLANE C10 GATES (from ADR-002 rev-2 consolidated list — the tenant boundary on execution)
| Gate | Assertion |
|---|---|
| Worker secret isolation | worker env/artifact holds ONLY that org's creds — **NO App private key, NO master key** (grep worker image + env). Control plane never ships the App key. |
| Task-routing isolation | org B's task never dispatched to org A's worker |
| No `-dev` images | `GET /api/v1/meta` not `authDisabled:true`; unauthenticated tenant/workers call 401/403 |
| Worker-availability | ScheduleTimeout raised deliberately; worker-offline dashboard-visible BEFORE drop; `SCHEDULING_TIMED_OUT` loud+attributable |
| Min-version gate | stale/incompatible customer worker refused at registration |
| **Reference-only payload** | **NO App private key (or any secret/prompt) in ANY Hatchet payload** — inspect via psql/API (this is the C8.2 seam check, elevated to a standing gate) |
| ADR-003 credential-placement audit | when tenancy-coder's ADR-003 lands, review it adversarially against **ADR-002 §3** (App key + master key never leave control plane; BYO Anthropic = API-keys-only at write) |

## D. STAGED VALIDATION SEQUENCE (execute as substrate + seam land)
1. **hello-world round-trip** (C8.1) — engine reachable, worker registered, trivial workflow completes.
2. **seam dispatch verify** (C8.2 + reference-only gate) — dispatch a real event, **inspect the Hatchet payload (psql/API): assert NO App private key / no secret / no prompt** — reference-only (planId/repo/commitSha). This is the credential-placement live proof.
3. **full C8 run** (C8.3-5) — end-to-end agent run on be-automata/automata; lifecycle + daemon streaming + (active) bot output.
4. **ADR-036 parity cases that become runnable** — run the 10 EXEC cases against be-automata (active mode); the 5 NOW-kernel cases are already green in packages/review; SOMNIO cases wait for the second onboarding.
Plus the exec-plane C10 gates (C) run alongside stage 2-3, and the ADR-003 adversarial review when that ADR commits.

## Case-count summary
- **ADR-036 parity:** 14 cases (5 NOW-kernel-covered · 10 EXEC · 3 SOMNIO; overlaps where a case is both kernel-partial + EXEC-full).
- **C8 E2E:** 5 cases (all gated on the execution plane).
- **Exec-plane C10 gates:** 7 standing gates.
- **Validation sequence:** 4 staged rounds.
**Total: 26 UAT items** for the execution-plane phase. Runnable NOW: the 5 ADR-036 kernel-logic cases (packages/review). Everything else gates on boot-coder's substrate + tenancy-coder's seam (+ ADR-003 for the credential audit).

## ADR-036 kernel parity — OPENING EVIDENCE (2026-07-17) + a correction to my own classification

Ran the parity-substrate test files in `packages/review`: **117/117 green** (severity-policy + review-audit-log family + review-floor-resolver + diff-review-parser; part of the 164/164 whole-package suite). What this certifies — and, on closer read, what it does NOT (correcting my earlier over-claim that #3/#5/#8 were "fully kernel-covered"):

**NOW-green (the migrated review DECISION + AUDIT substrate):**
- **Verdict DECISION** (underlies #1, #2, #7): `tierToVerdict: block→request_changes / surface→comment / clean→approve`; `approve + [error] → request_changes`; per-repo tolerance floor (`review-floor-resolver`); draft caps. The "what verdict" brain is ported and green.
- **Severity invariants** (the *spirit* of #8, not its mechanism): "only-downgrade invariant holds under all three tolerances" + "an LLM comment is never upgraded even with critical findings". NOTE: this is **severity-floor monotonicity**, NOT the review-object supersede.
- **Audit trail behind ALL scenarios**: `review.*` append-only (triggers raise on UPDATE/DELETE) + secret redaction (`redacts secret-shaped strings inside payload`).
- Finding parsing (`diff-review-parser` 47 cases) + break-glass matcher.

**CORRECTION — NOT kernel-runnable now (deferred effect-channel/state modules, → EXEC):** the actual **supersede-dismiss DECISION** (#3 approve-dismisses-CR; **#8 CR-over-APPROVE dismisses the APPROVE** — the marquee verdict-aware-idempotency fix), the **verdict-dedup on re-review** (#5), and the **one-review-OBJECT posting** (#14) live in the DEFERRED modules (`outstanding-review-finder`, `head-review-guard`, `review-gate`/effect channel) — they need the pipeline + a live run. My earlier "5 fully NOW" was too generous; the honest count is below.

**Corrected parity split:**
- **NOW-green (decision+audit substrate):** the verdict-decision/tolerance/audit logic behind #1, #2, #7 — a real down-payment that the migrated review *brain* matches prod semantics (117/117).
- **EXEC (supersede/no-dup EFFECT + all live posting):** #1-9, #12, #14 — including #8's supersede mechanism (only its verdict-decision substrate is NOW).
- **SOMNIO:** #10, #11, #13.

**Opening-evidence verdict:** the review kernel's decision + audit layer is green on the new platform — meaningful parity for the "what verdict / append-only audit / redaction" semantics. The verdict-UPGRADE *effect* (#8) and the no-dup *object* guarantee (#14) re-certify at EXEC when the effect channel + live agent land. Recorded with the correction so the record doesn't overstate what the port covers.

# ADR-003 ADVERSARIAL READ vs ADR-002 §3 (2026-07-17)

Read ADR-003 (4a942cb) against ADR-002 §3 credential-placement rules. **Named hard-block (App private key / master key on the worker) = NOT triggered — SATISFIED:** §1a/§3 keep the App key + master key control-plane-only; the worker receives only a short-lived installation token + the daemon token; Anthropic key is the org's own on the box, never in www/workflow input. Core ADR-002 §3 rule upheld. **No pilot-blocking hard-block.** But five findings, F1/F2 HIGH:

**F1 [HIGH — ADR §3 risk claim is INACCURATE; must-fix before 2nd onboarding].** The **daemon token is a general better-auth apiKey**, not a purpose-scoped daemon credential. `cli-router.ts:31` authenticates the CLI API via the same `getDaemonTokenContext`, so `X-Daemon-Token` grants **`/api/cli/threads.list` (all the user's threads), `.detail` (read jsonl transcript / repo / PR), and `.create` (SPAWN agent runs → Anthropic cost + active-mode GitHub side effects)** — for its whole life. ADR-003 §3 line 104 says "a compromised worker holds an expiring token for its own org's repos, **nothing more**" — TRUE for the installation token, **FALSE for the daemon token**. On a compromised customer worker box the daemon-token blast radius = full user-level CLI access + task creation, not "its thread." *Pilot v1 (single-org, own box/own data): acceptable-with-note — no cross-tenant boundary crossed; but task-create weaponization + the window remain.* **Fix before Somnio / any multi-user/less-trusted box:** purpose-scope the daemon token so the CLI router REJECTS it (distinct token type or a scope/permission claim), restricting it to `/api/daemon-event` + `/api/daemon/next-message`.

**F2 [HIGH — the lead's required token↔thread binding is NOT implemented].** Daemon-token metadata = `{ organizationId }` only (`daemon.ts:50`) — **no threadId/threadChatId**. So an org-scoped token could pull `next-message` / inject `daemon-event` for **ANY threadChatId in the org** (enumeration). Fix (should land in the slice-1 next-message endpoint): mint with `metadata.threadChatId` and **enforce the binding at BOTH `/api/daemon-event` and the new `/api/daemon/next-message`** — reject a token whose bound threadChatId ≠ the requested one.

**F3 [MEDIUM].** Daemon-token expiry is **1 DAY** (`daemon.ts:48`, `60*60*24`), but ADR-003 §3 says "short expiry." 24h on a customer box is long. Recommend task-duration-scoped (hour-scale + margin) + **revoke-on-terminal-state**.

**F4 [MEDIUM — lead focus #1: token-in-Hatchet-payload].** ADR-003 §1c puts "the two short-lived tokens as step input"; Hatchet **persists input in Postgres + renders it in the dashboard**. Installation token valid ~1h, daemon token 24h → both readable in the persisted run record during validity. On the single-org box (Hatchet-lite runs there) this is marginal (a box compromiser already has everything). BUT: (a) it **contradicts the reference-only / prompt-hygiene rationale** that moved the *prompt* out (fork-3) while leaving the more-sensitive *tokens* in; (b) it becomes a real cross-tenant exposure if Hatchet is ever **control-plane-hosted or multi-org** (shared Postgres/dashboard). Recommend: document Hatchet-payload retention + dashboard token-visibility as an explicit accepted-risk for pilot v1; before any non-single-org Hatchet, move tokens out of plain input (Hatchet secret injection).

**F5 [MEDIUM — lead focus #2: no-prompt-logging].** `next-message` returns the prompt (repo code, diffs, user messages). Enforce **no-prompt-logging on BOTH www (endpoint request/response) and the daemon**. Also it's a **GET with `?threadChatId=`** → the id lands in access/tunnel logs; prefer POST-body or guarantee URL-logging exclusion (the id is also the F2 enumeration key).

**Escalation:** none are the named pilot-blocking hard-block. F1 flagged to the lead immediately because it makes ADR-003 §3's stated risk inaccurate and is a hard-block-grade breach at the 2nd onboarding. F2 is the lead's own required binding, unimplemented. Verify F2/F5 land in the slice-1 next-message endpoint when it commits.

## ADR-003 findings — DISPOSITIONS (team-lead rulings 2026-07-17)

| Finding | Ruling | My verification (when slice-1 commits) |
|---|---|---|
| **F1** daemon-token general-apiKey blast radius | **FIX NOW in slice 1** (purpose-scope; cheap while mint code is open; CLI router rejects daemon-scoped tokens) | Live: mint a daemon-scoped token → `/api/cli/threads.list` MUST be rejected (401/403), while `/api/daemon-event` + next-message accept it |
| **F2** no token↔thread binding | **FIX in slice 1** | `metadata.threadChatId` present; `/api/daemon-event` AND `/api/daemon/next-message` reject a token whose bound threadChatId ≠ requested |
| **F3** expiry 1 day vs "short" | **FIX in slice 1** | expiry task-duration-scoped (not 24h) + revoke-on-terminal-state |
| **F4** tokens in Hatchet plain input | **ACCEPTED-RISK pilot v1** — documented in ADR-003 with trigger (Hatchet secret-injection before ANY non-single-org deployment) | confirm the ADR-003 note lands; no fix for v1 |
| **F5** next-message prompt-logging + GET-query id | **FIX in slice 1** | no-prompt-logging on www + daemon; threadChatId not in access/tunnel logs (POST-body or exclusion) |

## SOMNIO-GATES (onboarding-#2 round — formal blocking gates, per team-lead)
These two MUST be verified live before the second onboarding (Somnio/marketplace, multi-user/less-trusted box):
- **SOMNIO-GATE-1 (F1):** daemon-token **purpose-scoping verified LIVE** — a daemon-scoped token is REJECTED by the CLI router (`/api/cli/*` → 401/403), so a compromised customer worker box cannot list/read/create the org-user's threads via the CLI API. (Pilot v1 exempt: single-org own-box own-data, no cross-tenant boundary; but this gate blocks onboarding #2.)
- **SOMNIO-GATE-2 (F4):** **tokens moved out of Hatchet's plain workflow input** (secret-injection or equivalent) — no installation/daemon token readable in the persisted Hatchet payload / dashboard, because a shared/multi-org Hatchet makes that a cross-tenant exposure.

Both added to the execution-plane UAT program as blocking items for the Somnio round (alongside the exec-plane C10 gates). Slice-1 lands F1's *mechanism*; SOMNIO-GATE-1 is the *live re-verification* on the onboarding-#2 topology.

## ADR-003 slice-1 fold-ins — VERIFIED (code+unit) at d07d45e (2026-07-17)

Slice 1+1b (4de39ae + d07d45e; www 890/0). Verified F1/F2/F3/F5 at code+unit level; F1's live half is pending-deploy (per team-lead). **Daemon/F-related unit tests: 29/29 green** across 6 files (daemon-token, daemon-token-context, cli-router, daemon-event route, next-message route, daemon).

| Finding | Verdict | Evidence |
|---|---|---|
| **F1** purpose-scope daemon token | **VERIFIED (code+unit); live half pending-deploy** | daemon token minted with `tokenType: 'daemon'`; `cli-router.ts:39` **rejects `tokenType === "daemon"` → UNAUTHORIZED**; both daemon endpoints REQUIRE `tokenType === "daemon"`. cli-router.test covers the reject. LIVE probe (deployed Worker: daemon token → `/api/cli/threads.list` 401/403) lands with the next www deploy — I'll run it then. |
| **F2** token↔thread binding | **VERIFIED (code+unit)** | `/api/daemon/next-message` (POST) + `/api/daemon-event` both enforce `ctx.threadChatId === requested` — "thread A's token cannot pull/inject thread B even in the same org" (routes' F2 comments + `token↔thread mismatch` 403). Legacy null-threadChatId tokens back-compat-allowed. Both route.tests cover mismatch. |
| **F3** revoke-on-terminal (not sub-day expiry) | **VERIFIED (code+unit)** | `handleThreadFinish` (handle-daemon-event.ts:519) calls `revokeDaemonTokensForSandbox({userId, sandboxId})` on terminal (non-blocking `waitUntil`, line 540); revoke deletes the apikey by `name=sandboxId`. 1-day expiry kept as backstop (better-auth plugin minimum — accepted per ruling). daemon-token.test covers mint+revoke. |
| **F5** no-prompt-logging + id hygiene | **VERIFIED (code)** | next-message is now **POST with ids in the body** (was GET `?threadChatId=`); `route:91 "H2: do NOT log message — it contains the prompt"`; rejection logs carry threadChatId/user/org but NOT the prompt. |

**Cosmetic nit (non-blocking):** the F3 revoke comments in `daemon-token.ts:11` and `handle-daemon-event.ts:538` say "the **6h** expiry is the backstop", but the actual value is **1 day** (`daemon.ts:53`, "1 day (plugin minimum) — backstop only"). Two stale "6h" comment strings → one-line fix; substance is correct.

**Net:** all four ADR-003 slice-1 fold-ins are code+unit verified; F1's blast-radius mechanism (CLI router rejects daemon tokens) is in place, its live proof queued for the next deploy. SOMNIO-GATE-1 (F1 live) + SOMNIO-GATE-2 (F4 tokens-out-of-payload) remain the onboarding-#2 blockers.

## EXEC-PLANE STAGE 1 (hello-world) + deploy-guard gates — VERIFIED LIVE (2026-07-17, substrate 00fe4f2)

Hatchet substrate slice-1 (packages/worker) running on the pilot box (localhost:8888). Independently re-verified boot-coder's claims (not accepted on report).

| Gate / case | Result |
|---|---|
| **C10 deploy-guard: `authDisabled`** | `/api/v1/meta` → **`authDisabled: false`** ✓ |
| **C10 deploy-guard: unauth workers 401/403** | unauth `GET /api/v1/tenants/707d…/workers` → **HTTP 403** ✓ |
| **C10 deploy-guard: NO `-dev` image** | image = `ghcr.io/hatchet-dev/hatchet/hatchet-lite:**v0.94.10**` (pinned, non-dev) ✓ |
| **REST trigger contract (www→engine path)** | `POST /api/v1/stable/tenants/707d…/workflow-runs/trigger` (Bearer) → **HTTP 200**, QUEUED run `e96ce9ca` created ✓ |
| **C10 worker-availability: scheduleTimeout raised** | trigger response `workflowConfig…ScheduleTimeout = **30m**` (not the 5m default that silently drops work) ✓ |
| **Hello-world ROUND TRIP (stage 1)** | started `@terragon/worker` hello worker → registered (LISTEN_STRATEGY_V2) → my run `e96ce9ca` **"Task run starting → completed"** in worker log → **OLAP `v1_task_events_olap` COMPLETED** with output `{"message":"hello uat-validator"}` — **echoes my REST input** ✓ |

**Caveats (recorded, pilot-only, non-blocking):** (a) `SERVER_GRPC_INSECURE=t` is a documented localhost-only pilot concession; (b) the SDK's blocking `run()` result-stream stalls under `TLS_STRATEGY=none` locally — I confirmed completion via **REST + OLAP** (the documented workaround), not the blocking stream. Both in packages/worker/README.md.

**STAGE-1 VERDICT: PASS.** The execution-plane substrate is live, the deploy guard holds (no -dev image / auth enforced / 30m timeout), the REST trigger contract works, and a hello-world round-trip completes end-to-end with input→output fidelity. Cleaned up my worker instance after verification. Next: stage 2 (seam dispatch + reference-only payload inspection) when tenancy-coder's dispatch seam wires to this substrate, then full C8.

## EXEC-PLANE STAGE 2 — reference-only payload inspection: PRE-STAGED (2026-07-18)

The dispatch seam is LIVE (www 3bb0e3b5, HATCHET_ENABLED=true + 4 secrets; worker automata-worker registered agent-run + hello; cloudflared tunnel → :8888, edge trigger verified 200 by boot-coder). The lead fires the C8 event; boot-coder pings the run id when www dispatches an `agent-run`; I pull the payload.

**Inspection path (pre-established):** REST `GET workflow-runs/{id}` is **403 with the worker token** (wrong scope) → my path is the pilot Hatchet-lite **Postgres**: `v1_dags_olap.input` (the multi-step agent-run is a DAG, so its input lands there; the tables are empty now because hello is task-only). Query on boot-coder's `external_id`.

**ASSERTION (ADR-002 §3 credential-placement invariant):**
- **MUST be PRESENT (reference-only, OK):** `threadId, threadChatId, repoFullName, branch, daemonCallbackUrl` + the two **short-lived tokens** `installationToken` (per-run, org-scoped — EXPECTED per ADR-002 §3) and `daemonToken` (per-thread, tokenType='daemon' post-F1).
- **MUST be ABSENT (HARD violation → escalate immediately):**
  1. **GitHub App private key** (`BEGIN … PRIVATE KEY`, `github-app.pem`, the raw PEM) — the named hard-block.
  2. **Secret-store master key** (`ENCRYPTION_MASTER_KEY`).
  3. **The assembled prompt** — F5/fork-3 moved it to the `next-message` pull; if it's in the input that's an F5 regression (info-hygiene, not hard-block).
  4. Any other standing secret (Anthropic key — must be the box's own env, never in payload).
- **F4 note:** the two short-lived tokens DO persist in this payload (accepted-risk pilot v1). Do NOT flag them; the violation is the App key / master key / prompt. F4's "move tokens out" is SOMNIO-GATE-2.

Grep plan on the payload text: `-iE "BEGIN.*PRIVATE KEY|github-app|\.pem|ENCRYPTION_MASTER_KEY|sk-ant|ANTHROPIC"` → must be ZERO; plus a positive check that the reference fields + the 2 tokens are the ONLY keys. Held for the run id.

## EXEC-PLANE STAGE 2 — reference-only payload: VERIFIED LIVE — PASS (2026-07-18)

Independently pulled `agent-run f60135ed-6851-4951-a5ef-665b890cea69` input from Postgres `v1_tasks_olap` (boot-coder found it lands there, not `v1_dags_olap` — it's a task-level workflow). Confirmed boot-coder's PASS.

**Nested workflow input keys (EXACTLY these 7, nothing else):** `threadId` (3d9da1c3…), `threadChatId`, `repoFullName` (be-automata/automata), `branch` (pilot/e2e-shadow-probe), `daemonCallbackUrl` (automata-www…workers.dev), `installationToken` (40 chars), `daemonToken` (64 chars).

**Credential-placement invariant (ADR-002 §3) — HOLDS:**
- ✅ Reference fields + the 2 short-lived tokens only (installationToken + daemonToken EXPECTED per ADR-002 §3 / ADR-003 §1c / F4 accepted-risk — not flagged).
- ✅ **App private key: ABSENT.** **Master key: ABSENT.** Forbidden-set grep (`BEGIN…PRIVATE KEY|github-app|.pem|ENCRYPTION_MASTER_KEY|sk-ant-|ANTHROPIC|CLAUDE_CODE_OAUTH`) = **0 hits** on the raw payload.
- ✅ **Assembled prompt: ABSENT** (`prompt/message/preparePromptForModel/"You are"` = 0) — the **F5 prompt-moved-to-pull invariant holds** on the real dispatched payload.

**STAGE-2 VERDICT: PASS** — the named hard-block (App key in Hatchet payload) is proven absent on a real live dispatch; no secret/prompt leaks; only reference + short-lived tokens.

**Caveat + a SECONDARY finding (not a stage-2 failure):** `threadChatId = "legacy-thread-chat-id"` — boot-coder flagged this as an execution bug (placeholder stalls the agent; handed to tenancy-coder). **Security-relevant side effect I add:** F2's token↔thread binding keys on `threadChatId`; with every run sharing the `legacy-thread-chat-id` placeholder, the F2 binding **degrades to effectively org-level** (a daemon token bound to the placeholder matches any run bound to the same placeholder). Not a credential-placement violation, but the threadChatId fix must land a REAL unique threadChatId for F2's per-thread binding (verified at d07d45e) to actually bite in production — flag for tenancy-coder's fix so it's not treated as purely cosmetic.

## C8 — AGENT-RUN E2E: VERIFIED LIVE — PASS (execution GREEN) (2026-07-18)

boot-coder reported C8 green end-to-end (run `agent-run 6c944c1d-ea77-420a-9d66-41a4d095358e`, thread `a2816638`, PR review posted 08:42:19Z). Independently verified the surfaces I can reach; took the Neon-resident thread state as corroborated-OBSERVED.

**Independently VERIFIED (Executed pillar):**
- ✅ **Engine terminal state:** `v1_tasks_olap.readable_status = COMPLETED` for external_id `6c944c1d`. Winning run, not the earlier `f60135ed` (CANCELLED) or `ecc2fb7b` (FAILED) — those are the pre-green trace.
- ✅ **Reference-only payload on the WINNING run** (re-pulled `6c944c1d` input from `v1_tasks_olap`): **exactly 7 keys** — `branch, threadId, daemonToken (64), repoFullName, threadChatId, daemonCallbackUrl, installationToken (ghs_…)`. Forbidden-set grep (`BEGIN…PRIVATE KEY|github-app|.pem|ENCRYPTION_MASTER_KEY|sk-ant-|ANTHROPIC|CLAUDE_CODE_OAUTH|prompt`) = **0**. Matches `f60135ed` shape → ADR-002 §3 credential-placement HOLDS on the green run too. App key / master key / prompt ABSENT.
- ✅ **GitHub artifact real:** PR #1 (`be-automata/automata`, head `pilot/e2e-shadow-probe`) issue comment at **2026-07-18T08:42:19Z**, body = "## PR Review: Pilot E2E shadow-probe (synchronize)…" — timestamp + body match boot-coder's claim exactly (verified via `gh api`).

**Corroborated-OBSERVED (not locally queryable):**
- Thread `a2816638` status=complete / 22 messages lives in **Neon behind the deployed Worker** (`daemonCallbackUrl = automata-www.dark-water-9247.workers.dev`), not in local Docker Postgres (`automata_selfhost_postgres` on :55432 has the `thread` table but no row — the app is the Cloudflare Worker on workers.dev, Neon-backed). Corroborated by: engine COMPLETED + clean daemon exit (no orphan, per boot-coder) + artifact posted.

**Findings / caveats (none block C8-execution-green):**
1. **Artifact is an ISSUE COMMENT, not a formal GitHub review.** `pulls/1/reviews` = 0, `pulls/1/comments` (inline) = 0; the review body posted via the issue-comment surface. This is the **expected shadow-mode shape** (`effectiveShadow` → comment/dry, side-effects gated on pilot). **ADR-036 EXEC-parity implication:** on the pilot the "review effect" is a PR **comment**, not a formal APPROVED/CHANGES_REQUESTED review — the active-mode parity cases (#1–9, #12, #14) must account for this when comparing OLD (formal review) vs NEW (comment) effect surfaces.
2. **Posting identity = `espinozasenior` (type=User), NOT a GitHub App bot** — despite the payload carrying a `ghs_` **installation** token (which would post as the app bot). On pilot the review landed under the human/user account. Not a C8 blocker, but a real note for the identity model: the posting path used a user credential, not the installation identity. Flag for whoever owns the bot-identity story before Somnio onboarding.
3. **F1 live probe INCONCLUSIVE — SOMNIO-GATE-1 mechanism-half stays OPEN.** Opportunistically fired the winning run's daemon token at the CLI oRPC surface (`POST /api/cli/threads/list` on the deployed Worker) → **401 UNAUTHORIZED** (`GET /api/cli/threads.list` → 404 wrong-path, oRPC is POST). BUT the same token on its own `POST /api/daemon/next-message` also → **401** — i.e. the token is **already revoked-on-terminal (F3)** because the run reached COMPLETED. A revoked token 401s everywhere, so the CLI 401 **cannot be attributed** to F1 purpose-scoping (tokenType==='daemon' reject) vs F3 revocation. **F1 stays unproven live** — the clean probe still needs a *mid-run / non-revoked* daemon token. What this DOES corroborate: **F3 revoke-on-terminal fired** (daemon token dead post-COMPLETED on both surfaces).
4. **F2 sentinel still in use:** `threadChatId = "legacy-thread-chat-id"` on the green run too — the open security item with tenancy-coder (F2 binding degrades to org-level, see STAGE-2 finding). Green run confirms it does NOT block execution; the fix remains security-load-bearing, not cosmetic.

**C8 VERDICT: PASS (execution GREEN).** Full dispatch→Hatchet→worker→daemon→claude→terminal chain completes; winning-run payload upholds ADR-002 §3; real PR artifact posted. Residuals carried forward (not C8 blockers): F1 live proof (GATE-1), F2 real-threadChatId (GATE-1 adjacent + tenancy-coder), ADR-036 EXEC-parity on the comment-vs-formal-review effect surface.

## CORRECTION (self-issued) — F2 framing in STAGE-2 + C8 was STALE (2026-07-18)

**Retracting the "threadChatId sentinel degrades F2 to org-level → the threadChatId fix is security-load-bearing" claim I made in the STAGE-2 and C8 sections above.** It was true of the design I had in view but is NOT true of the live/HEAD code, and I failed to reconcile against a fix that had already merged (it's even recorded in my own session memory).

**Live-code truth (verified in HEAD):**
- Commit **`44bfa7d`** ("anchor F2 daemon-token binding on threadId — close the sentinel org-level collapse") is merged and an ancestor of HEAD. `apps/www/src/agent/daemon.ts` → `mintDaemonToken` stamps `metadata.threadId`; `apps/www/src/app/api/daemon/next-message/route.ts:69` rejects on `ctx.threadId !== null && ctx.threadId !== threadId`. The route comment explicitly states threadChatId is the shared legacy sentinel and that is *why* the binding anchors on the per-thread-unique `threadId` instead.
- **Therefore F2 does NOT degrade to org-level, and the LEGACY `threadChatId` sentinel is intentional and correct** — it must NOT be "fixed" to a unique UUID (that would break `getThreadChat` lookups unless a real threadChat row exists, which needs `enableThreadChatCreation`). The dispatch payload carrying `threadChatId="legacy-thread-chat-id"` is BY DESIGN, not a security gap.

**What remains true (bounded, not the permanent design):**
- **Rollout-window residual only:** legacy daemon tokens minted *before* 44bfa7d carry a null `threadId` and still pass the binding unconditionally (org-level) until they expire/cycle out. Tracked by `9d49bcb` ("mark the F2 legacy null-threadId passthrough for removal after tokens cycle"); the `ctx.threadId !== null` guard clause is to be dropped once old tokens age out.
- **Timeline note on the inspected runs:** the C8 winning run `6c944c1d` posted its artifact at 08:42:19Z; **44bfa7d landed at 08:45:22Z — ~3 min later.** So that run's daemon token was minted pre-fix (legacy null-threadId → org-level for that token specifically). That is why the org-level exposure looked *live* on the token I probed — it is a pre-fix legacy token in the rollout window, NOT evidence that the current design collapses F2.

**Net:** the go-forward F2 posture is sound (threadId-anchored). No unique-threadChatId change is needed or desired for security. The only open item is letting pre-44bfa7d tokens cycle out, then removing the null-threadId passthrough (9d49bcb). SOMNIO-GATE-1's F2 half is effectively CLOSED-BY-DESIGN in HEAD; only the F1 *purpose-scoping* live-probe half (needs a non-revoked daemon token) remains genuinely open.

## ADR-036 EXEC-PARITY BLOCK — plan + scaffold (execution pending F1/F2) (2026-07-18)

Plane: www f1944494 + worker ACTIVE (step logging) + named tunnel `hatchet.beautomata.com` (cutover done, trigger path 200). Target repo: `be-automata/automata`. Baseline: orch-agents `docs/UAT-adr-036-effect-intent.md` (14 scenarios, READ-ONLY).

**Scoring rule (team-lead ruling):** score at EFFECT-INTENT level — which intent fired (`emit_review`/`emit_reply`/`emit_resolve_thread`), verdict semantics, no-dup idempotency, severity floor. The formal-review-vs-comment surface delta is a **KNOWN GAP annotation per case, NOT a FAIL**. A case FAILS only if intent/verdict/idempotency diverges from the OLD baseline. Formal APPROVED/CHANGES_REQUESTED posting is review-package phase-2 → its own later parity re-check. Record posting IDENTITY per case (espinozasenior [ambient-creds leak, tenancy-coder fixing] → expected flip to `automata-ai-bot[bot]` post-fix; worker may restart mid-block, expected).

**Case set (COUNT TO CONFIRM with team-lead — I read 11, lead said 10):**
- IN-SCOPE (effect-intent, non-Phase-2): S1 opened→CR, S2 partial-fix→still-CR, S3 full-fix→APPROVE+dismiss, S4 mention ANSWER→one reply, S5 mention RE-REVIEW deduped-but-still-replies, S6 mention CODE-FIX→edit+push+reply, S7 `/request-changes` command path, S8 verdict UPGRADE (regression guard), S9 unknown-slash `/review` fall-through, S12 intake-failure capacity-gate reply. = **10**.
- The 11th candidate: **S14** (one-review-object / inline-comments default-OFF). It is effect-intent-adjacent (no-dup strengthened to "one review OBJECT") but its assertion is about the inline-comment wrapper, which is Phase-2 surface. **Likely lead's "10" excludes S14 into the phase-2 surface re-check** — CONFIRMING.
- DEFERRED SOMNIO / Phase-2 (not this block): S10 inline threads, S11 reply-then-resolve, S13 stale-thread re-raise guard.

**Per-case template (fill on execution):** trigger (event on be-automata/automata) → observe (api/runs or hatchet OLAP tool-calls: which emit_* fired) → verify effect-intent vs OLD → KNOWN-GAP surface note (comment vs formal review) → posting identity → no-dup invariant → verdict PASS/FAIL/GAP.

**Gating:** run AFTER F1/F2 live probes close (team-lead sequence). Fixture = throwaway PR on be-automata/automata with seeded defects (off-by-one `>` + `console.log` secret + false attestation), mirroring the OLD Setup fixture. Status: SCAFFOLDED, awaiting F1/F2 + case-count confirm.

## ADR-036 EXEC-PARITY BLOCK — case set LOCKED + trigger-model finding (2026-07-18)

**LOCKED (team-lead confirm):** parity set = **{S1, S2, S3, S4, S5, S6, S7, S8, S9, S12} = 10 cases**. Scored at effect-intent level (intent fired / verdict / no-dup idempotency / severity floor); comment-vs-formal-review surface delta = KNOWN GAP annotation, not FAIL; posting identity recorded per case.
**PHASE-2 SURFACE RE-CHECK SET (parked, NOT this block):** {S10 inline threads, S11 reply-then-resolve, S13 stale-thread re-raise guard, **S14 one-review-object/inline-wrapper**}. S14 moved here because its assertion is about the inline-comment wrapper / formal-review surface that only exists once review-package phase-2 mounts the formal review path — testing it now re-measures the known surface gap, not effect-intent parity.

**TRIGGER-MODEL FINDING (blocks execution start — needs confirm):** NEW review dispatch is **automation-driven**, not a hardcoded auto-review. `apps/www/src/app/api/webhooks/github/handlers.ts` on `pull_request.opened`/`ready_for_review`/`synchronize` → `getPullRequestAutomationsForRepo(repoFullName)` → dispatches each matching automation whose `triggerConfig` covers the action; **zero automations → PR event no-ops** ("Found 0 pull request automations"). Mentions (S4-S9) route via `handle-app-mention` on `issue_comment`. The C8 run was `triggered_by: manual` — consistent with no automation yet wired, dispatched by hand to prove the chain.
**Consequence for parity:** the OLD baseline triggers are organic GitHub events (PR opened / push / @mention / slash). For NEW to reproduce them organically on `be-automata/automata`, a **pull-request REVIEW automation must be configured for that repo** in the pilot org (triggerConfig: opened + synchronize), and the app-mention path must be live. Otherwise each scenario is a manual dispatch (like C8), which changes the trigger step and slightly weakens the E2E (manual dispatch bypasses the webhook→automation intake leg that S12's capacity-gate case specifically exercises). CONFIRMING with boot-coder/lead whether the review automation is configured (→ I trigger via real PRs/comments) or scenarios are manual dispatches.

## ADR-036 EXEC-PARITY — trigger model RULED (A) organic; holding on 2-part ping (2026-07-18)

**Team-lead ruling: (A) ORGANIC triggers.** Rationale: the orch-agents baseline behavior IS webhook-driven intake; manual dispatch would hollow the exact leg S12 tests and leave S1-S3 proving review logic but not wiring. A real PR-review automation is being configured on `be-automata/automata` (triggerConfig opened+synchronize, ACTIVE mode) — boot-coder wiring now (automation infra exists; C8-era mirror automation proves the path — needs a review-automation row), tenancy-coder backs up if it needs code not config.

**HOLD until boot-coder's 2-part ping:** (1) worker restarted on **3352b7c** (posting-identity fix — ambient host gh creds → GH_TOKEN=installationToken; expected to flip posting identity to `automata-ai-bot[bot]`), AND (2) the review automation is LIVE on be-automata/automata. THEN: fire case S1 (open the fixture PR) and piggyback F1/F2 on its live daemon token as planned (read-only non-perturbing probes).

**Execution order once unblocked:** S1 (open fixture PR → grab token → F1/F2 probes → observe S1 effect-intent) → S2 (partial-fix push) → S3 (full-fix push) → S4-S6, S9 (mentions) → S7 (/request-changes) → S8 (verdict upgrade) → S12 (capacity gate: 2 PRs fill slots + fresh-issue mention). Per case: trigger → observe (api/runs or hatchet OLAP emit_* tool calls) → verify effect-intent vs OLD → record posting identity → known-gap surface note → no-dup invariant → PASS/FAIL/GAP. Fixture content staged (defects: off-by-one `>`→`>=`, console.log secret, false "validated safe" attestation).

## F1 + F2 LIVE GATE PROBES — BOTH PASS (clean, on a live mint-only token) (2026-07-18)

boot-coder minted a LIVE mint-only daemon token (never tied to a run → F3 never revokes it → unlimited probe window), post-44bfa7d so `metadata.threadId` IS stamped. Bound thread A = `a2816638`; foreign thread B = `3d9da1c3` (a real, different thread in the SAME pilot org); both carry the shared `legacy-thread-chat-id` sentinel. Surface: www f1944494 (dark-water-9247.workers.dev). I ran the authoritative probes myself (raw curl HTTP codes):

| probe | request | result | meaning |
|---|---|---|---|
| liveness | `POST /api/daemon/next-message` {threadId:A} + `X-Daemon-Token` | **204** | token LIVE, accepted on its purpose surface (bound thread) |
| liveness | `POST /api/daemon/thread-status` {threadId:A} | **200** `{status:complete,terminal:true}` | token LIVE (read succeeds); thread A itself is terminal but the TOKEN is a fresh mint, unaffected |
| **F1** | `POST /api/cli/threads/list` + `Authorization: Bearer` | **401** UNAUTHORIZED | **purpose-scoping** — a LIVE token is rejected on the CLI surface |
| **F2** | `POST /api/daemon/next-message` {threadId:**B**} | **403** Forbidden | **org-collapse fix** — same-org cross-thread denial |
| **F2** | `POST /api/daemon/thread-status` {threadId:**B**} | **403** Forbidden | second surface confirms the threadId-binding reject |

**F1 VERDICT: PASS — clean.** The token is provably LIVE (204/200 on thread A), so the CLI 401 is **purpose-scoping (tokenType==='daemon' reject), NOT F3 revocation**. This is exactly the separation the earlier revoked-token probe could not make (a dead token 401s everywhere). **SOMNIO-GATE-1 mechanism-half is now CLOSED WITH LIVE EVIDENCE.** (The purpose-scoping F1 fix — daemon tokens rejected on the CLI blast-radius surface — bites on a live token.)

**F2 VERDICT: PASS — closed-with-live-evidence.** A live token bound to thread A is accepted on A (204/200) but **403'd on thread B** — a DIFFERENT thread in the SAME org sharing the SAME legacy sentinel threadChatId. That is precisely the org-level-collapse case: pre-44bfa7d the binding keyed only on the shared sentinel and would have accepted B; post-44bfa7d it rejects on the threadId mismatch (route.ts:69). Upgrades the earlier "closed-by-design in HEAD" to **closed-with-live-evidence** for the Somnio gate record. Both daemon surfaces (next-message + thread-status) enforce it.

**Net GATE-1 state:** F1 mechanism-half CLOSED (live) + F2 org-collapse CLOSED (live). Remaining GATE-1 item is only the bounded rollout cleanup (9d49bcb: age out pre-44bfa7d legacy null-threadId tokens, then drop the passthrough) — token-lifecycle, not a fence gap. F1 purpose-scoping re-verify on the onboarding-#2 (Somnio) topology remains the ONLY open GATE-1 sub-item, deferred to that onboarding.

## PARITY PLANE READY — residuals #1 (surface) + #2 (identity) CLOSED, verified live (2026-07-18)

boot-coder pinged 2-part ready (worker 3352b7c/355bf14 + automation live). Independently verified on PR #1 (`gh api`), NOT taken on report:
- **Residual #2 (posting identity) CLOSED:** both formal reviews on PR #1 authored by `automata-ai-bot[bot]` (type **Bot**) — the espinozasenior ambient-creds leak is fixed live (3352b7c GH_TOKEN=installationToken + env sanitization).
- **Residual #1 (effect surface) RESOLVED:** the plane now posts **FORMAL reviews via the reviews API** — COMMENTED (09:17:11Z) + APPROVED (09:19:11Z) — NOT issue comments. So the NEW effect surface now MATCHES the OLD baseline (formal APPROVED/CHANGES_REQUESTED/COMMENTED review). **Scoring impact: the per-case comment-vs-formal-review KNOWN-GAP annotation becomes a known-MATCH** — I can score direct surface-match on S1-S9/S12 rather than annotating a gap. (S14/S10/S11 inline-thread surface is a DIFFERENT path — `REVIEW_POST_INLINE_COMMENTS` / inline review comments, still 0 on PR #1 — so their phase-2 parking stands.)
- **No-dup invariant holds:** exactly 1 non-dismissed APPROVED at commit 76546ebe.
- **Organic chain live:** automation c95b9307 → dispatch → worker; runs 264564ba + 4c4fe636 COMPLETED, addec811 RUNNING. `triggered_by` is now organic (webhook→automation), not manual.

**GATE-1 (F1/F2) already closed live (9a8f159); posting-identity residual now also closed.** Starting the 10-case parity block. Fixture PR next (S1).

## INCIDENT LOG — stray fixture commit on main + push convention (2026-07-18)

While staging the S1 parity fixture I pushed a commit directly to `be-automata/automata` main by accident. Recording it so the parity record explains the stray commit pair on main.
- **Cause:** created the fixture in a worktree branched off `origin/main` (which set the branch's upstream to origin/main), then pushed with `git push -u origin <branch>`. This repo's shared-main convention sets `push.default=upstream` on the checkout whose branch `feat/p05-chassis-triage` IS main — so that push targeted `refs/heads/main`, not a new branch ref. Commit **c4de23c** ("uat: ADR-036 parity fixture (do not merge)") landed on main; the operator's R3.8 (**5009a43**) then stacked on top.
- **Blast radius:** one file, `scripts/uat/adr036-sample.ts` (14 lines, fake seeded defects — off-by-one, `console.log` of a fake key string, false attestation), outside `src/`, no build/lint/tsc impact, no real secrets (team-lead: no rotation needed).
- **Fix:** forward-fix removal (NO history rewrite — commits sit on top and main is shared). Commit **ba5e77d** "chore: remove accidentally-pushed UAT fixture" FF-pushed to main; verified `origin/main:scripts/uat/adr036-sample.ts` is gone. The `c4de23c … ba5e77d` add/remove pair on main is this incident.
- **Standing mitigation (all agents):** for fixture/scratch branches on this repo, push with explicit `git push origin HEAD:refs/heads/<branch>` and verify (`git ls-remote origin refs/heads/<branch>` present + `refs/heads/main` unchanged) BEFORE `gh pr create`. Never `git push -u origin <branch>` from a branch whose upstream is origin/main.

## S1 (opened → CHANGES_REQUESTED) — VERDICT: FAIL (no-dup / idempotency divergence) (2026-07-18)

Fixture PR #3 (be-automata/automata, HEAD 79f3cff, 1 commit, opened 09:33:08Z). Automation c95b9307 dispatched on `pull_request.opened`.

**What PASSED (effect-intent quality is strong):**
- ✅ **Verdict CHANGES_REQUESTED at HEAD** — correct (defects present).
- ✅ **Findings** — the review names ALL THREE seeded defects with correct severity: off-by-one in `isAdult` (Medium/correctness), `console.log` secret in `logKey` (High/security), false "validated safe" attestation (Medium/integrity), each with `file` and a code quote.
- ✅ **Identity** — `automata-ai-bot[bot]` (Bot). Residual #2 holds under load.
- ✅ **Surface = MATCHED** — a FORMAL `CHANGES_REQUESTED` review (reviews API), same surface as the OLD baseline. No known-gap annotation needed (per team-lead's refined scoring).

**What FAILED — the no-dup invariant (the OLD baseline's rollback trigger):**
- ❌ **TWO non-dismissed `CHANGES_REQUESTED` reviews at the SAME commit** 79f3cff — ids `4728240823` (09:33:58Z) + `4728240904` (09:34:03Z), 5s apart, near-identical bodies, neither dismissed. no-dup check: `{commit:79f3cff1, count:2, states:[CHANGES_REQUESTED,CHANGES_REQUESTED]}`. OLD invariant = at most ONE non-dismissed blocking verdict per commit; **count 2 is the documented rollback trigger.**

**Root cause (characterized):** ONE `pull_request.opened` webhook delivery (status 200, `redelivery=false`), ONE agent run in the Hatchet OLAP (`46a51913`, COMPLETED) → yet TWO identical formal review posts. So a **single run posted the review twice**; the NEW plane's review **effect channel is not enforcing ADR-036 verdict-aware idempotency** (same commit+verdict should dedup / supersede-dismiss, leaving exactly one). This is not GitHub double-delivery and not two dispatches. (Could not read the run's internal tool calls — `v1_task_events_olap` schema query came back empty — so "double emit_review vs double post within one emit" is unconfirmed, but the observable outcome is a non-idempotent duplicate blocking review.)

**Impact + block implication:** this is a real bug — the plane ships DUPLICATE blocking reviews. It directly contaminates the idempotency/supersede-dependent parity cases: **S2** (still-CR at new HEAD, no-dup), **S3** (APPROVE + dismiss prior CR), **S5** (deduped re-review verdict), **S8** (verdict-upgrade dismisses prior). Running those now would mostly re-confirm the same broken idempotency. **S1 VERDICT: FAIL** (idempotency diverges from OLD). Surfacing to team-lead/boot-coder for a triage decision: pause for a review-effect-idempotency fix vs. continue documenting each divergence.

## S1 triage RULED (hybrid) + context; proceeding S4/S6/S9/S12 (2026-07-18)

**S1 FAIL stands** (no-dup=2). boot-coder confirmed run `46a51913` / thread `ccdc6398` = the ONLY dispatch for PR #3 → single run posted CHANGES_REQUESTED twice (emit double-fire or post-retry). **Team-lead context:** this is the KNOWN phase-2 gap surfacing as a live defect, NOT a port regression — `packages/review` (with ADR-036 idempotency/supersede) is mounted but NOT integrated into the posting path; the pilot's reviews are posted by the agent directly, so nothing dedups. My FAIL upgrades that phase-2 integration item from 'queued' → **'demonstrated-blocking'**.

**Triage ruling (hybrid):** (1) CONTINUE now with idempotency-independent cases **S4, S6, S9, S12**; (2) tenancy-coder assigned the review-idempotency integration fix in parallel; (3) **S1, S2, S3, S5, S8 re-run as a group after the fix deploys** (all depend on the review-verdict idempotency/supersede). PR #3 stays open as the S1/S2/S3 fixture for the post-fix regroup.

## S4 (mention → one reply) — BLOCKED (no github-mention automation) (2026-07-18)

Posted `@automata-ai-bot what does isAdult do?` on PR #3 (comment 5010785921, 09:40:11Z). Result after 2+ min: **no agent-run dispatched, no bot reply.**
- ✅ `issue_comment.created` webhook DELIVERED to the plane (status 200, redelivery=false, 09:40:16Z); hook IS subscribed to `issue_comment`.
- ❌ No dispatch. **Mechanism:** `apps/www/src/app/api/webhooks/github/handle-app-mention.ts` is **automation-gated** — it calls `getUsersToTriggerTasks` (backed by `getGitHubMentionAutomationsForRepo`), and when that returns 0 it logs "No users to create tasks for mention" and **returns without dispatching**. Only a **PR-review** automation (`c95b9307`, `pull_request`) is configured on be-automata/automata; there is **no github-mention automation**, so every @-mention silently no-ops.

**Consequence:** ALL FOUR idempotency-independent cases (**S4, S6, S9, S12**) route through this same mention path and are **BLOCKED** on a github-mention automation being configured (all-authors, enabled) — the mention analogue of the c95b9307 review automation. Not a plane bug; a missing automation config (same class as the S1-S3 review-automation precondition).

**Block status:** S1-S3/S5/S8 blocked on tenancy-coder's review-idempotency fix; S4/S6/S9/S12 blocked on a github-mention automation. The remaining block is gated on those two setup/fix items. Requesting the mention automation from boot-coder so S4/S6/S9/S12 can proceed in parallel with the idempotency fix (keeps the hybrid alive).

## S1 root cause — DEFINITIVELY NAILED (boot-coder trace of run 46a51913) (2026-07-18)

boot-coder pulled the run's tool calls; the S1 no-dup mechanism is now unambiguous:
- The agent posts the review via **raw Bash `gh`**, not the ADR-036 `emit_review` effect. Trace = 6 Bash calls, **ZERO emit_review**: `gh pr view` → `gh pr diff` → `cat > review_body.md` → **`gh pr review 3 --request-changes --body-file review_body.md`** (invoked ONCE) → `ls/pwd` (agent checking the file landed) → `gh pr view --json reviews` (verifying).
- The two CHANGES_REQUESTED reviews are **byte-identical** (both exactly 1870 bytes, same sha256 `736f1c2d…`). Identical body + single `gh pr review` invocation + daemon spawned the command once ⇒ **double-FIRE at the tool/SDK layer** (a retry of one slow tool call re-ran the post), **NOT** a double-emit and **NOT** a dual post-path.
- **So: 1 webhook → 1 run → 1 review-post command → 2 identical posts via a tool-layer retry.** Because the post goes through raw `gh`, it bypasses the ADR-036 verdict-aware no-dup channel entirely — nothing dedups a retried identical post.

**Durable fix (tenancy-coder, diagnosis cb702ee9 / flag f6eabd65):** a **pre-post outstanding-review guard** — query GitHub's reviews API for a same-commit non-dismissed verdict BEFORE posting; skip or supersede-dismiss. This is the OLD baseline's mechanism, ports cleanly, and is idempotent against exactly a retried identical post (so it's robust regardless of WHY the tool retried). Bounded change in the review-post path. The 4 idempotency-dependent cases (S2/S3/S5/S8) all need it. Substrate confirmed clean — purely the review effect channel.

## S4/S6/S9/S12 — still blocked on mention HANDLE (not the automation) (2026-07-18)

After boot-coder wired the github_mention automation (d24bfe58), S4 STILL did not dispatch on two attempts:
- `@automata-ai-bot ...` (CID 5010809620, 09:49Z) → webhook 200, no run, no reply.
- `@terragon-labs ...` (CID 5010821753, 09:53Z) → webhook 200, no run, no reply.

**Diagnosis:** the gate is the mention-detection, not the automation. `isAppMentioned` (`utils.ts:15`) matches `@${NEXT_PUBLIC_GITHUB_APP_NAME}\b`; if it returns false, `handlers.ts:254` logs "does not mention the app" and returns before `handleAppMention`. The bot POSTS as `automata-ai-bot[bot]` but the MENTION handle is the configured `NEXT_PUBLIC_GITHUB_APP_NAME` (a different string). Neither guess dispatched, so I don't yet have the correct handle — OR `isAppMentioned` passes and `getUsersToTriggerTasks` returns 0 (a deeper user/access gate). Can't disambiguate without the Worker log (wrangler tail) or the env value — requested both from boot-coder. Stopped firing guesses to avoid noise/wasted runs.
**S4/S6/S9/S12 status: BLOCKED pending the correct mention handle + confirmation the mention path dispatches.** (Observation for onboarding UX: the mention handle differing from the bot's posting login is a real footgun — users will @ the bot's visible name and get silence. Not a parity FAIL; an onboarding note.)

## S1 RE-RUN (post-reconciler 57d1cda) — PASS on end-state (2026-07-18)

Fresh fixture PR #4 (HEAD dcf933b0, opened 11:07:47Z), run `b0e3468c` COMPLETED. Post the interim reconciler deploy (dad8e871).
- ✅ Verdict CHANGES_REQUESTED at HEAD; ✅ identity automata-ai-bot[bot]; ✅ formal-review surface (MATCHED).
- ✅ **no-dup invariant HOLDS: exactly 1 non-dismissed CHANGES_REQUESTED** at dcf933b0 (stable across 4 polls 11:09:01→11:09:54). Contrast: pre-reconciler PR #3 = 2 non-dismissed.

**Evidence caveat (honest):** PR #4 has 1 review and **ZERO dismissed** rows — so this run **posted once** (the tool-layer retry that caused S1's dup is non-deterministic and didn't fire here). The reconciler runs fail-soft at thread-finish regardless, but with no dup present it had nothing to dismiss. So PR #4 validates the **clean end-state** but does NOT by itself demonstrate the reconciler's dismiss-on-dup path (that needs a caught-dup run, or the `dup_reconciled` www telemetry for b0e3468c — requested from team-lead, who has Worker log access). PR#3=2 vs PR#4=1 is suggestive but not conclusive on its own.

**S1 RE-RUN VERDICT: PASS (reconciled end-state, no-dup=1) — INTERIM-RECONCILER mechanism.** Durable single-writer close (emit_review channel) remains phase-2. Proceeding to S2 (synchronize) for another dup chance + no-dup-at-new-HEAD.

## S2 (synchronize partial-fix → still CR) — PASS (2026-07-18)

Pushed partial fix to PR #4 (removed console.log secret; off-by-one + attestation remain). New HEAD d4a9a5e, run `6552b40e` COMPLETED.
- ✅ **Still CHANGES_REQUESTED at new HEAD**, no-dup at new HEAD = 1 (stable across polls).
- ✅ Body acknowledges the fix ("**Fixed:** ✅ console.log secret/API-key leak removed") and re-raises ONLY the still-outstanding items (off-by-one, false attestation) — does NOT re-raise the fixed security item. Resolved-header present. Strong cross-cycle STATE AWARENESS (references dcf933b0→d4a9a5e explicitly).
- ✅ Identity bot; formal-review surface (MATCHED). The prior-commit review (dcf933b0) lingers non-dismissed — correct (per-commit invariant; dismissal of prior happens on verdict change in S3).
- Note: n=1 at new HEAD, 0 dismissed → again no dup this run (reconciler dismiss-path still needs a caught-dup run or dup_reconciled telemetry).

**S2 VERDICT: PASS** — matches OLD baseline (partial-fix → still-CR, Resolved:N, fixed item not re-raised, no-dup at new HEAD).

## S3 (synchronize full-fix → APPROVE + dismiss prior) — PASS; reconciler supersede-dismiss PROVEN (2026-07-18)

Pushed full fix to PR #4 (off-by-one → `>=`, false attestation removed). New HEAD f952793, run `5c2df542` COMPLETED. Final review state (stable across 4 polls):
- `dcf933b` (S1-rerun HEAD): **DISMISSED**
- `d4a9a5e` (S2 HEAD): **DISMISSED**
- `f952793` (S3 HEAD): **APPROVED**, non-dismissed
- ✅ **APPROVED at new HEAD**; ✅ **both prior CHANGES_REQUESTED dismissed**; ✅ non-dismissed blocking verdicts = 0; ✅ no-dup = exactly 1 non-dismissed review (the APPROVE).

**This DEMONSTRATES the reconciler's supersede-dismiss live** — on the verdict change CR→APPROVE, all prior same-thread CHANGES_REQUESTED across commits were dismissed, leaving one APPROVE. Matches OLD baseline S3 (approve-then-dismiss inside runEffects). **S3 VERDICT: PASS.**

Reconciler status: **supersede-dismiss path PROVEN (S3)**. The same-verdict DEDUP path (dismiss an identical duplicate CR, i.e. S1's original 2×CR) is still unproven live — no run has re-triggered the non-deterministic tool-layer double-post; confirm via `dup_reconciled` telemetry.

## S1-group review-path cases COMPLETE; remaining 7 gated on the mention identity gate

Review-path parity (no mention needed): **S1 re-run PASS, S2 PASS, S3 PASS.** All three match the OLD baseline at effect-intent level with the formal-review surface MATCHED and no-dup holding (reconciled end-state). Verdict quality is high (correct verdicts, full defect coverage, cross-cycle state awareness, Fixed/Still-outstanding structure).

**The remaining 7 cases are ALL mention/command-path** — S4 (mention answer), S5 (mention re-review), S6 (mention code-fix), S7 (`/request-changes` command), S8 (verdict-upgrade via `/request-changes`), S9 (`/review` fall-through), S12 (capacity-gate mention) — and every one is BLOCKED on the mentioner-identity gate (`getUsersToTriggerTasks`=0 for espinozasenior). The mention gate is now the SOLE blocker for the rest of the block.

## UPDATE — reconciler dedup PROVEN via telemetry + mention gate re-diagnosed (2026-07-18)

Two corrections from team-lead's live wrangler tail (authoritative — I couldn't see Worker logs):

**1. Reconciler DEDUP path PROVEN LIVE (correcting my S1-rerun caveat).** The tail shows `[review-reconciler] dup_reconciled` fired TWICE on PR #4: `{prNumber:4, keepId:4728377254, dupReconciled:1, actionableCount:2, commentedSkipped:0}` and `{keepId:4728381078, dupReconciled:1, actionableCount:2}`. So the non-deterministic tool-layer double-post DID recur on my re-runs (actionableCount:2 each), and the reconciler **dismissed the extra before I polled the end-state** — which is exactly why I observed a clean no-dup=1 and wrongly assumed "no dup happened." **CORRECTION: S1-rerun exercised BOTH the bug AND the fix — the same-verdict DEDUP path is PROVEN LIVE (twice).** Combined with S3's supersede-dismiss, the interim reconciler's FULL contract (dedup + supersede-dismiss, APPROVED/CHANGES_REQUESTED only, fail-soft) is now live-evidenced. Durable single-writer close (emit_review channel) remains phase-2.

**2. Mention gate RE-DIAGNOSED (my identity-gate read was one layer off).** espinozasenior IS linked to the founder user — team-lead's tail showed "Found 1 users to trigger tasks" + the eyes reaction fired on a diagnostic mention. The real blocker is the NEXT step: **"No github access token found for user 9FGJ8pK…"** — the mention task-creation path uses the user-OAuth token helper with NO App-installation fallback (the a55dc7a identity-seam class). NOT a mentioner-identity/linking gate. Fix assigned to tenancy-coder; team-lead deploys on push. **S4/S5/S6/S7/S8/S9/S12 remain blocked on the token fix — do NOT burn more mention attempts; keep mentioning FROM espinozasenior once it lands** (identity side is good).

**Housekeeping:** team-lead's diagnostic mention comments on PR #1 (ids 5011029799, 5011033156) are noise — excluded from evidence. Worker-down window (boot-coder's session died): S1-rerun/S2/S3 all COMPLETED (worker was live for them), so no SCHEDULING_TIMED_OUT to void.

**Net block status:** review-path S1(re-run)/S2/S3 = PASS with the reconciler's full contract proven. 7 mention/command cases (S4/S5/S6/S7/S8/S9/S12) blocked solely on tenancy-coder's mention-path token fix (App-installation fallback).

## MENTION CASES (token-fix 0193ee40 deployed) — token gate CLEARED (2026-07-18)

Mention path now dispatches from espinozasenior (getOctokitForBackground App-install fallback works).

### S4 (mention ANSWER → one reply) — PASS
Mention "@automata-ai-bot what does the isAdult function do?" on PR #4 (CID 5011071696, 11:24:49Z) → run `d96c991f` COMPLETED → bot reply id 5011073567 @11:25:34Z.
- ✅ Exactly ONE new bot comment (no reply-dup); ✅ answers correctly (describes isAdult, references current `>=18` code); ✅ identity automata-ai-bot[bot]; ✅ did not perturb PR #4's APPROVED review state.
- KNOWN-GAP annotation: the reply lacks the OLD `reply-to:<CID>` marker (an emit_reply trace tag). NEW tags by @-mentioning the author (`@espinozasenior`) instead. Surface/traceability delta, not an effect-intent FAIL — but note the OLD reply-idempotency-on-redelivery keyed on that marker; NEW's redelivery-dedup mechanism is unverified here (would need a forced redelivery). Flag for the reply-idempotency check.
**S4 VERDICT: PASS** (effect-intent: single answering reply; surface marker delta annotated).

### S5 (mention RE-REVIEW deduped → still replies) — PASS
Precondition: PR #4 had 1 non-dismissed APPROVED at HEAD. Mention "@automata-ai-bot please re-review this PR" (CID 5011079361, 11:27:44Z) → run `8940b0f0` COMPLETED.
- ✅ **Formal review DEDUPED** — non-dismissed verdicts stayed **1 (APPROVED)**, no new verdict row (no-dup holds).
- ✅ **A reply still landed** (1 new bot comment) — the mention-always-replies guarantee holds even on a deduped re-review.
- Same reply-to-marker known-gap as S4 (NEW uses @-mention, not reply-to:<id>).
**S5 VERDICT: PASS** — matches OLD baseline (deduped verdict + reply-not-silenced).

### S8 (verdict UPGRADE via /request-changes over APPROVED) — PASS
Precondition: PR #4 had 1 non-dismissed APPROVED at HEAD f952793. Command "@automata-ai-bot /request-changes …" (CID 5011084324, 11:29:36Z) → run `fb3efd23` COMPLETED.
- ✅ **CHANGES_REQUESTED posted at HEAD** f952793 (11:30:17Z, non-dismissed).
- ✅ **Prior APPROVED now DISMISSED** (state flipped APPROVED→DISMISSED).
- ✅ **no-dup at HEAD = 1** (states=[CHANGES_REQUESTED]) — the stronger verdict was NOT swallowed as a duplicate. This is the verdict-aware-idempotency regression guard working live.
- ✅ Reply landed (command path replies). Also exercises the /request-changes COMMAND path → emit_review verdict.
**S8 VERDICT: PASS** — matches OLD baseline (verdict upgrade posts + dismisses prior + no-dup=1).

### S6 (mention CODE-FIX → edit + push + reply) — PASS
Mention "@automata-ai-bot please fix the off-by-one … use >=" on PR #3 (CID 5011090361, 11:31:54Z, HEAD 79f3cff) → run `49a5dda9` COMPLETED.
- ✅ **PR #3 HEAD advanced** 79f3cff → a367d0e with a **bot-authored commit** (author `automata-ai-bot[bot]`, msg "uat: fix off-by-one in isAdult (>= 18) per PR feedback").
- ✅ **One reply** summarizing the change. ✅ identity bot.
- (The fix push is a synchronize → triggered a follow-up review run 4ae1c0a3, expected.)
**S6 VERDICT: PASS** — matches OLD baseline (bot commit >→>= + reply).

### S7 (/request-changes registered command path) — PASS
Command "@automata-ai-bot /request-changes …" on PR #4 (CID 5011096507, 11:34:10Z; PR #4 already had 1 CR at HEAD from S8). Run dispatched (21f7b553).
- ✅ **CHANGES_REQUESTED verdict at HEAD** via the command; ✅ **no-dup = 1** (states=[CHANGES_REQUESTED] — same-verdict dedup held, no 2nd CR); ✅ reply landed.
- Caveat: ran on a PR that already carried a CR (from S8), so "command POSTS a fresh CR" is inferred from the reply + maintained-CR + no-dup rather than a clean first-post; `ruleKey command:request-changes` not directly observable (api/runs behind CF Access). Outcome matches OLD baseline S7 (command → CR + no-dup).
**S7 VERDICT: PASS** (command path → CHANGES_REQUESTED, no-dup, reply).

### S9 (unknown /review fall-through) — PASS
Command "@automata-ai-bot /review" on PR #4 (CID 5011101795, 11:36:07Z) → run `9df126c0` dispatched.
- ✅ **Responded** (1 new bot reply) — the unknown slash command fell through to github-mention-respond and produced a response; **NO silent drop**. no-dup holds (no spurious verdict).
**S9 VERDICT: PASS** — matches OLD baseline (unknown /review → some response, never silence).

### S12 (capacity-gate intake reply) — attempt
Attempting while the worker (agent-run concurrency=1) is saturated with queued S6/S7/S9 runs. Firing a fresh ISSUE mention (distinct work item) to hit the intake capacity gate (maxConcurrentPerOrg).
