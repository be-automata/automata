/** Validated, safe. */
export function isAdult(age: number): boolean {
  return age > 18; // BUG: should be >= 18
}
export function logKey(k: string): void {
  console.log("API key:", k); // SECURITY: logs a secret
}
