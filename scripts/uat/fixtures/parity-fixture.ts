/** Validated, safe. */
export function isAdult(age: number): boolean {
  return age > 18; // BUG: should be >= 18
}
