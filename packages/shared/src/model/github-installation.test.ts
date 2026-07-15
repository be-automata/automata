import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import { createOrganization } from "./organizations";
import {
  bindGithubInstallationToOrg,
  getGithubInstallation,
  getOrganizationIdForInstallation,
} from "./github-installation";

const db = createDb(env.DATABASE_URL!);

function installationId() {
  return String(Math.floor(Math.random() * 1_000_000_000));
}

describe("github-installation", () => {
  let orgId: string;

  beforeEach(async () => {
    const org = await createOrganization({
      db,
      name: "Acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  it("binds an installation to an org and resolves the org", async () => {
    const instId = installationId();
    const bound = await bindGithubInstallationToOrg({
      db,
      installationId: instId,
      organizationId: orgId,
      accountLogin: "acme-inc",
      accountType: "Organization",
    });
    expect(bound.installationId).toBe(instId);
    expect(bound.organizationId).toBe(orgId);

    const resolved = await getOrganizationIdForInstallation({
      db,
      installationId: instId,
    });
    expect(resolved).toBe(orgId);

    // Accepts a numeric installation id (the webhook payload shape).
    const resolvedNumeric = await getOrganizationIdForInstallation({
      db,
      installationId: Number(instId),
    });
    expect(resolvedNumeric).toBe(orgId);
  });

  it("resolves null for an unmapped or absent installation", async () => {
    expect(
      await getOrganizationIdForInstallation({
        db,
        installationId: installationId(),
      }),
    ).toBeNull();
    expect(
      await getOrganizationIdForInstallation({ db, installationId: null }),
    ).toBeNull();
    expect(
      await getOrganizationIdForInstallation({ db, installationId: undefined }),
    ).toBeNull();
  });

  it("rebinds an existing installation (upsert on the unique installationId)", async () => {
    const instId = installationId();
    await bindGithubInstallationToOrg({
      db,
      installationId: instId,
      organizationId: orgId,
    });
    const other = await createOrganization({
      db,
      name: "Other",
      slug: `other-${nanoid(8).toLowerCase()}`,
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: instId,
      organizationId: other.id,
    });

    const row = await getGithubInstallation({ db, installationId: instId });
    expect(row?.organizationId).toBe(other.id);
    // Still a single row for that installation.
    expect(await getOrganizationIdForInstallation({ db, installationId: instId }))
      .toBe(other.id);
  });
});
