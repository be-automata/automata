/**
 * WI-5 step 2 backfill: give every existing user a personal organization and
 * stamp their org-scoped rows with it.
 *
 * The tenancy retrofit (ADR-001) adds a nullable `organizationId` to 13 tables.
 * This script fills those nulls so the column can eventually be tightened to
 * NOT NULL. It creates ONE personal org per user (the user is its sole `owner`
 * member) and sets `organizationId` on every row the user owns.
 *
 * SAFETY: this is an operator/test tool, NOT a schema migration. It only runs
 * UPDATEs that set a currently-null `organizationId` (WHERE organization_id IS
 * NULL) and idempotent INSERTs — it never drops, deletes, or overwrites a
 * non-null tenant. Re-running is safe: users that already have a personal org
 * reuse it, and already-stamped rows are skipped. Pass `{ dryRun: true }` to
 * report what would change without writing.
 *
 * Usage (DATABASE_URL must point at the target Postgres):
 *   DATABASE_URL=postgresql://... pnpm exec tsx packages/shared/scripts/backfill-organizations.ts [--dry-run]
 */
import { createDb, DB } from "../src/db";
import * as schema from "../src/db/schema";
import { env } from "@terragon/env/pkg-shared";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export type BackfillResult = {
  usersProcessed: number;
  orgsCreated: number;
  rowsStamped: Record<string, number>;
};

// user-keyed tables: (result-label, physical table, owning-user column). All
// names are hardcoded constants — safe to interpolate as raw SQL identifiers.
// subscription keys the owner on reference_id (= user.id today).
const USER_KEYED_TABLES: ReadonlyArray<{
  name: string;
  table: string;
  userCol: string;
}> = [
  { name: "thread", table: "thread", userCol: "user_id" },
  { name: "threadChat", table: "thread_chat", userCol: "user_id" },
  { name: "environment", table: "environment", userCol: "user_id" },
  { name: "automations", table: "automations", userCol: "user_id" },
  { name: "apikey", table: "apikey", userCol: "user_id" },
  { name: "userCredits", table: "user_credits", userCol: "user_id" },
  { name: "usageEvents", table: "usage_events", userCol: "user_id" },
  {
    name: "usageEventsAggCacheSku",
    table: "usage_events_agg_cache_sku",
    userCol: "user_id",
  },
  {
    name: "agentProviderCredentials",
    table: "agent_provider_credentials",
    userCol: "user_id",
  },
  { name: "subscription", table: "subscription", userCol: "reference_id" },
];

function personalOrgName(name: string | null, email: string): string {
  const base = (name ?? email.split("@")[0] ?? email).trim();
  return base ? `${base}'s workspace` : "Personal workspace";
}

/**
 * Find the user's existing personal org (their first membership) or create one.
 * Idempotent: a user that already belongs to an org reuses it.
 */
async function ensurePersonalOrg(
  db: DB,
  u: { id: string; name: string | null; email: string },
  dryRun: boolean,
): Promise<{ organizationId: string; created: boolean }> {
  const [existing] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, u.id))
    .limit(1);
  if (existing) {
    return { organizationId: existing.organizationId, created: false };
  }
  const organizationId = nanoid();
  if (dryRun) {
    return { organizationId, created: true };
  }
  // A deterministic-ish unique slug; org slug is globally unique.
  const slug = `personal-${u.id.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(
    0,
    48,
  );
  await db.insert(schema.organization).values({
    id: organizationId,
    name: personalOrgName(u.name, u.email),
    slug,
    createdAt: new Date(),
  });
  await db.insert(schema.member).values({
    id: nanoid(),
    organizationId,
    userId: u.id,
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId, created: true };
}

export async function backfillOrganizations(
  db: DB = createDb(env.DATABASE_URL!),
  opts: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const result: BackfillResult = {
    usersProcessed: 0,
    orgsCreated: 0,
    rowsStamped: {},
  };
  const bump = (name: string, n: number) => {
    if (n > 0) result.rowsStamped[name] = (result.rowsStamped[name] ?? 0) + n;
  };

  const users = await db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.user);
  console.log(
    `[backfill-organizations]${dryRun ? " (dry run)" : ""} ${users.length} users to process`,
  );

  for (const u of users) {
    const { organizationId, created } = await ensurePersonalOrg(db, u, dryRun);
    result.usersProcessed += 1;
    if (created) result.orgsCreated += 1;
    if (dryRun) continue;

    for (const { name, table, userCol } of USER_KEYED_TABLES) {
      const res = await db.execute(sql`
        UPDATE ${sql.raw(table)}
        SET organization_id = ${organizationId}
        WHERE ${sql.raw(userCol)} = ${u.id}
          AND organization_id IS NULL
      `);
      bump(name, res.rowCount ?? 0);
    }
  }

  // Thread-child tables with no own userId inherit their thread's org.
  if (!dryRun) {
    const tv = await db.execute(sql`
      UPDATE thread_visibility AS c
      SET organization_id = t.organization_id
      FROM thread AS t
      WHERE c.thread_id = t.id
        AND c.organization_id IS NULL
        AND t.organization_id IS NOT NULL
    `);
    bump("threadVisibility", tv.rowCount ?? 0);

    const pr = await db.execute(sql`
      UPDATE github_pr AS c
      SET organization_id = t.organization_id
      FROM thread AS t
      WHERE c.thread_id = t.id
        AND c.organization_id IS NULL
        AND t.organization_id IS NOT NULL
    `);
    bump("githubPR", pr.rowCount ?? 0);

    // Slack installations map to their installer's org when known.
    const slack = await db.execute(sql`
      UPDATE slack_installation AS s
      SET organization_id = m.organization_id
      FROM member AS m
      WHERE s.installer_user_id = m.user_id
        AND s.organization_id IS NULL
    `);
    bump("slackInstallation", slack.rowCount ?? 0);
  }

  console.log("[backfill-organizations] done:", JSON.stringify(result));
  return result;
}

// Run only when executed directly (keeps the module importable in tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  backfillOrganizations(createDb(env.DATABASE_URL!), { dryRun })
    .then(() => {
      console.log("Backfill completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Backfill failed:", error);
      process.exit(1);
    });
}
