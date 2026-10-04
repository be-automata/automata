import { beforeEach, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";

import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { repoReviewSettings } from "@terragon/shared/db/schema";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  ORG_DEFAULT_REPO_SENTINEL,
  upsertRepoReviewSetting,
} from "@terragon/shared/model/repo-review-settings";
import { and, eq } from "drizzle-orm";

import {
  resolveReviewAgentForDispatch,
  resolveReviewAgentSettings,
  type ReviewAgentStoredRow,
} from "./resolve-review-agent";

/**
 * Review-agent resolution (phase 4). Precedence per field: repo row → '*'
 * org-default row → system default. Classic = exactly today's behaviour.
 * runTests is downgraded for fork / cross-repo / untrusted / missing trust.
 */

const ORG = "org-1";
const REPO = "acme/widgets";
const ALL_PACKS = ["gstack-review", "somnio-review", "gsd-reviewers"];

const TRUSTED = {
  isFork: false,
  isCrossRepo: false,
  authorAssociation: "MEMBER",
};

function row(
  values: Partial<Omit<ReviewAgentStoredRow, "repoFullName">>,
  repoFullName = REPO,
): ReviewAgentStoredRow {
  return {
    repoFullName,
    reviewMode: null,
    reviewBatteries: null,
    reviewRunTests: null,
    reviewCommandTimeoutS: null,
    reviewMaxTurns: null,
    ...values,
  };
}

function orgRow(
  values: Partial<Omit<ReviewAgentStoredRow, "repoFullName">>,
): ReviewAgentStoredRow {
  return row(values, ORG_DEFAULT_REPO_SENTINEL);
}

type ResolveArgs = Parameters<typeof resolveReviewAgentSettings>[0];

function resolve(overrides: Partial<ResolveArgs>) {
  return resolveReviewAgentSettings({
    organizationId: ORG,
    repo: undefined,
    orgDefault: undefined,
    trust: TRUSTED,
    trustedAuthorThreshold: "MEMBER",
    ...overrides,
  });
}

describe("resolveReviewAgentSettings — precedence and defaults", () => {
  it("no rows, trusted → classic system defaults with no optional keys", () => {
    const result = resolve({});
    expect(result).toEqual({
      mode: "classic",
      batteries: ALL_PACKS,
      runTests: false,
      commandTimeoutMs: 60000,
    });
    expect("maxTurns" in result).toBe(false);
    expect("runTestsDowngradedReason" in result).toBe(false);
  });

  it("org '*' orchestrated, no repo row → orchestrated with the 300s default", () => {
    const result = resolve({
      orgDefault: orgRow({ reviewMode: "orchestrated" }),
    });
    expect(result.mode).toBe("orchestrated");
    expect(result.commandTimeoutMs).toBe(300000);
  });

  it("repo classic overrides org orchestrated", () => {
    const result = resolve({
      repo: row({ reviewMode: "classic" }),
      orgDefault: orgRow({ reviewMode: "orchestrated" }),
    });
    expect(result.mode).toBe("classic");
    expect(result.commandTimeoutMs).toBe(60000);
  });

  it("resolves each field independently", () => {
    const result = resolve({
      repo: row({ reviewRunTests: true }),
      orgDefault: orgRow({
        reviewMode: "orchestrated",
        reviewBatteries: ["somnio-review"],
        reviewMaxTurns: 50,
      }),
    });
    expect(result).toEqual({
      mode: "orchestrated",
      batteries: ["somnio-review"],
      runTests: true,
      commandTimeoutMs: 300000,
      maxTurns: 50,
    });
    expect("runTestsDowngradedReason" in result).toBe(false);
  });

  it("orchestrated + org timeout 120s → 120000 ms", () => {
    const result = resolve({
      orgDefault: orgRow({
        reviewMode: "orchestrated",
        reviewCommandTimeoutS: 120,
      }),
    });
    expect(result.commandTimeoutMs).toBe(120000);
  });

  it("an explicit empty battery list on the repo row wins", () => {
    const result = resolve({
      repo: row({ reviewBatteries: [] }),
      orgDefault: orgRow({ reviewBatteries: ["gstack-review"] }),
    });
    expect(result.batteries).toEqual([]);
  });

  it("the default battery list is a fresh copy", () => {
    const first = resolve({});
    first.batteries.push("gstack-review");
    expect(resolve({}).batteries).toEqual(ALL_PACKS);
  });
});

