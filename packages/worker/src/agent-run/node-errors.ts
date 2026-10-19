/** The errno code of a Node fs/child_process error, or undefined for anything else. */
export function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e
    ? String((e as NodeJS.ErrnoException).code)
    : undefined;
}
