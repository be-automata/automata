// UAT fixture for ADR-036 effect-intent parity (throwaway — do NOT merge).
// S2 partial fix: security issue (console.log secret) REMOVED. Off-by-one + false attestation REMAIN.

/** Validated, safe. */
export function isAdult(age: number): boolean {
  return age > 18; // BUG: should be >= 18
}
