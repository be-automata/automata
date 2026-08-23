// Build step for the Docker credential-broker sidecar (#114 slice 1).
//
// Source of truth: src/cred-broker-standalone.cjs (self-contained CommonJS).
// Produces:
//  1. dist/cred-broker-standalone.cjs — the standalone artifact (verbatim copy;
//     the source is already dependency-free, so "build" is a copy).
//  2. src/cred-broker-standalone.generated.ts — the same content embedded as a
//     TS string constant, so a provider can materialize the sidecar script at
//     runtime without fs/path asset resolution in bundled server code (the
//     repo's www-bundle constraint). Mirrors build-egress-proxy.mjs. A vitest
//     test asserts the generated file is in sync.
//
// Run: pnpm -C packages/sandbox build-cred-broker
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  join(pkgRoot, "src", "cred-broker-standalone.cjs"),
  "utf8",
);

mkdirSync(join(pkgRoot, "dist"), { recursive: true });
writeFileSync(join(pkgRoot, "dist", "cred-broker-standalone.cjs"), source);

const generated = `// GENERATED FILE — DO NOT EDIT.
// Regenerate with: pnpm -C packages/sandbox build-cred-broker
// Source of truth: src/cred-broker-standalone.cjs
// (embedded as a string so a provider can materialize the sidecar script at
// runtime without fs asset resolution in bundled server code).

export const CRED_BROKER_SCRIPT: string = ${JSON.stringify(source)};
`;
writeFileSync(
  join(pkgRoot, "src", "cred-broker-standalone.generated.ts"),
  generated,
);

console.log(
  "built dist/cred-broker-standalone.cjs + src/cred-broker-standalone.generated.ts",
);