describe("resolveReviewAgentSettings — classic is exactly today (W4)", () => {
  const stored = {
    reviewRunTests: true,
    reviewCommandTimeoutS: 600,
    reviewMaxTurns: 50,
  };

  it("classic ignores stored runTests, timeout and maxTurns", () => {
    const result = resolve({ repo: row({ reviewMode: "classic", ...stored }) });
    expect(result).toEqual({
      mode: "classic",
      batteries: ALL_PACKS,
      runTests: false,
      commandTimeoutMs: 60000,
    });
    expect("maxTurns" in result).toBe(false);
    expect("runTestsDowngradedReason" in result).toBe(false);
  });

  it("the same stored values apply under orchestrated", () => {
    const result = resolve({
      repo: row({ reviewMode: "orchestrated", ...stored }),
    });
    expect(result.runTests).toBe(true);
    expect(result.commandTimeoutMs).toBe(600000);
    expect(result.maxTurns).toBe(50);
  });
});

describe("resolveReviewAgentSettings — runTests trust gate", () => {
  const orchestratedRunTests = row({
    reviewMode: "orchestrated",
    reviewRunTests: true,
  });

  function gate(
    trust: ResolveArgs["trust"],
    trustedAuthorThreshold: ResolveArgs["trustedAuthorThreshold"] = "MEMBER",
  ) {
    return resolve({
      repo: orchestratedRunTests,
      trust,
      trustedAuthorThreshold,
    });
  }

  it("fork → runTests false, reason fork", () => {
    const result = gate({ ...TRUSTED, isFork: true });
    expect(result.runTests).toBe(false);
    expect(result.runTestsDowngradedReason).toBe("fork");
  });

  it("non-fork cross-repo head → reason fork", () => {
    const result = gate({ ...TRUSTED, isCrossRepo: true });
    expect(result.runTests).toBe(false);
    expect(result.runTestsDowngradedReason).toBe("fork");
  });

  it("pre-phase-4 snapshot without isCrossRepo → reason fork (fail closed)", () => {
    const result = gate({ isFork: false, authorAssociation: "MEMBER" });
    expect(result.runTests).toBe(false);
    expect(result.runTestsDowngradedReason).toBe("fork");
  });

  it("author below the threshold → reason untrusted-author", () => {
    const result = gate({ ...TRUSTED, authorAssociation: "CONTRIBUTOR" });
    expect(result.runTests).toBe(false);
    expect(result.runTestsDowngradedReason).toBe("untrusted-author");
  });

  it("author at a lowered threshold → runTests true", () => {
    const result = gate(
      { ...TRUSTED, authorAssociation: "CONTRIBUTOR" },
      "CONTRIBUTOR",
    );
    expect(result.runTests).toBe(true);
    expect("runTestsDowngradedReason" in result).toBe(false);
  });

  it("missing trust snapshot → reason untrusted-author", () => {
    const result = gate(null);
    expect(result.runTests).toBe(false);
    expect(result.runTestsDowngradedReason).toBe("untrusted-author");
  });

  it("unknown author association (BOT) → reason untrusted-author", () => {
    const result = gate({ ...TRUSTED, authorAssociation: "BOT" });
    expect(result.runTests).toBe(false);
    expect(result.runTestsDowngradedReason).toBe("untrusted-author");
  });

  it("trusted member → runTests true, no reason", () => {
    const result = gate(TRUSTED);
    expect(result.runTests).toBe(true);
    expect("runTestsDowngradedReason" in result).toBe(false);
  });

  it("runTests not requested on a fork → false with no reason", () => {
    const result = resolve({
      repo: row({ reviewMode: "orchestrated", reviewRunTests: false }),
      trust: { ...TRUSTED, isFork: true },
    });
    expect(result.runTests).toBe(false);
    expect("runTestsDowngradedReason" in result).toBe(false);

    const inherited = resolve({
      repo: row({ reviewMode: "orchestrated" }),
      trust: { ...TRUSTED, isFork: true },
    });
    expect(inherited.runTests).toBe(false);
    expect("runTestsDowngradedReason" in inherited).toBe(false);
  });
});

