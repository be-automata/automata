/**
 * Static lint for the hand-written SQL under deploy/migrations/.
 *
 * WHY THIS EXISTS. Production schema changes ship as hand-written files that a
 * human (and, after the migration runner lands, the runner) applies to a live
 * database with traffic on it. The dangerous shapes are well known and cheap to
 * spot before anything touches a database: a destructive statement without an
 * expand step before it, a NOT NULL column with nothing to backfill, an index
 * build that takes a write lock on a hot table, a CONCURRENTLY that cannot run
 * inside the transaction the runner wraps it in, DDL that fails on a re-run, and
 * a file that opens its own transaction inside the runner's.
 *
 * Rules:
 *   L1  DROP TABLE / DROP COLUMN / DROP INDEX, RENAME, ALTER ... TYPE, TRUNCATE,
 *       DELETE without WHERE need `-- migrate:contract` AND
 *       `-- migrate:expand-ref <earlier migration id>`.
 *   L2  ADD COLUMN ... NOT NULL without a DEFAULT.
 *   L3  CREATE INDEX without CONCURRENTLY, unless the table is created in the
 *       same file (an empty new table has no traffic to block).
 *   L4  CONCURRENTLY in a file without `-- migrate:no-transaction`, or a
 *       no-transaction file with more than one statement (a multi-statement
 *       simple query is an implicit transaction, which breaks CONCURRENTLY).
 *   L5  Non-idempotent DDL: CREATE / DROP / ADD COLUMN without IF [NOT] EXISTS,
 *       or ADD CONSTRAINT outside a DO block that catches duplicate_object.
 *   L6  BEGIN / COMMIT in a transactional file (the runner owns the transaction).
 *
 * Suppress one rule for one file with a reason:
 *   -- migrate:lint-ignore L3 <why this is safe here>
 *
 * Files listed in <dir>/lint-grandfathered.json predate this lint and are
 * skipped; a listed file that does not exist (yet) is tolerated.
 *
 *   Usage:  node deploy/lint-migrations.ts [deploy/migrations]
 *   Exit:   0 = no findings; 1 = at least one finding, or the directory is
 *           unreadable.
 *
 * Zero dependencies on purpose: deploy/ has no package.json, and this runs with
 * Node's own type stripping (so: erasable TypeScript only, no enums).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuleId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

export interface MigrationHeaders {
  noTransaction: boolean;
  baseline: boolean;
  expand: boolean;
  contract: boolean;
  /** Ids named by `-- migrate:expand-ref <id>`. */
  expandRefs: string[];
  /** Rule id -> reason, from `-- migrate:lint-ignore L<n> <reason>`. */
  lintIgnore: Map<RuleId, string>;
}

export interface Finding {
  id: string;
  rule: RuleId;
  /** 1-based statement index within the file; 0 for file-level findings. */
  statement: number;
  message: string;
  excerpt: string;
}

export interface LintInput {
  id: string;
  sql: string;
  /** Parsed from `sql` when omitted. */
  headers?: MigrationHeaders;
  /**
   * Every migration id in the directory. When given, an expand-ref must name
   * one of these that sorts before `id`.
   */
  knownIds?: readonly string[];
}

interface Statement {
  /** Uppercased, comments/strings/dollar bodies stripped, quotes removed. */
  text: string;
  /** The same text in its original case, for messages. */
  display: string;
  /** Dollar-quoted bodies inside this statement (uppercased). */
  bodies: string[];
}

const RULE_IDS: readonly RuleId[] = ["L1", "L2", "L3", "L4", "L5", "L6"];

function isRuleId(value: string): value is RuleId {
  return (RULE_IDS as readonly string[]).includes(value);
}

/**
 * Directives are `-- migrate:<name>` comment lines anywhere in the file. They
 * are read from the raw text (the tokenizer drops comments).
 */
