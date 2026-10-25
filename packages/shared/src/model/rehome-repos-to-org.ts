import { and, eq, sql, type SQL } from "drizzle-orm";

import { rowsOf, type DB } from "../db";
import { hatchetRun, thread } from "../db/schema";
import { getOrganizationBySlug } from "./organizations";
import { threadIsTerminal } from "./thread-effective-status";

/**
 * Re-home every org-stamped row of one GitHub owner's repos from one
 * organization to another (operator tool; CLI in
 * deploy/rehome-repos-to-org.ts).
 *
 * The whole move is ONE serializable transaction behind a fixed advisory
 * lock. A dry run does exactly the same work and then rolls back, so the
 * report it prints is the report an apply would print.
 *
 * Every table with an `organization_id` column must appear in exactly one of
 * the lists below — rehome-repos-to-org.test.ts introspects
 * information_schema and fails when a new table is in neither, so a future
 * org-stamped table cannot be silently left behind.
 */

/** pg_advisory_xact_lock key: one re-home at a time, platform-wide. */
export const REHOME_ADVISORY_LOCK_KEY = 726_011_173;

export type RehomeCollisionPolicy = "abort" | "keep-target";

export interface RehomeByRepoTable {
  table: string;
  /** The repo slug column, matched case-insensitively on `<owner>/`. */
  repoColumn: string;
}

export interface RehomeByThreadTable {
  table: string;
  /** The column naming the thread whose repo decides the move. */
  threadColumn: string;
  /** The column RETURNING reports (the primary key). */
  idColumn: string;
}

/** Moved because their own repo column names one of the owner's repos. */
export const REHOME_MOVE_BY_REPO: readonly RehomeByRepoTable[] = [
  { table: "thread", repoColumn: "github_repo_full_name" },
  { table: "automations", repoColumn: "repo_full_name" },
  { table: "environment", repoColumn: "repo_full_name" },
  { table: "repo_review_settings", repoColumn: "repo_full_name" },
  { table: "repo_skills", repoColumn: "repo_full_name" },
  { table: "hatchet_run", repoColumn: "repo_full_name" },
  { table: "audit_runs", repoColumn: "repo_full_name" },
  { table: "audit_findings", repoColumn: "repo_full_name" },
  { table: "audit_effects", repoColumn: "repo_full_name" },
  { table: "audit_fix_attempts", repoColumn: "repo_full_name" },
  { table: "delivery_pull_requests", repoColumn: "repo_full_name" },
  { table: "knowledge_claim", repoColumn: "repo_full_name" },
  { table: "knowledge_pin", repoColumn: "repo_full_name" },
  { table: "knowledge_op", repoColumn: "repo_full_name" },
  { table: "knowledge_decision", repoColumn: "repo_full_name" },
  { table: "knowledge_cursor", repoColumn: "repo_full_name" },
  { table: "knowledge_intent", repoColumn: "repo_full_name" },
];

/** Moved because the thread they belong to is one of the owner's threads. */
export const REHOME_MOVE_BY_THREAD: readonly RehomeByThreadTable[] = [
  { table: "thread_chat", threadColumn: "thread_id", idColumn: "id" },
  { table: "thread_visibility", threadColumn: "thread_id", idColumn: "id" },
  { table: "egress_events", threadColumn: "thread_id", idColumn: "id" },
  {
    table: "self_heal_slot",
    threadColumn: "holder_thread_id",
    idColumn: "slot_key",
  },
];

/**
 * Tables that embed the org id in a `pr_key` (`${orgId}/${repo}/${prNumber}`,
 * see buildPrKey in supersede-recheck.ts) rather than in an organization_id
 * column. Their prefix is rewritten `${fromId}/` -> `${toId}/`.
 */
export const REHOME_PR_KEY_TABLES: readonly {
  table: string;
  idColumn: string;
}[] = [
  { table: "supersede_desired_head", idColumn: "pr_key" },
  { table: "supersede_recheck", idColumn: "id" },
];

/** The union of every table whose organization_id this tool rewrites. */
export const REHOME_MOVE_TABLES: readonly string[] = [
  ...REHOME_MOVE_BY_REPO.map((t) => t.table),
  ...REHOME_MOVE_BY_THREAD.map((t) => t.table),
];

