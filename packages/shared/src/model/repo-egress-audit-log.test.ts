import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { createDb, type DB } from "../db";
import { repoEgressAuditLog } from "../db/schema";
import { createOrganization } from "./organizations";
import * as auditModule from "./repo-egress-audit-log";
import {
  diffEgressHosts,
  listRepoEgressChanges,
  recordRepoEgressChange,
} from "./repo-egress-audit-log";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

const NONE = { level: null, allowlist: null, registries: null } as const;

describe("diffEgressHosts", () => {
  it("compares canonical sets, order-stable", () => {
    expect(
      diffEgressHosts(
        ["A.example.com", "b.example.com", " c.example.com "],
        ["c.example.com", "d.example.com", "a.example.com", "D.example.com"],
      ),
    ).toEqual({ added: ["d.example.com"], removed: ["b.example.com"] });
    expect(diffEgressHosts(null, null)).toEqual({ added: [], removed: [] });
  });
});

describe("repo-egress-audit-log (org-fenced)", () => {
  let orgA: string;
  let orgB: string;
  const repo = "acme/widgets";

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("records one row with the actor, the credential, before/after and the host diff", async () => {
    const row = await recordRepoEgressChange({
      db,
      organizationId: orgA,
      repoFullName: repo,
      actorUserId: "user-1",
      authKind: "api_key",
      credentialId: "apikey-row-1",
      before: {
        level: null,
        allowlist: ["old.example.com", "keep.example.com"],
        registries: null,
      },
      after: {
        level: "domain",
        allowlist: ["keep.example.com", "New.Example.com"],
        registries: true,
      },
    });
    expect(row).toMatchObject({
      organizationId: orgA,
      repoFullName: repo,
      actorUserId: "user-1",
      authKind: "api_key",
      credentialId: "apikey-row-1",
      levelBefore: null,
      levelAfter: "domain",
      hostsAdded: ["new.example.com"],
      hostsRemoved: ["old.example.com"],
      registriesBefore: null,
      registriesAfter: true,
    });
    expect(row.id).toMatch(/\S/);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("rolls back with the caller's transaction", async () => {
    await expect(
      db.transaction(async (rawTx) => {
        await recordRepoEgressChange({
          // The repo's convention for passing a tx where a DB is typed (knowledge-controls.ts).
          db: rawTx as unknown as DB,
          organizationId: orgA,
          repoFullName: repo,
          actorUserId: "user-1",
          authKind: "session",
          credentialId: null,
          before: NONE,
          after: { level: "none", allowlist: null, registries: null },
        });
        throw new Error("settings write failed");
      }),
    ).rejects.toThrow("settings write failed");
    const rows = await db
      .select()
      .from(repoEgressAuditLog)
      .where(eq(repoEgressAuditLog.organizationId, orgA));
    expect(rows).toEqual([]);
  });

  it("lists newest first and pages with the (createdAt, id) cursor, ties included", async () => {
    const t0 = new Date("2026-11-20T10:00:00.000Z");
    const tie = new Date("2026-11-20T10:00:01.000Z");
    const t2 = new Date("2026-11-20T10:00:02.000Z");
    const base = {
      organizationId: orgA,
      repoFullName: repo,
      actorUserId: "user-1",
      authKind: "session" as const,
      hostsAdded: [],
      hostsRemoved: [],
    };
    // Explicit ids and times: two rows share a millisecond, so the id breaks the tie.
    await db.insert(repoEgressAuditLog).values([
      { ...base, id: "a-1", createdAt: t0 },
      { ...base, id: "b-1", createdAt: tie },
      { ...base, id: "b-2", createdAt: tie },
      { ...base, id: "c-1", createdAt: t2 },
    ]);

    const order: string[] = [];
    let before: auditModule.RepoEgressHistoryCursor | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await listRepoEgressChanges({
        db,
        organizationId: orgA,
        repoFullName: repo,
        limit: 1,
        before,
      });
      order.push(...result.entries.map((e) => e.id));
      if (!result.nextBefore) break;
      before = result.nextBefore;
    }
    expect(order).toEqual(["c-1", "b-2", "b-1", "a-1"]);

    const firstTwo = await listRepoEgressChanges({
      db,
      organizationId: orgA,
      repoFullName: repo,
      limit: 2,
    });
    expect(firstTwo.entries.map((e) => e.id)).toEqual(["c-1", "b-2"]);
    expect(firstTwo.nextBefore).toEqual({ createdAt: tie, id: "b-2" });

    const all = await listRepoEgressChanges({
      db,
      organizationId: orgA,
      repoFullName: repo,
    });
    expect(all.entries).toHaveLength(4);
    expect(all.nextBefore).toBeNull();
  });

  it("never returns org B's rows for org A, nor another repo's", async () => {
    const write = (organizationId: string, repoFullName: string) =>
      recordRepoEgressChange({
        db,
        organizationId,
        repoFullName,
        actorUserId: "user-1",
        authKind: "session",
        credentialId: "session-1",
        before: NONE,
        after: {
          level: "domain",
          allowlist: [`${organizationId}.example.com`],
          registries: null,
        },
      });
    const a = await write(orgA, repo);
    await write(orgB, repo);
    await write(orgA, "acme/other");

    const listA = await listRepoEgressChanges({
      db,
      organizationId: orgA,
      repoFullName: repo,
    });
    expect(listA.entries.map((e) => e.id)).toEqual([a.id]);

    const rowsB = await db
      .select()
      .from(repoEgressAuditLog)
      .where(
        and(
          eq(repoEgressAuditLog.organizationId, orgB),
          eq(repoEgressAuditLog.repoFullName, repo),
        ),
      );
    expect(rowsB).toHaveLength(1);
  });

  it("exports insert and list only (append-only)", () => {
    expect(Object.keys(auditModule).sort()).toEqual([
      "REPO_EGRESS_HISTORY_MAX_LIMIT",
      "diffEgressHosts",
      "listRepoEgressChanges",
      "recordRepoEgressChange",
    ]);
  });
});
