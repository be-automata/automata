import { beforeEach, describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import { createOrganization } from "./organizations";
import { and, eq } from "drizzle-orm";
import { repoReviewSettings } from "../db/schema";
import {
  ORG_DEFAULT_REPO_SENTINEL,
  resolveSupersedePolicy,
  getRepoReviewSetting,
  setRepoReviewSetting,
  upsertRepoReviewSetting,
  removeRepoReviewSetting,
  listRepoReviewSettings,
} from "./repo-review-settings";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("repo-review-settings (Neon, org-fenced)", () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("returns undefined when no override exists", async () => {
    const row = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
    });
    expect(row).toBeUndefined();
  });

  it("upserts and reads back a tolerance for (org, repo)", async () => {
    const set = await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(set.blockTolerance).toBe("error");

    const got = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
    });
    expect(got?.blockTolerance).toBe("error");
  });

  it("upsert updates in place (one row per org+repo), not a second row", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "warning",
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "info",
    });
    const list = await listRepoReviewSettings({ db, organizationId: orgA });
    expect(list).toHaveLength(1);
    expect(list[0]!.blockTolerance).toBe("info");
  });

  it("lowercases the repo slug on write and read (case-insensitive match)", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "Acme/Widgets",
      blockTolerance: "error",
    });
    const got = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/WIDGETS",
    });
    expect(got?.blockTolerance).toBe("error");
    expect(got?.repoFullName).toBe("acme/widgets");
  });

  it("is org-fenced: the SAME repo slug under two orgs holds independent tolerances", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
      blockTolerance: "info",
    });
    await setRepoReviewSetting({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
      blockTolerance: "error",
    });

    const a = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
    });
    const b = await getRepoReviewSetting({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
    });
    expect(a?.blockTolerance).toBe("info");
    expect(b?.blockTolerance).toBe("error");

    // orgB never sees orgA's row in a list, and vice versa.
    expect(
      await listRepoReviewSettings({ db, organizationId: orgA }),
    ).toHaveLength(1);
    expect(
      await listRepoReviewSettings({ db, organizationId: orgB }),
    ).toHaveLength(1);
  });

  it("remove deletes the override and reports whether a row was removed", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(
      await removeRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toEqual({ removed: true, conflict: false });
    expect(
      await getRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toBeUndefined();
    // Removing an absent override is a no-op returning false.
    expect(
      await removeRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toEqual({ removed: false, conflict: false });
  });

  it("defaults: a tolerance-only insert leaves reviewDraftPrs TRUE", async () => {
    const row = await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    expect(row.reviewDraftPrs).toBe(true);
    expect(row.blockTolerance).toBe("error");
  });

  it("defaults: a draft-only insert leaves blockTolerance at 'warning'", async () => {
    const row = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { reviewDraftPrs: false },
    });
    expect(row.blockTolerance).toBe("warning");
    expect(row.reviewDraftPrs).toBe(false);
  });

  it("partial upsert: writing one field PRESERVES the other's stored value", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { blockTolerance: "error", reviewDraftPrs: false },
    });
    // Update ONLY the tolerance — draft policy must survive.
    const afterTol = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { blockTolerance: "info" },
    });
    expect(afterTol.blockTolerance).toBe("info");
    expect(afterTol.reviewDraftPrs).toBe(false);

    // Update ONLY the draft policy — tolerance must survive.
    const afterDraft = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { reviewDraftPrs: true },
    });
    expect(afterDraft.reviewDraftPrs).toBe(true);
    expect(afterDraft.blockTolerance).toBe("info");

    // Still exactly one row.
    expect(
      await listRepoReviewSettings({ db, organizationId: orgA }),
    ).toHaveLength(1);
  });

  it("remove is org-fenced: org A cannot delete org B's override", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
      blockTolerance: "info",
    });
    const removed = await removeRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
    });
    expect(removed).toEqual({ removed: false, conflict: false });
    // orgB's row survives.
    expect(
      await getRepoReviewSetting({
        db,
        organizationId: orgB,
        repoFullName: "shared/repo",
      }),
    ).toBeDefined();
  });
});

describe("repo-review-settings egress columns (#66 slice 1)", () => {
  let orgA: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
  });

  it("egress fields default to null (no enforcement) on a tolerance-only row", async () => {
    const row = await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "warning",
    });
    expect(row.egressPolicy).toBeNull();
    expect(row.egressAllowlist).toBeNull();
  });

  it("roundtrips egressPolicy + egressAllowlist through upsert/get/list", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: {
        egressPolicy: "domain",
        egressAllowlist: ["registry.npmjs.org", "*.githubusercontent.com"],
      },
    });
    const got = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
    });
    expect(got?.egressPolicy).toBe("domain");
    expect(got?.egressAllowlist).toEqual([
      "registry.npmjs.org",
      "*.githubusercontent.com",
    ]);
    const list = await listRepoReviewSettings({ db, organizationId: orgA });
    expect(list).toHaveLength(1);
    expect(list[0]!.egressPolicy).toBe("domain");
  });

  it("rejects an invalid egress level at the write boundary", async () => {
    await expect(
      upsertRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        patch: { egressPolicy: "everything" },
      }),
    ).rejects.toThrow(/Invalid egress policy level "everything"/);
    // Nothing landed in the table.
    expect(
      await getRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toBeUndefined();
  });

  it("rejects an invalid allowlist entry at the write boundary", async () => {
    await expect(
      upsertRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        patch: { egressPolicy: "domain", egressAllowlist: ["not a host"] },
      }),
    ).rejects.toThrow(/Invalid egress allowlist entry "not a host"/);

    // An allowlist-only patch is validated against the STORED level too.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "ip_port", egressAllowlist: ["10.0.0.5"] },
    });
    await expect(
      upsertRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        patch: { egressAllowlist: ["evil.example.com"] },
      }),
    ).rejects.toThrow(/expected an IP or IP:port/);
  });

  it("egress patch preserves other fields; other-field patch preserves egress; null clears", async () => {
    await setRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      blockTolerance: "error",
    });
    // Egress-only patch: tolerance survives.
    const withEgress = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: "ip_port", egressAllowlist: ["10.0.0.5:443"] },
    });
    expect(withEgress.blockTolerance).toBe("error");
    expect(withEgress.egressPolicy).toBe("ip_port");

    // Tolerance-only patch: egress survives.
    const afterTolerance = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { blockTolerance: "info" },
    });
    expect(afterTolerance.egressPolicy).toBe("ip_port");
    expect(afterTolerance.egressAllowlist).toEqual(["10.0.0.5:443"]);

    // Explicit null clears (revert to no enforcement — rollback path, spec §7).
    const cleared = await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { egressPolicy: null, egressAllowlist: null },
    });
    expect(cleared.egressPolicy).toBeNull();
    expect(cleared.egressAllowlist).toBeNull();
    expect(cleared.blockTolerance).toBe("info");
  });
});

