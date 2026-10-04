import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UNFENCED_SELF_HEAL_MODEL_FUNCTIONS } from "./self-heal-breaker";

const FILES = [
  "audit-findings.ts",
  "self-heal-outbox.ts",
  "self-heal-breaker.ts",
  "self-heal-admin-log.ts",
];

interface ExportedFn {
  file: string;
  name: string;
  params: string;
}

/** The first parameter's destructuring pattern: text of the first balanced {...}. */
function firstDestructure(src: string, from: number): string {
  const open = src.indexOf("{", src.indexOf("(", from));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

function exportedAsyncFunctions(): ExportedFn[] {
  const out: ExportedFn[] = [];
  for (const file of FILES) {
    const src = readFileSync(join(__dirname, file), "utf8");
    for (const m of src.matchAll(/export async function (\w+)/g)) {
      out.push({ file, name: m[1]!, params: firstDestructure(src, m.index!) });
    }
  }
  return out;
}

describe("TIER-01 org fence", () => {
  const fns = exportedAsyncFunctions();

  it("finds the exported model functions", () => {
    expect(fns.length).toBeGreaterThan(20);
  });

  it("every exported function takes organizationId or is documented as unfenced", () => {
    const offenders = fns
      .filter(
        (f) =>
          !/\borganizationId\b/.test(f.params) &&
          !(f.name in UNFENCED_SELF_HEAL_MODEL_FUNCTIONS),
      )
      .map((f) => `${f.file}:${f.name}`);
    expect(offenders).toEqual([]);
  });

  it("every unfenced entry names a real export and has a reason", () => {
    const names = new Set(fns.map((f) => f.name));
    for (const [name, reason] of Object.entries(
      UNFENCED_SELF_HEAL_MODEL_FUNCTIONS,
    )) {
      expect(names.has(name), `stale entry ${name}`).toBe(true);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});
