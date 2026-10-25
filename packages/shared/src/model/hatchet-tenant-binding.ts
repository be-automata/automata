import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { encryptValue } from "@terragon/utils/encryption";

import { DB } from "../db";
import { hatchetTenantBinding } from "../db/schema";
import { HatchetTenantBinding } from "../db/types";
import { normalizeRepo } from "./repo-review-settings";

/**
 * #374 per-org Hatchet tenant map. MULTI-TENANT: every read is fenced by
 * `organizationId`. `repoFullName` is lowercased on write and read; the
 * literal '*' is the org-wide default binding.
 */
export const HATCHET_TENANT_BINDING_ORG_DEFAULT = "*";

function bindingRepoKey(repoFullName: string): string {
  return repoFullName === HATCHET_TENANT_BINDING_ORG_DEFAULT
    ? HATCHET_TENANT_BINDING_ORG_DEFAULT
    : normalizeRepo(repoFullName);
}

/** The org's bindings that apply to one repo: the repo's own row and the '*' default. */
export async function getHatchetTenantBindings({
  db,
  organizationId,
  repoFullName,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
}): Promise<HatchetTenantBinding[]> {
  return db
    .select()
    .from(hatchetTenantBinding)
    .where(
      and(
        eq(hatchetTenantBinding.organizationId, organizationId),
        inArray(hatchetTenantBinding.repoFullName, [
          normalizeRepo(repoFullName),
          HATCHET_TENANT_BINDING_ORG_DEFAULT,
        ]),
      ),
    );
}

/**
 * The org's binding for one engine tenant id, if any. Several rows of one org
 * may share a tenant id with different api_url/token (the unique index is on
 * org + repo), so the pick is deterministic: the '*' row first, then the
 * lowest repoFullName.
 */
export async function getHatchetTenantBindingByTenant({
  db,
  organizationId,
  tenantId,
}: {
  db: DB;
  organizationId: string;
  tenantId: string;
}): Promise<HatchetTenantBinding | undefined> {
  const [row] = await db
    .select()
    .from(hatchetTenantBinding)
    .where(
      and(
        eq(hatchetTenantBinding.organizationId, organizationId),
        eq(hatchetTenantBinding.tenantId, tenantId),
      ),
    )
    .orderBy(
      desc(
        sql`${hatchetTenantBinding.repoFullName} = ${HATCHET_TENANT_BINDING_ORG_DEFAULT}`,
      ),
      asc(hatchetTenantBinding.repoFullName),
    )
    .limit(1);
  return row;
}

/** Create or replace the binding for (org, repo-or-'*'); the token is encrypted here. */
export async function upsertHatchetTenantBinding({
  db,
  organizationId,
  repoFullName,
  tenantId,
  apiUrl,
  apiToken,
  encryptionKey,
}: {
  db: DB;
  organizationId: string;
  repoFullName: string;
  tenantId: string;
  apiUrl: string | null;
  apiToken: string;
  encryptionKey: string;
}): Promise<HatchetTenantBinding> {
  const values = {
    organizationId,
    repoFullName: bindingRepoKey(repoFullName),
    tenantId,
    apiUrl,
    apiTokenEncrypted: encryptValue(apiToken, encryptionKey),
  };
  const [row] = await db
    .insert(hatchetTenantBinding)
    .values(values)
    .onConflictDoUpdate({
      target: [
        hatchetTenantBinding.organizationId,
        hatchetTenantBinding.repoFullName,
      ],
      set: {
        tenantId: values.tenantId,
        apiUrl: values.apiUrl,
        apiTokenEncrypted: values.apiTokenEncrypted,
      },
    })
    .returning();
  return row!;
}
