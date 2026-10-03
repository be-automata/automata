import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db";
import { env } from "@terragon/env/pkg-shared";
import * as schema from "../db/schema";
import { createTestUser } from "./test-helpers";
import {
  decryptTokenWithBackwardsCompatibility,
  encryptToken,
} from "@terragon/utils/encryption";
import {
  getGitHubUserAccessTokenOrThrow,
  GitHubTokenRefreshError,
  GitHubUserTokenRefresher,
} from "./user";

const db = createDb(env.DATABASE_URL!);

const ENCRYPTION_KEY = "dev-encryption-master-key-32chars!!";

async function setGitHubTokenExpiry(userId: string, expiresAt: Date | null) {
  await db
    .update(schema.account)
    .set({ accessTokenExpiresAt: expiresAt })
    .where(
      and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, "github"),
      ),
    );
}

describe("getGitHubUserAccessTokenOrThrow expiry handling", () => {
  let userId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
  });

  it("returns the token when there is no expiry (non-expiring provider)", async () => {
    await setGitHubTokenExpiry(userId, null);
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
      }),
    ).resolves.toBeTruthy();
  });

  it("returns the token when the expiry is in the future", async () => {
    await setGitHubTokenExpiry(userId, new Date(Date.now() + 60 * 60 * 1000));
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
      }),
    ).resolves.toBeTruthy();
  });

  // Regression: GitHub App user tokens live 8h. An expired token used to be
  // returned verbatim, producing "Bad credentials" on every call AND beating the
  // App-installation fallback in the background helpers, which broke PR
  // automations outright.
  it("throws once the token has expired", async () => {
    await setGitHubTokenExpiry(userId, new Date(Date.now() - 1000));
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
      }),
    ).rejects.toThrow(/expired/i);
  });
});

const HOUR = 60 * 60 * 1000;

function githubAccountWhere(userId: string) {
  return and(
    eq(schema.account.userId, userId),
    eq(schema.account.providerId, "github"),
  );
}

