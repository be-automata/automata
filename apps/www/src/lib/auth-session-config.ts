/**
 * Session lifetime + freshness knobs for better-auth.
 *
 * Kept in a dependency-free module so the invariants between them can be unit
 * tested: `auth.ts` pulls in env, the database and every plugin, so tests mock
 * it wholesale (see the proxy route tests) and can never assert on its config.
 * A silent regression of `SESSION_FRESH_AGE_SECONDS` back to 0 would otherwise
 * disable a security gate with nothing failing.
 */

/** How long a session remains valid: 60 days. */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 60;

/** How often an active session's expiry is rolled forward: 1 day. */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * How recently a session must have been CREATED to count as "fresh".
 *
 * better-auth 1.6 BREAKING: freshness is measured from the session's `createdAt`
 * rather than its rolling update time, and defaults to 24h. Under 60-day
 * sessions that default would fail every session from day 2 onward, so the
 * 1.6.25 upgrade initially set this to 0 — which disables the check entirely
 * (`freshAge === 0` is an explicit short-circuit in better-auth).
 *
 * 0 was behaviour-neutral versus pre-1.6 but opted us out of the gate rather
 * than tuning it. Resolving that (#40), this is now a real 7-day window.
 *
 * Scope of the gate in 1.6.25 — verified against the installed source rather
 * than the docs, because the commonly-cited list is wrong. `freshAge` gates
 * exactly:
 *   - `POST /unlink-account`  (api/routes/account.mjs)
 *   - `GET  /list-sessions`   (api/routes/session.mjs)
 *   - `POST /delete-user`, but ONLY the branch where no password is supplied
 *   - the `@better-auth/passkey` plugin's routes (not installed here)
 *
 * It does NOT gate `changeEmail`, `changePassword`, or any admin-plugin
 * operation: those use `sensitiveSessionMiddleware` (a session-store re-read,
 * unrelated to age) and `adminMiddleware` (a role check) respectively.
 *
 * In this app `deleteUser`/`changeEmail` are not enabled (both 404), no passkey
 * plugin is registered, and nothing calls `/unlink-account` or `/list-sessions`
 * — so raising this from 0 changes no user-facing flow today. It is pure
 * defense-in-depth: a hijacked session cookie can no longer unlink an OAuth
 * provider or enumerate sessions for the full 60-day window.
 *
 * NOTE for whoever enables self-service account management: there is no
 * re-auth/step-up UI in this app, so a non-fresh session hitting a gated route
 * gets a raw `SESSION_NOT_FRESH` (FORBIDDEN). Build the re-auth prompt as part
 * of that work — see #40.
 */
export const SESSION_FRESH_AGE_SECONDS = 60 * 60 * 24 * 7;
