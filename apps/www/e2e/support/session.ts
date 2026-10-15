import { createHmac, randomBytes } from "node:crypto";

import type { Pool } from "pg";

import { E2E_BASE_URL, E2E_BETTER_AUTH_SECRET } from "../e2e-env";

/**
 * Better Auth 1.6 session cookie. The `__Secure-` prefix only applies when
 * BETTER_AUTH_URL is https; the suite runs on http://localhost.
 */
export const SESSION_COOKIE_NAME = "better-auth.session_token";

export interface SeededSession {
  sessionId: string;
  token: string;
  /** The cookie value exactly as Better Auth signs it. */
  cookieValue: string;
}

/** A Playwright storage state holding one signed session cookie. */
export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax" | "Strict" | "None";
  }>;
  origins: never[];
}

/**
 * `token.<base64 HMAC-SHA256(secret, token)>`, URI-encoded — the same value
 * better-auth's makeSignature/setSignedCookie produce.
 */
export function signSessionToken(
  token: string,
  secret: string = E2E_BETTER_AUTH_SECRET,
): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

/**
 * Inserts a `session` row and returns its signed cookie. No cookie cache is
 * configured, so Better Auth reads this row on every request; tests that move
 * the active org get a session of their own and never disturb each other.
 */
export async function createSessionCookie(
  pool: Pool,
  {
    userId,
    activeOrganizationId,
  }: { userId: string; activeOrganizationId: string | null },
): Promise<SeededSession> {
  const sessionId = `e2e-session-${randomBytes(8).toString("hex")}`;
  const token = randomBytes(24).toString("base64url").slice(0, 32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO "session"
       (id, token, user_id, active_organization_id, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [sessionId, token, userId, activeOrganizationId, expiresAt, now],
  );
  return { sessionId, token, cookieValue: signSessionToken(token) };
}

export function storageStateFor(session: SeededSession): StorageState {
  return {
    cookies: [
      {
        name: SESSION_COOKIE_NAME,
        value: session.cookieValue,
        domain: new URL(E2E_BASE_URL).hostname,
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

export async function readActiveOrganizationId(
  pool: Pool,
  sessionId: string,
): Promise<string | null> {
  const result = await pool.query<{ active_organization_id: string | null }>(
    `SELECT active_organization_id FROM "session" WHERE id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Session ${sessionId} does not exist`);
  }
  return row.active_organization_id;
}