/**
 * Tables with an organization_id column that are deliberately NOT moved:
 * org-scoped state (membership, billing, credentials, installations, org
 * settings, breakers) that belongs to the organization, not to a repo, and
 * usage accounting that must stay where it was billed.
 */
export const REHOME_EXCLUDED_TABLES: readonly string[] = [
  "member",
  "invitation",
  "apikey",
  "subscription",
  "github_installation",
  "slack_installation",
  "user_credits",
  "usage_events",
  "usage_events_agg_cache_sku",
  "agent_provider_credentials",
  "hatchet_tenant_binding",
  "organization_review_settings",
  "organization_environment",
  "organization_environment_event",
  "self_heal_breaker",
  "self_heal_breaker_event",
  "self_heal_admin_log",
  "knowledge_usage_window",
  "knowledge_admin_log",
];

/**
 * Unique keys a moved row can collide on in the target org. `keys` are the
 * unique-key columns other than organization_id, compared with IS NOT
 * DISTINCT FROM (environment's constraint is NULLS NOT DISTINCT; the rest are
 * NOT NULL, where the two comparisons agree).
 */
interface CollisionSpec {
  table: string;
  index: string;
  repoColumn: string;
  keys: readonly string[];
  /** Extra predicate on the source row (partial unique index). */
  where?: string;
}

const COLLISION_SPECS: readonly CollisionSpec[] = [
  {
    table: "environment",
    index: "environment_org_user_repo_unique",
    repoColumn: "repo_full_name",
    keys: ["user_id", "repo_full_name"],
  },
  {
    table: "repo_review_settings",
    index: "repo_review_settings_org_repo_index",
    repoColumn: "repo_full_name",
    keys: ["repo_full_name"],
  },
  {
    table: "repo_skills",
    index: "repo_skills_org_repo_skill_index",
    repoColumn: "repo_full_name",
    keys: ["repo_full_name", "skill_name"],
  },
  {
    table: "audit_findings",
    index: "audit_findings_org_repo_fingerprint_index",
    repoColumn: "repo_full_name",
    keys: ["repo_full_name", "fingerprint"],
  },
  {
    table: "audit_findings",
    index: "audit_findings_org_repo_issue_index",
    repoColumn: "repo_full_name",
    keys: ["repo_full_name", "issue_number"],
    where: "issue_number is not null",
  },
  {
    table: "knowledge_cursor",
    index: "knowledge_cursor_org_repo_unique",
    repoColumn: "repo_full_name",
    keys: ["repo_full_name"],
  },
  {
    table: "knowledge_intent",
    index: "knowledge_intent_org_repo_sha_unique",
    repoColumn: "repo_full_name",
    keys: ["repo_full_name", "target_sha"],
  },
];

/** GitHub owner names: alphanumerics and single hyphens, no other characters. */
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface RehomeTableReport {
  table: string;
  via: "repo" | "thread" | "pr_key";
  /** Rows matching the owner in the source org before any collision handling. */
  candidates: number;
  /** Source rows whose target key already exists in the destination org. */
  collisions: number;
  /** Source rows deleted under keep-target (0 under abort). */
  deleted: number;
  /** Rows actually re-stamped (inside the transaction; rolled back on a dry run). */
  moved: number;
}

export interface RehomeCollision {
  table: string;
  index: string;
  sourceId: string;
}

export interface RehomeInFlightRun {
  id: string;
  externalId: string;
  repoFullName: string;
  prNumber: number;
}

export type RehomeStatus =
  | "dry-run"
  | "applied"
  | "refused-collision"
  | "refused-in-flight";

export interface RehomeResult {
  status: RehomeStatus;
  owner: string;
  from: { slug: string; id: string };
  to: { slug: string; id: string };
  onCollision: RehomeCollisionPolicy;
  tables: RehomeTableReport[];
  collisions: RehomeCollision[];
  inFlight: RehomeInFlightRun[];
  totals: {
    candidates: number;
    collisions: number;
    deleted: number;
    moved: number;
  };
}

export interface RehomeOptions {
  db: DB;
  owner: string;
  fromSlug: string;
  toSlug: string;
  apply: boolean;
  onCollision: RehomeCollisionPolicy;
}

