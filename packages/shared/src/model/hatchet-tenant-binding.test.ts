import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";

import { createDb } from "../db";
import {
  getHatchetTenantBindingByTenant,
  upsertHatchetTenantBinding,
} from "./hatchet-tenant-binding";
import { createTestOrg } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);
const encryptionKey = "test-encryption-key-32-chars-long";

async function bind(
  organizationId: string,
  repoFullName: string,
  apiUrl: string,
): Promise<void> {
  await upsertHatchetTenantBinding({
    db,
    organizationId,
    repoFullName,
    tenantId: "tenant-shared",
    apiUrl,
    apiToken: `token-${apiUrl}`,
    encryptionKey,
  });
}

describe("#374 getHatchetTenantBindingByTenant", () => {
  it("picks deterministically among rows sharing a tenant id: '*' first, then repoFullName", async () => {
    const organizationId = await createTestOrg({ db });
    await bind(organizationId, "zeta/repo", "https://zeta.example");
    await bind(organizationId, "acme/repo", "https://acme.example");

    const byRepo = await getHatchetTenantBindingByTenant({
      db,
      organizationId,
      tenantId: "tenant-shared",
    });
    expect(byRepo?.repoFullName).toBe("acme/repo");
    expect(byRepo?.apiUrl).toBe("https://acme.example");

    await bind(organizationId, "*", "https://default.example");
    const byDefault = await getHatchetTenantBindingByTenant({
      db,
      organizationId,
      tenantId: "tenant-shared",
    });
    expect(byDefault?.repoFullName).toBe("*");
    expect(byDefault?.apiUrl).toBe("https://default.example");
  });

  it("never returns another org's row", async () => {
    const organizationId = await createTestOrg({ db });
    const otherOrgId = await createTestOrg({ db });
    await bind(otherOrgId, "*", "https://other.example");

    expect(
      await getHatchetTenantBindingByTenant({
        db,
        organizationId,
        tenantId: "tenant-shared",
      }),
    ).toBeUndefined();
  });
});
