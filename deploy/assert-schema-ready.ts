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

import { Client } from "pg";

/** Columns this revision of the code cannot run without. */
const REQUIRED: ReadonlyArray<{
  table: string;
  column: string;
  since: string;
}> = [
  {
    table: "egress_events",
    column: "mode",
    since: "#108 — distinguishes an observe-mode allow from an enforced one; " +
      "without it the audit trail cannot say which traffic was actually fenced",
  },
];

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

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    console.error(
      `assert-schema-ready: FAIL: cannot reach the database (fail-closed): ${
        (error as Error).message
      }`,
    );
    process.exit(1);
  }

  const missing: string[] = [];
  try {
    for (const req of REQUIRED) {
      const { rows } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
        [req.table, req.column],
      );
      if (rows.length === 0) {
        missing.push(`  ${req.table}.${req.column} — ${req.since}`);
      } else {
        console.log(`assert-schema-ready: ok ${req.table}.${req.column}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }

  if (missing.length > 0) {
    console.error(
      "assert-schema-ready: FAIL: the deployed schema is missing:\n" +
        missing.join("\n") +
        "\n\nPush the schema BEFORE deploying:\n" +
        "  pnpm -C packages/shared drizzle-kit-push-prod\n" +
        "then re-run this gate.",
    );
    process.exit(1);
  }
  console.log(
    `assert-schema-ready: OK — all ${REQUIRED.length} required column(s) present`,
  );
}

main().catch((error: unknown) => {
  // Any unexpected throw is still a FAILED gate — never a pass by omission.
  console.error(
    `assert-schema-ready: FAIL: unexpected error (fail-closed): ${String(error)}`,
  );
  process.exit(1);
});
