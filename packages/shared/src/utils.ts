export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

export function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
