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
    await expect(insertEgressEvents({ db, events: [] })).resolves.toBeUndefined();
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
    expect(await listEgressEvents({ db, organizationId: orgB })).toHaveLength(0);
    expect(
      await listEgressEvents({ db, organizationId: orgB, runId }),
    ).toHaveLength(0);
    expect(await listEgressEvents({ db, organizationId: orgA, runId })).toHaveLength(
      1,
    );
  });

  it("prune deletes only rows past the age bound (all orgs — maintenance)", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - EGRESS_EVENTS_PRUNE_AFTER_MS - 1000);
    const fresh = new Date(now.getTime() - 60_000);
    await insertEgressEvents({
      db,
      events: [
        {
          organizationId: orgA,
          runId,
          destinationHost: "old.example.com",
          action: "deny",
          source: "worker",
          createdAt: old,
        },
        {
          organizationId: orgB,
          runId,
          destinationHost: "old-b.example.com",
          action: "allow",
          source: "docker",
          createdAt: old,
        },
        {
          organizationId: orgA,
          runId,
          destinationHost: "fresh.example.com",
          action: "allow",
          source: "worker",
          createdAt: fresh,
        },
      ],
    });
    // ≥2: rows from other tests in this suite may also be past the bound;
    // ours are the only ones under THIS runId, so assert via the run listing.
    const deleted = await pruneEgressEvents({ db, now });
    expect(deleted).toBeGreaterThanOrEqual(2);
    const remainingA = await listEgressEvents({ db, organizationId: orgA, runId });
    expect(remainingA.map((r) => r.destinationHost)).toEqual([
      "fresh.example.com",
    ]);
    expect(
      await listEgressEvents({ db, organizationId: orgB, runId }),
    ).toHaveLength(0);
  });
});
