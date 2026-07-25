import { NonRetryableError } from "@hatchet-dev/typescript-sdk";
import { NextMessageHttpError } from "./www-client";

/**
 * Non-retryable error classification (#6). Mark KNOWN-TERMINAL errors
 * `NonRetryableError` so they route straight to the on-failure handler instead of
 * burning agent-minutes on backoff. This is correct to apply now even though the run
 * task is `retries: 0` today (no auto-retry) — it keeps the classification right if
 * retries are ever raised, and documents intent.
 *
 * TRANSIENT (5xx / network) stays a plain Error (retryable); a 4xx from next-message
 * (PR gone / permission revoked / bad token) is terminal → NonRetryableError.
 */
export function classifyNextMessageError(err: unknown): unknown {
  if (
    err instanceof NextMessageHttpError &&
    err.status >= 400 &&
    err.status < 500
  ) {
    return new NonRetryableError(
      `next-message ${err.status} (PR gone / permission / bad token) — non-retryable: ${err.message}`,
    );
  }
  return err; // 5xx / network / abort → retryable (unchanged)
}

/** Wrap a preflight gh-auth failure as non-retryable (a misconfig, never transient). */
export function nonRetryablePreflight(err: unknown): NonRetryableError {
  return new NonRetryableError(
    `gh auth precondition failed — non-retryable (misconfig, not transient): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}
