import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { nanoid } from "nanoid";
import { eq, sql } from "drizzle-orm";

import { createDb } from "../db";
import * as schema from "../db/schema";
import { createOrganization } from "./organizations";
import { createTestUser } from "./test-helpers";
import { createThread } from "./threads";
import { buildPrKey } from "./supersede-recheck";
import {
  REHOME_EXCLUDED_TABLES,
  REHOME_MOVE_TABLES,
  REHOME_PR_KEY_TABLES,
  rehomeReposToOrg,
  type RehomeResult,
} from "./rehome-repos-to-org";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(): Promise<{ id: string; slug: string }> {
  const slug = `rehome-${nanoid(10).toLowerCase()}`;
  const org = await createOrganization({ db, name: "Rehome", slug });
  return { id: org.id, slug: org.slug };
}

/** A unique owner per test; mixed case so the case-insensitive match is exercised. */
function makeOwner(): string {
  return `Own${nanoid(8).replace(/[^A-Za-z0-9]/g, "x")}`;
}

interface Fixture {
  threadId: string;
  threadChatId: string;
  ids: Record<string, string>;
  prKey: string;
}

/**
 * One row in every table the tool moves, for `${owner}/app` in `orgId`.
 * Repo columns the app lowercases are seeded lowercased; the rest keep the
 * owner's mixed case.
 */
async function seedRepo({
  orgId,
  userId,
  owner,
  repo = "app",
  prNumber = 7,
  runStatus = "terminal",
}: {
  orgId: string;
  userId: string;
  owner: string;
  repo?: string;
  prNumber?: number;
  runStatus?: "in_flight" | "superseded" | "terminal";
}): Promise<Fixture> {
  const mixed = `${owner}/${repo}`;
  const lower = mixed.toLowerCase();
  const { threadId, threadChatId } = await createThread({
    db,
    userId,
    threadValues: {
      githubRepoFullName: mixed,
      repoBaseBranchName: "main",
      name: "rehome",
      sandboxProvider: "docker",
      organizationId: orgId,
    },
    initialChatValues: { agent: "claudeCode" },
    enableThreadChatCreation: true,
  });
  const ids: Record<string, string> = {
    thread: threadId,
    thread_chat: threadChatId,
  };
  const [visibility] = await db
    .insert(schema.threadVisibility)
    .values({ threadId, visibility: "private", organizationId: orgId })
    .returning();
  ids.thread_visibility = visibility!.id;
  const [egress] = await db
    .insert(schema.egressEvents)
    .values({
      organizationId: orgId,
      threadId,
      runId: nanoid(),
      destinationHost: "example.com",
      action: "allow",
    })
    .returning();
  ids.egress_events = egress!.id;
  const slotKey = `rehome-${nanoid(8)}`;
  await db.insert(schema.selfHealSlot).values({
    slotKey,
    organizationId: orgId,
    holderThreadId: threadId,
    holderKind: "audit",
  });
  ids.self_heal_slot = slotKey;
  const [automation] = await db
    .insert(schema.automations)
    .values({
      userId,
      organizationId: orgId,
      name: "rehome",
      triggerType: "schedule",
      triggerConfig: { cron: "0 9 * * *", timezone: "UTC" },
      repoFullName: mixed,
      branchName: "main",
      action: {
        type: "user_message",
        config: {
          message: {
            type: "user",
            model: null,
            parts: [{ type: "text", text: "x" }],
          },
        },
      },
    })
    .returning();
  ids.automations = automation!.id;
  const [environment] = await db
    .insert(schema.environment)
    .values({ userId, organizationId: orgId, repoFullName: mixed })
    .returning();
  ids.environment = environment!.id;
  const [settings] = await db
    .insert(schema.repoReviewSettings)
    .values({ organizationId: orgId, repoFullName: lower })
    .returning();
  ids.repo_review_settings = settings!.id;
  const [skill] = await db
    .insert(schema.repoSkills)
    .values({
      organizationId: orgId,
      repoFullName: lower,
      skillName: "github-ops",
    })
    .returning();
  ids.repo_skills = skill!.id;
  const [run] = await db
    .insert(schema.hatchetRun)
    .values({
      threadId,
      organizationId: orgId,
      repoFullName: lower,
      prNumber,
      externalId: nanoid(),
      status: runStatus,
    })
    .returning();
  ids.hatchet_run = run!.id;
  const [auditRun] = await db
    .insert(schema.auditRuns)
    .values({
      organizationId: orgId,
      repoFullName: lower,
      threadId,
      audit: "security",
    })
    .returning();
  ids.audit_runs = auditRun!.id;
  const fingerprint = "0123456789abcdef";
  const [finding] = await db
    .insert(schema.auditFindings)
    .values({
      organizationId: orgId,
      repoFullName: lower,
      fingerprint,
      audit: "security",
      ruleId: "r1",
      severity: "high",
      checkKind: "script",
      title: "t",
      issueNumber: 42,
    })
    .returning();
  ids.audit_findings = finding!.id;
  const [effect] = await db
    .insert(schema.auditEffects)
    .values({
      organizationId: orgId,
      repoFullName: lower,
      runId: auditRun!.id,
      findingId: finding!.id,
      fingerprint,
      action: "create_issue",
    })
    .returning();
  ids.audit_effects = effect!.id;
  const [attempt] = await db
    .insert(schema.auditFixAttempts)
    .values({
      organizationId: orgId,
      repoFullName: lower,
      findingId: finding!.id,
      attemptNo: 1,
    })
    .returning();
  ids.audit_fix_attempts = attempt!.id;
  const prKey = buildPrKey({ orgId, repoFullName: mixed, prNumber });
  await db.insert(schema.supersedeDesiredHead).values({
    prKey,
    sha: "a".repeat(40),
    webhookAt: new Date(),
    deliveryId: nanoid(),
  });
  ids.supersede_desired_head = prKey;
  const [recheck] = await db
    .insert(schema.supersedeRecheck)
    .values({
      prKey,
      desiredHeadSha: "a".repeat(40),
      triggeredByThreadId: threadId,
    })
    .returning();
  ids.supersede_recheck = recheck!.id;
  return { threadId, threadChatId, ids, prKey };
}

