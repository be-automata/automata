import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

import {
  REST,
  bootstrapTenant,
  compose,
  composeDownV,
  composeUp,
  connectPg,
} from "../agent-run/hatchet-it-harness";
import { provisionTenant } from "./hatchet-tenant";

/**
 * #374 AC 4, against a REAL isolated hatchet-lite (HATCHET_IT=1; never the
 * live `automata-hatchet` project — see hatchet-it-harness.ts). The
 * provisioner logs in with the image's seed admin, creates a tenant, mints a
 * token with the image's own `hatchet-admin`, and that token is scoped: it
 * reads its own tenant's windowed run collection (200, zero rows) and is
 * refused on the default tenant (403).
 */
const itEnabled = process.env.HATCHET_IT === "1";

// hatchet-lite's seed admin; the isolated stack is torn down after the suite.
const SEED_EMAIL = "admin@example.com";
const SEED_PASSWORD = "Admin123!!";

async function runsStatus(
  tenantId: string,
  token: string,
): Promise<{
  status: number;
  rows: unknown[] | null;
}> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const res = await fetch(
    `${REST}/api/v1/stable/tenants/${tenantId}/workflow-runs?since=${encodeURIComponent(since)}&limit=10&only_tasks=true`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body: unknown = await res.json().catch(() => null);
  const rows =
    typeof body === "object" && body !== null && "rows" in body
      ? (body as { rows: unknown }).rows
      : null;
  return { status: res.status, rows: Array.isArray(rows) ? rows : null };
}

describe.skipIf(!itEnabled)(
  "provision:tenant against dockerized hatchet-lite (HATCHET_IT=1)",
  () => {
    let pg: Client;
    let defaultTenantId: string;
    let dir: string;
    let passwordFile: string;

    beforeAll(async () => {
      await composeUp();
      pg = await connectPg();
      ({ tenantId: defaultTenantId } = await bootstrapTenant(pg));
      dir = await mkdtemp(path.join(tmpdir(), "provision-it-"));
      passwordFile = path.join(dir, "hatchet-admin.pass");
      await writeFile(passwordFile, `${SEED_PASSWORD}\n`, { mode: 0o600 });
    }, 240_000);

    afterAll(async () => {
      await pg?.end().catch(() => {});
      if (dir) await rm(dir, { recursive: true, force: true });
      await composeDownV();
    }, 120_000);

    it("creates a tenant and mints a token scoped to it", async () => {
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("needs a POSIX host");
      const { tenantId, token, expiresAt } = await provisionTenant(
        {
          apiUrl: REST,
          adminEmail: SEED_EMAIL,
          passwordFile,
          tokenName: "it-www",
          expiresIn: "24h",
          tenant: { name: "IT client", slug: "it-client" },
        },
        {
          fetch,
          uid,
          now: () => new Date(),
          runAdmin: (adminArgs) =>
            compose(["exec", "-T", "hatchet-lite", ...adminArgs]),
        },
      );
      expect(tenantId).not.toBe(defaultTenantId);
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
      const row = await pg.query(
        `SELECT slug FROM "Tenant" WHERE id = $1::uuid`,
        [tenantId],
      );
      expect(row.rows[0]?.slug).toBe("it-client");

      const own = await runsStatus(tenantId, token);
      expect(own.status).toBe(200);
      expect(own.rows).toEqual([]);

      const cross = await runsStatus(defaultTenantId, token);
      expect(cross.status).toBe(403);
    }, 120_000);
  },
);
