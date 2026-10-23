import { defaultKeyHasher } from "@better-auth/api-key";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apikey } from "@terragon/shared/db/schema";
import { DaemonAuthUnavailableError } from "./daemon-auth-unavailable";

type VerifyApiKeyResult = Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
export type VerifiedDaemonApiKey = NonNullable<VerifyApiKeyResult["key"]>;

/**
 * Whether an apikey row exists for the raw token. Hashes exactly as the
 * api-key plugin stores keys (`defaultKeyHasher`; auth.ts leaves
 * `disableKeyHashing` at its default `false`). Throws
 * DaemonAuthUnavailableError when the lookup itself fails.
 */
async function apiKeyRowExists(token: string): Promise<boolean> {
  const hashedKey = await defaultKeyHasher(token);
  try {
    const rows = await db
      .select({ id: apikey.id })
      .from(apikey)
      .where(eq(apikey.key, hashedKey))
      .limit(1);
    return rows.length > 0;
  } catch (error) {
    throw new DaemonAuthUnavailableError("api key lookup failed", {
      cause: error,
    });
  }
}

/**
 * Verify a raw X-Daemon-Token API key.
 *
 * Returns the verified key, or null (→ 401) for an unknown, disabled or
 * expired key. Throws DaemonAuthUnavailableError (→ 503) when the auth store
 * fails, so a database blip never reads as a revoked credential.
 */
export async function verifyDaemonApiKey(
  token: string,
): Promise<VerifiedDaemonApiKey | null> {
  // better-auth's verifyApiKey turns ANY non-APIError (a DB timeout included)
  // into `{ valid: false, code: "INVALID_API_KEY" }` — the same answer as an
  // unknown key. Look the row up ourselves first so an outage is observable:
  // the lookup throwing means the store is unavailable (503), no row means
  // the key is unknown (401).
  if (!(await apiKeyRowExists(token))) {
    console.log("Unauthorized", "reason", "unknown api key");
    return null;
  }
  let result: VerifyApiKeyResult;
  try {
    result = await auth.api.verifyApiKey({ body: { key: token } });
  } catch (error) {
    throw new DaemonAuthUnavailableError("api key verification threw", {
      cause: error,
    });
  }
  const { valid, error, key } = result;
  if (error || !valid) {
    // The row was just found, so "invalid" here means verification failed
    // internally (or the key was revoked in between — the retry then 401s).
    // KEY_DISABLED / KEY_EXPIRED and the other codes stay a 401.
    if (!error || error.code === "INVALID_API_KEY") {
      throw new DaemonAuthUnavailableError(
        "api key verification failed after the key row was found",
      );
    }
    console.log("Unauthorized", "code", error.code, "valid", valid);
    return null;
  }
  return key ?? null;
}
