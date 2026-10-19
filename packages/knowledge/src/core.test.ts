import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as core from "./core";

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW_SRC = resolve(HERE, "../../../apps/www/src");

/**
 * Runtime import specifiers of one module: `import x from`, `export * from`,
 * side-effect `import "x"` and dynamic `import("x")`. Type-only forms are erased
 * at build time, so they never reach the Worker bundle and are skipped.
 */
function runtimeImports(source: string): string[] {
  const specs: string[] = [];
  const statement =
    /^\s*(import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of source.matchAll(statement)) {
    if (!m[2] && m[3]) specs.push(m[3]);
  }
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Every module specifier reachable at runtime from `entry`, following relative imports. */
function runtimeGraph(entry: string): {
  modules: string[];
  external: string[];
} {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeImports(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      const base = resolve(dirname(file), spec);
      const target = [base, `${base}.ts`, join(base, "index.ts")].find(
        (p) => existsSync(p) && statSync(p).isFile(),
      );
      if (!target) throw new Error(`unresolved import ${spec} in ${file}`);
      visit(target);
    }
  };
  visit(entry);
  return { modules: [...seen], external: [...external] };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === "node_modules" ? [] : sourceFiles(p);
    return /\.(ts|tsx|mts|js|mjs)$/.test(d.name) ? [p] : [];
  });
}

describe("core entry (fs-free surface)", () => {
  it("reaches no Node built-in at runtime, so the Cloudflare Worker can bundle it", () => {
    const { modules, external } = runtimeGraph(join(HERE, "core.ts"));
    expect(modules.map((m) => m.slice(HERE.length + 1)).sort()).toEqual([
      "core.ts",
      "op-key.ts",
      "reanchor.ts",
    ]);
    expect(external).toEqual([]);
  });

  it("still exposes the pure helpers the control plane needs", () => {
    expect(typeof core.opKey).toBe("function");
    expect(typeof core.parseOpKey).toBe("function");
    expect(typeof core.parseHunks).toBe("function");
    expect(core.REANCHOR_FLOOR).toBe(0.5);
  });

  it("detects a runtime import but ignores type-only ones", () => {
    const src = [
      `import type { A } from "./claims";`,
      `export type { B } from "./claims";`,
      `import { c } from "./op-key";`,
      `export * from "./reanchor";`,
      `import "./side-effect";`,
      `const m = await import("node:fs");`,
    ].join("\n");
    expect(runtimeImports(src)).toEqual([
      "./op-key",
      "./reanchor",
      "./side-effect",
      "node:fs",
    ]);
  });
});

describe("apps/www boundary", () => {
  it("never imports the node entry or claims.ts (both read files with node:fs)", () => {
    const forbidden =
      /["']@terragon\/knowledge\/(node|claims)["']|["'][^"']*packages\/knowledge\/src\/(node|claims)(\.ts)?["']/;
    const offenders = sourceFiles(WWW_SRC).filter((f) =>
      forbidden.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
