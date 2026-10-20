/**
 * Forward-only migration runner for deploy/migrations, backed by the
 * public.schema_migrations ledger.
 *
 *   Usage:
 *     DATABASE_URL=... pnpm exec tsx deploy/migrate.ts                 # dry run: print the plan
 *     DATABASE_URL=... pnpm exec tsx deploy/migrate.ts --apply         # apply pending files
 *     DATABASE_URL=... pnpm exec tsx deploy/migrate.ts --mark-applied <id>...
 *                                                                      # record without running
 *     [--dir deploy/migrations]                                        # another directory
 *     [--no-contract]   refuse (exit 2, nothing applied) when a pending file is
 *                       marked `migrate:contract`; the CI auto-apply uses it
 *
 *   Exit: 0 = plan clean (and applied, with --apply); 1 = drift (an applied
 *         file was edited), an orphan ledger row, a failed migration, an unset
 *         or pooler DATABASE_URL, or an unreachable database; 2 = --no-contract
 *         and a pending contract file. Fails closed.
 *
 * Files apply in filename order. Each transactional file runs inside one
 * BEGIN … COMMIT together with its ledger row, under `lock_timeout` 5s and
 * `statement_timeout` 120s unless its header says otherwise. Header
 * directives (leading `--` block only):
 *   -- migrate:no-transaction        exactly one statement, outside a transaction
 *   -- migrate:baseline              full-schema snapshot; refused on a non-empty DB
 *   -- migrate:lock-timeout=<dur>    e.g. 30s
 *   -- migrate:statement-timeout=<dur>
 *   -- migrate:expand | migrate:contract
 *
 * Imports only the workspace package (no bare third-party imports: deploy/
 * has no package.json; see deploy/assert-schema-ready.ts).
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  assertDirectConnection,
  loadMigrations,
  markApplied,
  openClient,
  planMigrations,
  planProblems,
  readLedger,
  type MigrationLogger,
  type MigrationPlan,
} from "../packages/migrate/src/index";

interface CliArgs {
  apply: boolean;
  noContract: boolean;
  markApplied: string[];
  dir: string;
}

const DEFAULT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const USAGE =
  "usage: tsx deploy/migrate.ts [--apply] [--mark-applied <id>...] [--dir <dir>] [--no-contract]";

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    apply: false,
    noContract: false,
    markApplied: [],
    dir: DEFAULT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--no-contract") {
      args.noContract = true;
    } else if (arg === "--dir") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`--dir needs a value\n${USAGE}`);
      }
      args.dir = path.resolve(value);
      i += 1;
    } else if (arg === "--mark-applied") {
      while (argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
        args.markApplied.push(argv[i + 1] as string);
        i += 1;
      }
      if (args.markApplied.length === 0) {
        throw new Error(`--mark-applied needs at least one id\n${USAGE}`);
      }
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  if (args.apply && args.markApplied.length > 0) {
    throw new Error(`--apply and --mark-applied are separate runs\n${USAGE}`);
  }
  return args;
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function appliedBy(): string {
  const actor = process.env.GITHUB_ACTOR || os.userInfo().username;
  const sha = process.env.GITHUB_SHA || gitHead();
  return `${actor}@${sha}`;
}

const logger: MigrationLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`warning: ${message}`),
  error: (message) => console.error(`error: ${message}`),
};

function printPlan(plan: MigrationPlan): void {
  console.log(
    `migrations: ${plan.files.length} on disk, ${plan.applied.length} applied, ` +
      `${plan.pending.length} pending, ${plan.drift.length} drifted, ${plan.orphans.length} orphaned`,
  );
  for (const file of plan.pending) {
    const flags = [
      file.headers.baseline ? "baseline" : null,
      file.headers.noTransaction ? "no-transaction" : null,
      file.headers.expand ? "expand" : null,
      file.headers.contract ? "contract" : null,
    ].filter((flag): flag is string => flag !== null);
    console.log(
      `  pending  ${file.id}${flags.length ? ` [${flags.join(", ")}]` : ""}`,
    );
  }
  for (const problem of planProblems(plan)) {
    console.error(`  ${problem}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const url = assertDirectConnection(process.env.DATABASE_URL);
  const files = loadMigrations(args.dir);
  const client = await openClient(url);
  try {
    if (args.markApplied.length > 0) {
      await markApplied(client, files, args.markApplied, appliedBy(), logger);
    }
    const plan = planMigrations(files, await readLedger(client));
    printPlan(plan);
    if (planProblems(plan).length > 0) {
      return 1;
    }
    // A contract file removes what the previous revision may still read, and
    // a www/worker deploy is a separate manual step that can lag main. So the
    // unattended path refuses it; a person applies it after the deploy.
    const contracts = plan.pending.filter((file) => file.headers.contract);
    if (args.noContract && contracts.length > 0) {
      console.error(
        `refusing: pending contract migration(s) ${contracts.map((f) => f.id).join(", ")}; ` +
          "deploy the code that no longer reads the removed schema, then apply without --no-contract",
      );
      return 2;
    }
    if (!args.apply) {
      if (args.markApplied.length === 0 && plan.pending.length > 0) {
        console.log("dry run: pass --apply to apply the pending migrations");
      }
      return 0;
    }
    const result = await applyMigrations(client, plan, {
      appliedBy: appliedBy(),
      logger,
    });
    console.log(`applied ${result.applied.length} migration(s)`);
    return 0;
  } finally {
    await client.end();
  }
}

async function run(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(
      `migrate: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

void run();
