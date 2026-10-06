import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

/**
 * Guard for the root `tinypool@<2.1.2` override (GHSA-5gmw-xhrv-c9v3,
 * GHSA-85c8-ppgw-ccpr). vitest 3 declares tinypool ^1, so the override forces
 * a major the runner was not released against. This file runs inside that
 * pool: if it passes, the runner works on the patched major, and it fails the
 * day the override is dropped or resolves to a vulnerable release.
 */
const PATCHED = [2, 1, 2] as const;

function resolvedTinypoolVersion(): string {
  const fromVitest = createRequire(
    createRequire(import.meta.url).resolve("vitest/package.json"),
  );
  const manifest: unknown = JSON.parse(
    readFileSync(fromVitest.resolve("tinypool/package.json"), "utf8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof (manifest as { version?: unknown }).version !== "string"
  ) {
    throw new Error("tinypool package.json has no version");
  }
  return (manifest as { version: string }).version;
}

function atLeast(version: string, floor: readonly number[]): boolean {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (const [i, min] of floor.entries()) {
    const part = parts[i] ?? 0;
    if (part !== min) return part > min;
  }
  return true;
}

describe("test runner worker pool", () => {
  it("vitest resolves a tinypool release patched for the RCE advisories", () => {
    const version = resolvedTinypoolVersion();
    expect(atLeast(version, PATCHED), `tinypool ${version}`).toBe(true);
  });

  it("compares versions numerically", () => {
    expect(atLeast("2.1.2", PATCHED)).toBe(true);
    expect(atLeast("2.10.0", PATCHED)).toBe(true);
    expect(atLeast("2.1.1", PATCHED)).toBe(false);
    expect(atLeast("1.1.1", PATCHED)).toBe(false);
  });
});
