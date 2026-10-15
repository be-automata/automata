/**
 * Pre-deploy schema gate.
 *
 * WHY THIS EXISTS. AGENTS.md is explicit that production schema migration is
 * MANUAL — `.github/workflows/` contains only ci.yml and has no drizzle push
 * step — so a schema change ships in two ORDERED manual acts: push the schema
 * to prod FIRST, then deploy the worker/www. Until now that ordering existed
 * only as prose in a runbook, and prose does not fail a deploy.
 *
 * Deploying code that reads a column the database does not have is the whole
 * failure mode. For #108's `egress_events.mode` the blast radius is bounded —
 * insertEgressEvents catches 42703 and retries without the marker, so no audit
 * row is lost — but that fallback is a SAFETY NET, not a licence to deploy in
 * the wrong order, and the next column added will not come with one.
 *
 * This asserts every column listed below actually exists, and exits non-zero if
 * any is missing. Wire it into the deploy path so the ordering is enforced by a
 * process that can say no, rather than by whoever remembers the runbook.
 *
 *   Usage:  DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts
 *   Exit:   0 = every required column present; 1 = at least one missing (or the
 *           database is unreachable — fail closed, never "assume it is fine").
 *
 * ADDING A COLUMN: append it here in the SAME change that adds it to
 * packages/shared/src/db/schema.ts. An entry here is a claim that production
 * cannot run this code without it.
 */

// NO bare third-party imports here. deploy/ has no package.json, so `pg` or
// `drizzle-orm` imported directly resolve only if they happen to be hoisted to
// the repo-root node_modules — neither is a root dependency, so that is an
// accident of the current install, not a guarantee. (It does resolve today:
// this gate was run bare against a real Postgres repeatedly. That is precisely
// why it is worth changing — a gate whose own imports work by accident is not a
// gate.) Everything comes through the shared helper, whose resolution is rooted
// in packages/shared, which really does depend on drizzle-orm. (#173 review.)
import { createDb, rowsOf, sql } from "../packages/shared/src/db";

const REVIEW_AGENT_SINCE =
  "phase 4 (review-agent settings) — the dispatch resolver selects this " +
  "column on every PR-review run; without it every review dispatch fails";

const SELF_HEAL_SINCE =
  "phase 8: self-heal settings — the audit writer, dispatcher and fix trigger read these columns";

const AUDIT_LEDGER_SINCE =
  "phase 8: self-heal ledger — audit writer, outbox, breakers and the phase 9 fix loop read these tables";

const ORG_ENV_SINCE =
  "org-level environment — the tracker resolver and agent env assembly read " +
  "this table on every call (deploy/migrations/2026-10-08-organization-environment.sql)";

const ENV_ORG_UNIQUE_SINCE =
  "environment uniqueness by org — getOrCreateEnvironment names this index as " +
  "its ON CONFLICT target (deploy/migrations/2026-10-14-environment-org-unique.sql)";

