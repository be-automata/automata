import { describe, expect, it } from "vitest";
import {
  SCHEMA_READY,
  SCHEMA_READY_TABLES,
  schemaIsReady,
} from "./hatchet-it-harness";
import type { SchemaReadyCounts } from "./hatchet-it-harness";

/**
 * The readiness predicate the dockerized suites gate on, pinned WITHOUT docker.
 *
 * worker-e2e was intermittently red with `column r.evicted_at does not exist`
 * (42703) because the old gate accepted a half-migrated engine: hatchet-lite
 * creates the concurrency tables ~700ms before it adds
 * `v1_task_runtime.evicted_at`, and `reclaimEngineSlots` projects that column.
 * The in-docker suite cannot pin this — it can only reproduce it by losing the
 * race — so the invariant lives here, where it fails deterministically the
 * moment someone weakens the predicate.
 */
const READY: SchemaReadyCounts = {
  tables: SCHEMA_READY.tables,
  evicted_at: 1,
  delete_trigger_fn: 1,
};

describe("schemaIsReady — the #69 half-migrated-schema gate", () => {
  it("REGRESSION: rejects the half-migrated engine (tables landed, evicted_at not yet)", () => {
    expect(schemaIsReady({ ...READY, evicted_at: 0 })).toBe(false);
  });

  it("accepts a fully-migrated engine", () => {
    expect(schemaIsReady(READY)).toBe(true);
  });

  it("rejects an engine that has not started migrating", () => {
    expect(
      schemaIsReady({ tables: 0, evicted_at: 0, delete_trigger_fn: 0 }),
    ).toBe(false);
  });

  it("rejects a partially-created table set", () => {
    expect(schemaIsReady({ ...READY, tables: SCHEMA_READY.tables - 1 })).toBe(
      false,
    );
  });

  it("rejects a missing release trigger — the reclaim DELETE path needs it", () => {
    expect(schemaIsReady({ ...READY, delete_trigger_fn: 0 })).toBe(false);
  });

  it("requires ALL THREE — no single count is sufficient on its own", () => {
    expect(
      schemaIsReady({
        tables: SCHEMA_READY.tables,
        evicted_at: 0,
        delete_trigger_fn: 0,
      }),
    ).toBe(false);
    expect(
      schemaIsReady({ tables: 0, evicted_at: 1, delete_trigger_fn: 0 }),
    ).toBe(false);
    expect(
      schemaIsReady({ tables: 0, evicted_at: 0, delete_trigger_fn: 1 }),
    ).toBe(false);
  });

  it("tolerates counts above the floor rather than demanding equality", () => {
    expect(
      schemaIsReady({
        tables: SCHEMA_READY.tables + 1,
        evicted_at: 2,
        delete_trigger_fn: 2,
      }),
    ).toBe(true);
  });
});

describe("SCHEMA_READY_TABLES — covers what the suite's queries actually touch", () => {
  it("names every table scheduling-health.ts projects, so the gate is not a subset", () => {
    // Gating on a subset and trusting the rest to land in the same migration
    // batch is how this flake returns through a different table. Measured on
    // v0.94.10 the v1_* tables do land together, but the gate must not depend
    // on that coincidence.
    expect([...SCHEMA_READY_TABLES].sort()).toEqual(
      [
        "Worker",
        "v1_concurrency_slot",
        "v1_step_concurrency",
        "v1_task_events_olap",
        "v1_task_runtime",
        "v1_workflow_concurrency",
      ].sort(),
    );
  });

  it("the floor is derived from the table list, not a hand-maintained literal", () => {
    expect(SCHEMA_READY.tables).toBe(SCHEMA_READY_TABLES.length);
  });
});
