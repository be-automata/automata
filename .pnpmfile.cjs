// pnpm install hook.
//
// drizzle-orm declares every supported driver (pg, @neondatabase/serverless,
// @opentelemetry/api, mysql2, better-sqlite3, postgres, ...) as OPTIONAL peer
// dependencies. In a monorepo where different packages have different subsets of
// those drivers installed, pnpm produces a SEPARATE peer-hashed copy of
// drizzle-orm per subset. Multiple copies make drizzle's branded types (e.g.
// `SQL`, `PgDatabase`) nominally incompatible across package boundaries, so the
// shared `DB` type stops type-checking in consumers (apps/www).
//
// We provide the drivers we actually use (`pg`, `@neondatabase/serverless`) as
// direct dependencies, so drizzle-orm does not need to enforce them as peers.
// Clearing its peer set forces a single hoisted drizzle-orm copy across the
// workspace. drizzle loads driver modules lazily at runtime, so this is safe.
function readPackage(pkg) {
  if (pkg.name === "drizzle-orm") {
    pkg.peerDependencies = {};
    pkg.peerDependenciesMeta = {};
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
