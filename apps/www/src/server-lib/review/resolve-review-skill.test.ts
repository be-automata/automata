import { describe, it, expect, beforeEach } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "@terragon/shared/db";
import { nanoid } from "nanoid";
import { createOrganization } from "@terragon/shared/model/organizations";
import {
  createRepoSkillVersion,
  promoteLastKnownGood,
  computeContentSha,
} from "@terragon/shared/model/repo-skills";
import {
  resolveReviewSkill,
  renderSkillPlaceholders,
} from "./resolve-review-skill";

/**
 * The thread-creation resolution seam: proves resolveReviewSkill serves the
 * LIVE current version, walks the PURE-DB fallback chain (current →
 * last-known-good → oldest seed version), never dispatches a contract-less
 * github-ops body, and resolves versionless skills to null so the caller
 * skips the run. There is deliberately NO filesystem tier to test: the
 * Workers runtime has no checkout (PR #57).
 */

const db = createDb(env.DATABASE_URL!);

const REPO = "acme/widgets";

/** A minimal body satisfying the github-ops fenced-json verdict contract. */
const VALID_BODY =
  'Review methodology.\n```json\n{ "verdict": "approve" }\n```\n';
const VALID_BODY_V2 =
  'Review methodology, EDITED.\n```json\n{ "verdict": "approve" }\n```\n';
/** No fenced-json verdict block — must never be dispatched for github-ops. */
const BROKEN_BODY = "Just prose, no contract.";

async function makeOrg(): Promise<string> {
  const org = await createOrganization({
    db,
    name: "acme",
    slug: `acme-${nanoid(8).toLowerCase()}`,
  });
  return org.id;
}

describe("renderSkillPlaceholders", () => {
  it("substitutes repoFullName and baseBranch, every occurrence", () => {
    const rendered = renderSkillPlaceholders(
      "Repo {{repoFullName}} on {{baseBranch}}; diff origin/{{baseBranch}}...HEAD",
      { repoFullName: "acme/widgets", baseBranch: "develop" },
    );
    expect(rendered).toBe(
      "Repo acme/widgets on develop; diff origin/develop...HEAD",
    );
  });

  it("leaves unknown placeholders verbatim (a typo must stay visible)", () => {
    expect(
      renderSkillPlaceholders("Hello {{unknownThing}} {{repoFullName}}", {
        repoFullName: "a/b",
        baseBranch: "main",
      }),
    ).toBe("Hello {{unknownThing}} a/b");
  });
});

describe("resolveReviewSkill (fallback chain)", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await makeOrg();
  });

  it("serves the current version live: an edit is picked up on the next resolution", async () => {
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: VALID_BODY,
      source: "seed",
    });
    const first = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      version: "latest",
    });
    expect(first?.source).toBe("db-version");
    expect(first?.body).toBe(VALID_BODY);
    expect(first?.contentSha).toBe(computeContentSha(VALID_BODY));

    // The edit: no restart, no reseed — next resolution serves it.
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: VALID_BODY_V2,
      source: "dashboard",
    });
    const second = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      version: "latest",
    });
    expect(second?.body).toBe(VALID_BODY_V2);
    expect(second?.versionId).toBe(version.id);
  });

  it("a version-id pin serves THAT version, not the moved current pointer", async () => {
    const first = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: VALID_BODY,
      source: "seed",
    });
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: VALID_BODY_V2,
      source: "dashboard",
    });
    const pinned = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      version: first.version.id,
    });
    expect(pinned?.body).toBe(VALID_BODY);
    expect(pinned?.versionId).toBe(first.version.id);
  });

  it("invalid current → last-known-good (a broken edit never dispatches)", async () => {
    const good = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: VALID_BODY,
      source: "seed",
    });
    await promoteLastKnownGood({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      versionId: good.version.id,
    });
    // A broken edit becomes current...
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: BROKEN_BODY,
      source: "api",
    });
    // ...but the resolver serves the promoted good version.
    const resolved = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      version: "latest",
    });
    expect(resolved?.source).toBe("db-version");
    expect(resolved?.versionId).toBe(good.version.id);
    expect(resolved?.body).toBe(VALID_BODY);
  });

  it("invalid current, no last-known-good → oldest seed version", async () => {
    const seeded = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: VALID_BODY,
      source: "seed",
    });
    // A broken edit becomes current, and nothing was ever promoted...
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: BROKEN_BODY,
      source: "api",
    });
    // ...so the resolver falls to the DB record of the shipped default.
    const resolved = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      version: "latest",
    });
    expect(resolved?.source).toBe("seed-default");
    expect(resolved?.versionId).toBe(seeded.version.id);
    expect(resolved?.body).toBe(VALID_BODY);
    expect(resolved?.contentSha).toBe(computeContentSha(VALID_BODY));
  });

  it("no DB version at all → null (never dispatch a body the org didn't approve)", async () => {
    const resolved = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      version: "latest",
    });
    expect(resolved).toBeNull();
  });

  it("a broken seed never dispatches either → null", async () => {
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: BROKEN_BODY,
      source: "seed",
    });
    const resolved = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      version: "latest",
    });
    expect(resolved).toBeNull();
  });

  it("no org (legacy/unfenced) → null, never a DB body", async () => {
    // Even with a valid seed sitting in SOME org, an org-less request must
    // not resolve to it.
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-ops",
      body: VALID_BODY,
      source: "seed",
    });
    const resolved = await resolveReviewSkill({
      db,
      organizationId: null,
      repoFullName: REPO,
      skillName: "github-ops",
      version: "latest",
    });
    expect(resolved).toBeNull();
  });

  it("non-github-ops skill needs only a non-empty body", async () => {
    const { version } = await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-mention",
      body: "Respond to the GitHub mention.",
      source: "seed",
    });
    const resolved = await resolveReviewSkill({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-mention",
      version: "latest",
    });
    expect(resolved?.source).toBe("db-version");
    expect(resolved?.versionId).toBe(version.id);
  });

  it("non-github-ops skill with no usable version → null (caller skips the run)", async () => {
    // No row at all.
    expect(
      await resolveReviewSkill({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        skillName: "github-mention",
        version: "latest",
      }),
    ).toBeNull();
    // An empty body is invalid and there is no tracked default to fall to.
    await createRepoSkillVersion({
      db,
      organizationId: orgId,
      repoFullName: REPO,
      skillName: "github-mention",
      body: "   ",
      source: "api",
    });
    expect(
      await resolveReviewSkill({
        db,
        organizationId: orgId,
        repoFullName: REPO,
        skillName: "github-mention",
        version: "latest",
      }),
    ).toBeNull();
  });
});
