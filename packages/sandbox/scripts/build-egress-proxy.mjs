// Build step for the Docker egress sidecar proxy (#66 slice 3, spec §3.5).
//
// Source of truth: src/egress-proxy-standalone.cjs (self-contained CommonJS).
// Produces:
//  1. dist/egress-proxy-standalone.cjs — the standalone artifact (verbatim copy;
//     the source is already dependency-free, so "build" is a copy).
//  2. src/egress-proxy-standalone.generated.ts — the same content embedded as a
//     TS string constant. docker-provider.ts materializes the sidecar script
//     from this module at runtime, which keeps apps/www's webpack bundling
//     happy (no fs/path asset resolution in bundled server code — see the
//     repo's www-bundle constraint) while the .cjs stays the single editable
//     source. A vitest test asserts the generated file is in sync.
//
// Run: pnpm -C packages/sandbox build-egress-proxy
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  join(pkgRoot, "src", "egress-proxy-standalone.cjs"),
  "utf8",
);

mkdirSync(join(pkgRoot, "dist"), { recursive: true });
writeFileSync(join(pkgRoot, "dist", "egress-proxy-standalone.cjs"), source);

const generated = `// GENERATED FILE — DO NOT EDIT.
// Regenerate with: pnpm -C packages/sandbox build-egress-proxy
// Source of truth: src/egress-proxy-standalone.cjs
// (embedded as a string so docker-provider.ts can materialize the sidecar
// script at runtime without fs asset resolution in bundled server code).

export const EGRESS_PROXY_SCRIPT: string = ${JSON.stringify(source)};
`;
writeFileSync(
  join(pkgRoot, "src", "egress-proxy-standalone.generated.ts"),
  generated,
);

console.log(
  "built dist/egress-proxy-standalone.cjs + src/egress-proxy-standalone.generated.ts",
);
