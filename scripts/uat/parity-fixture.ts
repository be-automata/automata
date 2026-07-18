// UAT fixture for ADR-036 effect-intent parity (throwaway — do NOT merge).
// Outside src/ so it never breaks lint/tsc/tests. Seeded defects for the reviewer:
//   1. correctness: off-by-one — isAdult should be >= 18, not > 18
//   2. security: logs a secret to the console
//   3. false attestation — doc comment claims "validated, safe"

/** Validated, safe. */
export function isAdult(age: number): boolean {
  return age > 18; // BUG: should be >= 18
}

export function logKey(k: string): void {
  console.log("API key:", k); // SECURITY: logs a secret
}
