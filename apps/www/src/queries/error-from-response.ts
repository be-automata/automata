/**
 * A 409 from an optimistic-concurrency write (another admin saved between the
 * caller's read and this write). Callers branch on `instanceof ConflictError`
 * to render a reload flow instead of an error toast.
 */
export class ConflictError extends Error {
  constructor(public readonly currentUpdatedAt: string | null) {
    super("Another admin just saved changes to this setting.");
    this.name = "ConflictError";
  }
}

/** Read the error text from a failed response, falling back to the status line. */
export async function errorFromResponse(res: Response): Promise<Error> {
  let message = res.statusText;
  let currentUpdatedAt: string | null = null;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          error?: string;
          currentUpdatedAt?: string;
        };
        message = parsed.error ?? text;
        currentUpdatedAt = parsed.currentUpdatedAt ?? null;
      } catch {
        message = text;
      }
    }
  } catch {
    // keep the status line
  }
  if (res.status === 409) {
    return new ConflictError(currentUpdatedAt);
  }
  return new Error(message || `Request failed (${res.status})`);
}
