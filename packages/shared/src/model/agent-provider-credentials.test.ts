import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestUser } from "./test-helpers";
import { createDb } from "../db";
import {
  insertAgentProviderCredentials,
  getAgentProviderCredentialsDecrypted,
  getAgentProviderCredentialsRecord,
  deleteAgentProviderCredentialById,
  getAllAgentProviderCredentialRecords,
  getValidAccessTokenForCredential,
  isAgentProviderCredentialUnavailable,
  markAgentProviderCredentialUnavailable,
  resolveAgentProviderCredential,
} from "./agent-provider-credentials";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";

const db = createDb(process.env.DATABASE_URL!);

const CLAUDE_CODE_API_KEY_CREDENTIALS = {
  agent: "claudeCode",
  type: "api-key",
  apiKey: "test-claude-code-api-key",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastRefreshedAt: null,
  expiresAt: null,
  metadata: null,
  isActive: true,
} as const;

const CLAUDE_CODE_OAUTH_CREDENTIALS = {
  agent: "claudeCode",
  type: "oauth",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastRefreshedAt: null,
  expiresAt: null,
  metadata: null,
  isActive: true,
} as const;

const CODEX_API_KEY_CREDENTIALS = {
  agent: "codex",
  type: "api-key",
  apiKey: "test-codex-api-key",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastRefreshedAt: null,
  expiresAt: null,
  metadata: null,
  isActive: true,
} as const;

