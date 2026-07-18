// UAT fixture for ADR-036 effect-intent parity (throwaway — do NOT merge).
// S3 full fix: off-by-one corrected (>=), false attestation removed, console.log already removed.

export function isAdult(age: number): boolean {
  return age >= 18;
}
