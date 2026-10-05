# ADR-010: The audit self-healing loop — the agent emits findings, the control plane is the only writer of issues

- **Status:** Accepted. Part 1 (audit to issues) shipped in Phase 8; part 2 (the fix loop) in Phase 9.
- **Date:** 2026-10-04
- **Context source:** `apps/www/src/server-lib/audit/` (parser, fingerprint, decide, executor, issue
  writer, outbox applier, sweep, cron, drain), `packages/shared/src/model/audit-findings.ts`,
  `self-heal-outbox.ts`, `self-heal-breaker.ts`, `self-heal-settings.ts`,
  `packages/shared/src/self-heal/audit-rules.ts` (the closed vocabulary),
  `packages/worker/src/agent-run/self-heal-checks.ts` and `workflow.ts` (the platform checks that run
  before the daemon spawns), `apps/www/src/app/api/self-heal/` (admin and check-report routes),
  `deploy/skills/audit-findings/SKILL.md`.
- **Deciders:** operator + phase 8 planning (2026-10-04)
- **Relates to:** ADR-004 (the review lane is emit-only with a structural credential fence; this lane
  reuses the same shape), ADR-005 (monotone floors; the kill switch follows the same rule), ADR-007
  (supersession authority and the one-agent box budget), ADR-008 (tracker effects are emit-only).
- **Supersedes / superseded by:** none.

## Context

The platform runs a repository audit on a schedule. Until now its findings stayed in a thread
transcript: nobody was told, nothing was tracked, and the same finding would be re-reported on every
run. We want each real finding to become one GitHub issue that is kept current and closed when the
problem is gone, without giving an LLM a write credential and without letting a bad run flood a
repository.

Constraints that shaped the design:

- The agent runs on a shared execution box. ADR-004 already established that an agent run holds no
  GitHub write credential; only the control plane writes.
- GitHub is flaky and rate limited. A write that is retried blindly can duplicate an issue, and a
  run that dies half way must resume instead of starting over.
- A model's opinion that a finding is "fixed" is not evidence. Benchmarks of LLM re-scoring show
  unstable verdicts for the same input.
- Production has no Redis. All durable state for breakers and leases lives in Postgres.
- Review latency matters more than audit latency. An audit must never starve a review of the one
  agent slot on the box.

## Decision

**The audit lane is emit-only. The agent produces one tagged findings block; the control plane
parses it, decides, persists, and only then writes to GitHub.**

1. **Emit-only agent, read-only token.** The audit agent emits a single fenced block tagged
   `json audit-findings` and writes nothing to GitHub. The audit run carries the same read-only
   posture as a review run (ADR-004); no write token reaches the daemon environment.
2. **One writer, retry-free.** Every GitHub request for the lane goes through
   `createSelfHealOctokit` (retries disabled, throttle handlers return false, one bounded token
   mint) wrapped by `withSelfHealCall` (timeout, error classification, breaker, rate-limit horizon,
   permission latch, quota reserve). Effects are rows in a leased outbox so an interrupted run
   resumes; an ambiguous create is adopted by its marker instead of repeated.
3. **Fingerprinted, closed vocabulary.** A finding is one of nine rules. Its identity is a sha256
   fingerprint that does not depend on line numbers or wording, so a finding keeps its issue across
   audits. The parser is tagged-only and fails closed: anything outside the vocabulary is dropped
   and an unparseable block counts as a failed run, never as "no findings".
4. **2-of-3 consensus plus a failing check to file.** An issue is filed only when the finding was
   reported by two of the last three complete audits and a platform-owned deterministic check for
   that rule failed in the current run. A lone report, or a report with no failing check, is
   recorded but not filed.
5. **Close only on two consecutive sealed deterministic passes.** An issue is closed only after two
   consecutive audits in which the platform's own check ran, reported `pass`, and the finding was
   absent. The agent saying "fixed" never closes anything. A rubric-only finding (no deterministic
   check exists) is never auto-closed; it gets the `needs-human-review` label and a comment.
6. **Sealed worker-only check token.** The platform checks run on the worker, on the clean checkout,
   as the agent uid, BEFORE the daemon spawns. They report once, with a per-run token that is
   delivered only to the worker and never to the daemon environment or the journal. The endpoint
   accepts one report, only before the agent has spoken, and seals every unreported check as `error`.
