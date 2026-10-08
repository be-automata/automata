import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "@terragon/env/apps-www";
import { Session } from "@terragon/shared";
import { session as sessionTable } from "@terragon/shared/db/schema";
import {
  getDecryptedOrganizationEnvironmentVariables,
  listOrganizationEnvironmentEvents,
} from "@terragon/shared/model/organization-environment";
import { addOrganizationMember } from "@terragon/shared/model/organizations";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { db } from "@/lib/db";
import { getPostHogServer } from "@/lib/posthog-server";
import { mockLoggedInUser } from "@/test-helpers/mock-next";

import { updateOrganizationEnvironmentVariables } from "./organization-environment-variables";

const SECRET = "perm:very-secret-token";

async function activate(session: Session, organizationId: string | null) {
  await db
    .update(sessionTable)
    .set({ activeOrganizationId: organizationId })
    .where(eq(sessionTable.id, session.id));
}

async function orgValues(organizationId: string) {
  return await getDecryptedOrganizationEnvironmentVariables({
    db,
    organizationId,
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
  });
}

describe("updateOrganizationEnvironmentVariables", () => {
  let ownerSession: Session;
  let ownerId: string;
  let orgId: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const owner = await createTestUser({ db });
    ownerId = owner.user.id;
    ownerSession = owner.session;
    orgId = (await createTestOrganization({ db, userId: ownerId })).organization
      .id;
  });

  it("lets an owner save, records the keys, and never logs a value", async () => {
    const log = vi.spyOn(console, "log");
    const capture = vi.spyOn(getPostHogServer(), "capture");
    await mockLoggedInUser(ownerSession);
    await activate(ownerSession, orgId);

    const result = await updateOrganizationEnvironmentVariables({
      variables: [
        { key: "YOUTRACK_URL", value: "https://acme.youtrack.cloud" },
        { key: "YOUTRACK_TOKEN", value: SECRET },
      ],
    });
    expect(result).toEqual({ success: true, data: { success: true } });
    expect(await orgValues(orgId)).toEqual([
      { key: "YOUTRACK_URL", value: "https://acme.youtrack.cloud" },
      { key: "YOUTRACK_TOKEN", value: SECRET },
    ]);
    const [event] = await listOrganizationEnvironmentEvents({
      db,
      organizationId: orgId,
    });
    expect(event).toMatchObject({
      actorUserId: ownerId,
      addedKeys: ["YOUTRACK_TOKEN", "YOUTRACK_URL"],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(capture.mock.calls)).not.toContain(SECRET);
    expect(log).toHaveBeenCalledWith(
      "[org-env] updated",
      expect.objectContaining({ organizationId: orgId }),
    );
  });

  it("lets an admin save", async () => {
    const admin = await createTestUser({ db });
    await addOrganizationMember({
      db,
      organizationId: orgId,
      userId: admin.user.id,
      role: "admin",
    });
    await mockLoggedInUser(admin.session);
    await activate(admin.session, orgId);
    const result = await updateOrganizationEnvironmentVariables({
      variables: [{ key: "A", value: "1" }],
    });
    expect(result.success).toBe(true);
    expect(await orgValues(orgId)).toEqual([{ key: "A", value: "1" }]);
  });

  it("refuses a member and writes nothing", async () => {
    const member = await createTestUser({ db });
    await addOrganizationMember({
      db,
      organizationId: orgId,
      userId: member.user.id,
      role: "member",
    });
    await mockLoggedInUser(member.session);
    await activate(member.session, orgId);
    const result = await updateOrganizationEnvironmentVariables({
      variables: [{ key: "A", value: "1" }],
    });
    expect(result).toEqual({
      success: false,
      errorMessage:
        "Only organization owners and admins can edit organization variables",
    });
    expect(await orgValues(orgId)).toEqual([]);
  });

  it("refuses a non-member whose session points at the org", async () => {
    const outsider = await createTestUser({ db });
    await mockLoggedInUser(outsider.session);
    await activate(outsider.session, orgId);
    const result = await updateOrganizationEnvironmentVariables({
      variables: [{ key: "A", value: "1" }],
    });
    expect(result.success).toBe(false);
    expect(await orgValues(orgId)).toEqual([]);
  });

  it("refuses without an active organization", async () => {
    await mockLoggedInUser(ownerSession);
    await activate(ownerSession, null);
    expect(
      await updateOrganizationEnvironmentVariables({
        variables: [{ key: "A", value: "1" }],
      }),
    ).toEqual({ success: false, errorMessage: "No active organization" });
  });

  it("writes to the session's org, ignoring an org id in the arguments", async () => {
    const otherOrg = (
      await createTestOrganization({ db, userId: ownerId, name: "Globex" })
    ).organization.id;
    await mockLoggedInUser(ownerSession);
    await activate(ownerSession, orgId);
    await updateOrganizationEnvironmentVariables({
      variables: [{ key: "A", value: "1" }],
      organizationId: otherOrg,
    } as unknown as Parameters<
      typeof updateOrganizationEnvironmentVariables
    >[0]);
    expect(await orgValues(orgId)).toEqual([{ key: "A", value: "1" }]);
    expect(await orgValues(otherOrg)).toEqual([]);
  });

  it("rejects invalid and duplicate keys", async () => {
    await mockLoggedInUser(ownerSession);
    await activate(ownerSession, orgId);
    expect(
      (
        await updateOrganizationEnvironmentVariables({
          variables: [{ key: "1BAD", value: "x" }],
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await updateOrganizationEnvironmentVariables({
          variables: [
            { key: "A", value: "1" },
            { key: "A", value: "2" },
          ],
        })
      ).success,
    ).toBe(false);
    expect(await orgValues(orgId)).toEqual([]);
  });
});
