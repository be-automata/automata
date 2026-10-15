import type { ClientBase } from "pg";

import { LEDGER_TABLE } from "../ledger";

/** The ledger is the runner's own table; one side of a drift check never has it. */
const LEDGER_NAME = LEDGER_TABLE.replace(/^public\./, "");

export type CatalogKind =
  | "table"
  | "column"
  | "constraint"
  | "index"
  | "enum"
  | "sequence"
  | "extension";

/**
 * One schema object. `table` is null for objects that do not belong to a
 * table (enums, sequences, extensions). `definition` is the canonical text the
 * diff compares; names are part of the identity, never normalized away,
 * because ON CONFLICT targets and DROP CONSTRAINT statements name them.
 */
export interface CatalogEntry {
  kind: CatalogKind;
  table: string | null;
  name: string;
  definition: string;
}

export interface Catalog {
  entries: CatalogEntry[];
}

function compareEntries(a: CatalogEntry, b: CatalogEntry): number {
  return (
    a.kind.localeCompare(b.kind) ||
    (a.table ?? "").localeCompare(b.table ?? "") ||
    a.name.localeCompare(b.name)
  );
}

export function entryKey(entry: {
  kind: string;
  table: string | null;
  name: string;
}): string {
  return `${entry.kind}:${entry.table ?? ""}:${entry.name}`;
}

async function rows<T extends object>(
  c: ClientBase,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await c.query<T>(sql, params);
  return result.rows;
}

/**
 * Reads schema `public` from pg_catalog (excluding the migration ledger) into
 * a sorted, comparable snapshot. Column order (attnum) is deliberately not
 * compared: ADD COLUMN appends, so a migrated database and a fresh push can
 * hold the same columns in a different order.
 *
 * NOT NULL constraints (contype 'n', catalogued since Postgres 18) are left
 * out of the constraint list: the column's `not null` flag already carries
 * them, and their generated names add nothing.
 */
export async function snapshotCatalog(c: ClientBase): Promise<Catalog> {
  const [tables, columns, constraints, indexes, enums, sequences, extensions] =
    await Promise.all([
      rows<{ table: string }>(
        c,
        `SELECT cl.relname AS table
           FROM pg_class cl
           JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = 'public' AND cl.relkind IN ('r', 'p')
            AND cl.relname <> $1`,
        [LEDGER_NAME],
      ),
      rows<{
        table: string;
        name: string;
        type: string;
        not_null: boolean;
        default_expr: string | null;
        identity: string;
        generated: string;
      }>(
        c,
        `SELECT cl.relname AS table,
                a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS not_null,
                CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS default_expr,
                a.attidentity AS identity,
                CASE WHEN a.attgenerated <> '' THEN a.attgenerated::text || ' ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END AS generated
           FROM pg_attribute a
           JOIN pg_class cl ON cl.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = cl.relnamespace
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE n.nspname = 'public' AND cl.relkind IN ('r', 'p')
            AND cl.relname <> $1
            AND a.attnum > 0 AND NOT a.attisdropped`,
        [LEDGER_NAME],
      ),
      rows<{ table: string; name: string; definition: string }>(
        c,
        `SELECT cl.relname AS table,
                con.conname AS name,
                pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = 'public' AND con.contype <> 'n'
            AND cl.relname <> $1`,
        [LEDGER_NAME],
      ),
      rows<{ table: string; name: string; definition: string }>(
        c,
        `SELECT t.relname AS table,
                i.relname AS name,
                pg_get_indexdef(ix.indexrelid) AS definition
           FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_class t ON t.oid = ix.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname <> $1`,
        [LEDGER_NAME],
      ),
      rows<{ name: string; labels: string[] }>(
        c,
        `SELECT t.typname AS name,
                array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = 'public'
          GROUP BY t.typname`,
      ),
      rows<{
        name: string;
        type: string;
        start: string;
        increment: string;
        min: string;
        max: string;
        cycle: boolean;
      }>(
        c,
        `SELECT cl.relname AS name,
                format_type(s.seqtypid, NULL) AS type,
                s.seqstart::text AS start,
                s.seqincrement::text AS increment,
                s.seqmin::text AS min,
                s.seqmax::text AS max,
                s.seqcycle AS cycle
           FROM pg_sequence s
           JOIN pg_class cl ON cl.oid = s.seqrelid
           JOIN pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname = 'public'`,
      ),
      rows<{ name: string; version: string }>(
        c,
        `SELECT extname AS name, extversion AS version FROM pg_extension`,
      ),
    ]);

  const entries: CatalogEntry[] = [
    ...tables.map((t) => ({
      kind: "table" as const,
      table: t.table,
      name: t.table,
      definition: "table",
    })),
    ...columns.map((col) => ({
      kind: "column" as const,
      table: col.table,
      name: col.name,
      definition: [
        col.type,
        col.not_null ? "not null" : "null",
        `default ${col.default_expr ?? "none"}`,
        col.identity ? `identity ${col.identity}` : null,
        col.generated ? `generated ${col.generated}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" | "),
    })),
    ...constraints.map((con) => ({
      kind: "constraint" as const,
      table: con.table,
      name: con.name,
      definition: con.definition,
    })),
    ...indexes.map((ix) => ({
      kind: "index" as const,
      table: ix.table,
      name: ix.name,
      definition: ix.definition,
    })),
    ...enums.map((en) => ({
      kind: "enum" as const,
      table: null,
      name: en.name,
      definition: en.labels.join(", "),
    })),
    ...sequences.map((seq) => ({
      kind: "sequence" as const,
      table: null,
      name: seq.name,
      definition: `${seq.type} start ${seq.start} increment ${seq.increment} min ${seq.min} max ${seq.max}${seq.cycle ? " cycle" : ""}`,
    })),
    ...extensions.map((ext) => ({
      kind: "extension" as const,
      table: null,
      name: ext.name,
      definition: ext.version,
    })),
  ];
  entries.sort(compareEntries);
  return { entries };
}