7. **Breakers and leases in Postgres.** API breakers (CAS-versioned, forward-only Retry-After
   horizon), the permission latch, outbox leases and audit-run claims are rows with leases and
   bounded transactions. No process-local or Redis state decides whether a write happens.
8. **Three independent stops.** The `selfHealLoop` global feature flag (default off), a per-repo
   mode (`off` / `dry-run` / `on`, default `off`) with an org-only kill switch on the `*` row, and an
   admin Drain that sets the kill switch first and then cancels live self-heal runs. Dry-run
   records every decision as `would_*` and performs no GitHub write.
9. **Labels.** The lane uses `automata:finding`, `automata:auto-fix`, `needs-human-review`,
   `automata:wontfix`, `automata:paused` and `audit:<name>`. It never applies `bug` or
   `enhancement`, so a repository's own triage is not overwritten.

## Options considered

- **Agent-written issues (the agent gets a write token).** Rejected. It breaks the ADR-004
  fence, makes duplicates and prompt-injected content a write the platform cannot sanitise, and
  moves the credential onto the shared box.
- **Close an issue when an LLM re-scores the finding as fixed.** Rejected. Unstable verdicts
  produce reopen/close flapping. Closing needs a deterministic, platform-owned check that passed
  twice.
- **Redis-backed rate limits and breakers.** Rejected. Production has no Redis; Postgres rows with
  leases are durable across isolates and restarts.
- **Retrying GitHub writes inside the client.** Rejected. A silent retry after a lost response is
  how a duplicate issue is created. The outbox adopts by marker instead.
- **A spend or cost cap on the lane.** Rejected by operator decision: no spend limits. The bounds
  are count-based (open issues, attempts) and rate-based (cooldown, run window).

## Consequences

**Positive**

- The agent cannot write to GitHub; a compromised or confused audit run can at worst emit a bad
  block, which the parser and the consensus rule drop.
- Idempotent by construction: marker on line 1 of every issue and comment, one issue per
  fingerprint, adoption on ambiguous create.
- Stops are layered and fast: flag off, org kill switch, Drain.

**Negative / watch**

- A new finding needs two audits before it is filed. That delay is the price of low churn.
- The lane adds 8 tables and 11 settings columns. Production does not migrate by CI: the schema must
  be pushed by hand BEFORE any deploy that contains this code (`deploy/assert-schema-ready.ts` gates
  it).
- Fingerprint churn (a finding whose identity shifts between audits) shows up as open-then-closed
  noise. The dry-run exit criteria cap it at 10 percent.

## Testing

Each plan of phase 8 shipped its own tests; the load-bearing ones:

- Settings, schema gate and storage: `packages/shared/src/model/self-heal-settings.test.ts`,
  `schema-gate.test.ts`, `audit-findings.test.ts`, `self-heal-tx.test.ts`,
  `self-heal-outbox.test.ts`, `self-heal-breaker.test.ts`, `self-heal-unfenced.test.ts`,
  `packages/shared/src/self-heal/audit-rules.test.ts`, `packages/shared/src/github-app.test.ts`.
- Pure logic: `apps/www/src/server-lib/audit/parse-audit-findings.test.ts`, `fingerprint.test.ts`,
  `fingerprint-churn.test.ts`, `consensus.test.ts`, `render-issue.test.ts`,
  `decide-audit-actions.test.ts`, `decision-log.test.ts`, `resolve-self-heal.test.ts`,
  `plan-self-heal-run.test.ts`.
- GitHub effects: `self-heal-octokit.test.ts`, `with-self-heal-call.test.ts`,
  `self-heal-preflight.test.ts`, `issue-writer.test.ts`, `apply-outbox.test.ts`,
  `execute-audit-findings.test.ts`, `audit-ledger.test.ts`.
- Pipeline and recovery: `audit-finish.hook.test.ts`, `audit-sweep.test.ts`,
  `self-heal-cron.test.ts`, `self-heal-drain.test.ts`, `audit-pipeline.e2e.test.ts`.
- Worker checks: `packages/worker/src/agent-run/self-heal-checks.test.ts`, `agent-command.test.ts`,
  `daemon-env.test.ts`, `run-lane.test.ts`, `workflow.test.ts`, `www-client.test.ts`.
- Routes and UI: `apps/www/src/app/api/self-heal/**/route.test.ts`, the review-settings route
  tests, `apps/www/src/components/settings/self-heal/*.test.tsx`.
