import { desc, eq } from "drizzle-orm";
import { encryptValue } from "@terragon/utils/encryption";

import { DB } from "../db";
import {
  organizationEnvironment,
  organizationEnvironmentEvent,
} from "../db/schema";
import type {
  OrganizationEnvironment,
  OrganizationEnvironmentEvent,
} from "../db/types";
import { decryptStoredVariables } from "./environments";

/**
 * Org-level environment variables: one encrypted variable list per org,
 * shared by every repository in it.
 *
 * MULTI-TENANT: `organizationId` is the primary key and the tenant fence —
 * every read and write here is a bare PK match. Nothing in this module is
 * user-scoped; who may read values or write is decided at the apps/www
 * boundary (org owners/admins), never here.
 */

export interface EnvironmentVariableDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export async function getOrganizationEnvironment({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<OrganizationEnvironment | undefined> {
  const [row] = await db
    .select()
    .from(organizationEnvironment)
    .where(eq(organizationEnvironment.organizationId, organizationId))
    .limit(1);
  return row;
}

/**
 * Key names only — no decryption, so it needs no master key and is safe to
 * hand to a member who may see which variables exist but not their values.
 */
export async function getOrganizationEnvironmentKeys({
  db,
  organizationId,
}: {
  db: DB;
  organizationId: string;
}): Promise<string[]> {
  const row = await getOrganizationEnvironment({ db, organizationId });
  return (row?.environmentVariables ?? []).map((variable) => variable.key);
}

export async function getDecryptedOrganizationEnvironmentVariables({
  db,
  organizationId,
  encryptionMasterKey,
}: {
  db: DB;
  organizationId: string;
  encryptionMasterKey: string;
}): Promise<Array<{ key: string; value: string }>> {
  const row = await getOrganizationEnvironment({ db, organizationId });
  return decryptStoredVariables(row?.environmentVariables, encryptionMasterKey);
}

/** Which keys a write adds, removes, or changes the value of. Pure. */
export function diffEnvironmentVariables(
  previous: ReadonlyArray<{ key: string; value: string }>,
  next: ReadonlyArray<{ key: string; value: string }>,
): EnvironmentVariableDiff {
  const before = new Map(previous.map((v) => [v.key, v.value]));
  const after = new Map(next.map((v) => [v.key, v.value]));
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const changed = [...after.entries()]
    .filter(([key, value]) => before.has(key) && before.get(key) !== value)
    .map(([key]) => key);
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

export function isEmptyDiff(diff: EnvironmentVariableDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  );
}

/**
 * Replace the org's whole variable list and record who changed which keys, in
 * one transaction. The previous values are decrypted in memory only to tell a
 * changed value from an unchanged one — ciphertexts are salted, so they can't
 * be compared. An empty diff writes no event. Returns the diff (keys only).
 */
export async function replaceOrganizationEnvironmentVariables({
  db,
  organizationId,
  actorUserId,
  variables,
  encryptionMasterKey,
}: {
  db: DB;
  organizationId: string;
  actorUserId: string;
  variables: ReadonlyArray<{ key: string; value: string }>;
  encryptionMasterKey: string;
}): Promise<EnvironmentVariableDiff> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(organizationEnvironment)
      .where(eq(organizationEnvironment.organizationId, organizationId))
      .for("update")
      .limit(1);
    const previous = decryptStoredVariables(
      existing?.environmentVariables,
      encryptionMasterKey,
    );
    const diff = diffEnvironmentVariables(previous, variables);
    if (existing && isEmptyDiff(diff)) {
      return diff;
    }
    const environmentVariables = variables.map((variable) => ({
      key: variable.key,
      valueEncrypted: encryptValue(variable.value, encryptionMasterKey),
    }));
    await tx
      .insert(organizationEnvironment)
      .values({
        organizationId,
        environmentVariables,
        updatedByUserId: actorUserId,
      })
      .onConflictDoUpdate({
        target: organizationEnvironment.organizationId,
        set: {
          environmentVariables,
          updatedByUserId: actorUserId,
          updatedAt: new Date(),
        },
      });
    if (!isEmptyDiff(diff)) {
      await tx.insert(organizationEnvironmentEvent).values({
        organizationId,
        actorUserId,
        addedKeys: diff.added,
        removedKeys: diff.removed,
        changedKeys: diff.changed,
      });
    }
    return diff;
  });
}

export async function listOrganizationEnvironmentEvents({
  db,
  organizationId,
  limit = 10,
}: {
  db: DB;
  organizationId: string;
  limit?: number;
}): Promise<OrganizationEnvironmentEvent[]> {
  return await db
    .select()
    .from(organizationEnvironmentEvent)
    .where(eq(organizationEnvironmentEvent.organizationId, organizationId))
    .orderBy(desc(organizationEnvironmentEvent.createdAt))
    .limit(limit);
}