export function parseHeaders(sql: string): MigrationHeaders {
  const headers: MigrationHeaders = {
    noTransaction: false,
    baseline: false,
    expand: false,
    contract: false,
    expandRefs: [],
    lintIgnore: new Map(),
  };
  for (const line of sql.split(/\r?\n/)) {
    const match = /^\s*--\s*migrate:([a-z-]+)(?:[=\s]+(.*))?$/i.exec(line);
    if (!match) continue;
    const name = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (name === "no-transaction") headers.noTransaction = true;
    else if (name === "baseline") headers.baseline = true;
    else if (name === "expand") headers.expand = true;
    else if (name === "contract") headers.contract = true;
    else if (name === "expand-ref") {
      const ref = rest.split(/\s+/)[0];
      if (ref) headers.expandRefs.push(ref);
    } else if (name === "lint-ignore") {
      const ignore = /^(L\d+)\s+(.+)$/i.exec(rest);
      const rule = ignore?.[1]?.toUpperCase() ?? "";
      const reason = ignore?.[2]?.trim() ?? "";
      if (isRuleId(rule) && reason.length > 0) {
        headers.lintIgnore.set(rule, reason);
      }
    }
  }
  return headers;
}

/**
 * Split into top-level statements. Line and (nested) block comments are
 * dropped, single-quoted literals are blanked to '', dollar-quoted bodies are
 * lifted out into `bodies` and replaced by `$$`, and double quotes around
 * identifiers are removed.
 */
export function tokenize(sql: string): Statement[] {
  const statements: Statement[] = [];
  let text = "";
  let bodies: string[] = [];
  const flush = (): void => {
    const display = text.replace(/\s+/g, " ").trim();
    if (display.length > 0) {
      statements.push({ text: display.toUpperCase(), display, bodies });
    }
    text = "";
    bodies = [];
  };

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      text += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      text += " ";
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      text += "''";
      continue;
    }
    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      const stop = end === -1 ? sql.length : end;
      text += sql.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        const delimiter = tag[0];
        const start = i + delimiter.length;
        const end = sql.indexOf(delimiter, start);
        const stop = end === -1 ? sql.length : end;
        bodies.push(sql.slice(start, stop).toUpperCase());
        text += " $$ ";
        i = end === -1 ? sql.length : end + delimiter.length;
        continue;
      }
    }
    if (ch === ";") {
      flush();
      i += 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return statements;
}

