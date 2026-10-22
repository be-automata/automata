import { NextResponse } from "next/server";

/**
 * Daemon-token verification could not reach a verdict because the auth store
 * failed (a database timeout, a dropped connection), not because the token is
 * bad. Callers answer 503 + Retry-After, never 401: a 401 tells the worker the
 * run's credential is gone and it kills a live run over a transient outage.
 *
 * Kept in its own dependency-light module (no auth/db imports) so route tests
 * that mock `@/lib/auth-server` wholesale still get the real class and helpers.
 */
export class DaemonAuthUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DaemonAuthUnavailableError";
  }
}

/** Seconds a caller should wait before retrying a 503 from daemon auth. */
export const DAEMON_AUTH_RETRY_AFTER_SECONDS = 2;

/** The 503 every daemon-token route answers when verification is unavailable. */
export function daemonAuthUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "Authentication temporarily unavailable" },
    {
      status: 503,
      headers: { "Retry-After": String(DAEMON_AUTH_RETRY_AFTER_SECONDS) },
    },
  );
}

/**
 * Wrap a route handler so a DaemonAuthUnavailableError thrown anywhere inside
 * it becomes the 503 response. Every other error propagates unchanged.
 */
export function withDaemonAuthUnavailable<
  Args extends unknown[],
  R extends Response,
>(
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof DaemonAuthUnavailableError) {
        // The cause's message can quote the failed SQL with the key hash as a
        // parameter, so only its class name is logged here.
        console.error("[daemon-auth] verification unavailable", {
          reason: error.message,
          cause: error.cause instanceof Error ? error.cause.name : undefined,
        });
        return daemonAuthUnavailableResponse();
      }
      throw error;
    }
  };
}
