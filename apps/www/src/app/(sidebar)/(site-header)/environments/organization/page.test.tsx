import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "@terragon/env/apps-www";
import { Session } from "@terragon/shared";
import { session as sessionTable } from "@terragon/shared/db/schema";
import { replaceOrganizationEnvironmentVariables } from "@terragon/shared/model/organization-environment";
import { addOrganizationMember } from "@terragon/shared/model/organizations";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";

import { db } from "@/lib/db";
import { mockLoggedInUser } from "@/test-helpers/mock-next";

import OrganizationEnvironmentPage from "./page";

const SECRET = "perm:org-secret-value";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: vi.fn(() => "NOT_FOUND"),
  redirect: vi.fn(),
}));

async function signIn(session: Session, organizationId: string) {
  await mockLoggedInUser(session);
  await db
    .update(sessionTable)
    .set({ activeOrganizationId: organizationId })
    .where(eq(sessionTable.id, session.id));
}

describe("organization environment page", () => {
  let ownerSession: Session;
  let orgId: string;

  beforeEach(async () => {
    const owner = await createTestUser({ db });
    ownerSession = owner.session;
    orgId = (await createTestOrganization({ db, userId: owner.user.id }))
      .organization.id;
    await replaceOrganizationEnvironmentVariables({
      db,
      organizationId: orgId,
      actorUserId: owner.user.id,
      variables: [{ key: "YOUTRACK_TOKEN", value: SECRET }],
      encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    });
  });

  it("gives an owner values and the change history", async () => {
    await signIn(ownerSession, orgId);
    const element = (await OrganizationEnvironmentPage()) as {
      props: Record<string, unknown>;
    };
    expect(element.props).toMatchObject({
      canEdit: true,
      environmentVariables: [{ key: "YOUTRACK_TOKEN", value: SECRET }],
    });
    expect(element.props.events).toHaveLength(1);
  });

  it("gives a member key names only — no value in the props", async () => {
    const member = await createTestUser({ db });
    await addOrganizationMember({
      db,
      organizationId: orgId,
      userId: member.user.id,
      role: "member",
    });
    await signIn(member.session, orgId);
    const element = (await OrganizationEnvironmentPage()) as {
      props: Record<string, unknown>;
    };
    expect(element.props).toMatchObject({
      canEdit: false,
      keys: ["YOUTRACK_TOKEN"],
    });
    expect(JSON.stringify(element.props)).not.toContain(SECRET);
  });

  it("is not found for a non-member", async () => {
    const outsider = await createTestUser({ db });
    await signIn(outsider.session, orgId);
    expect(await OrganizationEnvironmentPage()).toBe("NOT_FOUND");
  });
});
