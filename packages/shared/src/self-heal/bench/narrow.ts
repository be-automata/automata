/** Narrowing helpers for the benchmark's JSON inputs (manifest, exports). */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as a plain object; throws `<where> must be an object` otherwise. */
export function recordOf(
  value: unknown,
  where: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where} must be an object`);
  return value;
}
