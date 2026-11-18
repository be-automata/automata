import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tryAcquireBoxLock, type BoxLock } from "./box-lock";
import {
  SCHEMA_READY,
  SCHEMA_READY_TABLES,
  acquireItStackLock,
  createStackGuard,
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

/**
 * #395: two HATCHET_IT processes on one machine shared ONE fixed compose
 * stack and one tenant, so each suite saw the other's executions as runs
 * "COMPLETED without executing". The harness now holds a kernel flock for the
 * life of the stack. Pinned here without docker, on a private root per case
 * (never the machine-wide IT root another process may be holding).
 */
describe("acquireItStackLock — one IT stack per machine (#395)", () => {
  let root: string;
  const held: BoxLock[] = [];
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hatchet-it-lock-"));
  });
  afterEach(async () => {
    await Promise.all(held.splice(0).map((l) => l.release()));
    await rm(root, { recursive: true, force: true });
  });

  it("REGRESSION: while one holder has the stack, nobody else can take it", async () => {
    held.push(await acquireItStackLock({ root, log: () => {} }));
    expect(await tryAcquireBoxLock({ root, holder: "intruder" })).toBeNull();
  });

  it("a second acquirer parks (and says so) instead of joining the live stack", async () => {
    held.push(await acquireItStackLock({ root, log: () => {} }));
    const log = vi.fn();
    let err: unknown = null;
    try {
      await acquireItStackLock({
        root,
        log,
        signal: AbortSignal.timeout(300),
      });
    } catch (e) {
      err = e;
    }
    expect(err instanceof Error && err.name).toBe("AbortError");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("held by another process"),
    );
  });

  it("the parked acquirer gets the stack once the holder releases", async () => {
    const first = await acquireItStackLock({ root, log: () => {} });
    const second = acquireItStackLock({ root, log: () => {} });
    await first.release();
    held.push(await second);
    expect(await tryAcquireBoxLock({ root, holder: "intruder" })).toBeNull();
  });
});

describe("createStackGuard — teardown only by the holder (#395)", () => {
  const fakeLock = () => {
    const release = vi.fn(async () => {});
    const lock: BoxLock = { release, lost: false, slot: 0 };
    return { lock, release };
  };

  it("an exit while still waiting aborts the wait and never tears down the other process's stack", async () => {
    let seen: AbortSignal | undefined;
    const guard = createStackGuard(
      (signal) =>
        new Promise<BoxLock>((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const entering = guard.enter().catch((e: unknown) => e);
    const teardown = vi.fn(async () => {});
    await guard.exit(teardown);
    expect(seen?.aborted).toBe(true);
    expect(teardown).not.toHaveBeenCalled();
    const err = await entering;
    expect(err instanceof Error && err.name).toBe("AbortError");
  });

  it("after an exit without the lock, the next enter acquires afresh", async () => {
    const { lock, release } = fakeLock();
    const acquire = vi
      .fn<(signal: AbortSignal) => Promise<BoxLock>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(lock);
    const guard = createStackGuard(acquire);
    await expect(guard.enter()).rejects.toThrow("unavailable");
    await guard.exit(async () => {});
    await guard.enter();
    expect(acquire).toHaveBeenCalledTimes(2);
    const teardown = vi.fn(async () => {});
    await guard.exit(teardown);
    expect(teardown).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("the holder tears down, then releases — even when the teardown throws", async () => {
    const { lock, release } = fakeLock();
    const guard = createStackGuard(async () => lock);
    await guard.enter();
    await expect(
      guard.exit(async () => {
        throw new Error("down failed");
      }),
    ).rejects.toThrow("down failed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("concurrent enters share ONE acquire (a second helper would park behind its own process)", async () => {
    const acquire = vi.fn(async () => fakeLock().lock);
    const guard = createStackGuard(acquire);
    await Promise.all([guard.enter(), guard.enter()]);
    expect(acquire).toHaveBeenCalledOnce();
  });
});
