import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Static sync test (SCHEMA-01): deploy/assert-schema-ready.ts REQUIRED must
 * cover every self_heal_* column and every column of any table added after the
 * frozen baseline. Both files are read as text and the expectations are
 * DERIVED from schema.ts, never hard-coded, so a new column cannot ship
 * without its deploy-gate entry.
 */

/**
 * Every pgTable name in packages/shared/src/db/schema.ts at origin/main
 * 5481fd3, sorted. A table not in this list is new in this revision and must
 * have every column in REQUIRED.
 */
const BASELINE_TABLES: readonly string[] = [
  "access_codes",
  "account",
  "agent_provider_credentials",
  "allowed_signup",
  "amp_auth",
  "apikey",
  "automations",
  "claude_oauth_tokens",
  "claude_session_checkpoints",
  "egress_events",
  "environment",
  "feature_flags",
  "feedback",
  "gemini_auth",
  "github_check_run",
  "github_installation",
  "github_pr",
  "hatchet_run",
  "invitation",
  "member",
  "onboarding_completion_emails",
  "onboarding_questionnaire",
  "openai_auth",
  "organization",
  "organization_review_settings",
  "reengagement_emails",
  "repo_review_settings",
  "repo_skill_versions",
  "repo_skills",
  "session",
  "slack_account",
  "slack_installation",
  "slack_settings",
  "subscription",
  "supersede_desired_head",
  "supersede_recheck",
  "thread",
  "thread_chat",
  "thread_chat_read_status",
  "thread_read_status",
  "thread_visibility",
  "usage_events",
  "usage_events_agg_cache_sku",
  "user",
  "user_credits",
  "user_feature_flags",
  "user_flags",
  "user_info_server_side",
  "user_settings",
  "user_stripe_promotion_code",
  "verification",
  "waitlist",
];

const SCHEMA_PATH = fileURLToPath(new URL("../db/schema.ts", import.meta.url));
const GATE_PATH = fileURLToPath(
  new URL("../../../../deploy/assert-schema-ready.ts", import.meta.url),
);

const COLUMN_PATTERN =
  /\b(?:text|integer|boolean|timestamp|jsonb|json|numeric|varchar|bigint|bigserial|serial|real|uuid|date|smallint|doublePrecision|char)\(\s*"([a-z_0-9]+)"/g;

interface TableColumns {
  table: string;
  columns: string[];
}

function parseSchemaTables(source: string): TableColumns[] {
  const parts = source.split(/pgTable\(\s*/).slice(1);
  const tables: TableColumns[] = [];
  for (const part of parts) {
    const nameMatch = /^"([a-z_0-9]+)"/.exec(part);
    if (nameMatch?.[1] === undefined) continue;
    // A part runs to the next pgTable( call, so it holds exactly one table's
    // column builders (plus its index builders, which match no column type).
    const columns = [...part.matchAll(COLUMN_PATTERN)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    tables.push({ table: nameMatch[1], columns });
  }
  return tables;
}

function parseRequired(source: string): Set<string> {
  const keys = new Set<string>();
  for (const m of source.matchAll(
    /table:\s*"([^"]+)",\s*column:\s*"([^"]+)"/g,
  )) {
    keys.add(`${m[1]}.${m[2]}`);
  }
  return keys;
}

const tables = parseSchemaTables(readFileSync(SCHEMA_PATH, "utf8"));
const required = parseRequired(readFileSync(GATE_PATH, "utf8"));

describe("assert-schema-ready REQUIRED stays in sync with schema.ts", () => {
  it("parses the schema (guards a silently broken parser)", () => {
    const settings = tables.find((t) => t.table === "repo_review_settings");
    expect(settings).toBeDefined();
    const selfHeal = (settings?.columns ?? []).filter((c) =>
      c.startsWith("self_heal_"),
    );
    expect(selfHeal.length).toBeGreaterThanOrEqual(11);
    expect(tables.length).toBeGreaterThanOrEqual(BASELINE_TABLES.length);
    expect(required.size).toBeGreaterThan(0);
  });

  it("lists every self_heal_* column of repo_review_settings in REQUIRED", () => {
    const settings = tables.find((t) => t.table === "repo_review_settings");
    const missing = (settings?.columns ?? [])
      .filter((c) => c.startsWith("self_heal_"))
      .filter((c) => !required.has(`repo_review_settings.${c}`));
    expect(missing).toEqual([]);
  });

  it("has no gate-commands column anywhere (GATE-01)", () => {
    for (const t of tables) {
      expect(t.columns).not.toContain("self_heal_gate_commands");
    }
    expect([...required].join("\n")).not.toContain("gate_commands");
  });

  it("requires every column of every table absent from the baseline", () => {
    const baseline = new Set(BASELINE_TABLES);
    const missing: string[] = [];
    for (const t of tables) {
      if (baseline.has(t.table)) continue;
      for (const column of t.columns) {
        if (!required.has(`${t.table}.${column}`)) {
          missing.push(`${t.table}.${column}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("treats every phase 8 ledger table as new, not baseline (RES-23)", () => {
    const baseline = new Set(BASELINE_TABLES);
    for (const name of [
      "audit_runs",
      "audit_findings",
      "audit_effects",
      "audit_fix_attempts",
      "self_heal_breaker",
      "self_heal_breaker_event",
      "self_heal_slot",
      "self_heal_admin_log",
    ]) {
      expect(baseline.has(name)).toBe(false);
      expect(tables.some((t) => t.table === name)).toBe(true);
    }
  });

  it("lists the lease, token and retry columns phase 8 and 9 depend on", () => {
    const wanted = [
      "audit_runs.claim_expires_at",
      "audit_runs.check_token_hash",
      "audit_effects.next_attempt_at",
      "audit_fix_attempts.dispatch_lease_until",
      "audit_fix_attempts.infra_refunded",
      "audit_fix_attempts.pr_open_attempts",
      "audit_fix_attempts.next_pr_open_at",
      "audit_fix_attempts.gate_kind",
      "self_heal_breaker.rate_limited_until",
      "self_heal_breaker.probe_in_flight_until",
      "self_heal_slot.lease_until",
    ];
    const inSchema = new Set(
      tables.flatMap((t) => t.columns.map((c) => `${t.table}.${c}`)),
    );
    for (const key of wanted) {
      expect(inSchema.has(key), `schema.ts lacks ${key}`).toBe(true);
      expect(required.has(key), `REQUIRED lacks ${key}`).toBe(true);
    }
  });
});