- Operator evidence: `packages/worker/deploy/linux/self-heal-acceptance.sh` and its test
  `packages/worker/src/agent-run/self-heal-acceptance.test.ts`.

## Anti-deviation invariants

Each must keep holding; the named test is the guard.

1. **No write credential for the audit agent.** Nothing in the audit run's daemon environment or
   argv carries a GitHub write token, and the check token never enters the daemon env.
   Guards: `daemon-env.test.ts`, `agent-command.test.ts`, `workflow.test.ts`.
2. **Every GitHub call goes through `createSelfHealOctokit` + `withSelfHealCall`.** No retry
   plugin, no raw client, no throttle retry. Guards: `self-heal-octokit.test.ts`,
   `with-self-heal-call.test.ts`, `issue-writer.test.ts`.
3. **Persist before effects.** Bookkeeping, outbox rows and run decisions commit in one transaction
   before the first GitHub call. Guards: `execute-audit-findings.test.ts`, `audit-ledger.test.ts`.
4. **Check results arrive only through the sealed worker token.** One report, before the agent has
   spoken; unreported checks seal as `error`. Guards: `audit-checks/route.test.ts`,
   `self-heal-checks.test.ts`, `www-client.test.ts`, `self-heal-acceptance.test.ts` (no journal line
   may carry the token header).
5. **Org fence or an explicit UNFENCED entry.** Every self-heal model function filters by
   organization, or is listed with a reason in `UNFENCED_SELF_HEAL_MODEL_FUNCTIONS`.
   Guard: `self-heal-unfenced.test.ts`.
6. **The kill switch is monotone and org-only.** It can be set only on the `*` row; no repo row can
   lift it. Guards: `self-heal-settings.test.ts`, `resolve-self-heal.test.ts`, the review-settings
   route tests.
7. **Defaults are off.** The `selfHealLoop` flag and the repo mode default to off; effective mode
   resolves to the most restrictive input. Guards: `self-heal-settings.test.ts`,
   `resolve-self-heal.test.ts`.
8. **No spend or cost gate, and no admin-supplied gate command.** The settings family has neither;
   the validator rejects the keys as unknown. Guards: `self-heal-settings.test.ts`, the
   review-settings route tests.
9. **Closing needs two sealed deterministic passes; the agent never closes.** Guards:
   `decide-audit-actions.test.ts`, `audit-pipeline.e2e.test.ts`.
10. **Agent text is sanitised before it reaches GitHub.** Closing keywords, mentions, comment
    delimiters and secrets are removed. Guard: `render-issue.test.ts`.

## Part 2 — fix loop (Phase 9)

- **Date:** 2026-10-04
- **Context source:** `apps/www/src/server-lib/audit/` (`self-heal-dispatcher.ts`,
  `evaluate-fix-trigger.ts`, `run-audit-fix.ts`, `self-heal-admission.ts`, `plan-self-heal-run.ts`,
  `fix-dispatch-reconcile.ts`, `fix-outcome-classify.ts`, `suppression-guard.ts`, `open-fix-pr.ts`,
  `required-checks.ts`, `evaluate-fix-ci.ts`, `loop-breaker.ts`, `fix-pr-lifecycle.ts`,
  `fix-pr-expiry.ts`, `regression-sweep.ts`, `metrics.ts`), `apps/www/src/agent/hatchet/dispatch.ts`,
  `apps/www/src/app/api/self-heal/fix-check/route.ts`,
  `packages/shared/src/model/audit-fix-attempts.ts`, `self-heal-slot.ts`, `self-heal-breaker.ts`,
  `packages/shared/src/self-heal/fix-paths.ts`, `packages/worker/src/agent-run/receive-pack-refs.ts`,
  `git-broker.ts`, `self-heal-fix-check.ts`, `workflow.ts`, `deploy/skills/audit-fix/SKILL.md`.
- **Schema:** none. Every table and column the fix loop uses shipped with part 1, so the one manual
  production push of phase 8 covers both parts.

### Context

Part 1 files a finding as an issue. Part 2 lets the platform try to fix it: one agent run per
finding attempt, which pushes a branch and nothing else, followed by a pull request that a person
merges. The constraints of part 1 still hold, plus three more:

- The fix agent needs a write path, but ADR-004 says no agent holds a GitHub write credential.
- Many repositories are on GitHub's free plan. A private repo there cannot have branch protection,
  so the design cannot depend on it.
