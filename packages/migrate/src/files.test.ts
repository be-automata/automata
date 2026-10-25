import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checksumOf,
  loadMigrations,
  MigrationFileError,
  parseHeaders,
  splitStatements,
  toMigrationFile,
} from "./files";
import { planMigrations } from "./runner";

const REPO_MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../deploy/migrations",
);

describe("parseHeaders", () => {
  it("reads directives from the leading comment block only", () => {
    const headers = parseHeaders(
      [
        "-- migrate:no-transaction",
        "-- migrate:lock-timeout=30s",
        "--   migrate:statement-timeout=10min",
        "-- migrate:expand",
        "",
        "CREATE INDEX CONCURRENTLY x ON t (a);",
        "-- migrate:baseline",
      ].join("\n"),
    );
    expect(headers).toEqual({
      noTransaction: true,
      baseline: false,
      lockTimeout: "30s",
      statementTimeout: "10min",
      expand: true,
      contract: false,
    });
  });

  it("rejects a malformed duration", () => {
    expect(() => parseHeaders("-- migrate:lock-timeout=5s;DROP\n")).toThrow(
      MigrationFileError,
    );
  });
});

describe("checksumOf", () => {
  it("is stable across CRLF and LF line endings", () => {
    expect(checksumOf("SELECT 1;\r\nSELECT 2;\r\n")).toBe(
      checksumOf("SELECT 1;\nSELECT 2;\n"),
    );
    expect(checksumOf("SELECT 1;")).not.toBe(checksumOf("SELECT 2;"));
  });
});

describe("splitStatements", () => {
  it("ignores semicolons in comments, strings, identifiers and dollar quotes", () => {
    const sql = `
      -- a comment; with a semicolon
      /* block; /* nested; */ still comment; */
      INSERT INTO "we;ird" VALUES ('it''s; fine');
      DO $body$ BEGIN PERFORM 1; END $body$;
      DO $$ BEGIN PERFORM 2; END $$;
      -- trailing comment only;
    `;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(`'it''s; fine'`);
    expect(statements[1]).toContain("PERFORM 1;");
  });
});

describe("toMigrationFile", () => {
  it("holds a no-transaction file to exactly one statement", () => {
    expect(() =>
      toMigrationFile(
        "/x/001-two.sql",
        "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);\n",
      ),
    ).toThrow(/exactly one statement \(found 2\)/);
    const ok = toMigrationFile(
      "/x/002-one.sql",
      "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);\n",
    );
    expect(ok.id).toBe("002-one");
    expect(ok.headers.noTransaction).toBe(true);
  });

  it("refuses transaction control in a transactional file", () => {
    expect(() =>
      toMigrationFile("/x/001.sql", "BEGIN;\nSELECT 1;\nCOMMIT;\n"),
    ).toThrow(/transaction control \(BEGIN\)/);
    // BEGIN inside a DO body is plpgsql, not transaction control.
    expect(() =>
      toMigrationFile("/x/002.sql", "DO $$ BEGIN PERFORM 1; END $$;\n"),
    ).not.toThrow();
  });
});

describe("deploy/migrations", () => {
  it("loads the baseline first, then the dated deltas", () => {
    const files = loadMigrations(REPO_MIGRATIONS);
    expect(files.map((f) => f.id)).toEqual([
      "0000-baseline",
      "2026-08-04-better-auth-1.6-apikey-rename",
      "2026-09-02-165-retire-app-side-rows",
      "2026-10-08-organization-environment",
      "2026-10-14-environment-org-unique",
      "2026-10-19-knowledge-plane",
      "2026-10-22-queued-at",
      "2026-10-22-review-rerun",
      "2026-10-23-knowledge-org-controls",
      "2026-10-24-knowledge-op-fingerprint-index",
      "2026-10-25-knowledge-updated-at",
      "2026-10-26-delivery-loop",
    ]);
    expect(files[0]?.headers.baseline).toBe(true);
    expect(files.slice(1).every((f) => !f.headers.baseline)).toBe(true);
  });
});

describe("planMigrations", () => {
  const a = toMigrationFile("/x/001-a.sql", "SELECT 1;");
  const b = toMigrationFile("/x/002-b.sql", "SELECT 2;");
  const row = (id: string, checksum: string) => ({
    id,
    checksum,
    appliedAt: new Date(0),
    appliedBy: "test@0",
    mode: "applied" as const,
  });

  it("splits files into applied, pending, drift and orphans", () => {
    const plan = planMigrations(
      [a, b],
      [row("001-a", "not-the-checksum"), row("000-gone", "x")],
    );
    expect(plan.pending.map((f) => f.id)).toEqual(["002-b"]);
    expect(plan.applied).toEqual([]);
    expect(plan.drift).toEqual([
      { id: "001-a", expected: "not-the-checksum", actual: a.checksum },
    ]);
    expect(plan.orphans.map((o) => o.id)).toEqual(["000-gone"]);
  });

  it("is all-applied when every checksum matches", () => {
    const plan = planMigrations(
      [a, b],
      [row("001-a", a.checksum), row("002-b", b.checksum)],
    );
    expect(plan.pending).toEqual([]);
    expect(plan.applied.map((f) => f.id)).toEqual(["001-a", "002-b"]);
  });
});
