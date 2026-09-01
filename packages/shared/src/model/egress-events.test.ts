import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import { createOrganization } from "./organizations";
import {
  EGRESS_EVENTS_PRUNE_AFTER_MS,
  insertEgressEvents,
  listEgressEvents,
  pruneEgressEvents,
} from "./egress-events";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("egress-events (audit sink, org-fenced)", () => {
  let orgA: string;
  let orgB: string;
  let runId: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
    runId = `run-${nanoid(8)}`;
  });

  it("inserts a batch and lists it back for the run (newest first)", async () => {
    await insertEgressEvents({
      db,
      events: [
        {
          organizationId: orgA,
          threadId: "t1",
          runId,
          destinationHost: "api.anthropic.com",
          destinationPort: 443,
          action: "allow",
          policyLevel: "domain",
          source: "worker",
        },
        {
          organizationId: orgA,
          runId,
          destinationHost: "evil.example.com",
          action: "deny",
          policyLevel: "domain",
          source: "worker",
        },
      ],
    });
    const rows = await listEgressEvents({ db, organizationId: orgA, runId });
    expect(rows).toHaveLength(2);
    const byHost = Object.fromEntries(rows.map((r) => [r.destinationHost, r]));
    expect(byHost["api.anthropic.com"]).toMatchObject({
      action: "allow",
      destinationPort: 443,
      policyLevel: "domain",
      source: "worker",
      threadId: "t1",
      runId,
    });
    expect(byHost["evil.example.com"]).toMatchObject({
      action: "deny",
      destinationPort: null,
      threadId: null,
    });
  });

  it("empty batch is a no-op", async () => {
    await expect(
      insertEgressEvents({ db, events: [] }),
    ).resolves.toBeUndefined();
  });

  it("org fence: one org can never read another's audit rows", async () => {
    await insertEgressEvents({
      db,
      events: [
        {
          organizationId: orgA,
          runId,
          destinationHost: "a.example.com",
          action: "deny",
          source: "worker",
        },
      ],
    });
    expect(await listEgressEvents({ db, organizationId: orgB })).toHaveLength(
      0,
    );
    expect(
      await listEgressEvents({ db, organizationId: orgB, runId }),
    ).toHaveLength(0);
    expect(
      await listEgressEvents({ db, organizationId: orgA, runId }),
    ).toHaveLength(1);
  });

  it("prune deletes only rows past the age bound (all orgs — maintenance)", async () => {
    await insertEgressEvents({
      db,
      events: [
        {
          organizationId: orgA,
          runId,
          destinationHost: "old.example.com",
          action: "deny",
          source: "worker",
        },
        {
          organizationId: orgB,
          runId,
          destinationHost: "old-b.example.com",
          action: "allow",
          source: "docker",
        },
      ],
    });
    // With today's clock the just-inserted rows are inside the window — kept.
    await pruneEgressEvents({ db });
    expect(
      await listEgressEvents({ db, organizationId: orgA, runId }),
    ).toHaveLength(1);
    // A `now` past the retention window sweeps them, across BOTH orgs.
    // ≥2: rows from other tests in this suite may also fall past the bound;
    // ours are the only ones under THIS runId, so assert via the run listing.
    const future = new Date(Date.now() + EGRESS_EVENTS_PRUNE_AFTER_MS + 60_000);
    const deleted = await pruneEgressEvents({ db, now: future });
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(
      await listEgressEvents({ db, organizationId: orgA, runId }),
    ).toHaveLength(0);
    expect(
      await listEgressEvents({ db, organizationId: orgB, runId }),
    ).toHaveLength(0);
  });
});

/**
 * #108: production schema migration is manual (AGENTS.md), so www can reach
 * production before `egress_events.mode` exists. That window must not turn every
 * audit POST into a 500 — losing decisions is the one thing an audit trail may
 * not do. These use a stub db so the missing-column path is reachable without
 * actually dropping a column from the shared test database.
 */
describe("insertEgressEvents — pre-migration `mode` column fallback", () => {
  const event = {
    organizationId: null,
    runId: "run_1",
    destinationHost: "example.com",
    destinationPort: 443,
    action: "allow" as const,
    policyLevel: "none" as const,
    mode: "observe" as const,
  };

  function stubDb(failFirstWith?: { code: string }) {
    const calls: Array<Record<string, unknown>[]> = [];
    let n = 0;
    return {
      calls,
      db: {
        insert: () => ({
          values: async (rows: Record<string, unknown>[]) => {
            calls.push(rows);
            n += 1;
            if (n === 1 && failFirstWith) throw failFirstWith;
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
  }

  it("retries WITHOUT `mode` when the column does not exist (42703)", async () => {
    const { db: stub, calls } = stubDb({ code: "42703" });
    await insertEgressEvents({ db: stub, events: [event] });
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toHaveProperty("mode", "observe");
    expect(calls[1]![0]).not.toHaveProperty("mode");
    // the rest of the row must survive the retry intact
    expect(calls[1]![0]).toMatchObject({
      runId: "run_1",
      destinationHost: "example.com",
      action: "allow",
    });
  });

  it("does NOT swallow any other database error", async () => {
    const { db: stub, calls } = stubDb({ code: "23505" }); // unique_violation
    await expect(
      insertEgressEvents({ db: stub, events: [event] }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(calls).toHaveLength(1); // no retry
  });

  it("sends `mode` on the first attempt and does not retry when it succeeds", async () => {
    const { db: stub, calls } = stubDb();
    await insertEgressEvents({ db: stub, events: [event] });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toHaveProperty("mode", "observe");
  });
});