/** Bad input (unknown org, same org twice, malformed owner): nothing was attempted. */
export class RehomeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RehomeUsageError";
  }
}

/** Thrown inside the transaction to roll it back while carrying the report out. */
class RehomeRollback extends Error {
  constructor(readonly result: RehomeResult) {
    super(`rehome rolled back (${result.status})`);
    this.name = "RehomeRollback";
  }
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

const ident = (name: string): SQL => sql`${sql.identifier(name)}`;

/** `lower(<alias>.<col>)` starts with `<owner>/` — no LIKE, so no wildcard escaping. */
function ownerPrefix(alias: string, column: string, prefix: string): SQL {
  return sql`left(lower(${ident(alias)}.${ident(column)}), ${prefix.length}) = ${prefix}`;
}

function totalsOf(tables: RehomeTableReport[]): RehomeResult["totals"] {
  return tables.reduce(
    (acc, t) => ({
      candidates: acc.candidates + t.candidates,
      collisions: acc.collisions + t.collisions,
      deleted: acc.deleted + t.deleted,
      moved: acc.moved + t.moved,
    }),
    { candidates: 0, collisions: 0, deleted: 0, moved: 0 },
  );
}

async function countRows(tx: Tx, query: SQL): Promise<number> {
  const rows = rowsOf<{ n: string | number }>(await tx.execute(query));
  return Number(rows[0]?.n ?? 0);
}

/** Children of the owner's threads: threads in either org, so a straggler child is also fixed. */
function ownerThreadIds(ownerSlash: string, fromId: string, toId: string): SQL {
  return sql`(select th.id from ${ident("thread")} th where ${ownerPrefix("th", "github_repo_full_name", ownerSlash)} and th.organization_id in (${fromId}, ${toId}))`;
}

async function runRehome(
  tx: Tx,
  ctx: {
    owner: string;
    ownerSlash: string;
    from: { slug: string; id: string };
    to: { slug: string; id: string };
    apply: boolean;
    onCollision: RehomeCollisionPolicy;
  },
): Promise<RehomeResult> {
  const { ownerSlash, from, to } = ctx;
  await tx.execute(
    sql`select pg_advisory_xact_lock(${REHOME_ADVISORY_LOCK_KEY})`,
  );

  // 1. In-flight guard. hatchet_run.status 'in_flight' is NOT proof of a live
  // run: a successfully completed run is never eagerly marked (schema.ts), so
  // a row is live only while its thread is not terminal as well.
  const inFlight = await tx
    .select({
      id: hatchetRun.id,
      externalId: hatchetRun.externalId,
      repoFullName: hatchetRun.repoFullName,
      prNumber: hatchetRun.prNumber,
    })
    .from(hatchetRun)
    .innerJoin(thread, eq(thread.id, hatchetRun.threadId))
    .where(
      and(
        eq(hatchetRun.organizationId, from.id),
        eq(hatchetRun.status, "in_flight"),
        sql`left(lower(${hatchetRun.repoFullName}), ${ownerSlash.length}) = ${ownerSlash}`,
        sql`not ${threadIsTerminal()}`,
      ),
    );

  const reports = new Map<string, RehomeTableReport>();
  const report = (
    table: string,
    via: RehomeTableReport["via"],
  ): RehomeTableReport => {
    let r = reports.get(table);
    if (!r) {
      r = { table, via, candidates: 0, collisions: 0, deleted: 0, moved: 0 };
      reports.set(table, r);
    }
    return r;
  };

  // 2. Candidate counts (pre-move, so a refused run still reports them).
  for (const t of REHOME_MOVE_BY_REPO) {
    report(t.table, "repo").candidates = await countRows(
      tx,
      sql`select count(*) as n from ${ident(t.table)} s where s.organization_id = ${from.id} and ${ownerPrefix("s", t.repoColumn, ownerSlash)}`,
    );
  }
  for (const t of REHOME_MOVE_BY_THREAD) {
    report(t.table, "thread").candidates = await countRows(
      tx,
      sql`select count(*) as n from ${ident(t.table)} s where s.organization_id = ${from.id} and s.${ident(t.threadColumn)} in ${ownerThreadIds(ownerSlash, from.id, to.id)}`,
    );
  }
  const fromPrefix = `${from.id}/${ownerSlash}`;
  const rewritePrKey = (alias: string): SQL =>
    sql`${to.id + "/"} || substr(${ident(alias)}.pr_key, ${from.id.length + 2})`;
  const prKeyMatch = (alias: string): SQL =>
    sql`left(${ident(alias)}.pr_key, ${fromPrefix.length}) = ${fromPrefix}`;
  for (const t of REHOME_PR_KEY_TABLES) {
    report(t.table, "pr_key").candidates = await countRows(
      tx,
      sql`select count(*) as n from ${ident(t.table)} s where ${prKeyMatch("s")}`,
    );
  }

  // 3. Collisions on the target org's unique keys.
  const collisions: RehomeCollision[] = [];
  for (const spec of COLLISION_SPECS) {
    const keyMatch = sql.join(
      spec.keys.map(
        (k) => sql`t.${ident(k)} is not distinct from s.${ident(k)}`,
      ),
      sql` and `,
    );
    const extra = spec.where ? sql` and s.${sql.raw(spec.where)}` : sql``;
    const rows = rowsOf<{ id: string }>(
      await tx.execute(
        sql`select s.id from ${ident(spec.table)} s where s.organization_id = ${from.id} and ${ownerPrefix("s", spec.repoColumn, ownerSlash)}${extra} and exists (select 1 from ${ident(spec.table)} t where t.organization_id = ${to.id} and ${keyMatch}) order by s.id`,
      ),
    );
    for (const row of rows) {
      collisions.push({
        table: spec.table,
        index: spec.index,
        sourceId: row.id,
      });
    }
  }
  const desiredHeadCollisions = rowsOf<{ id: string }>(
    await tx.execute(
      sql`select s.pr_key as id from ${ident("supersede_desired_head")} s where ${prKeyMatch("s")} and exists (select 1 from ${ident("supersede_desired_head")} t where t.pr_key = ${rewritePrKey("s")}) order by s.pr_key`,
    ),
  );
  for (const row of desiredHeadCollisions) {
    collisions.push({
      table: "supersede_desired_head",
      index: "supersede_desired_head_pkey",
      sourceId: row.id,
    });
  }
  const recheckCollisions = rowsOf<{ id: string }>(
    await tx.execute(
      sql`select s.id from ${ident("supersede_recheck")} s where ${prKeyMatch("s")} and exists (select 1 from ${ident("supersede_recheck")} t where t.pr_key = ${rewritePrKey("s")} and t.desired_head_sha = s.desired_head_sha) order by s.id`,
    ),
  );
  for (const row of recheckCollisions) {
    collisions.push({
      table: "supersede_recheck",
      index: "supersede_recheck_pr_key_sha_index",
      sourceId: row.id,
    });
  }
  // One source row can collide on two indexes (audit_findings): count rows, not hits.
  const collidingIds = new Map<string, Set<string>>();
  for (const c of collisions) {
    const ids = collidingIds.get(c.table) ?? new Set<string>();
    ids.add(c.sourceId);
    collidingIds.set(c.table, ids);
  }
  for (const [table, ids] of collidingIds) {
    const r = reports.get(table);
    if (r) r.collisions = ids.size;
  }

  const base = {
    owner: ctx.owner,
    from,
    to,
    onCollision: ctx.onCollision,
    collisions,
    inFlight,
  };
  const refuse = (status: RehomeStatus): never => {
    const tables = [...reports.values()];
    throw new RehomeRollback({
      ...base,
      status,
      tables,
      totals: totalsOf(tables),
    });
  };
  if (inFlight.length > 0) refuse("refused-in-flight");
  if (collisions.length > 0 && ctx.onCollision === "abort") {
    refuse("refused-collision");
  }

  // 4. keep-target: drop the SOURCE side of every collision. FK cascades
  // follow (repo_skill_versions of a dropped skill, audit_fix_attempts of a
  // dropped finding) — the target's copy is the one that survives.
  for (const [table, ids] of collidingIds) {
    const idColumn = table === "supersede_desired_head" ? "pr_key" : "id";
    const deleted = rowsOf<{ id: string }>(
      await tx.execute(
        sql`delete from ${ident(table)} where ${ident(idColumn)} in (${sql.join(
          [...ids].map((id) => sql`${id}`),
          sql`, `,
        )}) returning ${ident(idColumn)} as id`,
      ),
    );
    report(table, "repo").deleted = deleted.length;
  }

  // 5. The move. Children are re-stamped by thread membership, which does
  // not depend on the thread's own org, so the order of the updates is free.
  for (const t of REHOME_MOVE_BY_REPO) {
    const moved = rowsOf<{ id: string }>(
      await tx.execute(
        sql`update ${ident(t.table)} s set organization_id = ${to.id} where s.organization_id = ${from.id} and ${ownerPrefix("s", t.repoColumn, ownerSlash)} returning s.id`,
      ),
    );
    report(t.table, "repo").moved = moved.length;
  }
  for (const t of REHOME_MOVE_BY_THREAD) {
    const moved = rowsOf<{ id: string }>(
      await tx.execute(
        sql`update ${ident(t.table)} s set organization_id = ${to.id} where s.organization_id = ${from.id} and s.${ident(t.threadColumn)} in ${ownerThreadIds(ownerSlash, from.id, to.id)} returning s.${ident(t.idColumn)} as id`,
      ),
    );
    report(t.table, "thread").moved = moved.length;
  }
  for (const t of REHOME_PR_KEY_TABLES) {
    const moved = rowsOf<{ id: string }>(
      await tx.execute(
        sql`update ${ident(t.table)} s set pr_key = ${rewritePrKey("s")} where ${prKeyMatch("s")} returning s.${ident(t.idColumn)} as id`,
      ),
    );
    report(t.table, "pr_key").moved = moved.length;
  }

  const tables = [...reports.values()];
  const result: RehomeResult = {
    ...base,
    status: ctx.apply ? "applied" : "dry-run",
    tables,
    totals: totalsOf(tables),
  };
  if (!ctx.apply) throw new RehomeRollback(result);
  return result;
}

/**
 * Move the owner's repos from org `fromSlug` to org `toSlug`. Never throws for
 * a refusal or a dry run — those come back as a result whose `status` says so
 * (and whose transaction was rolled back). Throws RehomeUsageError for bad
 * input and lets database errors (including serialization failures, 40001)
 * propagate: the caller re-runs.
 */
export async function rehomeReposToOrg(
  opts: RehomeOptions,
): Promise<RehomeResult> {
  const { db, owner, fromSlug, toSlug } = opts;
  if (!GITHUB_OWNER_PATTERN.test(owner)) {
    throw new RehomeUsageError(
      `--owner must be a GitHub owner name (letters, digits, hyphens), got: ${JSON.stringify(owner)}`,
    );
  }
  if (fromSlug === toSlug) {
    throw new RehomeUsageError("--from and --to name the same organization");
  }
  const [fromOrg, toOrg] = await Promise.all([
    getOrganizationBySlug({ db, slug: fromSlug }),
    getOrganizationBySlug({ db, slug: toSlug }),
  ]);
  if (!fromOrg) {
    throw new RehomeUsageError(`No organization with slug '${fromSlug}'`);
  }
  if (!toOrg) {
    throw new RehomeUsageError(`No organization with slug '${toSlug}'`);
  }
  const ctx = {
    owner,
    ownerSlash: `${owner.toLowerCase()}/`,
    from: { slug: fromOrg.slug, id: fromOrg.id },
    to: { slug: toOrg.slug, id: toOrg.id },
    apply: opts.apply,
    onCollision: opts.onCollision,
  };
  try {
    return await db.transaction((tx) => runRehome(tx, ctx), {
      isolationLevel: "serializable",
    });
  } catch (error: unknown) {
    if (error instanceof RehomeRollback) return error.result;
    throw error;
  }
}

/** Human-readable table, one row per table plus a totals row. */
export function formatRehomeTable(result: RehomeResult): string {
  const header = [
    "table",
    "via",
    "candidates",
    "collisions",
    "deleted",
    "moved",
  ];
  const rows = [
    ...result.tables.map((t) => [
      t.table,
      t.via,
      String(t.candidates),
      String(t.collisions),
      String(t.deleted),
      String(t.moved),
    ]),
    [
      "TOTAL",
      "",
      String(result.totals.candidates),
      String(result.totals.collisions),
      String(result.totals.deleted),
      String(result.totals.moved),
    ],
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ");
  return [
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}
