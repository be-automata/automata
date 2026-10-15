import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Directives read from a migration file's leading `--` comment block. */
export interface MigrationHeaders {
  /** Run outside a transaction (required for CREATE INDEX CONCURRENTLY). */
  noTransaction: boolean;
  /** The full-schema snapshot; refused on a database that already has tables. */
  baseline: boolean;
  /** Per-file override of the runner's lock_timeout. */
  lockTimeout?: string;
  /** Per-file override of the runner's statement_timeout. */
  statementTimeout?: string;
  /** Expand/contract phase markers (consumed by the migration linter). */
  expand: boolean;
  contract: boolean;
}

export interface MigrationFile {
  /** Filename without `.sql`; the ledger primary key. */
  id: string;
  /** Absolute path, for error messages. */
  path: string;
  /** File content with CRLF normalized to LF. */
  sql: string;
  /** sha256 hex of the normalized content. */
  checksum: string;
  headers: MigrationHeaders;
}

export class MigrationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationFileError";
  }
}

/** Postgres interval literal accepted by lock_timeout / statement_timeout. */
const DURATION = /^\d+(us|ms|s|min|h|d)?$/;

const TRANSACTION_CONTROL =
  /^(BEGIN|COMMIT|ROLLBACK|END|ABORT|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b/i;

export function isValidDuration(value: string): boolean {
  return DURATION.test(value);
}

export function normalizeSql(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

export function checksumOf(raw: string): string {
  return createHash("sha256").update(normalizeSql(raw), "utf8").digest("hex");
}

/**
 * Directives come only from the LEADING comment block (lines that are blank or
 * start with `--`, up to the first line of SQL), so a `-- migrate:` string in
 * the body or in a trailing verification note is never mistaken for one.
 */
export function parseHeaders(sql: string): MigrationHeaders {
  const headers: MigrationHeaders = {
    noTransaction: false,
    baseline: false,
    expand: false,
    contract: false,
  };
  for (const rawLine of normalizeSql(sql).split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    if (!line.startsWith("--")) {
      break;
    }
    const match = /^--\s*migrate:([a-z-]+)(?:=(\S+))?\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const [, name, value] = match;
    switch (name) {
      case "no-transaction":
        headers.noTransaction = true;
        break;
      case "baseline":
        headers.baseline = true;
        break;
      case "expand":
        headers.expand = true;
        break;
      case "contract":
        headers.contract = true;
        break;
      case "lock-timeout":
      case "statement-timeout": {
        if (!value || !isValidDuration(value)) {
          throw new MigrationFileError(
            `migrate:${name} needs a duration like 5s or 500ms (got ${JSON.stringify(value ?? "")})`,
          );
        }
        if (name === "lock-timeout") {
          headers.lockTimeout = value;
        } else {
          headers.statementTimeout = value;
        }
        break;
      }
      default:
        // Other `migrate:` directives (e.g. lint-ignore, expand-ref) belong to
        // the linter; the runner ignores them.
        break;
    }
  }
  return headers;
}

/**
 * Splits SQL into top-level statements, ignoring `;` inside comments, quoted
 * strings, quoted identifiers and dollar-quoted bodies. Statements that are
 * empty once comments are removed are dropped. Used to hold a no-transaction
 * file to exactly ONE statement: Postgres runs a multi-statement simple query
 * as an implicit transaction, which breaks CREATE INDEX CONCURRENTLY.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let hasCode = false;
  let i = 0;
  const flush = (): void => {
    if (hasCode) {
      statements.push(current.trim());
    }
    current = "";
    hasCode = false;
  };
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      current += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      i = j;
      current += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j + 1);
      hasCode = true;
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? sql.length : close + tag[0].length;
        current += sql.slice(i, end);
        hasCode = true;
        i = end;
        continue;
      }
    }
    if (ch === ";") {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    if (!/\s/.test(ch)) {
      hasCode = true;
    }
    i += 1;
  }
  flush();
  return statements;
}

export function toMigrationFile(filePath: string, raw: string): MigrationFile {
  const sql = normalizeSql(raw);
  const id = path.basename(filePath).replace(/\.sql$/, "");
  let headers: MigrationHeaders;
  try {
    headers = parseHeaders(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MigrationFileError(`${id}: ${message}`);
  }
  const statements = splitStatements(sql);
  if (headers.noTransaction) {
    if (statements.length !== 1) {
      throw new MigrationFileError(
        `${id}: a migrate:no-transaction file must hold exactly one statement (found ${statements.length}); ` +
          "Postgres runs a multi-statement query as one implicit transaction, which breaks CONCURRENTLY",
      );
    }
  } else {
    // The runner wraps a transactional file in its own BEGIN … COMMIT next to
    // the ledger insert. A COMMIT inside the file would end that transaction
    // early and decouple the ledger row from the DDL.
    const control = statements.find((s) =>
      TRANSACTION_CONTROL.test(s.trimStart()),
    );
    if (control) {
      throw new MigrationFileError(
        `${id}: transaction control (${control.split(/\s/)[0]}) is not allowed in a transactional migration; ` +
          "the runner owns the transaction (use -- migrate:no-transaction for a file that must run outside one)",
      );
    }
  }
  return { id, path: filePath, sql, checksum: checksumOf(sql), headers };
}

/** Every `*.sql` file in `dir`, sorted by filename (the apply order). */
export function loadMigrations(dir: string): MigrationFile[] {
  const absolute = path.resolve(dir);
  return readdirSync(absolute)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const filePath = path.join(absolute, name);
      return toMigrationFile(filePath, readFileSync(filePath, "utf8"));
    });
}