describe("resolveSupersedePolicy (#125/#127)", () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("defaults to newest-wins with recheck off when nothing is configured", async () => {
    await expect(
      resolveSupersedePolicy({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).resolves.toEqual({ policy: "newest-wins", recheckOnComplete: false });
  });

  it("resetting the TOLERANCE family keeps a repo's supersede override (row kept, tolerance back to defaults); a row with nothing else is deleted (#131)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/both",
      patch: { blockTolerance: "error", supersedePolicy: "complete-run-queue" },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/tolerance-only",
      patch: { blockTolerance: "error" },
    });
    expect(
      await removeRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/both",
      }),
    ).toEqual({ removed: true, conflict: false });
    const kept = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/both",
    });
    expect(kept?.supersedePolicy).toBe("complete-run-queue");
    expect(kept?.blockTolerance).toBe("warning");
    expect(
      await removeRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/tolerance-only",
      }),
    ).toEqual({ removed: true, conflict: false });
    expect(
      await getRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/tolerance-only",
      }),
    ).toBeUndefined();
    // CAS: a stale version resets nothing.
    const stale = new Date(kept!.updatedAt.getTime() - 60_000);
    expect(
      await removeRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/both",
        expectedUpdatedAt: stale,
      }),
    ).toEqual({ removed: false, conflict: true });
  });

  it("listRepoReviewSettings never returns the org-default sentinel ('*') (#131 AC6)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { supersedePolicy: "app-side" },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/x",
      patch: { supersedePolicy: "complete-run-queue" },
    });
    const names = (
      await listRepoReviewSettings({ db, organizationId: orgA })
    ).map((r) => r.repoFullName);
    expect(names).toEqual(["acme/x"]);
    // The sentinel is still reachable by its own accessor.
    const sentinel = await getRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
    });
    expect(sentinel?.supersedePolicy).toBe("app-side");
  });

  it("falls back to the org-default sentinel row ('*') when the repo has no override", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { supersedePolicy: "complete-run-queue" },
    });
    await expect(
      resolveSupersedePolicy({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).resolves.toEqual({
      policy: "complete-run-queue",
      recheckOnComplete: false,
    });
    // Other orgs are untouched by A's default (tenant fence).
    await expect(
      resolveSupersedePolicy({
        db,
        organizationId: orgB,
        repoFullName: "acme/widgets",
      }),
    ).resolves.toEqual({ policy: "newest-wins", recheckOnComplete: false });
  });

  it("repo override beats org default, and matches case-insensitively", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { supersedePolicy: "complete-run-queue" },
    });
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "Acme/Widgets",
      patch: {
        supersedePolicy: "complete-run-discard",
        recheckOnComplete: true,
      },
    });
    await expect(
      resolveSupersedePolicy({
        db,
        organizationId: orgA,
        repoFullName: "ACME/WIDGETS",
      }),
    ).resolves.toEqual({
      policy: "complete-run-discard",
      recheckOnComplete: true,
    });
  });

  it("a repo row with NULL policy defers to the org default (not to newest-wins)", async () => {
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: ORG_DEFAULT_REPO_SENTINEL,
      patch: { supersedePolicy: "app-side" },
    });
    // Repo row exists for another field only.
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { blockTolerance: "error" },
    });
    await expect(
      resolveSupersedePolicy({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).resolves.toMatchObject({ policy: "app-side" });
  });

  it("rejects an unknown policy at the write boundary", async () => {
    await expect(
      upsertRepoReviewSetting({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        patch: { supersedePolicy: "yolo" },
      }),
    ).rejects.toThrow(/Unknown supersedePolicy 'yolo'/);
  });

  it("THROWS on an unknown stored value — never a silent default", async () => {
    // Bypass the write-boundary check to simulate a bad row (e.g. a future
    // policy removed from the union while rows still carry it).
    await upsertRepoReviewSetting({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      patch: { blockTolerance: "error" },
    });
    await db
      .update(repoReviewSettings)
      .set({ supersedePolicy: "legacy-unknown" })
      .where(
        and(
          eq(repoReviewSettings.organizationId, orgA),
          eq(repoReviewSettings.repoFullName, "acme/widgets"),
        ),
      );
    await expect(
      resolveSupersedePolicy({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).rejects.toThrow(/Unknown supersedePolicy 'legacy-unknown'/);
  });
});
