// UAT fixture for ADR-036 effect-intent parity (throwaway — do NOT merge).
// Outside src/ so it never breaks lint/tsc/tests. Seeded defects for the reviewer:
//   1. correctness: off-by-one — isAdult should be >= 18, not > 18 [FIXED per PR #3 request]
//   2. security: logs a secret to the console [still present — not requested]
//   3. false attestation — doc comment claims "validated, safe" [removed alongside fix #1]

export function isAdult(age: number): boolean {
  return age >= 18;
}

export function logKey(k: string): void {
  console.log("API key:", k); // SECURITY: logs a secret
}
