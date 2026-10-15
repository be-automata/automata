import { describe, it, vi, beforeEach, expect } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { Session, User } from "@terragon/shared";
import {
  createOrganization,
  addOrganizationMember,
} from "@terragon/shared/model/organizations";
import {
  bindGithubInstallationToOrg,
  getGithubInstallation,
} from "@terragon/shared/model/github-installation";
import { session as sessionTable } from "@terragon/shared/db/schema";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { getOctokitForUser } from "@/lib/github";
import { unwrapResult } from "@/lib/server-actions";
import {
  bindGithubInstallation,
  getGithubInstallations,
} from "./bind-github-installation";

function githubError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function makeOctokit(
  installations: Array<{ id: number; login: string; type: string }>,
  {
    orgMembership = { state: "active", role: "admin" },
    viewerLogin = "acme-owner",
  }: {
    // An Error makes the membership lookup reject with it.
    orgMembership?: { state: string; role: string } | Error;
    viewerLogin?: string;
  } = {},
) {
  const listed = installations.map(({ id, login, type }) => ({
    id,
    account: { login, type },
  }));
  return {
    rest: {
      apps: {
        listInstallationsForAuthenticatedUser: vi.fn(),
      },
      orgs: {
        getMembershipForAuthenticatedUser: vi.fn(async () => {
          if (orgMembership instanceof Error) {
            throw orgMembership;
          }
          return { data: orgMembership };
        }),
      },
      users: {
        getAuthenticated: vi.fn(async () => ({
          data: { login: viewerLogin },
        })),
      },
    },
    paginate: vi.fn().mockResolvedValue(listed),
  };
}

async function createOrg(name: string) {
  return await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
}

async function setActiveOrg(sessionId: string, orgId: string | null) {
  await db
    .update(sessionTable)
    .set({ activeOrganizationId: orgId })
    .where(eq(sessionTable.id, sessionId));
}

