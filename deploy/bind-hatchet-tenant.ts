/**
 * Bind an org (or one of its repos) to a dedicated Hatchet tenant (#374, operator tool).
 *
 * The control plane resolves every trigger, cancel, status read and sweep through
 * these rows: the repo's own row, then the org's '*' row, then the env tenant
 * (apps/www/src/agent/hatchet/tenant-resolver.ts). The tenant and its API token
 * come from `provision:tenant` on the box.
 *
 * Idempotent: re-running upserts on (org, repo). The token is encrypted here with
 * ENCRYPTION_MASTER_KEY (the www value); it is read from the environment, never
 * from argv, and never printed.
 *
 * Usage (DATABASE_URL must point at the target Postgres):
 *   DATABASE_URL=postgres://... ENCRYPTION_MASTER_KEY=... HATCHET_TENANT_API_TOKEN=... \
 *     pnpm exec tsx deploy/bind-hatchet-tenant.ts <orgSlug> <owner/repo|'*'> <tenantId> [apiUrl]
 *
 * Rollback: delete the binding row; the org returns to the env tenant. Drain the
 * bound tenant first: runs already dispatched there stay there.
 */
import { createDb } from "../packages/shared/src/db";
import { getOrganizationBySlug } from "../packages/shared/src/model/organizations";
import { upsertHatchetTenantBinding } from "../packages/shared/src/model/hatchet-tenant-binding";

const USAGE =
  "Usage: DATABASE_URL=... ENCRYPTION_MASTER_KEY=... HATCHET_TENANT_API_TOKEN=... pnpm exec tsx deploy/bind-hatchet-tenant.ts <orgSlug> <owner/repo|'*'> <tenantId> [apiUrl]";

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.ENCRYPTION_MASTER_KEY;
const apiToken = process.env.HATCHET_TENANT_API_TOKEN;
if (!databaseUrl || !encryptionKey || !apiToken) {
  console.error(
    "DATABASE_URL, ENCRYPTION_MASTER_KEY and HATCHET_TENANT_API_TOKEN must all be set.\n" +
      USAGE,
  );
  process.exit(1);
}

const [orgSlug, repoArg, tenantId, apiUrlArg] = process.argv.slice(2);
if (!orgSlug || !repoArg || !tenantId) {
  console.error(USAGE);
  process.exit(1);
}

const repoFullName = repoArg === "*" ? "*" : repoArg.toLowerCase();
if (
  repoFullName !== "*" &&
  !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repoFullName)
) {
  console.error(`repo must be 'owner/name' or '*', got: ${repoArg}`);
  process.exit(1);
}

if (apiUrlArg !== undefined && !/^https?:\/\//.test(apiUrlArg)) {
  console.error(`apiUrl must be http(s)://, got: ${apiUrlArg}`);
  process.exit(1);
}

const db = createDb(databaseUrl);

// The argv/env checks above exit on a missing value, so the `!` reads below are set.
async function main() {
  const org = await getOrganizationBySlug({ db, slug: orgSlug! });
  if (!org) {
    console.error(`No organization found with slug '${orgSlug}'.`);
    process.exit(1);
  }

  const bound = await upsertHatchetTenantBinding({
    db,
    organizationId: org.id,
    repoFullName,
    tenantId: tenantId!,
    apiUrl: apiUrlArg ?? null,
    apiToken: apiToken!,
    encryptionKey: encryptionKey!,
  });

  console.log(
    `\nBound org '${org.name}' (${org.id}) repo '${bound.repoFullName}' -> tenant ${bound.tenantId}`,
  );
  console.log(`  apiUrl: ${bound.apiUrl ?? "(env HATCHET_API_URL)"}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(
    "Bind failed:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
