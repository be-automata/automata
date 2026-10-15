import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@terragon/shared/db/schema";
import { and, eq } from "drizzle-orm";
import {
  adminOnly,
  getActiveOrganizationMembershipOrNull,
  getTenantContextOrNull,
  userOnlyAction,
  adminOnlyAction,
  getAdminUserOrThrow,
  getUserIdOrNull,
  getUserInfoOrNull,
  validInternalRequestOrThrow,
  requireExpectedActiveMembership,
} from "@/lib/auth-server";
import {
  createTestOrganization,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import {
  mockLoggedInUser,
  mockLoggedOutUser,
  mockNextHeaders,
} from "@/test-helpers/mock-next";
import { env } from "@terragon/env/apps-www";
import { UserFacingError } from "./server-actions";

describe("auth-server", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  describe("userOnlyAction", () => {
    it("should set userOnly and wrappedServerAction properties for testing", () => {
      const mockCallback = vi.fn();
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      expect(wrappedCallback.userOnly).toBe(true);
      expect(wrappedCallback.wrappedServerAction).toBe(true);
    });

    it("should return an error when no user is logged in", async () => {
      await mockLoggedOutUser();
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Unauthorized");
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should return the data when a user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(true);
      expect(result.data).toBe("data");
      expect(mockCallback).toHaveBeenCalledWith(user.id, "arg1", "arg2");
    });

    it("should return an error when the callback throws an error", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi
        .fn()
        .mockRejectedValue(new UserFacingError("test error"));
      const wrappedCallback = userOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("test error");
      expect(mockCallback).toHaveBeenCalledWith(user.id, "arg1", "arg2");
    });
  });

  describe("adminOnly", () => {
    it("should set adminOnly property for testing", () => {
      const mockCallback = vi.fn();
      const wrappedCallback = adminOnly(mockCallback);
      expect(wrappedCallback.adminOnly).toBe(true);
    });

    it("should reject non-admin users", async () => {
      const { session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnly(mockCallback);
      await expect(wrappedCallback("arg1", "arg2")).rejects.toThrow(
        "Unauthorized",
      );
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should reject when no user is logged in", async () => {
      await mockLoggedOutUser();
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnly(mockCallback);
      await expect(wrappedCallback("arg1", "arg2")).rejects.toThrow(
        "Unauthorized",
      );
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should allow admin users to call the function", async () => {
      const { user, session } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, user.id));
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnly(mockCallback);
      const result = await wrappedCallback("arg1", "arg2");
      expect(result).toBe("success");
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({ id: user.id, role: "admin" }),
        "arg1",
        "arg2",
      );
    });
  });

  describe("adminOnlyAction", () => {
    it("should set adminOnly and wrappedServerAction properties for testing", () => {
      const mockCallback = vi.fn();
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      expect(wrappedCallback.adminOnly).toBe(true);
      expect(wrappedCallback.wrappedServerAction).toBe(true);
    });

    it("should return an error when no admin user is logged in", async () => {
      await mockLoggedOutUser();
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Unauthorized");
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should reject non-admin users", async () => {
      const { session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("success");
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(false);
      expect(result.errorMessage).toBe("Unauthorized");
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("should return the data when a admin user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, user.id));
      await mockLoggedInUser(session);
      const mockCallback = vi.fn().mockResolvedValue("data");
      const wrappedCallback = adminOnlyAction(mockCallback, {
        defaultErrorMessage: "Unauthorized",
      });
      const result = await wrappedCallback("arg1", "arg2");
      expect(result.success).toBe(true);
      expect(result.data).toBe("data");
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({ id: user.id, role: "admin" }),
        "arg1",
        "arg2",
      );
    });
  });

  describe("getAdminUserOrThrow", () => {
    it("should throw an error when no admin user is logged in", async () => {
      await mockLoggedOutUser();
      await expect(getAdminUserOrThrow()).rejects.toThrow("Unauthorized");
    });

    it("should return the admin user when a admin user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await db
        .update(schema.user)
        .set({ role: "admin" })
        .where(eq(schema.user.id, user.id));
      await mockLoggedInUser(session);
      const adminUser = await getAdminUserOrThrow();
      expect(adminUser.id).toBe(user.id);
    });

    it("should throw an error when a non-admin user is logged in", async () => {
      const { session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      await expect(getAdminUserOrThrow()).rejects.toThrow("Unauthorized");
    });
  });

  describe("getUserIdOrNull", () => {
    it("should return null when no user is logged in", async () => {
      await mockLoggedOutUser();
      const userId = await getUserIdOrNull();
      expect(userId).toBeNull();
    });

    it("should return the user id when a user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const userId = await getUserIdOrNull();
      expect(userId).toBe(user.id);
    });
  });

  describe("getUserInfoOrNull", () => {
    it("should return null when no user is logged in", async () => {
      await mockLoggedOutUser();
      const userInfo = await getUserInfoOrNull();
      expect(userInfo).toBeNull();
    });

    it("should return user info when a user is logged in", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      const userInfo = await getUserInfoOrNull();
      expect(userInfo).toBeDefined();
      expect(userInfo?.user.id).toBe(user.id);
      expect(userInfo?.session.id).toBe(session.id);
    });
  });

  describe("validInternalRequestOrThrow", () => {
    it("should throw an error when the secret is incorrect", async () => {
      await mockNextHeaders({ "X-Terragon-Secret": "incorrect" });
      await expect(validInternalRequestOrThrow()).rejects.toThrow(
        "Unauthorized",
      );
    });

    it("should not throw an error when the secret is correct", async () => {
      await mockNextHeaders({
        "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET,
      });
      await validInternalRequestOrThrow();
    });
  });

  describe("getTenantContextOrNull / getActiveOrganizationMembershipOrNull", () => {
    async function signedInMemberOfActiveOrg() {
      const { user, session } = await createTestUser({ db });
      const { organization } = await createTestOrganization({
        db,
        userId: user.id,
        role: "admin",
      });
      await db
        .update(schema.session)
        .set({ activeOrganizationId: organization.id })
        .where(eq(schema.session.id, session.id));
      await mockLoggedInUser(session);
      return { userId: user.id, organizationId: organization.id };
    }

    it("returns null when no user is logged in", async () => {
      await mockLoggedOutUser();
      await expect(getTenantContextOrNull()).resolves.toBeNull();
    });

    it("returns the active org while the user is a member of it", async () => {
      const { userId, organizationId } = await signedInMemberOfActiveOrg();
      await expect(getTenantContextOrNull()).resolves.toEqual({
        userId,
        organizationId,
      });
      await expect(
        getActiveOrganizationMembershipOrNull(userId),
      ).resolves.toEqual({ organizationId, role: "admin" });
    });

    it("drops the session's org once the user is removed from it", async () => {
      const { userId, organizationId } = await signedInMemberOfActiveOrg();
      await db
        .delete(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, organizationId),
            eq(schema.member.userId, userId),
          ),
        );
      await expect(getTenantContextOrNull()).resolves.toEqual({
        userId,
        organizationId: null,
      });
      await expect(
        getActiveOrganizationMembershipOrNull(userId),
      ).resolves.toBeNull();
    });

    it("returns a null org without an active org", async () => {
      const { user, session } = await createTestUser({ db });
      await mockLoggedInUser(session);
      await expect(getTenantContextOrNull()).resolves.toEqual({
        userId: user.id,
        organizationId: null,
      });
    });

    it("never reports the session's membership for a different user", async () => {
      await signedInMemberOfActiveOrg();
      await expect(
        getActiveOrganizationMembershipOrNull("some-other-user"),
      ).resolves.toBeNull();
    });
  });

  describe("requireExpectedActiveMembership", () => {
    async function signedInWithActiveOrg(
      role: "owner" | "admin" | "member" | null,
    ) {
      const { user, session } = await createTestUser({ db });
      let organizationId: string | null = null;
      if (role) {
        const { organization } = await createTestOrganization({
          db,
          userId: user.id,
          role,
        });
        organizationId = organization.id;
        await db
          .update(schema.session)
          .set({ activeOrganizationId: organizationId })
          .where(eq(schema.session.id, session.id));
      }
      await mockLoggedInUser(session);
      return { userId: user.id, organizationId };
    }

    it("returns the active membership when it is the org the page showed", async () => {
      const { userId, organizationId } = await signedInWithActiveOrg("owner");
      await expect(
        requireExpectedActiveMembership(userId, {
          expectedOrganizationId: organizationId,
          requireAdmin: { action: "do it" },
        }),
      ).resolves.toEqual({ organizationId, role: "owner" });
    });

    it("refuses when the session moved off the org the page showed", async () => {
      const { userId } = await signedInWithActiveOrg("owner");
      await expect(
        requireExpectedActiveMembership(userId, {
          expectedOrganizationId: "org_the_page_showed",
        }),
      ).rejects.toThrow(
        "Your active organization changed in another tab. Reload the page and try again.",
      );
    });

    it("refuses an expected 'no org' while the session has one", async () => {
      const { userId } = await signedInWithActiveOrg("member");
      await expect(
        requireExpectedActiveMembership(userId, {
          expectedOrganizationId: null,
        }),
      ).rejects.toThrow(/active organization changed/);
    });

    it("skips the comparison when the page did not know the org yet", async () => {
      const { userId, organizationId } = await signedInWithActiveOrg("member");
      await expect(
        requireExpectedActiveMembership(userId, {
          expectedOrganizationId: undefined,
        }),
      ).resolves.toEqual({ organizationId, role: "member" });
    });

    it("refuses a plain member when an admin is required", async () => {
      const { userId, organizationId } = await signedInWithActiveOrg("member");
      const promise = requireExpectedActiveMembership(userId, {
        expectedOrganizationId: organizationId,
        requireAdmin: { action: "install the Slack app" },
      });
      await expect(promise).rejects.toBeInstanceOf(UserFacingError);
      await expect(promise).rejects.toThrow(
        "Only organization owners and admins can install the Slack app",
      );
    });

    it("lets an admin through when an admin is required", async () => {
      const { userId, organizationId } = await signedInWithActiveOrg("admin");
      await expect(
        requireExpectedActiveMembership(userId, {
          expectedOrganizationId: organizationId,
          requireAdmin: { action: "install the Slack app" },
        }),
      ).resolves.toEqual({ organizationId, role: "admin" });
    });

    it("returns null without an active org, even when an admin is required", async () => {
      const { userId } = await signedInWithActiveOrg(null);
      await expect(
        requireExpectedActiveMembership(userId, {
          expectedOrganizationId: null,
          requireAdmin: { action: "install the Slack app" },
        }),
      ).resolves.toBeNull();
    });

    it("refuses a missing org when one is required", async () => {
      const { userId } = await signedInWithActiveOrg(null);
      await expect(
        requireExpectedActiveMembership(userId, {
          expectedOrganizationId: null,
          requireOrganization: { action: "binding a GitHub installation" },
        }),
      ).rejects.toThrow(
        "Select an organization before binding a GitHub installation",
      );
    });
  });
});
