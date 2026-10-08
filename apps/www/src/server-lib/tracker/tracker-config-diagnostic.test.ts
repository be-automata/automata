import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/apps-www";
import { encryptValue } from "@terragon/utils/encryption";
import {
  getOrCreateEnvironment,
  updateEnvironment,
} from "@terragon/shared/model/environments";
import { replaceOrganizationEnvironmentVariables } from "@terragon/shared/model/organization-environment";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { db } from "@/lib/db";

import { diagnoseTrackerConfig } from "./tracker-config-diagnostic";

const REPO = "acme/widgets";
const TOKEN = "perm:diagnostic-secret";

describe("diagnoseTrackerConfig", () => {
  let ownerId: string;
  let orgId: string;
  let slug: string;

  beforeEach(async () => {
    ownerId = (await createTestUser({ db })).user.id;
    const { organization } = await createTestOrganization({
      db,
      userId: ownerId,
    });
    orgId = organization.id;
    slug = organization.slug;
  });

  it("reports an unknown org", async () => {
    expect(
      await diagnoseTrackerConfig({
        db,
        organizationSlug: "no-such-org",
        repoFullName: REPO,
      }),
    ).toEqual({ status: "org_not_found" });
  });

  it("reports sources and never the token", async () => {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgId,
      actorUserId: ownerId,
      variables: [
        { key: "YOUTRACK_URL", value: "https://acme.youtrack.cloud" },
        { key: "YOUTRACK_TOKEN", value: TOKEN },
        { key: "YOUTRACK_PROJECTS", value: "ACME" },
      ],
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    });
    const result = await diagnoseTrackerConfig({
      db,
      organizationSlug: slug,
      repoFullName: REPO,
    });
    expect(result).toEqual({
      status: "configured",
      baseUrl: "https://acme.youtrack.cloud",
      projects: ["ACME"],
      writes: "off",
      sources: {
        YOUTRACK_URL: "organization",
        YOUTRACK_TOKEN: "organization",
        YOUTRACK_PROJECTS: "organization",
      },
      mixedLayers: false,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("warns when URL and token come from different layers", async () => {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgId,
      actorUserId: ownerId,
      variables: [
        { key: "YOUTRACK_URL", value: "https://acme.youtrack.cloud" },
      ],
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    });
    const repoEnvironment = await getOrCreateEnvironment({
      db,
      userId: ownerId,
      organizationId: orgId,
      repoFullName: REPO,
    });
    await updateEnvironment({
      db,
      userId: ownerId,
      organizationId: orgId,
      environmentId: repoEnvironment.id,
      updates: {
        environmentVariables: [
          {
            key: "YOUTRACK_TOKEN",
            valueEncrypted: encryptValue(TOKEN, env.ENCRYPTION_MASTER_KEY),
          },
        ],
      },
    });
    const result = await diagnoseTrackerConfig({
      db,
      organizationSlug: slug,
      repoFullName: REPO,
    });
    expect(result).toMatchObject({ status: "configured", mixedLayers: true });
  });

  it("reports an invalid URL without echoing it", async () => {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgId,
      actorUserId: ownerId,
      variables: [
        { key: "YOUTRACK_URL", value: "http://10.0.0.1" },
        { key: "YOUTRACK_TOKEN", value: TOKEN },
      ],
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    });
    const result = await diagnoseTrackerConfig({
      db,
      organizationSlug: slug,
      repoFullName: REPO,
    });
    expect(result.status).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("10.0.0.1");
  });
});
