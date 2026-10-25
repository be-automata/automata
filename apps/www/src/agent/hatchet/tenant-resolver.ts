import { eq } from "drizzle-orm";

import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import { thread } from "@terragon/shared/db/schema";
import type { HatchetTenantBinding } from "@terragon/shared/db/types";
import {
  getHatchetTenantBindingByTenant,
  getHatchetTenantBindings,
  HATCHET_TENANT_BINDING_ORG_DEFAULT,
} from "@terragon/shared/model/hatchet-tenant-binding";
import { decryptValue } from "@terragon/utils/encryption";

import { hatchetConfig } from "./dispatch";
import type { HatchetTriggerConfig } from "./transport";

/** A hatchet_tenant_binding row is malformed, or a run's tenant has no binding. */
export class HatchetTenantBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HatchetTenantBindingError";
  }
}

const REPO_SLUG = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** Throws on a row the resolver must never act on. Never echoes the token. */
function validateRow(row: HatchetTenantBinding): void {
  const where = `org ${row.organizationId}, repo ${String(row.repoFullName)}`;
  if (typeof row.tenantId !== "string" || row.tenantId.trim() === "") {
    throw new HatchetTenantBindingError(`empty tenant id (${where})`);
  }
  if (
    typeof row.apiTokenEncrypted !== "string" ||
    row.apiTokenEncrypted === ""
  ) {
    throw new HatchetTenantBindingError(`empty api token (${where})`);
  }
  if (
    row.repoFullName !== HATCHET_TENANT_BINDING_ORG_DEFAULT &&
    !REPO_SLUG.test(row.repoFullName)
  ) {
    throw new HatchetTenantBindingError(`invalid repo slug (${where})`);
  }
  if (
    row.apiUrl !== null &&
    !row.apiUrl.startsWith("http://") &&
    !row.apiUrl.startsWith("https://")
  ) {
    throw new HatchetTenantBindingError(`invalid api url (${where})`);
  }
}

function configFromRow(
  row: HatchetTenantBinding,
  decrypt: (ciphertext: string) => string,
): HatchetTriggerConfig {
  return {
    apiUrl: row.apiUrl ?? env.HATCHET_API_URL,
    tenantId: row.tenantId,
    apiToken: decrypt(row.apiTokenEncrypted),
  };
}

/**
 * Pure: repo row, else the org '*' row, else the env config unchanged.
 * Every row is validated first so a bad row is never silently skipped.
 */
export function resolveHatchetConfigFromRows({
  rows,
  repoFullName,
  decrypt,
}: {
  rows: HatchetTenantBinding[];
  repoFullName: string;
  decrypt: (ciphertext: string) => string;
}): HatchetTriggerConfig {
  for (const row of rows) validateRow(row);
  const repo = repoFullName.trim().toLowerCase();
  const chosen =
    rows.find((r) => r.repoFullName === repo) ??
    rows.find((r) => r.repoFullName === HATCHET_TENANT_BINDING_ORG_DEFAULT);
  return chosen ? configFromRow(chosen, decrypt) : hatchetConfig();
}

function decryptToken(ciphertext: string): string {
  return decryptValue(ciphertext, env.ENCRYPTION_MASTER_KEY);
}

function isEnvScope(organizationId: string | null | undefined): boolean {
  return organizationId == null || organizationId.startsWith("u:");
}

/** Dispatch-time config for an org + repo. Personal (`u:`) or no org uses env, no query. */
export async function resolveHatchetConfig({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string | null | undefined;
  repoFullName: string;
}): Promise<HatchetTriggerConfig> {
  if (organizationId == null || isEnvScope(organizationId)) {
    return hatchetConfig();
  }
  const rows = await getHatchetTenantBindings({
    db,
    organizationId,
    repoFullName,
  });
  return resolveHatchetConfigFromRows({
    rows,
    repoFullName,
    decrypt: decryptToken,
  });
}

/** Config for an existing run: its recorded tenant (null or env tenant means env). */
export async function resolveHatchetConfigForRun({
  db,
  organizationId,
  tenantId,
}: {
  db: DB;
  organizationId: string | null | undefined;
  tenantId: string | null | undefined;
}): Promise<HatchetTriggerConfig> {
  if (tenantId == null || tenantId === env.HATCHET_TENANT_ID) {
    return hatchetConfig();
  }
  if (organizationId == null || isEnvScope(organizationId)) {
    throw new HatchetTenantBindingError(
      `no binding for tenant ${tenantId} in org ${String(organizationId)}`,
    );
  }
  const row = await getHatchetTenantBindingByTenant({
    db,
    organizationId,
    tenantId,
  });
  if (!row) {
    throw new HatchetTenantBindingError(
      `no binding for tenant ${tenantId} in org ${organizationId}`,
    );
  }
  validateRow(row);
  return configFromRow(row, decryptToken);
}

/** Config for a thread's org + repo; an unknown thread falls back to env. */
export async function resolveHatchetConfigForThread({
  db,
  threadId,
}: {
  db: DB;
  threadId: string;
}): Promise<HatchetTriggerConfig> {
  const [row] = await db
    .select({
      organizationId: thread.organizationId,
      githubRepoFullName: thread.githubRepoFullName,
    })
    .from(thread)
    .where(eq(thread.id, threadId))
    .limit(1);
  if (!row) return hatchetConfig();
  return resolveHatchetConfig({
    db,
    organizationId: row.organizationId,
    repoFullName: row.githubRepoFullName,
  });
}
