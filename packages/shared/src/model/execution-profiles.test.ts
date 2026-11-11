import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { nanoid } from "nanoid";
import { createDb } from "../db";
import {
  canonicalJson,
  executionProfileConfigHash,
  getCellDecisionsForThread,
  getCurrentProfileEvidence,
  getExecutionProfile,
  getExecutionProfileByConfiguration,
  insertCellDecision,
  insertProfileEvidence,
  insertProfileEvidenceRows,
  listExecutionProfiles,
  profileRecordForPolicy,
  upsertExecutionProfile,
} from "./execution-profiles";
import { createTestThread, createTestUser } from "./test-helpers";

const db = createDb(env.DATABASE_URL!);

const DAY_MS = 86_400_000;

describe("executionProfileConfigHash", () => {
  it("is order-insensitive over keys", async () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"e":0,"f":1}]},"b":1}',
    );
    expect(await executionProfileConfigHash({ a: 1, b: 2 })).toBe(
      await executionProfileConfigHash({ b: 2, a: 1 }),
    );
  });

  it("matches the hashes the seed migration computes in SQL", async () => {
    // deploy/migrations/2026-11-10-execution-profile-seed-automata-box.sql:
    // encode(sha256(convert_to('{"egress_mode":"observe"}', 'UTF8')), 'hex')
    expect(await executionProfileConfigHash({ egress_mode: "observe" })).toBe(
      "262c29647b320dfafd7123ad48e14e7a95801b82af7aca92d4c0df8d6f80014b",
    );
    expect(await executionProfileConfigHash({ egress_mode: "enforce" })).toBe(
      "8f1617ada06e676744be2382972193ac790bd93ab193eb253e42ac5ffb9e5bff",
    );
  });
});

describe("execution profiles and evidence (DB)", () => {
  const newProfile = (configuration: Record<string, unknown>) =>
    upsertExecutionProfile({
      db,
      id: `test/${nanoid(8)}`,
      provider: `prov-${nanoid(6)}`,
      tier: "customer_box",
      configuration,
    });

  it("finds a profile by exact configuration only", async () => {
    const p = await newProfile({ egress_mode: "observe", x: 1 });
    const hit = await getExecutionProfileByConfiguration({
      db,
      provider: p.provider,
      tier: "customer_box",
      configuration: { x: 1, egress_mode: "observe" },
    });
    expect(hit?.id).toBe(p.id);
    const miss = await getExecutionProfileByConfiguration({
      db,
      provider: p.provider,
      tier: "customer_box",
      configuration: { egress_mode: "observe" },
    });
    expect(miss).toBeUndefined();
  });

  it("generates expires_at = measured_at + 30 days", async () => {
    const p = await newProfile({ egress_mode: "enforce" });
    const measuredAt = new Date("2026-10-25T09:56:00Z");
    const row = await insertProfileEvidence({
      db,
      evidence: {
        profileId: p.id,
        capability: "metadata_blocked",
        measuredAt,
        source: "conformance",
        result: { value: true },
      },
    });
    expect(row.expiresAt.toISOString()).toBe("2026-11-24T09:56:00.000Z");
  });

  it("returns the newest row per capability and summarizes the earliest expiry", async () => {
    const p = await newProfile({ egress_mode: "enforce" });
    const t0 = new Date("2026-10-01T00:00:00Z");
    const insert = (
      capability: string,
      at: Date,
      value: unknown,
      source = "conformance",
    ) =>
      insertProfileEvidence({
        db,
        evidence: {
          profileId: p.id,
          capability,
          measuredAt: at,
          source,
          result: { value },
        },
      });
    await insert("peer_isolated", t0, false);
    const peerNew = await insert(
      "peer_isolated",
      new Date(t0.getTime() + 10 * DAY_MS),
      true,
    );
    const meta = await insert(
      "metadata_blocked",
      new Date(t0.getTime() + 5 * DAY_MS),
      true,
    );

    const current = await getCurrentProfileEvidence({ db, profileId: p.id });
    expect(current.map((r) => r.id).sort()).toEqual(
      [peerNew.id, meta.id].sort(),
    );

    const { profile, evidenceIds } = profileRecordForPolicy(p, current, {
      capabilities: { egress_allowlist: ["a.example"] },
    });
    expect(profile.capabilities).toEqual({
      peer_isolated: true,
      metadata_blocked: true,
      egress_allowlist: ["a.example"],
    });
    expect(profile.configuration).toEqual({ egress_mode: "enforce" });
    expect(profile.evidence).toEqual({
      source: "conformance",
      measured_at: new Date(t0.getTime() + 5 * DAY_MS).toISOString(),
      expires_at: new Date(t0.getTime() + 35 * DAY_MS).toISOString(),
    });
    expect(evidenceIds).toEqual([peerNew.id, meta.id].sort());

    // One non-conformance row taints the summary instead of being averaged away.
    await insert(
      "teardown_verified",
      new Date(t0.getTime() + 11 * DAY_MS),
      true,
      "vendor_docs",
    );
    const tainted = profileRecordForPolicy(
      p,
      await getCurrentProfileEvidence({ db, profileId: p.id }),
    );
    expect(tainted.profile.evidence?.source).toBe("vendor_docs");
  });

  it("a profile with no evidence carries no evidence summary", async () => {
    const p = await newProfile({ egress_mode: "observe" });
    const { profile, evidenceIds } = profileRecordForPolicy(p, []);
    expect(profile.evidence).toBeUndefined();
    expect(evidenceIds).toEqual([]);
  });

  it("records a cell decision for a thread", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
    });
    await insertCellDecision({
      db,
      decision: {
        threadId,
        threadChatId,
        profileId: null,
        allowed: false,
        reasons: ["unknown_profile"],
        evidenceIds: [],
        seam: "dispatch",
        mode: "shadow",
        input: { now: "2026-11-10T00:00:00Z" },
      },
    });
    const rows = await getCellDecisionsForThread({ db, threadId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allowed: false,
      reasons: ["unknown_profile"],
      seam: "dispatch",
      mode: "shadow",
    });
  });
});

describe("evidence renewal helpers (DB)", () => {
  it("inserts a batch of rows and reads the profile back by id", async () => {
    const p = await upsertExecutionProfile({
      db,
      id: `test/${nanoid(8)}`,
      provider: `prov-${nanoid(6)}`,
      tier: "customer_box",
      configuration: { egress_mode: "observe" },
    });
    expect((await getExecutionProfile({ db, id: p.id }))?.id).toBe(p.id);
    expect(await getExecutionProfile({ db, id: `test/${nanoid(8)}` })).toBe(
      undefined,
    );
    expect(
      (await listExecutionProfiles({ db })).some((row) => row.id === p.id),
    ).toBe(true);

    const measuredAt = new Date("2026-11-15T04:00:00Z");
    const rows = await insertProfileEvidenceRows({
      db,
      rows: ["metadata_blocked", "peer_isolated"].map((capability) => ({
        profileId: p.id,
        capability,
        measuredAt,
        source: "conformance",
        result: { value: true },
      })),
    });
    expect(rows.map((r) => r.expiresAt.toISOString())).toEqual([
      "2026-12-15T04:00:00.000Z",
      "2026-12-15T04:00:00.000Z",
    ]);
    expect(await insertProfileEvidenceRows({ db, rows: [] })).toEqual([]);
  });
});
