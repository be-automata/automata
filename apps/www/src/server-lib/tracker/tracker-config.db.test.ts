import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/apps-www";
import { encryptValue } from "@terragon/utils/encryption";
import {
  getOrCreateEnvironment,
  getOrCreateGlobalEnvironment,
  updateEnvironment,
} from "@terragon/shared/model/environments";
import { replaceOrganizationEnvironmentVariables } from "@terragon/shared/model/organization-environment";
import { addOrganizationMember } from "@terragon/shared/model/organizations";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { db } from "@/lib/db";

import {
  resolveTrackerConfig,
  resolveTrackerConfigWithSources,
} from "./tracker-config";

const REPO = "acme/widgets";

function encrypted(record: Record<string, string>) {
  return Object.entries(record).map(([key, value]) => ({
    key,
    valueEncrypted: encryptValue(value, env.ENCRYPTION_MASTER_KEY),
  }));
}

async function setGlobal(userId: string, record: Record<string, string>) {
  const environment = await getOrCreateGlobalEnvironment({ db, userId });
  await updateEnvironment({
    db,
    userId,
    environmentId: environment.id,
    updates: { environmentVariables: encrypted(record) },
  });
}

async function setRepo(
  userId: string,
  organizationId: string | null,
  record: Record<string, string>,
) {
  const environment = await getOrCreateEnvironment({
    db,
    userId,
    organizationId,
    repoFullName: REPO,
  });
  await updateEnvironment({
    db,
    userId,
    organizationId,
    environmentId: environment.id,
    updates: { environmentVariables: encrypted(record) },
  });
}

async function setOrg(
  organizationId: string,
  actorUserId: string,
  record: Record<string, string>,
) {
  await replaceOrganizationEnvironmentVariables({
    db,
    organizationId,
    actorUserId,
    variables: Object.entries(record).map(([key, value]) => ({ key, value })),
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
  });
}

const TRACKER = {
  YOUTRACK_URL: "https://acme.youtrack.cloud",
  YOUTRACK_TOKEN: "perm:org-token",
};

describe("resolveTrackerConfig (organization → repository, never global)", () => {
  let ownerId: string;
  let orgId: string;

  beforeEach(async () => {
    ownerId = (await createTestUser({ db })).user.id;
    orgId = (await createTestOrganization({ db, userId: ownerId })).organization
      .id;
  });

  it("never reads the owner's personal global environment", async () => {
    await setGlobal(ownerId, TRACKER);
    expect(
      await resolveTrackerConfig({
        db,
        userId: ownerId,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBeNull();
  });

  it("resolves from the organization environment alone", async () => {
    await setOrg(orgId, ownerId, {
      ...TRACKER,
      YOUTRACK_PROJECTS: "ACME",
      AUTOMATA_TRACKER_WRITES: "live",
    });
    const { config, sources } = await resolveTrackerConfigWithSources({
      db,
      userId: ownerId,
      organizationId: orgId,
      repoFullName: REPO,
    });
    expect(config).toMatchObject({
      baseUrl: "https://acme.youtrack.cloud",
      token: "perm:org-token",
      projects: ["ACME"],
      writes: "live",
    });
    expect(sources).toEqual({
      YOUTRACK_URL: "organization",
      YOUTRACK_TOKEN: "organization",
      YOUTRACK_PROJECTS: "organization",
      AUTOMATA_TRACKER_WRITES: "organization",
    });
  });

  it("lets the repository override single keys", async () => {
    await setOrg(orgId, ownerId, { ...TRACKER, YOUTRACK_PROJECTS: "ACME" });
    await setRepo(ownerId, orgId, { YOUTRACK_PROJECTS: "WIDGET" });
    const { config, sources } = await resolveTrackerConfigWithSources({
      db,
      userId: ownerId,
      organizationId: orgId,
      repoFullName: REPO,
    });
    expect(config?.projects).toEqual(["WIDGET"]);
    expect(config?.token).toBe("perm:org-token");
    expect(sources.YOUTRACK_PROJECTS).toBe("repository");
    expect(sources.YOUTRACK_TOKEN).toBe("organization");
  });

  it("keeps two orgs of the same owner apart", async () => {
    const otherOrg = (
      await createTestOrganization({ db, userId: ownerId, name: "Globex" })
    ).organization.id;
    await setOrg(orgId, ownerId, TRACKER);
    await setOrg(otherOrg, ownerId, {
      YOUTRACK_URL: "https://globex.youtrack.cloud",
      YOUTRACK_TOKEN: "perm:globex",
    });
    const acme = await resolveTrackerConfig({
      db,
      userId: ownerId,
      organizationId: orgId,
      repoFullName: REPO,
    });
    const globex = await resolveTrackerConfig({
      db,
      userId: ownerId,
      organizationId: otherOrg,
      repoFullName: REPO,
    });
    expect(acme?.token).toBe("perm:org-token");
    expect(globex?.token).toBe("perm:globex");
  });

  it("reads only the repository without an organization", async () => {
    await setOrg(orgId, ownerId, TRACKER);
    expect(
      await resolveTrackerConfig({
        db,
        userId: ownerId,
        organizationId: null,
        repoFullName: REPO,
      }),
    ).toBeNull();
    await setRepo(ownerId, null, TRACKER);
    expect(
      (
        await resolveTrackerConfig({
          db,
          userId: ownerId,
          organizationId: null,
          repoFullName: REPO,
        })
      )?.token,
    ).toBe("perm:org-token");
  });

  it("skips the organization layer for a user who is not a member", async () => {
    await setOrg(orgId, ownerId, TRACKER);
    const outsider = (await createTestUser({ db })).user.id;
    expect(
      await resolveTrackerConfig({
        db,
        userId: outsider,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toBeNull();
    await addOrganizationMember({
      db,
      organizationId: orgId,
      userId: outsider,
      role: "member",
    });
    expect(
      (
        await resolveTrackerConfig({
          db,
          userId: outsider,
          organizationId: orgId,
          repoFullName: REPO,
        })
      )?.token,
    ).toBe("perm:org-token");
  });
});
