export class ConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionConfigError";
  }
}

/**
 * Validates DATABASE_URL for the runner. Errors never echo the value: it
 * carries a password.
 *
 * A Neon pooler endpoint (`-pooler.` in the host) is refused: PgBouncer in
 * transaction mode does not keep a session advisory lock on one backend, so
 * two runners would not serialize, and session-level SETs leak between
 * clients.
 */
export function assertDirectConnection(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value === "") {
    throw new ConnectionConfigError("DATABASE_URL is not set");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectionConfigError("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConnectionConfigError(
      `DATABASE_URL must be a postgres:// or postgresql:// URL (got ${url.protocol})`,
    );
  }
  if (url.hostname.includes("-pooler.")) {
    throw new ConnectionConfigError(
      `DATABASE_URL points at a connection pooler (${url.hostname}); migrations need a direct ` +
        "connection to hold the session advisory lock — drop '-pooler' from the host",
    );
  }
  return value;
}
