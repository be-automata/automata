/**
 * Mirrors `formatError` in `daemon.ts` (private there) so the claude/amp
 * façades can log parse failures identically to the inline `onStdoutLine`
 * handlers they replace (daemon.ts:688-715, 782-813).
 */
export function formatError(error: unknown): object {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause ? { cause: error.cause } : {}),
    };
  }
  return { value: error };
}
