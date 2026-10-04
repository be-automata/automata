# ADR-010: The audit self-healing loop — the agent emits findings, the control plane is the only writer of issues

- **Status:** Accepted (part 1: audit to issues). Part 2 (the fix loop) is appended in Phase 9.
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
   check exists) is never auto-closed; it gets the `needs-human-approve` label and a comment.
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
9. **Labels.** The lane uses `automata:finding`, `automata:auto-fix`, `needs-human-approve`,
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

Reserved. Phase 9 appends the fix loop here (auto-fix dispatch, the PR gate, the attempt cap).
The schema for it already ships with part 1 so one manual production push covers both phases.
