import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "./schema";

/**
 * The columns and unique indexes schema.ts declares, read from the Drizzle
 * table objects themselves. deploy/assert-schema-ready.ts derives its required
 * lists from these, so the pre-deploy gate can no longer drift from the schema
 * by someone forgetting to append to a hand-kept list.
 */

export interface SchemaColumn {
  table: string;
  column: string;
}

/** Postgres truncates identifiers to NAMEDATALEN - 1 bytes. */
const MAX_IDENTIFIER_LENGTH = 63;

function schemaTables(): PgTable[] {
  const tables = new Set<PgTable>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) tables.add(value);
  }
  return [...tables];
}

/** Every (table, column) pair in schema.ts, sorted. */
export function listSchemaColumns(): SchemaColumn[] {
  const columns: SchemaColumn[] = [];
  for (const table of schemaTables()) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      columns.push({ table: config.name, column: column.name });
    }
  }
  return columns.sort(
    (a, b) =>
      a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  );
}

/**
 * The name of every unique index schema.ts declares, sorted: `uniqueIndex()`,
 * table-level `unique()` constraints and column-level `.unique()` (Postgres
 * backs both constraint forms with a unique index of the same name). Primary
 * keys are excluded.
 */
export function listSchemaUniqueIndexes(): string[] {
  const names = new Set<string>();
  for (const table of schemaTables()) {
    const config = getTableConfig(table);
    for (const index of config.indexes) {
      if (index.config.unique && index.config.name) {
        names.add(index.config.name);
      }
    }
    for (const constraint of config.uniqueConstraints) {
      const name = constraint.getName();
      if (name) names.add(name);
    }
    for (const column of config.columns) {
      if (column.isUnique && column.uniqueName) {
        names.add(column.uniqueName);
      }
    }
  }
  return [...names]
    .map((name) => name.slice(0, MAX_IDENTIFIER_LENGTH))
    .sort((a, b) => a.localeCompare(b));
}