/** Normalize a table reference: no schema prefix, lowercase. */
function tableName(raw: string): string {
  const name = raw.toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

/** Split an ALTER TABLE action list on top-level commas. */
function splitActions(actions: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of actions) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

const ALTER_TABLE = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([A-Z0-9_.]+) (.*)$/;
const NOT_A_COLUMN_AFTER_ADD =
  /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/;
const NOT_A_COLUMN_AFTER_DROP =
  /^(?:CONSTRAINT|DEFAULT|NOT|IDENTITY|EXPRESSION)\b/;
const DUPLICATE_HANDLER =
  /EXCEPTION\s+WHEN\s+(?:[A-Z_]+\s+OR\s+)*DUPLICATE_OBJECT\b/;

function excerptOf(statement: Statement): string {
  return statement.display.length > 120
    ? `${statement.display.slice(0, 117)}...`
    : statement.display;
}

function isTransactionControl(text: string): boolean {
  return (
    /^(?:BEGIN(?: TRANSACTION| WORK)?|START TRANSACTION|COMMIT(?: TRANSACTION| WORK)?|END(?: TRANSACTION| WORK)?|ROLLBACK(?: TRANSACTION| WORK)?)(?: .*)?$/.test(
      text,
    ) && !/^BEGIN ATOMIC\b/.test(text)
  );
}

export function lintMigration(input: LintInput): Finding[] {
  const headers = input.headers ?? parseHeaders(input.sql);
  const statements = tokenize(input.sql);
  const raw: Array<Omit<Finding, "id">> = [];
  const add = (
    rule: RuleId,
    statementIndex: number,
    message: string,
    excerpt: string,
  ): void => {
    raw.push({ rule, statement: statementIndex, message, excerpt });
  };

  const createdTables = new Set<string>();
  for (const statement of statements) {
    const created =
      /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([A-Z0-9_.]+)/.exec(
        statement.text,
      );
    if (created?.[1]) createdTables.add(tableName(created[1]));
  }

  // L1 needs a valid contract declaration; work it out once per file.
  const knownIds = input.knownIds;
  const validRef = headers.expandRefs.some(
    (ref) =>
      ref < input.id && (knownIds === undefined || knownIds.includes(ref)),
  );
  const contractProblem = !headers.contract
    ? "needs `-- migrate:contract` and `-- migrate:expand-ref <earlier id>` (ship the expand step first)"
    : !validRef
      ? "`-- migrate:contract` needs `-- migrate:expand-ref <id>` naming an EARLIER migration in this directory"
      : null;

  statements.forEach((statement, position) => {
    const n = position + 1;
    const text = statement.text;
    const excerpt = excerptOf(statement);
    const destructive = (what: string): void => {
      if (contractProblem) add("L1", n, `${what} ${contractProblem}`, excerpt);
    };

    // ── L6: the runner owns the transaction ───────────────────────────────
    if (!headers.noTransaction && isTransactionControl(text)) {
      add(
        "L6",
        n,
        "transaction control in a transactional file: the runner wraps every file in BEGIN/COMMIT; remove it",
        excerpt,
      );
      return;
    }

    // ── DROP TABLE / DROP INDEX ───────────────────────────────────────────
    const drop = /^DROP (TABLE|INDEX)( CONCURRENTLY)?( IF EXISTS)? /.exec(text);
    if (drop) {
      destructive(`DROP ${drop[1]}`);
      if (!drop[3]) {
        add("L5", n, `DROP ${drop[1]} without IF EXISTS`, excerpt);
      }
    }

    // ── CREATE TABLE ──────────────────────────────────────────────────────
    if (
      /^CREATE (?:UNLOGGED )?TABLE /.test(text) &&
      !/^CREATE (?:UNLOGGED )?TABLE IF NOT EXISTS /.test(text)
    ) {
      add("L5", n, "CREATE TABLE without IF NOT EXISTS", excerpt);
    }

    // ── CREATE INDEX ──────────────────────────────────────────────────────
    const createIndex =
      /^CREATE (?:UNIQUE )?INDEX( CONCURRENTLY)?( IF NOT EXISTS)?(?: [A-Z0-9_.]+)? ON (?:ONLY )?([A-Z0-9_.]+)/.exec(
        text,
      );
    if (createIndex) {
      const table = tableName(createIndex[3] ?? "");
      if (!createIndex[1] && !createdTables.has(table)) {
        add(
          "L3",
          n,
          `CREATE INDEX on existing table ${table} without CONCURRENTLY (blocks writes for the whole build); use CREATE INDEX CONCURRENTLY in a \`-- migrate:no-transaction\` file`,
          excerpt,
        );
      }
      if (!createIndex[2]) {
        add("L5", n, "CREATE INDEX without IF NOT EXISTS", excerpt);
      }
    }

    // ── L4: CONCURRENTLY cannot run inside a transaction ─────────────────
    if (/\bINDEX CONCURRENTLY\b/.test(text) && !headers.noTransaction) {
      add(
        "L4",
        n,
        "CONCURRENTLY inside a transaction fails; put it alone in a `-- migrate:no-transaction` file",
        excerpt,
      );
    }

    // ── Other CREATE ... without IF NOT EXISTS ────────────────────────────
    const otherCreate = /^CREATE (EXTENSION|SCHEMA|SEQUENCE) /.exec(text);
    if (otherCreate && !/^CREATE [A-Z]+ IF NOT EXISTS /.test(text)) {
      add("L5", n, `CREATE ${otherCreate[1]} without IF NOT EXISTS`, excerpt);
    }
    if (/^CREATE TYPE /.test(text)) {
      add(
        "L5",
        n,
        "CREATE TYPE has no IF NOT EXISTS; wrap it in DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$",
        excerpt,
      );
    }

    // ── RENAME anywhere outside ALTER TABLE (ALTER INDEX ... RENAME etc.) ─
    if (/^ALTER (?:INDEX|SEQUENCE|VIEW|TYPE|SCHEMA) .* RENAME\b/.test(text)) {
      destructive("RENAME");
    }

    // ── TRUNCATE / DELETE without WHERE ───────────────────────────────────
    if (/^TRUNCATE\b/.test(text)) destructive("TRUNCATE");
    if (/^DELETE FROM /.test(text) && !/\bWHERE\b/.test(text)) {
      destructive("DELETE without WHERE");
    }

    // ── ALTER TABLE actions ───────────────────────────────────────────────
    const alter = ALTER_TABLE.exec(text);
    if (alter) {
      const actions = alter[2] ?? "";
      if (/^RENAME\b/.test(actions)) destructive("RENAME");
      for (const action of splitActions(actions)) {
        const addMatch = /^ADD (COLUMN )?(IF NOT EXISTS )?(.*)$/.exec(action);
        if (addMatch) {
          const rest = addMatch[3] ?? "";
          if (!addMatch[1] && NOT_A_COLUMN_AFTER_ADD.test(rest)) {
            if (/^CONSTRAINT\b/.test(rest)) {
              add(
                "L5",
                n,
                "ADD CONSTRAINT fails on a re-run; wrap it in DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$",
                excerpt,
              );
            }
            continue;
          }
          if (!addMatch[2]) {
            add("L5", n, "ADD COLUMN without IF NOT EXISTS", excerpt);
          }
          if (
            /\bNOT NULL\b/.test(rest) &&
            !/\bDEFAULT\b/.test(rest) &&
            !/\bGENERATED\b/.test(rest)
          ) {
            add(
              "L2",
              n,
              "ADD COLUMN ... NOT NULL without DEFAULT fails on any table with rows; add a DEFAULT (or add it nullable, backfill, then SET NOT NULL)",
              excerpt,
            );
          }
          continue;
        }
        const dropMatch = /^DROP (COLUMN )?(IF EXISTS )?(.*)$/.exec(action);
        if (dropMatch) {
          const rest = dropMatch[3] ?? "";
          if (!dropMatch[1] && NOT_A_COLUMN_AFTER_DROP.test(rest)) continue;
          destructive("DROP COLUMN");
          if (!dropMatch[2]) {
            add("L5", n, "DROP COLUMN without IF EXISTS", excerpt);
          }
          continue;
        }
        if (/^ALTER (?:COLUMN )?[A-Z0-9_]+ (?:SET DATA )?TYPE\b/.test(action)) {
          destructive("ALTER COLUMN ... TYPE");
          continue;
        }
        if (/^RENAME\b/.test(action)) continue; // reported above
      }
    }

    // ── DO bodies: ADD CONSTRAINT must catch duplicate_object ─────────────
    for (const body of statement.bodies) {
      const flat = body.replace(/\s+/g, " ");
      if (/\bADD CONSTRAINT\b/.test(flat) && !DUPLICATE_HANDLER.test(flat)) {
        add(
          "L5",
          n,
          "ADD CONSTRAINT inside a DO block without EXCEPTION WHEN duplicate_object fails on a re-run",
          excerpt,
        );
      }
    }
  });

  if (headers.noTransaction && statements.length > 1) {
    add(
      "L4",
      0,
      `a \`-- migrate:no-transaction\` file must hold exactly ONE statement (found ${statements.length}); a multi-statement simple query runs as one implicit transaction`,
      "",
    );
  }

  return raw
    .filter((finding) => !headers.lintIgnore.has(finding.rule))
    .map((finding) => ({ id: input.id, ...finding }));
}

interface Grandfathered {
  ids: string[];
}

function readGrandfathered(dir: string): Set<string> {
  const file = path.join(dir, "lint-grandfathered.json");
  if (!existsSync(file)) return new Set();
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const ids = (parsed as Partial<Grandfathered> | null)?.ids;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
    throw new Error(`${file}: expected {"ids": string[]}`);
  }
  return new Set(ids);
}