describe("resolveReviewAgentSettings — invalid stored values throw", () => {
  it("unknown repo mode throws, naming the field, the org and the row", () => {
    expect(() => resolve({ repo: row({ reviewMode: "turbo" }) })).toThrow(
      /reviewMode.*org-1.*acme\/widgets/s,
    );
  });

  it("unknown org pack id throws even under classic", () => {
    expect(() =>
      resolve({ orgDefault: orgRow({ reviewBatteries: ["nope"] }) }),
    ).toThrow(/reviewBatteries/);
  });

  it("out-of-range timeout throws", () => {
    expect(() =>
      resolve({ orgDefault: orgRow({ reviewCommandTimeoutS: 5 }) }),
    ).toThrow(/reviewCommandTimeoutS/);
  });

  it("out-of-range max turns throws", () => {
    expect(() =>
      resolve({ orgDefault: orgRow({ reviewMaxTurns: 900 }) }),
    ).toThrow(/reviewMaxTurns/);
  });
});

describe("resolveReviewAgentForDispatch (real DB)", () => {
  const db = createDb(env.DATABASE_URL!);
  let orgId: string;

  beforeEach(async () => {
    const org = await createOrganization({
      db,
      name: "acme",
      slug: `acme-${nanoid(8).toLowerCase()}`,
    });
    orgId = org.id;
  });

  const trustContext = {
    source: "github-pr" as const,
    isFork: false,
    isCrossRepo: false,
    authorAssociation: "MEMBER",
    capturedAt: "2026-10-03T00:00:00.000Z",
  };

  it("composes the '*' row and the repo row", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { reviewMode: "orchestrated" },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewRunTests: true },
    });
    const result = await resolveReviewAgentForDispatch({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      trustContext,
    });
    expect(result).toEqual({
      mode: "orchestrated",
      batteries: ALL_PACKS,
      runTests: true,
      commandTimeoutMs: 300000,
    });
  });

  it("rejects when a stored value is corrupt", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewMode: "classic" },
    });
    await db
      .update(repoReviewSettings)
      .set({ reviewMode: "turbo" })
      .where(
        and(
          eq(repoReviewSettings.organizationId, orgId),
          eq(repoReviewSettings.repoFullName, REPO),
        ),
      );
    await expect(
      resolveReviewAgentForDispatch({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        trustContext,
      }),
    ).rejects.toThrow(/reviewMode/);
  });

  it("ignores an invalid stored taskBatteries: the review resolves normally (phase 7)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      patch: { reviewMode: "orchestrated", taskBatteries: ["somnio-skills"] },
    });
    // A pack id removed from the manifest after it was stored.
    await db
      .update(repoReviewSettings)
      .set({ taskBatteries: ["nope"] })
      .where(
        and(
          eq(repoReviewSettings.organizationId, orgId),
          eq(repoReviewSettings.repoFullName, REPO),
        ),
      );
    const result = await resolveReviewAgentForDispatch({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      trustContext,
    });
    expect(result).toEqual({
      mode: "orchestrated",
      batteries: ALL_PACKS,
      runTests: false,
      commandTimeoutMs: 300000,
    });
    expect("taskBatteries" in result).toBe(false);
  });
});