/** Columns this revision of the code cannot run without. */
const REQUIRED: ReadonlyArray<{
  table: string;
  column: string;
  since: string;
}> = [
  {
    table: "egress_events",
    column: "mode",
    since:
      "#108 — distinguishes an observe-mode allow from an enforced one; " +
      "without it the audit trail cannot say which traffic was actually fenced",
  },
  {
    table: "repo_review_settings",
    column: "review_mode",
    since: REVIEW_AGENT_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "review_batteries",
    since: REVIEW_AGENT_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "review_run_tests",
    since: REVIEW_AGENT_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "review_command_timeout_s",
    since: REVIEW_AGENT_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "review_max_turns",
    since: REVIEW_AGENT_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "task_batteries",
    since: "phase 7: task-run batteries (Admin panel task agent packs)",
  },
  {
    table: "repo_review_settings",
    column: "self_heal_mode",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_kill_switch",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_max_open_issues",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_max_attempts",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_cooldown_min",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_min_severity",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_auto_label",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_absent_audits",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_max_diff_lines",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_pr_expiry_days",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "repo_review_settings",
    column: "self_heal_run_window",
    since: SELF_HEAL_SINCE,
  },
  {
    table: "audit_runs",
    column: "id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "repo_full_name",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "thread_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "audit",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "status",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "claimed_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "claim_expires_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "claim_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "mode",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "outcome",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "complete",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "requested_checks",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "check_token_hash",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "check_token_expires_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "check_results",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "checks_reported_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "parsed_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "created_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "updated_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "closed_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "skipped",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "decisions",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "error",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "created_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_runs",
    column: "finished_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "repo_full_name",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "fingerprint",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "audit",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "rule_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "section",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "severity",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "check_kind",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "title",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "subject",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "finding_key",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "plan_md",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "acceptance_md",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "plan_files",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "plan_hash",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "issue_number",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "status",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "recent_sightings",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "consecutive_check_passes",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "last_check_outcome",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "absent_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "attempts",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "last_attempt_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "active_thread_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "active_attempt_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "pr_number",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "auto_fix_labeled",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "fix_ready_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "last_seen_run_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "last_reopened_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "last_decision",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "last_decision_reason",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "created_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_findings",
    column: "updated_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "repo_full_name",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "run_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "finding_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "fingerprint",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "action",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "payload",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "status",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "attempts",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "next_attempt_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "lease_until",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "pending_since",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "last_error",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "applied_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "created_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_effects",
    column: "updated_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "repo_full_name",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "finding_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "attempt_no",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "thread_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "branch",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "phase",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "claimed_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "claim_expires_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "dispatch_lease_until",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "gate_kind",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "gate_token_hash",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "gate_token_expires_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "check_reported_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "check_status",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "check_results",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "gated_head_sha",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "denied_paths",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "guard_status",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "guard_reasons",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "diff_lines",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "ci_status",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "ci_results",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "ci_evaluated_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "lease_until",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "pr_number",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "pr_state",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "pr_open_attempts",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "next_pr_open_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "pr_opened_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "ready_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "merged_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "merge_sha",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "merged_by",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "human_commit_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "changed_ranges",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "regression",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "regression_checked_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "regression_window_ends_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "outcome",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "terminal_cause",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "infra_refunded",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "created_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "audit_fix_attempts",
    column: "updated_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "scope_kind",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "scope_key",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "state",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "opened_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "open_until",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "half_open_probes_left",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "probe_in_flight_until",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "trip_count",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "last_trip_reason",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "last_trip_evidence",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "rate_limited_until",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "version",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker",
    column: "updated_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "scope_kind",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "scope_key",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "outcome",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "signal",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "latency_ms",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_breaker_event",
    column: "created_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_slot",
    column: "slot_key",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_slot",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_slot",
    column: "holder_thread_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_slot",
    column: "holder_kind",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_slot",
    column: "lease_until",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_slot",
    column: "acquired_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_slot",
    column: "updated_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_admin_log",
    column: "id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_admin_log",
    column: "organization_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_admin_log",
    column: "actor_user_id",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_admin_log",
    column: "action",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_admin_log",
    column: "target",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "self_heal_admin_log",
    column: "created_at",
    since: AUDIT_LEDGER_SINCE,
  },
  {
    table: "organization_environment",
    column: "organization_id",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment",
    column: "environment_variables",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment",
    column: "updated_by_user_id",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment",
    column: "created_at",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment",
    column: "updated_at",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment_event",
    column: "id",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment_event",
    column: "organization_id",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment_event",
    column: "actor_user_id",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment_event",
    column: "added_keys",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment_event",
    column: "removed_keys",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment_event",
    column: "changed_keys",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization_environment_event",
    column: "created_at",
    since: ORG_ENV_SINCE,
  },
  {
    table: "organization",
    column: "is_personal",
    since:
      "organization.is_personal — the org switcher and the default active org " +
      "read it (deploy/migrations/2026-10-14-environment-org-unique.sql)",
  },
];

/**
 * Unique indexes the code relies on for CORRECTNESS: an INSERT ... ON CONFLICT
 * naming them as its target errors when they are missing, so a missing or
 * invalid one FAILS the gate exactly like a missing column.
 */
const REQUIRED_INDEXES: ReadonlyArray<{ name: string; since: string }> = [
  { name: "environment_org_user_repo_unique", since: ENV_ORG_UNIQUE_SINCE },
  { name: "environment_user_global_unique", since: ENV_ORG_UNIQUE_SINCE },
];

/**
 * Indexes the code relies on for PERFORMANCE only. A missing or invalid one is
 * reported as a WARN and never fails the gate (columns decide correctness).
 * Create them on prod with CREATE INDEX CONCURRENTLY (see PILOT-RUNBOOK.md).
 */
const RECOMMENDED_INDEXES: ReadonlyArray<{ name: string; create: string }> = [
  {
    name: "audit_fix_attempts_pr_repo_lower_index",
    create:
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_fix_attempts_pr_repo_lower_index ON audit_fix_attempts (pr_number, lower(repo_full_name));",
  },
];

/**
 * Validity of each named index in the public schema, in one query: true =
 * present and valid, false = present but INVALID (a failed CONCURRENTLY
 * build), absent from the map = missing. `uniqueOnly` ignores a non-unique
 * index of the same name. Throws when the database cannot be queried.
 */
