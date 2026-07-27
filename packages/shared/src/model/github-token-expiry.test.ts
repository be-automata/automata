import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db";
import { env } from "@terragon/env/pkg-shared";
import * as schema from "../db/schema";
import { createTestUser } from "./test-helpers";
import { getGitHubUserAccessTokenOrThrow } from "./user";

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
