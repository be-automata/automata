import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser } from "./test-helpers";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { User } from "../db/types";
import * as schema from "../db/schema";
import {
  getSlackAccounts,
  getSlackAccountForSlackUserId,
  getSlackAccountForTeam,
  getSlackSettingsForTeam,
  upsertSlackAccount,
  deleteSlackAccount,
  getSlackInstallationForTeam,
  upsertSlackInstallation,
  upsertSlackSettings,
  SlackWorkspaceBoundElsewhereError,
} from "./slack";
import { createOrganization } from "./organizations";
import { nanoid } from "nanoid/non-secure";

const db = createDb(env.DATABASE_URL!);

describe("slack", () => {
  let user: User;
  let otherUser: User;
  const teamId = `T${nanoid(10)}`;
  const otherTeamId = `T${nanoid(10)}`;
  const slackUserId = `U${nanoid(10)}`;
  const otherSlackUserId = `U${nanoid(10)}`;

  beforeEach(async () => {
    // Clean up slack tables
    await db.delete(schema.slackSettings);
    await db.delete(schema.slackAccount);
    await db.delete(schema.slackInstallation);

    // Create test users
    const testUserAndAccount = await createTestUser({ db });
    user = testUserAndAccount.user;

    const otherTestUserAndAccount = await createTestUser({ db });
    otherUser = otherTestUserAndAccount.user;
  });

  describe("getSlackAccounts", () => {
    it("should return empty array when user has no slack accounts", async () => {
      const accounts = await getSlackAccounts({ db, userId: user.id });
      expect(accounts).toEqual([]);
    });

    it("should return slack accounts with installation and settings", async () => {
      // Create slack account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Create slack installation
      await db.insert(schema.slackInstallation).values({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });

      // Create slack settings
      await db.insert(schema.slackSettings).values({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      const accounts = await getSlackAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
        installation: expect.objectContaining({
          teamId,
          botUserId: "B123",
        }),
        settings: expect.objectContaining({
          userId: user.id,
          teamId,
          defaultRepoFullName: "test/repo",
          defaultModel: "sonnet",
        }),
      });
    });

    it("should only return accounts for the specified user", async () => {
      // Create account for user
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "User Team",
        slackTeamDomain: "user-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Create account for other user
      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId: otherTeamId,
        slackUserId: otherSlackUserId,
        slackTeamName: "Other Team",
        slackTeamDomain: "other-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const accounts = await getSlackAccounts({ db, userId: user.id });

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.teamId).toBe(teamId);
    });
  });

  describe("getSlackAccountForSlackUserId", () => {
    it("should return null when account doesn't exist", async () => {
      const account = await getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId,
      });
      expect(account).toBeNull();
    });

    it("should return the correct slack account", async () => {
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const account = await getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId,
      });

      expect(account).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });
    });

    it("should return correct account for specific team", async () => {
      // Create accounts for different slack users in same team
      const slackUserId1 = `U${nanoid(10)}`;
      const slackUserId2 = `U${nanoid(10)}`;

      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId: slackUserId1,
        slackTeamName: "Team 1",
        slackTeamDomain: "team-1",
        accessTokenEncrypted: "encrypted-token",
      });

      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId,
        slackUserId: slackUserId2,
        slackTeamName: "Team 1",
        slackTeamDomain: "team-1",
        accessTokenEncrypted: "encrypted-token-2",
      });

      const account = await getSlackAccountForSlackUserId({
        db,
        teamId,
        slackUserId: slackUserId1,
      });

      expect(account?.userId).toBe(user.id);
      expect(account?.slackTeamName).toBe("Team 1");
    });
  });

  describe("getSlackAccountForTeam", () => {
    it("should return null when account doesn't exist", async () => {
      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(account).toBeNull();
    });

    it("should return the correct slack account for user and team", async () => {
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });
    });

    it("should only return account for the specified user", async () => {
      // Create account for different user, same team
      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId,
        slackUserId: otherSlackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account).toBeNull();
    });
  });

  describe("getSlackSettingsForTeam", () => {
    it("should return null when settings don't exist", async () => {
      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(settings).toBeNull();
    });

    it("should return the correct slack settings", async () => {
      await db.insert(schema.slackSettings).values({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings).toMatchObject({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });
    });

    it("should only return settings for the specified user", async () => {
      // Create settings for different user, same team
      await db.insert(schema.slackSettings).values({
        userId: otherUser.id,
        teamId,
        defaultRepoFullName: "other/repo",
        defaultModel: "opus",
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings).toBeNull();
    });
  });

  describe("upsertSlackAccount", () => {
    it("should create a new slack account", async () => {
      await upsertSlackAccount({
        db,
        userId: user.id,
        teamId,
        account: {
          slackUserId,
          slackTeamName: "New Team",
          slackTeamDomain: "new-team",
          accessTokenEncrypted: "encrypted-token",
        },
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account).toMatchObject({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "New Team",
        slackTeamDomain: "new-team",
        accessTokenEncrypted: "encrypted-token",
      });
    });

    it("should update an existing slack account", async () => {
      // Create initial account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Old Team",
        slackTeamDomain: "old-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Update the account
      await upsertSlackAccount({
        db,
        userId: user.id,
        teamId,
        account: {
          slackUserId: `U${nanoid(10)}`,
          slackTeamName: "Updated Team",
          slackTeamDomain: "updated-team",
          accessTokenEncrypted: "encrypted-updated-token",
        },
      });

      const account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(account?.slackTeamName).toBe("Updated Team");
      expect(account?.slackTeamDomain).toBe("updated-team");
      expect(account?.accessTokenEncrypted).toBe("encrypted-updated-token");
    });
  });

  describe("deleteSlackAccount", () => {
    it("should delete an existing slack account", async () => {
      // Create account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Verify it exists
      let account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(account).not.toBeNull();

      // Delete the account
      await deleteSlackAccount({
        db,
        userId: user.id,
        teamId,
      });

      // Verify it's deleted
      account = await getSlackAccountForTeam({
        db,
        userId: user.id,
        teamId,
      });
      expect(account).toBeNull();
    });

    it("should not affect other users' accounts", async () => {
      // Create accounts for both users
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "User Team",
        slackTeamDomain: "user-team",
        accessTokenEncrypted: "encrypted-token",
      });

      await db.insert(schema.slackAccount).values({
        userId: otherUser.id,
        teamId,
        slackUserId: otherSlackUserId,
        slackTeamName: "Other User Team",
        slackTeamDomain: "other-user-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Delete first user's account
      await deleteSlackAccount({
        db,
        userId: user.id,
        teamId,
      });

      // Other user's account should still exist
      const otherAccount = await getSlackAccountForTeam({
        db,
        userId: otherUser.id,
        teamId,
      });
      expect(otherAccount).not.toBeNull();
    });
  });

  describe("getSlackInstallationForTeam", () => {
    it("should return null when installation doesn't exist", async () => {
      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });
      expect(installation).toBeNull();
    });

    it("should return the correct slack installation", async () => {
      await db.insert(schema.slackInstallation).values({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });

      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });

      expect(installation).toMatchObject({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });
    });
  });

  describe("upsertSlackInstallation", () => {
    it("should throw error if user is not part of the team", async () => {
      await expect(
        upsertSlackInstallation({
          db,
          userId: user.id,
          teamId,
          installation: {
            teamName: "Test Team",
            botUserId: "B123",
            botAccessTokenEncrypted: "encrypted-xoxb-123",
            scope: "app_mentions:read,chat:write",
            appId: "A123",
          },
        }),
      ).rejects.toThrow("User is not part of this team");
    });

    it("should create a new slack installation", async () => {
      // First create a slack account for the user
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Now create installation
      await upsertSlackInstallation({
        db,
        userId: user.id,
        teamId,
        installation: {
          teamName: "Test Team",
          botUserId: "B123",
          botAccessTokenEncrypted: "encrypted-xoxb-123",
          scope: "app_mentions:read,chat:write",
          appId: "A123",
        },
      });

      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });

      expect(installation).toMatchObject({
        teamId,
        teamName: "Test Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-123",
        scope: "app_mentions:read,chat:write",
        appId: "A123",
      });
    });

    it("should update an existing slack installation", async () => {
      // Create slack account
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });

      // Create initial installation
      await db.insert(schema.slackInstallation).values({
        teamId,
        teamName: "Old Team",
        botUserId: "B123",
        botAccessTokenEncrypted: "encrypted-xoxb-old",
        scope: "app_mentions:read",
        appId: "A123",
      });

      // Update the installation
      await upsertSlackInstallation({
        db,
        userId: user.id,
        teamId,
        installation: {
          teamName: "Updated Team",
          botUserId: "B456",
          botAccessTokenEncrypted: "encrypted-xoxb-new",
          scope: "app_mentions:read,chat:write,users:read",
          appId: "A456",
        },
      });

      const installation = await getSlackInstallationForTeam({
        db,
        teamId,
      });

      expect(installation?.teamName).toBe("Updated Team");
      expect(installation?.botUserId).toBe("B456");
      expect(installation?.botAccessTokenEncrypted).toBe("encrypted-xoxb-new");
    });
  });

  describe("upsertSlackInstallation org binding", () => {
    const install = (organizationId: string | null) =>
      upsertSlackInstallation({
        db,
        userId: user.id,
        teamId,
        installation: {
          organizationId,
          teamName: "Test Team",
          botUserId: "B123",
          botAccessTokenEncrypted: "encrypted-xoxb-123",
          scope: "app_mentions:read",
          appId: "A123",
        },
      });

    beforeEach(async () => {
      await db.insert(schema.slackAccount).values({
        userId: user.id,
        teamId,
        slackUserId,
        slackTeamName: "Test Team",
        slackTeamDomain: "test-team",
        accessTokenEncrypted: "encrypted-token",
      });
    });

    it("binds an unbound workspace to the installing org", async () => {
      const org = await createOrganization({
        db,
        name: "Acme",
        slug: `acme-${nanoid(8).toLowerCase()}`,
      });
      await install(null);
      await install(org.id);
      const installation = await getSlackInstallationForTeam({ db, teamId });
      expect(installation?.organizationId).toBe(org.id);
    });

    it("lets the same org reinstall", async () => {
      const org = await createOrganization({
        db,
        name: "Acme",
        slug: `acme-${nanoid(8).toLowerCase()}`,
      });
      await install(org.id);
      await expect(install(org.id)).resolves.toBeUndefined();
    });

    it("refuses to move a workspace another org holds", async () => {
      const [org, otherOrg] = await Promise.all([
        createOrganization({
          db,
          name: "Acme",
          slug: `acme-${nanoid(8).toLowerCase()}`,
        }),
        createOrganization({
          db,
          name: "Other",
          slug: `other-${nanoid(8).toLowerCase()}`,
        }),
      ]);
      await install(org.id);
      await expect(install(otherOrg.id)).rejects.toBeInstanceOf(
        SlackWorkspaceBoundElsewhereError,
      );
      await expect(install(null)).rejects.toBeInstanceOf(
        SlackWorkspaceBoundElsewhereError,
      );
      const installation = await getSlackInstallationForTeam({ db, teamId });
      expect(installation?.organizationId).toBe(org.id);
    });
  });

  describe("upsertSlackSettings", () => {
    it("should create new slack settings", async () => {
      await upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: {
          defaultRepoFullName: "test/repo",
          defaultModel: "sonnet",
        },
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings).toMatchObject({
        userId: user.id,
        teamId,
        defaultRepoFullName: "test/repo",
        defaultModel: "sonnet",
      });
    });

    it("should update existing slack settings", async () => {
      // Create initial settings
      await db.insert(schema.slackSettings).values({
        userId: user.id,
        teamId,
        defaultRepoFullName: "old/repo",
        defaultModel: "opus",
      });

      // Update the settings
      await upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: {
          defaultRepoFullName: "new/repo",
          defaultModel: "sonnet",
        },
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings?.defaultRepoFullName).toBe("new/repo");
      expect(settings?.defaultModel).toBe("sonnet");
    });

    it("should handle settings with null values", async () => {
      await upsertSlackSettings({
        db,
        userId: user.id,
        teamId,
        settings: {
          defaultRepoFullName: null,
          defaultModel: "opus",
        },
      });

      const settings = await getSlackSettingsForTeam({
        db,
        userId: user.id,
        teamId,
      });

      expect(settings?.defaultRepoFullName).toBeNull();
      expect(settings?.defaultModel).toBe("opus");
    });
  });
});
