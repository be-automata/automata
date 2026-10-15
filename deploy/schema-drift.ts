/**
 * Schema drift check: compares the pg_catalog of two databases and fails on
 * any difference the allowlist does not explain.
 *
 *   Usage:
 *     pnpm exec tsx deploy/schema-drift.ts --a <url> --b <url> \
 *       [--allowlist deploy/migrations/drift-allowlist.json]
 *
 *   CI builds `a` from deploy/migrations (tsx deploy/migrate.ts --apply) and
 *   `b` from packages/shared/src/db/schema.ts (drizzle-kit push), so a
 *   schema.ts change without a migration — or a migration schema.ts does not
 *   describe — fails the job.
 *
 *   Exit: 0 = no unexplained difference; 1 = a difference no allowlist entry
 *         covers, a stale allowlist entry (one that matches nothing), a bad
 *         allowlist, or an unreachable database.
 *
 * The URLs are never echoed: they may carry a password. Imports only the
 * workspace package (deploy/ has no package.json; see deploy/migrate.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffCatalogs,
  formatDiffReport,
  openClient,
  parseAllowlist,
  snapshotCatalog,
  type Catalog,
} from "../packages/migrate/src/index";

interface CliArgs {
  a: string;
  b: string;
  allowlist: string;
}

const DEFAULT_ALLOWLIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "drift-allowlist.json",
);

const USAGE =
  "usage: tsx deploy/schema-drift.ts --a <url> --b <url> [--allowlist <file>]";

function parseArgs(argv: string[]): CliArgs {
  const values: Partial<CliArgs> = { allowlist: DEFAULT_ALLOWLIST };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== "--a" && flag !== "--b" && flag !== "--allowlist") {
      throw new Error(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} needs a value\n${USAGE}`);
    }
    const key = flag.slice(2) as keyof CliArgs;
    values[key] = key === "allowlist" ? path.resolve(value) : value;
    i += 1;
  }
  if (!values.a || !values.b || !values.allowlist) {
    throw new Error(`--a and --b are required\n${USAGE}`);
  }
  return { a: values.a, b: values.b, allowlist: values.allowlist };
}

/** Database name only — safe to print, unlike the full URL. */
function databaseLabel(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "") || "(default db)";
  } catch {
    throw new Error("--a/--b must be postgres:// URLs");
  }
}

async function snapshot(url: string): Promise<Catalog> {
  const client = await openClient(url);
  try {
    return await snapshotCatalog(client);
  } finally {
    await client.end();
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const aLabel = `a (${databaseLabel(args.a)})`;
  const bLabel = `b (${databaseLabel(args.b)})`;
  const allow = parseAllowlist(
    JSON.parse(readFileSync(args.allowlist, "utf8")) as unknown,
  );
  const [a, b] = await Promise.all([snapshot(args.a), snapshot(args.b)]);
  const result = diffCatalogs(a, b, allow);
  console.log(
    `compared ${a.entries.length} objects in ${aLabel} with ${b.entries.length} in ${bLabel}`,
  );
  console.log(formatDiffReport(result, aLabel, bLabel));
  for (const entry of result.allowed) {
    console.log(
      `  allowed ${entry.kind} ${entry.table ?? "-"}.${entry.name}: ${entry.reason}`,
    );
  }
  return result.diffs.length > 0 || result.unusedAllow.length > 0 ? 1 : 0;
}

async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(
      `schema-drift: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

void run();