const ORG_TABLES: Record<string, string> = {
  thread: "id",
  thread_chat: "id",
  thread_visibility: "id",
  egress_events: "id",
  self_heal_slot: "slot_key",
  automations: "id",
  environment: "id",
  repo_review_settings: "id",
  repo_skills: "id",
  hatchet_run: "id",
  audit_runs: "id",
  audit_findings: "id",
  audit_effects: "id",
  audit_fix_attempts: "id",
};

/** The org stamped on each fixture row (undefined = the row is gone). */
async function orgsOf(
  fixture: Fixture,
): Promise<Record<string, string | null | undefined>> {
  const out: Record<string, string | null | undefined> = {};
  for (const [table, idColumn] of Object.entries(ORG_TABLES)) {
    const result = await db.execute(
      sql`select organization_id from ${sql.identifier(table)} where ${sql.identifier(idColumn)} = ${fixture.ids[table]!}`,
    );
    const rows = (result as unknown as { rows: { organization_id: string }[] })
      .rows;
    out[table] = rows[0]?.organization_id;
  }
  return out;
}

async function prKeyExists(table: string, prKey: string): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 from ${sql.identifier(table)} where pr_key = ${prKey}`,
  );
  return (result as unknown as { rows: unknown[] }).rows.length > 0;
}

function tableReport(result: RehomeResult, table: string) {
  const report = result.tables.find((t) => t.table === table);
  if (!report) throw new Error(`no report for ${table}`);
  return report;
}

async function setup() {
  const { user } = await createTestUser({ db });
  const [from, to] = await Promise.all([makeOrg(), makeOrg()]);
  return { userId: user.id, from, to, owner: makeOwner() };
}

describe("rehomeReposToOrg", () => {
  it("dry run reports every moved table and writes nothing", async () => {
    const { userId, from, to, owner } = await setup();
    const fixture = await seedRepo({ orgId: from.id, userId, owner });

    const result = await rehomeReposToOrg({
      db,
      owner,
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: false,
      onCollision: "abort",
    });

    expect(result.status).toBe("dry-run");
    for (const table of [
      ...Object.keys(ORG_TABLES),
      ...REHOME_PR_KEY_TABLES.map((t) => t.table),
    ]) {
      expect(tableReport(result, table)).toMatchObject({
        candidates: 1,
        moved: 1,
        collisions: 0,
      });
    }
    const orgs = await orgsOf(fixture);
    for (const table of Object.keys(ORG_TABLES)) {
      expect(orgs[table], table).toBe(from.id);
    }
    expect(await prKeyExists("supersede_desired_head", fixture.prKey)).toBe(
      true,
    );
  });

  it("apply moves exactly the owner's rows (case-insensitive) and rewrites pr_key", async () => {
    const { userId, from, to, owner } = await setup();
    const mine = await seedRepo({ orgId: from.id, userId, owner });
    // Same owner, other repo, owner typed in a different case on the CLI.
    const mineToo = await seedRepo({
      orgId: from.id,
      userId,
      owner,
      repo: "lib",
    });
    // A different owner whose name merely starts with this owner's name.
    const other = await seedRepo({
      orgId: from.id,
      userId,
      owner: `${owner}x`,
    });

    const result = await rehomeReposToOrg({
      db,
      owner: owner.toUpperCase(),
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: true,
      onCollision: "abort",
    });

    expect(result.status).toBe("applied");
    expect(tableReport(result, "thread").moved).toBe(2);
    for (const fixture of [mine, mineToo]) {
      const orgs = await orgsOf(fixture);
      for (const table of Object.keys(ORG_TABLES)) {
        expect(orgs[table], table).toBe(to.id);
      }
      const movedKey = `${to.id}/${fixture.prKey.slice(from.id.length + 1)}`;
      expect(await prKeyExists("supersede_desired_head", fixture.prKey)).toBe(
        false,
      );
      expect(await prKeyExists("supersede_desired_head", movedKey)).toBe(true);
      expect(await prKeyExists("supersede_recheck", movedKey)).toBe(true);
    }
    const otherOrgs = await orgsOf(other);
    for (const table of Object.keys(ORG_TABLES)) {
      expect(otherOrgs[table], table).toBe(from.id);
    }
    expect(await prKeyExists("supersede_desired_head", other.prKey)).toBe(true);
  });

  it("is idempotent: a second apply moves 0 rows", async () => {
    const { userId, from, to, owner } = await setup();
    await seedRepo({ orgId: from.id, userId, owner });
    const args = {
      db,
      owner,
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: true,
      onCollision: "abort" as const,
    };
    expect((await rehomeReposToOrg(args)).totals.moved).toBeGreaterThan(0);
    const second = await rehomeReposToOrg(args);
    expect(second.status).toBe("applied");
    expect(second.totals).toEqual({
      candidates: 0,
      collisions: 0,
      deleted: 0,
      moved: 0,
    });
  });

  it("aborts on collisions by default and writes nothing", async () => {
    const { userId, from, to, owner } = await setup();
    const source = await seedRepo({ orgId: from.id, userId, owner });
    const target = await seedRepo({ orgId: to.id, userId, owner });

    const result = await rehomeReposToOrg({
      db,
      owner,
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: true,
      onCollision: "abort",
    });

    expect(result.status).toBe("refused-collision");
    expect(result.totals.moved).toBe(0);
    const collided = new Set(
      result.collisions.map((c) => `${c.table}:${c.sourceId}`),
    );
    for (const table of [
      "environment",
      "repo_review_settings",
      "repo_skills",
      "audit_findings",
      "supersede_desired_head",
      "supersede_recheck",
    ]) {
      expect(collided.has(`${table}:${source.ids[table]}`), table).toBe(true);
      expect(tableReport(result, table).collisions, table).toBe(1);
    }
    // Both audit_findings unique indexes are reported for the one row.
    expect(
      result.collisions
        .filter((c) => c.table === "audit_findings")
        .map((c) => c.index)
        .sort(),
    ).toEqual([
      "audit_findings_org_repo_fingerprint_index",
      "audit_findings_org_repo_issue_index",
    ]);
    const orgs = await orgsOf(source);
    for (const table of Object.keys(ORG_TABLES)) {
      expect(orgs[table], table).toBe(from.id);
    }
    expect((await orgsOf(target)).environment).toBe(to.id);
  });

  it("keep-target deletes the source side of each collision and moves the rest", async () => {
    const { userId, from, to, owner } = await setup();
    const source = await seedRepo({ orgId: from.id, userId, owner });
    const target = await seedRepo({ orgId: to.id, userId, owner });

    const result = await rehomeReposToOrg({
      db,
      owner,
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: true,
      onCollision: "keep-target",
    });

    expect(result.status).toBe("applied");
    const orgs = await orgsOf(source);
    for (const table of [
      "environment",
      "repo_review_settings",
      "repo_skills",
      "audit_findings",
      // Cascades from the dropped finding.
      "audit_fix_attempts",
    ]) {
      expect(orgs[table], table).toBeUndefined();
    }
    expect(tableReport(result, "environment").deleted).toBe(1);
    expect(tableReport(result, "audit_findings").deleted).toBe(1);
    for (const table of [
      "thread",
      "thread_chat",
      "hatchet_run",
      "audit_runs",
    ]) {
      expect(orgs[table], table).toBe(to.id);
    }
    // audit_effects lost its finding (set null) but still moved.
    expect(orgs.audit_effects).toBe(to.id);
    expect(await prKeyExists("supersede_desired_head", source.prKey)).toBe(
      false,
    );
    // The target's rows are untouched.
    const targetOrgs = await orgsOf(target);
    for (const table of Object.keys(ORG_TABLES)) {
      expect(targetOrgs[table], table).toBe(to.id);
    }
    const rechecks = await db
      .select()
      .from(schema.supersedeRecheck)
      .where(eq(schema.supersedeRecheck.prKey, target.prKey));
    expect(rechecks.map((r) => r.id)).toEqual([target.ids.supersede_recheck]);
  });

  it("refuses while a hatchet_run for those repos is in flight", async () => {
    const { userId, from, to, owner } = await setup();
    const live = await seedRepo({
      orgId: from.id,
      userId,
      owner,
      runStatus: "in_flight",
    });

    const result = await rehomeReposToOrg({
      db,
      owner,
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: true,
      onCollision: "abort",
    });

    expect(result.status).toBe("refused-in-flight");
    expect(result.inFlight.map((r) => r.id)).toEqual([live.ids.hatchet_run]);
    expect((await orgsOf(live)).thread).toBe(from.id);
  });

  it("does not refuse an in_flight row whose thread is terminal", async () => {
    const { userId, from, to, owner } = await setup();
    const done = await seedRepo({
      orgId: from.id,
      userId,
      owner,
      runStatus: "in_flight",
    });
    await db
      .update(schema.thread)
      .set({ terminalCause: "superseded" })
      .where(eq(schema.thread.id, done.threadId));

    const result = await rehomeReposToOrg({
      db,
      owner,
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: true,
      onCollision: "abort",
    });

    expect(result.status).toBe("applied");
    expect((await orgsOf(done)).hatchet_run).toBe(to.id);
  });

  it("rejects bad input before touching the database", async () => {
    const { from, to } = await setup();
    const base = {
      db,
      fromSlug: from.slug,
      toSlug: to.slug,
      apply: false,
      onCollision: "abort" as const,
    };
    await expect(rehomeReposToOrg({ ...base, owner: "a%" })).rejects.toThrow(
      /GitHub owner/,
    );
    await expect(
      rehomeReposToOrg({ ...base, owner: "acme", toSlug: from.slug }),
    ).rejects.toThrow(/same organization/);
    await expect(
      rehomeReposToOrg({ ...base, owner: "acme", toSlug: "no-such-org-x" }),
    ).rejects.toThrow(/No organization/);
  });
});

describe("rehome coverage guard", () => {
  it("every table with an organization_id column is listed as MOVE or EXCLUDE", async () => {
    const result = await db.execute(
      sql`select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' order by table_name`,
    );
    const tables = (
      result as unknown as { rows: { table_name: string }[] }
    ).rows.map((r) => r.table_name);
    const listed = new Set([...REHOME_MOVE_TABLES, ...REHOME_EXCLUDED_TABLES]);
    expect(tables.filter((t) => !listed.has(t))).toEqual([]);
    // Lists name only real org-stamped tables, and never both.
    expect([...listed].filter((t) => !tables.includes(t))).toEqual([]);
    expect(
      REHOME_MOVE_TABLES.filter((t) => REHOME_EXCLUDED_TABLES.includes(t)),
    ).toEqual([]);
  });

  it("the pr_key tables exist and carry a pr_key column", async () => {
    const names = REHOME_PR_KEY_TABLES.map((t) => t.table);
    const result = await db.execute(
      sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'pr_key' and table_name in (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );
    expect(
      (result as unknown as { rows: { table_name: string }[] }).rows
        .map((r) => r.table_name)
        .sort(),
    ).toEqual([...names].sort());
  });
});
