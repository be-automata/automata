import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import { nanoid } from "nanoid";
import { createOrganization } from "./organizations";
import {
  computeContentSha,
  createRepoSkillVersion,
  getRepoSkill,
  getSkillVersion,
  listRecentSkillVersionsWithBodies,
  listRepoSkills,
  listSkillVersions,
  promoteLastKnownGood,
  revertSkillToVersion,
} from "./repo-skills";

const db = createDb(env.DATABASE_URL!);

async function makeOrg(name: string): Promise<string> {
  const org = await createOrganization({
    db,
    name,
    slug: `${name.toLowerCase()}-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("repo-skills (Neon, org-fenced, append-only versions)", () => {
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    orgA = await makeOrg("acme");
    orgB = await makeOrg("globex");
  });

  it("returns undefined when no skill exists", async () => {
    expect(
      await getRepoSkill({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        skillName: "github-ops",
      }),
    ).toBeUndefined();
  });

  it("first write creates the skill row, a version, and moves the pointer", async () => {
    const { skill, version } = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "review methodology v1",
      source: "seed",
    });
    expect(skill.currentVersionId).toBe(version.id);
    expect(skill.lastKnownGoodVersionId).toBeNull();
    expect(version.body).toBe("review methodology v1");
    expect(version.source).toBe("seed");
  });

  it("computes sha256 of the body — never trusts a caller hash", async () => {
    const body = "some skill body";
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body,
      source: "api",
    });
    const expected = createHash("sha256").update(body, "utf8").digest("hex");
    expect(version.contentSha).toBe(expected);
    expect(computeContentSha(body)).toBe(expected);
  });

  it("an edit appends a version and moves currentVersionId; history survives", async () => {
    const first = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "v1",
      source: "seed",
    });
    const second = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "v2",
      source: "dashboard",
    });
    // One skill row, pointer moved.
    expect(second.skill.id).toBe(first.skill.id);
    expect(second.skill.currentVersionId).toBe(second.version.id);
    // v1 is still readable (append-only history — rollback = move the pointer).
    const v1 = await getSkillVersion({
      db,
      organizationId: orgA,
      versionId: first.version.id,
    });
    expect(v1?.body).toBe("v1");
    expect(await listRepoSkills({ db, organizationId: orgA })).toHaveLength(1);
  });

  it("lowercases the repo slug on write and read (case-insensitive match)", async () => {
    await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "Acme/Widgets",
      skillName: "github-ops",
      body: "v1",
      source: "seed",
    });
    const got = await getRepoSkill({
      db,
      organizationId: orgA,
      repoFullName: "acme/WIDGETS",
      skillName: "github-ops",
    });
    expect(got).toBeDefined();
    expect(got?.repoFullName).toBe("acme/widgets");
  });

  it("is org-fenced: the SAME (repo, skill) under two orgs holds independent bodies", async () => {
    await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
      skillName: "github-ops",
      body: "org A body",
      source: "seed",
    });
    await createRepoSkillVersion({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
      skillName: "github-ops",
      body: "org B body",
      source: "seed",
    });
    const a = await getRepoSkill({
      db,
      organizationId: orgA,
      repoFullName: "shared/repo",
      skillName: "github-ops",
    });
    const b = await getRepoSkill({
      db,
      organizationId: orgB,
      repoFullName: "shared/repo",
      skillName: "github-ops",
    });
    expect(a?.id).not.toBe(b?.id);
    const aBody = await getSkillVersion({
      db,
      organizationId: orgA,
      versionId: a!.currentVersionId!,
    });
    expect(aBody?.body).toBe("org A body");
    expect(await listRepoSkills({ db, organizationId: orgA })).toHaveLength(1);
    expect(await listRepoSkills({ db, organizationId: orgB })).toHaveLength(1);
  });

  it("getSkillVersion is org-fenced: another org's version id never resolves", async () => {
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "secret body",
      source: "seed",
    });
    expect(
      await getSkillVersion({
        db,
        organizationId: orgB,
        versionId: version.id,
      }),
    ).toBeUndefined();
  });

  it("listRepoSkills narrows by repo when given one", async () => {
    await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "v1",
      source: "seed",
    });
    await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/gadgets",
      skillName: "github-ops",
      body: "v1",
      source: "seed",
    });
    expect(await listRepoSkills({ db, organizationId: orgA })).toHaveLength(2);
    expect(
      await listRepoSkills({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
      }),
    ).toHaveLength(1);
  });

  it("promoteLastKnownGood moves the fallback pointer, fenced to the skill", async () => {
    const first = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "healthy body",
      source: "seed",
    });
    const promoted = await promoteLastKnownGood({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      versionId: first.version.id,
    });
    expect(promoted?.lastKnownGoodVersionId).toBe(first.version.id);

    // A version from ANOTHER skill can never be promoted onto this one.
    const other = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-mention",
      body: "mention body",
      source: "seed",
    });
    expect(
      await promoteLastKnownGood({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        skillName: "github-ops",
        versionId: other.version.id,
      }),
    ).toBeUndefined();
    // The pointer is unchanged.
    const skill = await getRepoSkill({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
    });
    expect(skill?.lastKnownGoodVersionId).toBe(first.version.id);

    // Cross-org promotion is a no-op too.
    expect(
      await promoteLastKnownGood({
        db,
        organizationId: orgB,
        repoFullName: "acme/widgets",
        skillName: "github-ops",
        versionId: first.version.id,
      }),
    ).toBeUndefined();
  });

  it("listSkillVersions returns newest-first metadata WITHOUT bodies, org-fenced", async () => {
    const first = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "v1",
      source: "seed",
    });
    const second = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "v2",
      source: "dashboard",
    });
    const versions = await listSkillVersions({
      db,
      organizationId: orgA,
      repoFullName: "Acme/WIDGETS", // case-insensitive like every read
      skillName: "github-ops",
    });
    expect(versions.map((v) => v.id)).toEqual([
      second.version.id,
      first.version.id,
    ]);
    // Metadata only — the multi-KB bodies never ride along on history reads.
    expect(versions[0]).not.toHaveProperty("body");
    expect(versions[0]!.contentSha).toBe(second.version.contentSha);
    expect(versions[0]!.source).toBe("dashboard");
    // Another org sees nothing.
    expect(
      await listSkillVersions({
        db,
        organizationId: orgB,
        repoFullName: "acme/widgets",
        skillName: "github-ops",
      }),
    ).toHaveLength(0);
  });

  it("revertSkillToVersion moves currentVersionId back; append-only history intact", async () => {
    const first = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "v1",
      source: "seed",
    });
    const second = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "v2",
      source: "dashboard",
    });
    const reverted = await revertSkillToVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      versionId: first.version.id,
    });
    expect(reverted?.currentVersionId).toBe(first.version.id);
    // No new version row was created — revert is a pointer move, not an edit.
    expect(
      await listSkillVersions({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        skillName: "github-ops",
      }),
    ).toHaveLength(2);
    // v2 is still readable (roll-forward stays possible).
    expect(
      (
        await getSkillVersion({
          db,
          organizationId: orgA,
          versionId: second.version.id,
        })
      )?.body,
    ).toBe("v2");
  });

  it("revertSkillToVersion is fenced: cross-org and cross-skill ids are no-ops", async () => {
    const ops = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
      body: "ops v1",
      source: "seed",
    });
    const mention = await createRepoSkillVersion({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-mention",
      body: "mention v1",
      source: "seed",
    });
    // A version from another SKILL can never become this skill's current.
    expect(
      await revertSkillToVersion({
        db,
        organizationId: orgA,
        repoFullName: "acme/widgets",
        skillName: "github-ops",
        versionId: mention.version.id,
      }),
    ).toBeUndefined();
    // Cross-org: no-op.
    expect(
      await revertSkillToVersion({
        db,
        organizationId: orgB,
        repoFullName: "acme/widgets",
        skillName: "github-ops",
        versionId: ops.version.id,
      }),
    ).toBeUndefined();
    // Pointer unchanged.
    const skill = await getRepoSkill({
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
    });
    expect(skill?.currentVersionId).toBe(ops.version.id);
  });

  it("listRecentSkillVersionsWithBodies: newest first, capped, org-fenced, bodies included", async () => {
    const args = {
      db,
      organizationId: orgA,
      repoFullName: "acme/widgets",
      skillName: "github-ops",
    };
    for (const [i, source] of (
      ["api", "dashboard", "api"] as const
    ).entries()) {
      await createRepoSkillVersion({ ...args, body: `v${i + 1}`, source });
      // Distinct createdAt: (createdAt, id) is the order key and ids are random.
      await new Promise((r) => setTimeout(r, 5));
    }
    const recent = await listRecentSkillVersionsWithBodies({
      ...args,
      limit: 2,
    });
    expect(recent.map((v) => v.body)).toEqual(["v3", "v2"]);
    expect(recent[0]?.source).toBe("api");
    // Org fence: the same (repo, skill) under another org resolves nothing.
    expect(
      await listRecentSkillVersionsWithBodies({
        ...args,
        organizationId: orgB,
        limit: 5,
      }),
    ).toEqual([]);
  });
});
