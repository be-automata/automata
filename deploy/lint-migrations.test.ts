import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  lintMigration,
  main,
  parseHeaders,
  tokenize,
  type RuleId,
} from "./lint-migrations.ts";

const ID = "2026-11-01-example";
const KNOWN = ["2026-10-01-expand", ID];

function rules(sql: string): RuleId[] {
  return lintMigration({ id: ID, sql, knownIds: KNOWN }).map((f) => f.rule);
}

describe("tokenize", () => {
  test("drops comments, blanks strings, lifts dollar bodies", () => {
    const statements = tokenize(
      [
        "-- DROP TABLE commented_out;",
        "/* DROP TABLE /* nested */ also_out; */",
        "UPDATE t SET note = 'DROP TABLE x; still a string' WHERE id = 1;",
        "DO $body$ BEGIN DROP TABLE inside_body; END $body$;",
      ].join("\n"),
    );
    assert.equal(statements.length, 2);
    assert.equal(statements[0]?.text, "UPDATE T SET NOTE = '' WHERE ID = 1");
    assert.match(statements[1]?.bodies[0] ?? "", /DROP TABLE INSIDE_BODY/);
  });
});

describe("L1 destructive statements need contract + expand-ref", () => {
  const destructive = [
    "DROP TABLE IF EXISTS old_table;",
    "ALTER TABLE t DROP COLUMN IF EXISTS c;",
    "DROP INDEX IF EXISTS old_index;",
    "ALTER TABLE t RENAME COLUMN a TO b;",
    "ALTER TABLE t ALTER COLUMN c TYPE bigint;",
    "TRUNCATE t;",
    "DELETE FROM t;",
  ];
  for (const sql of destructive) {
    test(`bad: ${sql}`, () => {
      assert.ok(rules(sql).includes("L1"), sql);
    });
    test(`good with contract: ${sql}`, () => {
      const header =
        "-- migrate:contract\n-- migrate:expand-ref 2026-10-01-expand\n";
      assert.ok(!rules(header + sql).includes("L1"), sql);
    });
  }

  test("contract with an expand-ref to an unknown or later id is rejected", () => {
    assert.ok(
      rules(
        "-- migrate:contract\n-- migrate:expand-ref 2099-01-01-later\nDROP TABLE IF EXISTS t;",
      ).includes("L1"),
    );
    assert.ok(
      rules("-- migrate:contract\nDROP TABLE IF EXISTS t;").includes("L1"),
    );
  });

  test("DELETE with WHERE and DROP CONSTRAINT/DEFAULT are not destructive", () => {
    assert.deepEqual(rules("DELETE FROM t WHERE expired = true;"), []);
    assert.deepEqual(
      rules("ALTER TABLE t ALTER COLUMN c DROP DEFAULT, DROP CONSTRAINT x;"),
      [],
    );
  });
});

describe("L2 ADD COLUMN NOT NULL needs a DEFAULT", () => {
  test("bad", () => {
    assert.deepEqual(
      rules("ALTER TABLE t ADD COLUMN IF NOT EXISTS c text NOT NULL;"),
      ["L2"],
    );
  });
  test("good", () => {
    assert.deepEqual(
      rules(
        "ALTER TABLE t ADD COLUMN IF NOT EXISTS c text NOT NULL DEFAULT 'x';",
      ),
      [],
    );
  });
});

describe("L3 CREATE INDEX needs CONCURRENTLY on an existing table", () => {
  test("bad", () => {
    assert.deepEqual(rules("CREATE INDEX IF NOT EXISTS i ON t (c);"), ["L3"]);
  });
  test("good: concurrently, alone, no-transaction", () => {
    assert.deepEqual(
      rules(
        "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);",
      ),
      [],
    );
  });
  test("good: table created in the same file", () => {
    assert.deepEqual(
      rules(
        'CREATE TABLE IF NOT EXISTS "fresh" (id text);\nCREATE INDEX IF NOT EXISTS "fresh_i" ON "public"."fresh" ("id");',
      ),
      [],
    );
  });
});

describe("L4 CONCURRENTLY and no-transaction files", () => {
  test("bad: CONCURRENTLY in a transactional file", () => {
    assert.deepEqual(
      rules("CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);"),
      ["L4"],
    );
  });
  test("bad: no-transaction file with two statements", () => {
    assert.deepEqual(
      rules(
        "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS j ON t (d);",
      ),
      ["L4"],
    );
  });
  test("good", () => {
    assert.deepEqual(
      rules(
        "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);",
      ),
      [],
    );
  });
});

describe("L5 idempotent DDL", () => {
  const bad = [
    "CREATE TABLE t (id text);",
    "ALTER TABLE t ADD COLUMN c text;",
    "ALTER TABLE t ADD CONSTRAINT t_fk FOREIGN KEY (c) REFERENCES u (id);",
    "DO $$ BEGIN ALTER TABLE t ADD CONSTRAINT t_fk FOREIGN KEY (c) REFERENCES u (id); END $$;",
    "CREATE EXTENSION pgcrypto;",
  ];
  for (const sql of bad) {
    test(`bad: ${sql}`, () => {
      assert.deepEqual(rules(sql), ["L5"]);
    });
  }
  test("good", () => {
    assert.deepEqual(
      rules(
        [
          "CREATE TABLE IF NOT EXISTS t (id text);",
          "ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;",
          "DO $$ BEGIN ALTER TABLE t ADD CONSTRAINT t_fk FOREIGN KEY (c) REFERENCES u (id);",
          "EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;",
          "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
        ].join("\n"),
      ),
      [],
    );
  });
});

describe("L6 transaction control in a transactional file", () => {
  test("bad", () => {
    assert.deepEqual(
      rules("BEGIN;\nUPDATE t SET c = 1 WHERE id = 2;\nCOMMIT;"),
      ["L6", "L6"],
    );
  });
  test("good: BEGIN inside a DO body is not transaction control", () => {
    assert.deepEqual(
      rules("DO $$ BEGIN UPDATE t SET c = 1 WHERE id = 2; END $$;"),
      [],
    );
  });
});

describe("lint-ignore", () => {
  test("suppresses one rule when a reason is given", () => {
    assert.deepEqual(
      rules(
        "-- migrate:lint-ignore L3 table holds 12 rows\nCREATE INDEX IF NOT EXISTS i ON t (c);",
      ),
      [],
    );
  });
  test("is ignored without a reason", () => {
    assert.equal(parseHeaders("-- migrate:lint-ignore L3").lintIgnore.size, 0);
    assert.deepEqual(
      rules(
        "-- migrate:lint-ignore L3\nCREATE INDEX IF NOT EXISTS i ON t (c);",
      ),
      ["L3"],
    );
  });
});

describe("main", () => {
  test("skips grandfathered files, tolerates a missing one, fails on findings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lint-migrations-"));
    writeFileSync(path.join(dir, "2026-01-01-old.sql"), "BEGIN; COMMIT;");
    writeFileSync(
      path.join(dir, "lint-grandfathered.json"),
      JSON.stringify({ ids: ["0000-baseline", "2026-01-01-old"] }),
    );
    assert.equal(main([dir]), 0);

    writeFileSync(
      path.join(dir, "2026-02-01-new.sql"),
      "CREATE INDEX IF NOT EXISTS i ON t (c);",
    );
    assert.equal(main([dir]), 1);
  });

  test("an unreadable directory fails closed", () => {
    assert.equal(main([path.join(tmpdir(), "does-not-exist-lint-dir")]), 1);
  });
});
