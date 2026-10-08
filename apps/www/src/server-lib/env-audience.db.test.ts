import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/apps-www";
import { encryptValue } from "@terragon/utils/encryption";
import {
  getOrCreateEnvironment,
  getOrCreateGlobalEnvironment,
  updateEnvironment,
} from "@terragon/shared/model/environments";
import { replaceOrganizationEnvironmentVariables } from "@terragon/shared/model/organization-environment";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { db } from "@/lib/db";

import {
  getExecutionPlaneLayeredEnvironmentVariables,
  getExecutionPlaneRunEnvironment,
} from "./env-audience";

const REPO = "acme/widgets";

function encrypted(record: Record<string, string>) {
  return Object.entries(record).map(([key, value]) => ({
    key,
    valueEncrypted: encryptValue(value, env.ENCRYPTION_MASTER_KEY),
  }));
}

describe("agent environment layering (global → organization → repository)", () => {
  let userId: string;
  let orgId: string;
  let repoEnvironmentId: string;

  async function setGlobal(record: Record<string, string>) {
    const environment = await getOrCreateGlobalEnvironment({ db, userId });
    await updateEnvironment({
      db,
      userId,
      environmentId: environment.id,
      updates: { environmentVariables: encrypted(record) },
    });
  }

  async function setRepo(record: Record<string, string>) {
    await updateEnvironment({
      db,
      userId,
      organizationId: orgId,
      environmentId: repoEnvironmentId,
      updates: { environmentVariables: encrypted(record) },
    });
  }

  async function setOrg(record: Record<string, string>) {
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgId,
      actorUserId: userId,
      variables: Object.entries(record).map(([key, value]) => ({ key, value })),
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    });
  }

  const run = () =>
    getExecutionPlaneRunEnvironment({
      db,
      userId,
      organizationId: orgId,
      repoFullName: REPO,
    });

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
    orgId = (await createTestOrganization({ db, userId, role: "member" }))
      .organization.id;
    repoEnvironmentId = (
      await getOrCreateEnvironment({
        db,
        userId,
        organizationId: orgId,
        repoFullName: REPO,
      })
    ).id;
  });

  it("overlays the layers in order, the repository winning", async () => {
    await setGlobal({ SHARED: "global", ONLY_GLOBAL: "g" });
    await setOrg({ SHARED: "org", ONLY_ORG: "o" });
    await setRepo({ ONLY_REPO: "r" });
    expect(await run()).toEqual({
      SHARED: "org",
      ONLY_GLOBAL: "g",
      ONLY_ORG: "o",
      ONLY_REPO: "r",
    });
    await setRepo({ SHARED: "repo" });
    expect((await run()).SHARED).toBe("repo");

    const sandbox = await getExecutionPlaneLayeredEnvironmentVariables({
      db,
      userId,
      organizationId: orgId,
      repoEnvironmentId,
    });
    expect(Object.fromEntries(sandbox.map((v) => [v.key, v.value]))).toEqual({
      SHARED: "repo",
      ONLY_GLOBAL: "g",
      ONLY_ORG: "o",
    });
  });

  it("never hands an organization's tracker token to an agent", async () => {
    await setOrg({
      YOUTRACK_URL: "https://acme.youtrack.cloud",
      YOUTRACK_TOKEN: "perm:org-token",
    });
    const runEnv = await run();
    expect(runEnv).toEqual({ YOUTRACK_URL: "https://acme.youtrack.cloud" });
    expect(JSON.stringify(runEnv)).not.toContain("perm:org-token");

    const sandbox = await getExecutionPlaneLayeredEnvironmentVariables({
      db,
      userId,
      organizationId: orgId,
      repoEnvironmentId,
    });
    expect(JSON.stringify(sandbox)).not.toContain("perm:org-token");
  });

  it("delivers an explicit organization agent token", async () => {
    await setOrg({
      YOUTRACK_TOKEN: "perm:org-token",
      YOUTRACK_AGENT_TOKEN: "perm:org-bot",
    });
    expect(await run()).toEqual({ YOUTRACK_AGENT_TOKEN: "perm:org-bot" });
  });

  it("keeps the personal tracker-token fallback for the user's own layers", async () => {
    await setOrg({ YOUTRACK_TOKEN: "perm:org-token" });
    await setRepo({ YOUTRACK_TOKEN: "perm:owner" });
    expect(await run()).toEqual({ YOUTRACK_AGENT_TOKEN: "perm:owner" });

    await setRepo({});
    await setGlobal({ YOUTRACK_TOKEN: "perm:personal" });
    expect(await run()).toEqual({ YOUTRACK_AGENT_TOKEN: "perm:personal" });
  });

  it("drops the organization layer once the user is not a member", async () => {
    await setOrg({ ONLY_ORG: "o" });
    const outsider = (await createTestUser({ db })).user.id;
    expect(
      await getExecutionPlaneRunEnvironment({
        db,
        userId: outsider,
        organizationId: orgId,
        repoFullName: REPO,
      }),
    ).toEqual({});
  });
});