- Reviews keep priority over self-heal on the single execution box.

### Decision

**The fix lane is single-writer too. The agent pushes one fenced branch through the git broker;
the control plane decides, opens, readies and closes the pull request; a person merges.**

1. **The dispatcher is the only starter.** A labelled ledger issue only marks the finding fix-ready
   in the DB; the webhook makes no GitHub call and starts nothing. Fix automations are labelled-only
   (`automata:auto-fix`), so an older www that strips the label keys can never fire one. The `*/10`
   tick runs the dispatcher last. It checks the flag, lists ready findings, and then admits through
   **review-first admission and one platform-wide box slot**: no self-heal run starts while any
   review is queued or running, and at most one self-heal run (audit or fix) holds the box. Scheduled
   audits are admitted the same way. Branch protection is never a dispatch refusal.
2. **Leased claims; the attempt id travels in the stamp.** A claim is one compare-and-set on the
   finding inside `withSelfHealTx`, leased for 10 minutes. The attempt id is written into the
   thread's automation-skill stamp, and the planner binds the stamped attempt (an idempotent CAS).
   A thread that cannot be planned fails closed: no unfenced fix agent starts. The Hatchet trigger
   is bounded at 5 s and an ambiguous answer is read back before the single retry.
3. **Ref fence and deny list.** The worker's git broker parses the receive-pack command list before
   a byte reaches GitHub and accepts only updates of the run's own `refs/heads/automata/fix-*`
   branch (creates allowed, deletes and every other ref refused, the whole push rejected on one bad
   update). A fix run on a box without the credential broker fails before the clone. The path deny
   list (`FIX_DENY_PATHS`, nested `AGENTS.md` / `CLAUDE.md` / `.claude/` at any depth) is enforced
   twice: by the worker on the pushed diff, and by www on GitHub's compare diff together with the
   suppression and scope guard.
4. **Worker finding check on the pushed sha, single-use gate token.** After the agent has exited and
   been reaped, the worker confirms the pushed sha on GitHub, checks it out clean (`git clean -ffdx`)
   and runs only the finding's deterministic check as the agent uid, with no LLM and a 3-minute
   budget. It posts the verdict once with a per-attempt gate token: 32 bytes, only its sha256 at
   rest, a 2-hour TTL, compared timing-safe, accepted once. The token is not a GitHub credential and
   never enters the daemon environment or the journal.
5. **Draft PR through the App client.** A passed check whose sha is still the branch head and that
   passes the guard becomes ONE bot-authored draft PR (`createSelfHealOctokit`, adopted by head when
   it already exists). Drafts are not reviewed.
6. **CI gate, then ready, then one review, then a human merge.** The CI gate source is chosen per
   head: `protection` (the default branch's required checks), else `all-checks` (every check run and
   commit status green, with a 2-minute settle window), else `finding-check-only` (no check within
   10 minutes; the PR gets `needs-human-review` and a no-repo-CI note). The source is recorded on the
   attempt and shown in the activity card. When the gate is green, the PR head still equals the
   gated sha and the guard still passes, the platform marks the PR ready with one App GraphQL
   `markPullRequestReadyForReview` call. That triggers exactly one review from the bot-author-matching
   review automation. A person merges. On a gate failure the platform withdraws the draft (marker
   comment, close, branch delete, one issue comment) and counts the attempt.
7. **Infrastructure is refunded, the finding's failures are counted.** Every terminal cause is
   classified exhaustively. Lost dispatches are read back from Hatchet before any refund. Killed,
   abandoned, cancelled-CI and stuck drafts are refunded; red CI, a guard rejection, a moved head, a
   human close and an expiry are counted. Credential 401/quota is counted, never refunded and never a
   breaker input. Drain covers fix runs.
8. **Loop and plane breakers.** `loop_fix` and `loop_audit` per repo, `hatchet_dispatch` and
   `exec_plane` per org, trip on consecutive-count and rate rules (including 403/422 on lane writes,
   expiries and 30-day regressions). Cooldowns escalate 24 h → 72 h → `paused_manual` (third trip in
   30 days); only the attributed admin reset leaves `paused_manual`. Recovery is exactly one probe
   run, taken in the same transaction as the claim.