describe("bindGithubInstallation", () => {
  let user: User;
  let session: Session;
  let orgA: string;
  let installationId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    const a = await createOrg("Acme");
    orgA = a.id;
    await addOrganizationMember({
      db,
      organizationId: orgA,
      userId: user.id,
      role: "owner",
    });
    await setActiveOrg(session.id, orgA);
    // Unique per test: installationId is globally unique in the table.
    installationId = String(Math.floor(Math.random() * 1_000_000_000));
    vi.mocked(getOctokitForUser).mockResolvedValue(
      makeOctokit([
        { id: Number(installationId), login: "acme", type: "Organization" },
      ]) as any,
    );
    await mockLoggedInUser(session);
  });

  it("binds a new installation to the active org with the default mode", async () => {
    const result = unwrapResult(
      await bindGithubInstallation({
        installationId,
        expectedOrganizationId: orgA,
      }),
    );
    expect(result.organizationId).toBe(orgA);
    expect(result.mode).toBe("shadow");
    const row = await getGithubInstallation({ db, installationId });
    expect(row?.accountLogin).toBe("acme");
    expect(row?.accountType).toBe("Organization");
  });

  it("refuses when the session org is not the one the page showed", async () => {
    const other = await createOrg("Other");
    const result = await bindGithubInstallation({
      installationId,
      expectedOrganizationId: other.id,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/active organization changed/);
    expect(await getGithubInstallation({ db, installationId })).toBeUndefined();
  });

  it("refuses without an active org", async () => {
    await setActiveOrg(session.id, null);
    const result = await bindGithubInstallation({
      installationId,
      expectedOrganizationId: null,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/Select an organization/);
  });

  it("refuses a plain member of the active org", async () => {
    const memberOrg = await createOrg("Members");
    await addOrganizationMember({
      db,
      organizationId: memberOrg.id,
      userId: user.id,
      role: "member",
    });
    await setActiveOrg(session.id, memberOrg.id);
    const result = await bindGithubInstallation({
      installationId,
      expectedOrganizationId: memberOrg.id,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/owners and admins/);
  });

  it("refuses when the user has no usable GitHub token", async () => {
    vi.mocked(getOctokitForUser).mockResolvedValue(null);
    const result = await bindGithubInstallation({
      installationId,
      expectedOrganizationId: orgA,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/Reconnect GitHub/);
  });

  it("refuses an installation the user's GitHub token cannot see", async () => {
    const result = await bindGithubInstallation({
      installationId: `${installationId}9`,
      expectedOrganizationId: orgA,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/not visible to your GitHub account/);
  });

  describe("GitHub authority over the installation's account", () => {
    function mockGithub(
      installation: { login: string; type: string },
      options: Parameters<typeof makeOctokit>[1],
    ) {
      const octokit = makeOctokit(
        [{ id: Number(installationId), ...installation }],
        options,
      );
      vi.mocked(getOctokitForUser).mockResolvedValue(octokit as any);
      return octokit;
    }

    async function bind() {
      return await bindGithubInstallation({
        installationId,
        expectedOrganizationId: orgA,
      });
    }

    it("lets an active admin of the GitHub organization bind it, checking live", async () => {
      const octokit = mockGithub(
        { login: "acme", type: "Organization" },
        { orgMembership: { state: "active", role: "admin" } },
      );
      const result = unwrapResult(await bind());
      expect(result.organizationId).toBe(orgA);
      expect(
        octokit.rest.orgs.getMembershipForAuthenticatedUser,
      ).toHaveBeenCalledWith({ org: "acme" });
    });

    it("refuses a read-only collaborator (an active plain member)", async () => {
      mockGithub(
        { login: "acme", type: "Organization" },
        { orgMembership: { state: "active", role: "member" } },
      );
      const result = await bind();
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(
        /Only an admin of the acme GitHub organization/,
      );
      expect(
        await getGithubInstallation({ db, installationId }),
      ).toBeUndefined();
    });

    it("refuses an admin whose membership is still pending", async () => {
      mockGithub(
        { login: "acme", type: "Organization" },
        { orgMembership: { state: "pending", role: "admin" } },
      );
      const result = await bind();
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/Only an admin of the acme/);
      expect(
        await getGithubInstallation({ db, installationId }),
      ).toBeUndefined();
    });

    it.each([403, 404])(
      "fails closed when GitHub answers the membership lookup with %i",
      async (status) => {
        mockGithub(
          { login: "acme", type: "Organization" },
          { orgMembership: githubError(status) },
        );
        const result = await bind();
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/Only an admin of the acme/);
        expect(
          await getGithubInstallation({ db, installationId }),
        ).toBeUndefined();
      },
    );

    it("fails closed when GitHub errors on the membership lookup", async () => {
      mockGithub(
        { login: "acme", type: "Organization" },
        { orgMembership: githubError(502) },
      );
      const result = await bind();
      expect(result.success).toBe(false);
      expect(
        await getGithubInstallation({ db, installationId }),
      ).toBeUndefined();
    });

    it("lets a user bind their own account's installation (login case-insensitive)", async () => {
      const octokit = mockGithub(
        { login: "Octo-Cat", type: "User" },
        { viewerLogin: "octo-cat" },
      );
      const result = unwrapResult(await bind());
      expect(result.organizationId).toBe(orgA);
      expect(octokit.rest.users.getAuthenticated).toHaveBeenCalled();
      expect(
        octokit.rest.orgs.getMembershipForAuthenticatedUser,
      ).not.toHaveBeenCalled();
    });

    it("refuses another user's personal installation", async () => {
      mockGithub(
        { login: "someone-else", type: "User" },
        { viewerLogin: "octo-cat" },
      );
      const result = await bind();
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(
        /belongs to the GitHub user someone-else/,
      );
      expect(
        await getGithubInstallation({ db, installationId }),
      ).toBeUndefined();
    });

    it("refuses an enterprise installation", async () => {
      mockGithub({ login: "big-enterprise", type: "Enterprise" }, {});
      const result = await bind();
      expect(result.success).toBe(false);
      expect(result.errorMessage).toMatch(/enterprise-level/);
    });
  });

  it("refuses to move a binding from an org the caller is not a member of", async () => {
    const elsewhere = await createOrg("Elsewhere");
    await bindGithubInstallationToOrg({
      db,
      installationId,
      organizationId: elsewhere.id,
    });
    const result = await bindGithubInstallation({
      installationId,
      expectedOrganizationId: orgA,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/bound to another organization/);
    const row = await getGithubInstallation({ db, installationId });
    expect(row?.organizationId).toBe(elsewhere.id);
  });

  it("refuses to move a binding from an org where the caller is only a member", async () => {
    const elsewhere = await createOrg("Elsewhere");
    await addOrganizationMember({
      db,
      organizationId: elsewhere.id,
      userId: user.id,
      role: "member",
    });
    await bindGithubInstallationToOrg({
      db,
      installationId,
      organizationId: elsewhere.id,
    });
    const result = await bindGithubInstallation({
      installationId,
      expectedOrganizationId: orgA,
    });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/bound to another organization/);
  });

  it("moves a binding when the caller administers both orgs, keeping its mode", async () => {
    const elsewhere = await createOrg("Elsewhere");
    await addOrganizationMember({
      db,
      organizationId: elsewhere.id,
      userId: user.id,
      role: "admin",
    });
    await bindGithubInstallationToOrg({
      db,
      installationId,
      organizationId: elsewhere.id,
      mode: "active",
    });
    const result = unwrapResult(
      await bindGithubInstallation({
        installationId,
        expectedOrganizationId: orgA,
      }),
    );
    expect(result.organizationId).toBe(orgA);
    expect(result.mode).toBe("active");
  });
});

describe("getGithubInstallations", () => {
  let session: Session;
  let user: User;

  beforeEach(async () => {
    vi.clearAllMocks();
    const created = await createTestUser({ db });
    user = created.user;
    session = created.session;
    await mockLoggedInUser(session);
  });

  it("reports each visible installation's binding and mode", async () => {
    const mine = await createOrg("Acme");
    await addOrganizationMember({
      db,
      organizationId: mine.id,
      userId: user.id,
      role: "owner",
    });
    const notMine = await createOrg("Customer");
    const base = Math.floor(Math.random() * 1_000_000_000);
    const [boundHere, boundElsewhere, unbound] = [base, base + 1, base + 2];
    await bindGithubInstallationToOrg({
      db,
      installationId: boundHere,
      organizationId: mine.id,
      mode: "active",
    });
    await bindGithubInstallationToOrg({
      db,
      installationId: boundElsewhere,
      organizationId: notMine.id,
    });
    vi.mocked(getOctokitForUser).mockResolvedValue(
      makeOctokit([
        { id: boundHere, login: "acme", type: "Organization" },
        { id: boundElsewhere, login: "customer-org", type: "Organization" },
        { id: unbound, login: "someone", type: "User" },
      ]) as any,
    );

    const result = unwrapResult(await getGithubInstallations());

    expect(result.installations).toEqual([
      {
        installationId: String(boundHere),
        accountLogin: "acme",
        accountType: "Organization",
        binding: {
          kind: "organization",
          organization: { id: mine.id, name: "Acme", logo: null },
        },
        mode: "active",
      },
      {
        installationId: String(boundElsewhere),
        accountLogin: "customer-org",
        accountType: "Organization",
        binding: { kind: "other-organization" },
        mode: "shadow",
      },
      {
        installationId: String(unbound),
        accountLogin: "someone",
        accountType: "User",
        binding: { kind: "unbound" },
        mode: null,
      },
    ]);
  });

  it("returns githubTokenMissing without a usable GitHub token", async () => {
    vi.mocked(getOctokitForUser).mockResolvedValue(null);
    const result = unwrapResult(await getGithubInstallations());
    expect(result).toEqual({ installations: [], githubTokenMissing: true });
  });
});