async function readIndexValidity(
  db: ReturnType<typeof createDb>,
  names: readonly string[],
  { uniqueOnly }: { uniqueOnly: boolean },
): Promise<Map<string, boolean>> {
  const unique = uniqueOnly ? sql` AND i.indisunique` : sql``;
  const result = await db.execute(sql`
    SELECT c.relname AS name, i.indisvalid AS valid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY(${sql.param(names)}::text[])${unique}
  `);
  return new Map(
    rowsOf<{ name: string; valid: boolean }>(result).map((row) => [
      row.name,
      row.valid === true,
    ]),
  );
}

async function warnOnMissingIndexes(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  let validity: Map<string, boolean>;
  try {
    validity = await readIndexValidity(
      db,
      RECOMMENDED_INDEXES.map((index) => index.name),
      { uniqueOnly: false },
    );
  } catch (error) {
    for (const index of RECOMMENDED_INDEXES) {
      console.warn(
        `assert-schema-ready: WARN cannot check index ${index.name}: ${(error as Error).message}`,
      );
    }
    return;
  }
  for (const index of RECOMMENDED_INDEXES) {
    const valid = validity.get(index.name);
    if (valid === true) {
      console.log(`assert-schema-ready: ok index ${index.name}`);
    } else {
      const present = valid === false;
      console.warn(
        `assert-schema-ready: WARN index ${index.name} is ${present ? "INVALID" : "missing"} (performance only, not a failure). Create it:\n  ${index.create}` +
          (present
            ? `\n  (drop the invalid one first: DROP INDEX CONCURRENTLY ${index.name};)`
            : ""),
      );
    }
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      "assert-schema-ready: FAIL: DATABASE_URL is not set (fail-closed).\n" +
        "  The prod URL is a write-only Cloudflare Worker secret — `wrangler secret list`\n" +
        "  shows names only — so whoever runs this needs it out of band.",
    );
    process.exit(1);
  }

  const db = createDb(url);
  const missing: string[] = [];
  for (const req of REQUIRED) {
    let present: boolean;
    try {
      // table_schema is pinned: without it, a same-named table in ANOTHER
      // schema on the search_path reports a false "present" and lets a real
      // gap through — the one way a gate like this can be worse than nothing.
      const result = await db.execute(sql`
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ${req.table}
           AND column_name = ${req.column}
         LIMIT 1
      `);
      present = rowsOf(result).length > 0;
    } catch (error) {
      console.error(
        `assert-schema-ready: FAIL: cannot query the database (fail-closed): ${
          (error as Error).message
        }`,
      );
      process.exit(1);
    }
    if (present) {
      console.log(`assert-schema-ready: ok ${req.table}.${req.column}`);
    } else {
      missing.push(`  ${req.table}.${req.column} — ${req.since}`);
    }
  }

  let uniqueIndexValidity: Map<string, boolean>;
  try {
    uniqueIndexValidity = await readIndexValidity(
      db,
      REQUIRED_INDEXES.map((index) => index.name),
      { uniqueOnly: true },
    );
  } catch (error) {
    console.error(
      `assert-schema-ready: FAIL: cannot query the database (fail-closed): ${
        (error as Error).message
      }`,
    );
    process.exit(1);
  }
  for (const index of REQUIRED_INDEXES) {
    if (uniqueIndexValidity.get(index.name) === true) {
      console.log(`assert-schema-ready: ok unique index ${index.name}`);
    } else {
      missing.push(`  unique index ${index.name} — ${index.since}`);
    }
  }

  if (missing.length > 0) {
    console.error(
      "assert-schema-ready: FAIL: the deployed schema is missing:\n" +
        missing.join("\n") +
        "\n\nPush the schema BEFORE deploying (or apply the hand-written\n" +
        "migration under deploy/migrations/ that the entry names):\n" +
        "  pnpm -C packages/shared drizzle-kit-push-prod\n" +
        "then re-run this gate.",
    );
    process.exit(1);
  }
  console.log(
    `assert-schema-ready: OK — all ${REQUIRED.length} required column(s) and ${REQUIRED_INDEXES.length} unique index(es) present`,
  );
  await warnOnMissingIndexes(db);
  // Explicit exit, as every sibling script in deploy/ does after a createDb()
  // run (bind-github-installation, seed-pilot-mirror, seed-selfhost, skill-push).
  // createDb opens a pool that keeps the event loop alive: measured, the success
  // path returned only after ~10s on node-postgres, and PROD IS NEON, where
  // createDb selects the websocket-backed neon-serverless driver instead — a
  // handle far more likely to hold the loop open indefinitely. A deploy gate
  // that does not return control promptly is not usable in a pipeline.
  process.exit(0);
}

main().catch((error: unknown) => {
  // Any unexpected throw is still a FAILED gate — never a pass by omission.
  console.error(
    `assert-schema-ready: FAIL: unexpected error (fail-closed): ${String(error)}`,
  );
  process.exit(1);
});