describe("agent-provider-credentials", () => {
  let userId: string;
  const encryptionKey = "test-encryption-key-32-chars-long";

  beforeEach(async () => {
    const testUser = await createTestUser({ db });
    userId = testUser.user.id;
  });

  describe("insertAgentProviderCredentials", () => {
    it("should store API key credentials", async () => {
      const result = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      expect(result).toBeDefined();
      expect(result.userId).toBe(userId);
      expect(result.agent).toBe("claudeCode");
      expect(result.type).toBe("api-key");
      expect(result.apiKeyEncrypted).toBeDefined();
      expect(result.accessTokenEncrypted).toBeNull();
    });

    it("should store OAuth credentials", async () => {
      const result = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_OAUTH_CREDENTIALS,
        encryptionKey,
      });

      expect(result).toBeDefined();
      expect(result.agent).toBe("claudeCode");
      expect(result.type).toBe("oauth");
      expect(result.accessTokenEncrypted).toBeDefined();
      expect(result.refreshTokenEncrypted).toBeDefined();
    });
  });

  describe("getAgentProviderCredentialsDecrypted", () => {
    it("should retrieve and decrypt credentials", async () => {
      await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      const result = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "claudeCode",
        encryptionKey,
      });
      expect(result).toBeDefined();
      expect(result!.agent).toBe("claudeCode");
      expect(result!.type).toBe("api-key");
      expect(result!.apiKey).toBe(CLAUDE_CODE_API_KEY_CREDENTIALS.apiKey);
    });

    it("should return null for non-existent credentials", async () => {
      const result = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "claudeCode",
        encryptionKey,
      });
      expect(result).toBeNull();
    });
  });

  describe("getAllAgentProviderCredentialsDecrypted", () => {
    it("should retrieve all credentials for a user", async () => {
      await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });

      await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CODEX_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      const result = await getAllAgentProviderCredentialRecords({
        db,
        userId,
      });
      expect(result).toHaveLength(2);
      expect(result.find((c) => c.agent === "claudeCode")).toBeDefined();
      expect(result.find((c) => c.agent === "codex")).toBeDefined();
    });
  });

  describe("deleteAgentProviderCredentials", () => {
    it("should delete credentials", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      await deleteAgentProviderCredentialById({
        db,
        userId,
        credentialId: credential.id,
      });
      const record = await getAgentProviderCredentialsRecord({
        db,
        userId,
        agent: "claudeCode",
      });
      expect(record).toBeUndefined();
    });
  });

  describe("getValidAccessTokenForCredential", () => {
    it("should return null when credentials exist but no access token", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });
      expect(result).toBeNull();
    });

    it("should return access token when valid and not expired", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: futureDate,
        },
        encryptionKey,
      });
      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });
      expect(result).toBe("test-access-token");
    });

    it("should return access token if no expiration date", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: null,
        },
        encryptionKey,
      });
      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });
      expect(result).toBe("test-access-token");
    });

    it("should refresh token if expired and callback provided", async () => {
      const pastDate = new Date(Date.now() - 1000); // 1 second ago
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: null,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(refreshTokenCallback).toHaveBeenCalledWith({
        refreshToken: "test-refresh-token",
      });
      expect(result).toBe("new-access-token");
    });

    it("should update only changed fields during token refresh", async () => {
      const pastDate = new Date(Date.now() - 1000);
      const originalMetadata = { type: "claude" as const };
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
          metadata: originalMetadata,
        },
        encryptionKey,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });

      expect(result).toBe("test-access-token");
    });

    it("should return expired token when no refresh token available", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          refreshToken: undefined,
          expiresAt: pastDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn();

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(result).toBe("test-access-token");
      expect(refreshTokenCallback).not.toHaveBeenCalled();
    });

    it("should use 1 hour buffer before expiration", async () => {
      // Token expires in 30 minutes (within the 1-hour buffer)
      const nearFutureDate = new Date(Date.now() + 30 * 60 * 1000);
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: nearFutureDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: "refreshed-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: null,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(result).toBe("refreshed-access-token");
      expect(refreshTokenCallback).toHaveBeenCalled();
    });

    it("should preserve existing metadata when refreshing", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
          metadata: { type: "claude", accountEmail: "test@example.com" },
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: { type: "claude", accountId: "1234567890" },
      });

      await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      const updatedCreds = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "claudeCode",
        encryptionKey,
      });
      expect(updatedCreds!.metadata).toEqual({
        type: "claude",
        accountEmail: "test@example.com",
        accountId: "1234567890",
      });
    });

    it("should handle refresh callback returning null accessToken", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: null,
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: null,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(result).toBeNull();
    });
  });

  // #442 (epic #440 C2): per-credential unavailability, on real Postgres.
  describe("credential unavailability (#442)", () => {
    const HOUR = 60 * 60 * 1000;

    async function connect(createdAt = new Date()) {
      const cred = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_OAUTH_CREDENTIALS,
        encryptionKey,
      });
      // Pin the ordering column so "newest" is deterministic.
      await db
        .update(schema.agentProviderCredentials)
        .set({ createdAt })
        .where(eq(schema.agentProviderCredentials.id, cred.id));
      return cred;
    }

    async function row(id: string) {
      const found = await db.query.agentProviderCredentials.findFirst({
        where: eq(schema.agentProviderCredentials.id, id),
      });
      return found!;
    }

    function mark(
      credentialId: string,
      until: Date | null,
      reason: "usage_limit" | "subscription_disabled" | "auth_rejected" = until
        ? "usage_limit"
        : "subscription_disabled",
    ) {
      return markAgentProviderCredentialUnavailable({
        db,
        userId,
        credentialId,
        reason,
        until,
      });
    }

    // Card: protects=the first timed mark stores until, reason and marked_at;
    // fails_when=any column stays NULL or until differs from resets_at;
    // no_claim=who calls it (handle-daemon-event suite).
    it("the first timed mark sets until = resets_at, the reason and marked_at", async () => {
      const cred = await connect();
      const until = new Date(Date.now() + 5 * HOUR);
      expect(await mark(cred.id, until)).toBe(true);
      const after = await row(cred.id);
      expect(after.unavailableUntil?.getTime()).toBe(until.getTime());
      expect(after.unavailableReason).toBe("usage_limit");
      expect(after.unavailableMarkedAt).toBeInstanceOf(Date);
    });

    // Card: protects=monotonic GREATEST; fails_when=a later, earlier reset
    // shortens the mark or a later reset does not extend it;
    // no_claim=concurrency (next test).
    it("a timed mark only extends, never shortens", async () => {
      const cred = await connect();
      const late = new Date(Date.now() + 10 * HOUR);
      const early = new Date(Date.now() + 2 * HOUR);
      const later = new Date(Date.now() + 20 * HOUR);
      await mark(cred.id, late);
      expect(await mark(cred.id, early)).toBe(false);
      expect((await row(cred.id)).unavailableUntil?.getTime()).toBe(
        late.getTime(),
      );
      expect(await mark(cred.id, later)).toBe(true);
      expect((await row(cred.id)).unavailableUntil?.getTime()).toBe(
        later.getTime(),
      );
      // Idempotent: the same until again is a no-op.
      expect(await mark(cred.id, later)).toBe(false);
    });

    // Card: protects=concurrent marks of one row are monotonic;
    // fails_when=the smaller until wins a race; no_claim=cross-row races.
    it("two concurrent marks leave the larger until", async () => {
      const cred = await connect();
      const a = new Date(Date.now() + 3 * HOUR);
      const b = new Date(Date.now() + 7 * HOUR);
      await Promise.all([
        mark(cred.id, b),
        mark(cred.id, a),
        mark(cred.id, b),
        mark(cred.id, a),
      ]);
      expect((await row(cred.id)).unavailableUntil?.getTime()).toBe(
        b.getTime(),
      );
    });

    // Card: protects=indefinite marks (subscription_disabled, auth_rejected)
    // survive timed marks and end only on an admin clear; fails_when=a timed
    // mark shortens it, a second indefinite mark re-stamps it, or a clear
    // leaves it unavailable; no_claim=which kinds the caller maps to
    // indefinite (credential-unavailability suite).
    it("an indefinite mark is never shortened and only an admin clear ends it", async () => {
      const cred = await connect();
      expect(await mark(cred.id, null, "auth_rejected")).toBe(true);
      const first = await row(cred.id);
      expect(first.unavailableUntil).toBeNull();
      expect(first.unavailableReason).toBe("auth_rejected");

      expect(await mark(cred.id, new Date(Date.now() + 99 * HOUR))).toBe(false);
      expect(await mark(cred.id, null, "subscription_disabled")).toBe(false);
      const still = await row(cred.id);
      expect(still.unavailableUntil).toBeNull();
      expect(still.unavailableReason).toBe("auth_rejected");
      expect(still.unavailableMarkedAt?.getTime()).toBe(
        first.unavailableMarkedAt?.getTime(),
      );
      expect(isAgentProviderCredentialUnavailable(still, new Date())).toBe(
        true,
      );

      // The admin clear documented in the epic's rollback plan.
      await db
        .update(schema.agentProviderCredentials)
        .set({ unavailableUntil: null, unavailableReason: null })
        .where(eq(schema.agentProviderCredentials.id, cred.id));
      const resolved = await resolveAgentProviderCredential({
        db,
        userId,
        agent: "claudeCode",
      });
      expect(resolved.status).toBe("available");
    });

    it("an indefinite mark replaces a timed one", async () => {
      const cred = await connect();
      await mark(cred.id, new Date(Date.now() + HOUR));
      expect(await mark(cred.id, null)).toBe(true);
      const after = await row(cred.id);
      expect(after.unavailableUntil).toBeNull();
      expect(after.unavailableReason).toBe("subscription_disabled");
    });

    it("a half admin clear (reason only) never blocks a new, shorter mark", async () => {
      const cred = await connect();
      await mark(cred.id, new Date(Date.now() + 10 * HOUR));
      await db
        .update(schema.agentProviderCredentials)
        .set({ unavailableReason: null })
        .where(eq(schema.agentProviderCredentials.id, cred.id));
      const shorter = new Date(Date.now() + HOUR);
      expect(await mark(cred.id, shorter)).toBe(true);
      const after = await row(cred.id);
      expect(after.unavailableReason).toBe("usage_limit");
      expect(after.unavailableUntil?.getTime()).toBe(shorter.getTime());
    });

    it("a mark is fenced by user", async () => {
      const cred = await connect();
      const other = (await createTestUser({ db })).user.id;
      const changed = await markAgentProviderCredentialUnavailable({
        db,
        userId: other,
        credentialId: cred.id,
        reason: "usage_limit",
        until: new Date(Date.now() + HOUR),
      });
      expect(changed).toBe(false);
      expect((await row(cred.id)).unavailableReason).toBeNull();
    });

    // Card: protects=resolution keeps the newest active row and types its
    // mark, never stepping down (epic decision 1); fails_when=a marked newest
    // row resolves available, an older or inactive row is returned, or an
    // expired mark still reads unavailable; no_claim=delivery (unchanged in
    // C2) and the dispatch gate (C3).
    describe("resolveAgentProviderCredential", () => {
      it("returns none without an active row", async () => {
        expect(
          await resolveAgentProviderCredential({
            db,
            userId,
            agent: "claudeCode",
          }),
        ).toEqual({ status: "none" });
      });

      it("returns the newest active row when it is unmarked", async () => {
        const cred = await connect();
        const resolved = await resolveAgentProviderCredential({
          db,
          userId,
          agent: "claudeCode",
        });
        expect(resolved.status).toBe("available");
        expect(resolved.status === "available" && resolved.credential.id).toBe(
          cred.id,
        );
      });

      it("a timed mark whose until has passed is available again", async () => {
        const cred = await connect();
        const until = new Date(Date.now() + HOUR);
        await mark(cred.id, until);
        const later = new Date(until.getTime() + 1);
        const resolved = await resolveAgentProviderCredential({
          db,
          userId,
          agent: "claudeCode",
          now: later,
        });
        expect(resolved.status).toBe("available");
      });

      it("types the newest active row's mark and never steps down to an unmarked older row", async () => {
        const older = await connect(new Date(Date.now() - 2 * HOUR));
        const newest = await connect(new Date());
        // Make the older row active again too: even then it must not win.
        await db
          .update(schema.agentProviderCredentials)
          .set({ isActive: true })
          .where(eq(schema.agentProviderCredentials.id, older.id));
        const until = new Date(Date.now() + 4 * HOUR);
        await mark(newest.id, until);
        expect(
          await resolveAgentProviderCredential({
            db,
            userId,
            agent: "claudeCode",
          }),
        ).toEqual({
          status: "credential-unavailable",
          credentialId: newest.id,
          until,
          reason: "usage_limit",
        });
      });

      it("never returns an inactive row", async () => {
        const cred = await connect();
        await db
          .update(schema.agentProviderCredentials)
          .set({ isActive: false })
          .where(eq(schema.agentProviderCredentials.id, cred.id));
        expect(
          (
            await resolveAgentProviderCredential({
              db,
              userId,
              agent: "claudeCode",
            })
          ).status,
        ).toBe("none");
      });
    });
  });
});
