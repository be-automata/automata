/**
 * The body of a top-level bash function: from `name() {` to the `}` at column
 * 0 that closes it. Throws when the function is missing, so a renamed function
 * fails its test loudly instead of matching an empty string.
 */
export function fnBody(script: string, name: string): string {
  const start = script.indexOf(`${name}() {\n`);
  if (start < 0) throw new Error(`bash function not found: ${name}`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end < 0 ? undefined : end);
}
