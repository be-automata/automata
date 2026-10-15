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
 * This asserts every column schema.ts declares actually exists, and exits non-zero if
 * any is missing. Wire it into the deploy path so the ordering is enforced by a
 * process that can say no, rather than by whoever remembers the runbook.
 *
 *   Usage:  DATABASE_URL=... pnpm exec tsx deploy/assert-schema-ready.ts
 *   Exit:   0 = every required column present; 1 = at least one missing (or the
 *           database is unreachable — fail closed, never "assume it is fine").
 *
 * WHAT IS REQUIRED is derived from packages/shared/src/db/schema.ts (every
 * column and every unique index it declares; see db/schema-columns.ts), so
 * there is no list to forget to update. SINCE_NOTES below only adds context.
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
import {
  listSchemaColumns,
  listSchemaUniqueIndexes,
} from "../packages/shared/src/db/schema-columns";

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

const DEFAULT_SINCE =
  "declared in packages/shared/src/db/schema.ts — this revision's code may read it";

/**
 * Optional context printed next to a missing column, keyed `table.column` or,
 * for a note that covers every column of a table, `table`. Purely explanatory:
 * WHAT is required comes from schema.ts, never from this map.
 */
const SINCE_NOTES: Readonly<Record<string, string>> = {
  "egress_events.mode":
    "#108 — distinguishes an observe-mode allow from an enforced one; " +
    "without it the audit trail cannot say which traffic was actually fenced",
  "repo_review_settings.review_mode": REVIEW_AGENT_SINCE,
  "repo_review_settings.review_batteries": REVIEW_AGENT_SINCE,
  "repo_review_settings.review_run_tests": REVIEW_AGENT_SINCE,
  "repo_review_settings.review_command_timeout_s": REVIEW_AGENT_SINCE,
  "repo_review_settings.review_max_turns": REVIEW_AGENT_SINCE,
  "repo_review_settings.task_batteries":
    "phase 7: task-run batteries (Admin panel task agent packs)",
  "repo_review_settings.self_heal_mode": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_kill_switch": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_max_open_issues": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_max_attempts": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_cooldown_min": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_min_severity": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_auto_label": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_absent_audits": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_max_diff_lines": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_pr_expiry_days": SELF_HEAL_SINCE,
  "repo_review_settings.self_heal_run_window": SELF_HEAL_SINCE,
  audit_runs: AUDIT_LEDGER_SINCE,
  audit_findings: AUDIT_LEDGER_SINCE,
  audit_effects: AUDIT_LEDGER_SINCE,
  audit_fix_attempts: AUDIT_LEDGER_SINCE,
  self_heal_breaker: AUDIT_LEDGER_SINCE,
  self_heal_breaker_event: AUDIT_LEDGER_SINCE,
  self_heal_slot: AUDIT_LEDGER_SINCE,
  self_heal_admin_log: AUDIT_LEDGER_SINCE,
  organization_environment: ORG_ENV_SINCE,
  organization_environment_event: ORG_ENV_SINCE,
  "organization.is_personal":
    "organization.is_personal — the org switcher and the default active org " +
    "read it (deploy/migrations/2026-10-14-environment-org-unique.sql)",
  environment_org_user_repo_unique: ENV_ORG_UNIQUE_SINCE,
  environment_user_global_unique: ENV_ORG_UNIQUE_SINCE,
};

/**
 * Every column schema.ts declares. Derived, not hand-kept: the old hand-kept
 * list needed a human to append to it in the same change as the schema, and a
 * forgotten append was a silent hole in the gate.
 */
const REQUIRED: ReadonlyArray<{
  table: string;
  column: string;
  since: string;
}> = listSchemaColumns().map(({ table, column }) => ({
  table,
  column,
  since:
    SINCE_NOTES[`${table}.${column}`] ?? SINCE_NOTES[table] ?? DEFAULT_SINCE,
}));

/**
 * Every unique index schema.ts declares. The code relies on them for
 * CORRECTNESS: an INSERT ... ON CONFLICT naming one as its target errors when
 * it is missing, so a missing or invalid one FAILS the gate exactly like a
 * missing column.
 */
const REQUIRED_INDEXES: ReadonlyArray<{ name: string; since: string }> =
  listSchemaUniqueIndexes().map((name) => ({
    name,
    since: SINCE_NOTES[name] ?? DEFAULT_SINCE,
  }));

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
  // An empty derived list would pass vacuously; a gate must never do that.
  if (REQUIRED.length === 0 || REQUIRED_INDEXES.length === 0) {
    console.error(
      "assert-schema-ready: FAIL: derived nothing from schema.ts (fail-closed)",
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
