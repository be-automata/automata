export function isAdult(age: number): boolean {
  return age > 18; // BUG: off-by-one, should be >= 18
}