9. **No merge API.** Nothing in the lane calls merge, auto-merge, enable-auto-merge or update-branch.
   Merges, human closes, expiries and 30-day regressions are only recorded.

### Options considered

- **A build/test gate run on the box before the PR.** Rejected. It would compete with the run's
  30-minute cap, the agent uid has no Docker, and admin-supplied gate commands are a remote-code
  surface on a shared box. The repository's own CI on a draft PR is the build gate.
- **Open the PR ready for review without waiting for CI.** Rejected by the operator's R1 amendment:
  a review of a red PR wastes the review and asks a person to read broken code. The draft-then-ready
  order makes "one review per fix" a property of code.
- **Engine priority for reviews (Hatchet priority on a separate workflow).** Not adopted. It is
  unverified on hatchet-lite, and a second workflow adds a competing concurrency group. The www
  admission gate is the bulkhead, and the RES-12 drill shows a review queued behind a self-heal run
  starts within milliseconds of the box-lock release.
- **Require branch protection.** Rejected: a free-plan private repo cannot have it. The ref fence
  and the human merge keep the default branch safe without it; protection only changes the gate
  source.
- **A write token for the fix agent.** Rejected, as in part 1 and ADR-004.

### Consequences

**Positive**

- A fix agent can at worst push a bad commit to its own `automata/fix-*` branch. The guard, the
  finding check, the CI gate, the review and the human merge all stand between it and the default
  branch.
- One review per fix, after CI, and none for a red draft.
- Reviews keep priority; the box runs one self-heal run at a time.

**Negative / watch**

- A fix needs a passing deterministic check; rubric-only findings are never fixed automatically.
- Deploy skew is dangerous: an older worker has no ref fence. The worker deploys first, and the
  flag and mode stay off until both halves run phase 9 (runbook).
- Known gaps: an expiry close that fails leaves the PR open while the attempt is recorded expired
  (no retry); a failed regression read still counts as that day's check; follow-up matching includes
  GitHub's 3 context lines; a `pull_request.reopened` on a counted fix PR is not handled.

### Anti-deviation invariants

Each must keep holding; the named test is the guard.

1. **Nothing in the lane merges.** No non-test source in the lane calls a merge, auto-merge or
   update-branch API. Guard: `apps/www/src/server-lib/audit/no-merge.static.test.ts`.
2. **The fix agent can push only its own fix branch.** Receive-pack commands are parsed before
   forwarding; any other ref, a delete or a malformed or compressed body is refused. Guards:
   `packages/worker/src/agent-run/receive-pack-refs.test.ts`, `git-broker.test.ts`,
   `broker-integration.test.ts` (real `git push`), `workflow-cleanup.test.ts` (no broker → no run).
3. **The guard judges exactly the checked commit.** Suppressions, tests, CI, audit config, denied
   paths and out-of-plan files are rejected on the compare diff of the gated sha. Guards:
   `apps/www/src/server-lib/audit/suppression-guard.test.ts`, `packages/shared/src/self-heal/fix-paths.test.ts`,
   `self-heal-fix-check.test.ts` (worker mirror).
4. **One attempt per claim, bound once.** The planner and the dispatcher race to bind; exactly one
   attempt is consumed. Guard: the RACE-01 drill in `apps/www/src/server-lib/audit/run-audit-fix.test.ts`.
5. **Fix runs start only from the dispatcher, behind admission and the slot.** Concurrent ticks start
   exactly one run; a review in flight defers; a half-open probe is taken in the claim transaction.
   Guards: `apps/www/src/server-lib/audit/self-heal-dispatcher.test.ts`, `self-heal-admission.test.ts`,
   `packages/worker/src/agent-run/self-heal-box-lock.integration.test.ts` (RES-12, `HATCHET_IT=1`).
6. **The gate token never reaches the agent or a log.** Guards: `daemon-env.test.ts`,
   `fix-check/route.test.ts`, `dispatch.test.ts`, `self-heal-acceptance.test.ts` (no journal line may
   carry the gate token header or field).
7. **Ready only after the gate.** Guards: `evaluate-fix-ci.test.ts`, `required-checks.test.ts`,
   and the fix-lane checks of `packages/worker/deploy/linux/self-heal-acceptance.sh` on live evidence.
8. **Every GitHub call of the lane uses the App installation client.** Guards:
   `no-shared-octokit.static.test.ts`, `with-self-heal-call.test.ts`.
