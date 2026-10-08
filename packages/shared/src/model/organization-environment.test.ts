import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  diffEnvironmentVariables,
  getDecryptedOrganizationEnvironmentVariables,
  getOrganizationEnvironment,
  getOrganizationEnvironmentKeys,
  listOrganizationEnvironmentEvents,
  replaceOrganizationEnvironmentVariables,
} from "./organization-environment";
import { createTestOrg, createTestUser } from "./test-helpers";

const MASTER_KEY = "test-master-key-org-environment";

describe("organization environment", () => {
  let db: DB;
  let userId: string;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    db = createDb(process.env.DATABASE_URL!);
    const { user } = await createTestUser({ db });
    userId = user.id;
    orgA = await createTestOrg({ db, name: "Acme" });
    orgB = await createTestOrg({ db, name: "Globex" });
  });

  it("creates one row per org and updates it in place", async () => {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables: [
        { key: "YOUTRACK_URL", value: "https://acme.youtrack.cloud" },
      ],
      encryptionMasterKey: MASTER_KEY,
    });
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables: [
        { key: "YOUTRACK_URL", value: "https://acme.youtrack.cloud" },
        { key: "YOUTRACK_PROJECTS", value: "ACME" },
      ],
      encryptionMasterKey: MASTER_KEY,
    });
    const rows = await db
      .select()
      .from(schema.organizationEnvironment)
      .where(eq(schema.organizationEnvironment.organizationId, orgA));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedByUserId).toBe(userId);
    expect(
      await getOrganizationEnvironmentKeys({ db, organizationId: orgA }),
    ).toEqual(["YOUTRACK_URL", "YOUTRACK_PROJECTS"]);
  });

  it("encrypts at rest and round-trips through decryption", async () => {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables: [{ key: "YOUTRACK_TOKEN", value: "perm:secret-value" }],
      encryptionMasterKey: MASTER_KEY,
    });
    const row = await getOrganizationEnvironment({ db, organizationId: orgA });
    expect(JSON.stringify(row)).not.toContain("perm:secret-value");
    expect(
      await getDecryptedOrganizationEnvironmentVariables({
        db,
        organizationId: orgA,
        encryptionMasterKey: MASTER_KEY,
      }),
    ).toEqual([{ key: "YOUTRACK_TOKEN", value: "perm:secret-value" }]);
  });

  it("never returns one org's variables for another org", async () => {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables: [{ key: "ONLY_A", value: "a" }],
      encryptionMasterKey: MASTER_KEY,
    });
    expect(
      await getDecryptedOrganizationEnvironmentVariables({
        db,
        organizationId: orgB,
        encryptionMasterKey: MASTER_KEY,
      }),
    ).toEqual([]);
    expect(
      await getOrganizationEnvironmentKeys({ db, organizationId: orgB }),
    ).toEqual([]);
  });

  it("records added, removed and changed keys, never values", async () => {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables: [
        { key: "KEEP", value: "same" },
        { key: "CHANGE", value: "old-value" },
        { key: "DROP", value: "gone" },
      ],
      encryptionMasterKey: MASTER_KEY,
    });
    const diff = await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables: [
        { key: "KEEP", value: "same" },
        { key: "CHANGE", value: "new-value" },
        { key: "NEW", value: "fresh" },
      ],
      encryptionMasterKey: MASTER_KEY,
    });
    expect(diff).toEqual({
      added: ["NEW"],
      removed: ["DROP"],
      changed: ["CHANGE"],
    });
    const events = await listOrganizationEnvironmentEvents({
      db,
      organizationId: orgA,
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actorUserId: userId,
      addedKeys: ["NEW"],
      removedKeys: ["DROP"],
      changedKeys: ["CHANGE"],
    });
    const serialized = JSON.stringify(events);
    for (const value of ["same", "old-value", "new-value", "gone", "fresh"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("writes no event for an unchanged save", async () => {
    const variables = [{ key: "A", value: "1" }];
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables,
      encryptionMasterKey: MASTER_KEY,
    });
    const diff = await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: userId,
      variables,
      encryptionMasterKey: MASTER_KEY,
    });
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
    expect(
      await listOrganizationEnvironmentEvents({ db, organizationId: orgA }),
    ).toHaveLength(1);
  });

  it("cascades on org delete and survives the actor's deletion", async () => {
    const { user: actor } = await createTestUser({ db });
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgA,
      actorUserId: actor.id,
      variables: [{ key: "A", value: "1" }],
      encryptionMasterKey: MASTER_KEY,
    });
    await db.delete(schema.user).where(eq(schema.user.id, actor.id));
    const kept = await getOrganizationEnvironment({ db, organizationId: orgA });
    expect(kept?.updatedByUserId).toBeNull();
    expect(kept?.environmentVariables).toHaveLength(1);

    await db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgA));
    expect(
      await getOrganizationEnvironment({ db, organizationId: orgA }),
    ).toBeUndefined();
    expect(
      await listOrganizationEnvironmentEvents({ db, organizationId: orgA }),
    ).toEqual([]);
  });
});

describe("diffEnvironmentVariables", () => {
  it("is empty for identical lists", () => {
    expect(
      diffEnvironmentVariables(
        [{ key: "A", value: "1" }],
        [{ key: "A", value: "1" }],
      ),
    ).toEqual({ added: [], removed: [], changed: [] });
  });
});