async function setExpiredWithRefreshToken(
  userId: string,
  {
    refreshToken,
    refreshTokenExpiresAt,
  }: { refreshToken: string | null; refreshTokenExpiresAt: Date | null },
) {
  await db
    .update(schema.account)
    .set({
      accessToken: encryptToken("ghu_dead", ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(Date.now() - 1000),
      refreshToken: refreshToken
        ? encryptToken(refreshToken, ENCRYPTION_KEY)
        : null,
      refreshTokenExpiresAt,
    })
    .where(githubAccountWhere(userId));
}

async function readGitHubAccount(userId: string) {
  const [row] = await db
    .select()
    .from(schema.account)
    .where(githubAccountWhere(userId));
  return row!;
}

// Regression: an expired token used to be final, so 8h after signing in every
// user's repo list (Create Environment, new-task picker) went empty until they
// re-linked GitHub, even though the 6-month refresh token was sitting in the row.
describe("getGitHubUserAccessTokenOrThrow refresh", () => {
  let userId: string;

  beforeEach(async () => {
    userId = (await createTestUser({ db })).user.id;
  });

  it("renews an expired token with the stored refresh token and persists the rotated pair encrypted", async () => {
    await setExpiredWithRefreshToken(userId, {
      refreshToken: "ghr_old",
      refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR),
    });
    const newExpiry = new Date(Date.now() + 8 * HOUR);
    const newRefreshExpiry = new Date(Date.now() + 4000 * HOUR);
    const refresh = vi.fn<GitHubUserTokenRefresher>().mockResolvedValue({
      accessToken: "ghu_fresh",
      accessTokenExpiresAt: newExpiry,
      refreshToken: "ghr_new",
      refreshTokenExpiresAt: newRefreshExpiry,
    });

    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
        refresh,
      }),
    ).resolves.toBe("ghu_fresh");

    // GitHub gets the PLAINTEXT refresh token, never the ciphertext.
    expect(refresh).toHaveBeenCalledWith("ghr_old");
    const row = await readGitHubAccount(userId);
    expect(row.accessToken).not.toBe("ghu_fresh");
    expect(
      decryptTokenWithBackwardsCompatibility(row.accessToken!, ENCRYPTION_KEY),
    ).toBe("ghu_fresh");
    expect(
      decryptTokenWithBackwardsCompatibility(row.refreshToken!, ENCRYPTION_KEY),
    ).toBe("ghr_new");
    expect(row.accessTokenExpiresAt?.getTime()).toBe(newExpiry.getTime());
    expect(row.refreshTokenExpiresAt?.getTime()).toBe(
      newRefreshExpiry.getTime(),
    );

    // The next read uses the stored token without another exchange.
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
        refresh,
      }),
    ).resolves.toBe("ghu_fresh");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not attempt a refresh when the refresh token itself has expired", async () => {
    await setExpiredWithRefreshToken(userId, {
      refreshToken: "ghr_old",
      refreshTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const refresh = vi.fn<GitHubUserTokenRefresher>();
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
        refresh,
      }),
    ).rejects.toThrow(/expired/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("throws when there is no refresh token to use", async () => {
    await setExpiredWithRefreshToken(userId, {
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    const refresh = vi.fn<GitHubUserTokenRefresher>();
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
        refresh,
      }),
    ).rejects.toThrow(/expired/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("throws, without touching the row, when GitHub rejects the refresh token", async () => {
    await setExpiredWithRefreshToken(userId, {
      refreshToken: "ghr_revoked",
      refreshTokenExpiresAt: null,
    });
    const before = await readGitHubAccount(userId);
    const refresh = vi
      .fn<GitHubUserTokenRefresher>()
      .mockRejectedValue(
        new Error("GitHub token refresh failed: bad_refresh_token"),
      );
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
        refresh,
      }),
    ).rejects.toThrow(GitHubTokenRefreshError);
    const after = await readGitHubAccount(userId);
    expect(after.accessToken).toBe(before.accessToken);
    expect(after.refreshToken).toBe(before.refreshToken);
  });

  // GitHub rotates refresh tokens, so of two concurrent refreshes one exchange
  // fails. The loser must pick up the winner's token, not report "expired".
  it("uses the token a concurrent refresh stored when its own exchange fails", async () => {
    await setExpiredWithRefreshToken(userId, {
      refreshToken: "ghr_old",
      refreshTokenExpiresAt: null,
    });
    const refresh = vi
      .fn<GitHubUserTokenRefresher>()
      .mockImplementation(async () => {
        await db
          .update(schema.account)
          .set({
            accessToken: encryptToken("ghu_winner", ENCRYPTION_KEY),
            accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR),
            refreshToken: encryptToken("ghr_winner", ENCRYPTION_KEY),
          })
          .where(githubAccountWhere(userId));
        throw new Error("GitHub token refresh failed: bad_refresh_token");
      });
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
        refresh,
      }),
    ).resolves.toBe("ghu_winner");
  });

  it("does not overwrite a row another writer rotated while it was refreshing", async () => {
    await setExpiredWithRefreshToken(userId, {
      refreshToken: "ghr_old",
      refreshTokenExpiresAt: null,
    });
    const refresh = vi
      .fn<GitHubUserTokenRefresher>()
      .mockImplementation(async () => {
        await db
          .update(schema.account)
          .set({
            accessToken: encryptToken("ghu_winner", ENCRYPTION_KEY),
            accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR),
            refreshToken: encryptToken("ghr_winner", ENCRYPTION_KEY),
          })
          .where(githubAccountWhere(userId));
        return {
          accessToken: "ghu_loser",
          accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR),
          refreshToken: "ghr_loser",
          refreshTokenExpiresAt: null,
        };
      });
    await expect(
      getGitHubUserAccessTokenOrThrow({
        db,
        userId,
        encryptionKey: ENCRYPTION_KEY,
        refresh,
      }),
    ).resolves.toBe("ghu_winner");
    const row = await readGitHubAccount(userId);
    expect(
      decryptTokenWithBackwardsCompatibility(row.refreshToken!, ENCRYPTION_KEY),
    ).toBe("ghr_winner");
  });
});