export function main(argv: readonly string[]): number {
  const dir = argv[0] ?? "deploy/migrations";
  let files: string[];
  let grandfathered: Set<string>;
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    grandfathered = readGrandfathered(dir);
  } catch (error) {
    console.error(
      `lint-migrations: FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const ids = files.map((name) => name.slice(0, -".sql".length));
  for (const id of grandfathered) {
    if (!ids.includes(id)) {
      console.log(`lint-migrations: note: grandfathered ${id} not present`);
    }
  }

  const findings: Finding[] = [];
  let linted = 0;
  for (const [i, name] of files.entries()) {
    const id = ids[i] ?? name;
    if (grandfathered.has(id)) continue;
    linted += 1;
    const sql = readFileSync(path.join(dir, name), "utf8");
    findings.push(...lintMigration({ id, sql, knownIds: ids }));
  }

  for (const finding of findings) {
    const where =
      finding.statement > 0 ? ` statement ${finding.statement}` : "";
    console.error(
      `${finding.id}: ${finding.rule}${where}: ${finding.message}` +
        (finding.excerpt ? `\n    ${finding.excerpt}` : ""),
    );
  }
  const skipped = files.length - linted;
  if (findings.length > 0) {
    console.error(
      `lint-migrations: FAIL: ${findings.length} finding(s) in ${linted} file(s) (${skipped} grandfathered). ` +
        "Suppress a rule only with `-- migrate:lint-ignore L<n> <reason>`.",
    );
    return 1;
  }
  console.log(
    `lint-migrations: OK — ${linted} file(s) linted, ${skipped} grandfathered`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
