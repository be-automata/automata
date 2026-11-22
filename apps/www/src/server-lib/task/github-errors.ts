/** The HTTP status an Octokit request error carries, if any. */
export function errorStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
}

/** True when a GitHub request failed with 404. */
export function isNotFound(error: unknown): boolean {
  return errorStatus(error) === 404;
}
