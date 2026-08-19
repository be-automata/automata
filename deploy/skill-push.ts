/**
 * Push a skill body from a local markdown file into the live skill store —
 * the TERMINAL edit surface of issue #54 C4 (twin of the dashboard panel and
 * the /api/repo-skills PUT). The next automation run for the target
 * (org, repo, skill) picks up the new version: the resolver reads Neon live,
 * so there is no seed script and no redeploy.
 *
 * Usage (DATABASE_URL must point at the target Postgres):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/skill-push.ts \
 *     <orgSlug> <owner/repo> <skillName> <path-to-md>
 *
 * Example:
 *   ... deploy/skill-push.ts beautomata be-automata/automata github-ops \
 *     deploy/skills/github-ops/SKILL.md
 *
 * The body is validated LOCALLY with the SAME per-skill registry the resolver
 * applies at dispatch (github-ops: fenced-json verdict contract; others:
 * non-empty) BEFORE any DB write — a push that would only be rejected or
 * fallen-back-from at run time must fail here, loudly, instead. Frontmatter is
 * stripped exactly like the seed loader (deploy/lib/review-skill-file) so a SKILL.md
 * pushes the same text the seed would inline. The body is NEVER logged — only
 * its sha (it can be multi-KB and shas are the traceability currency).
 */
import { readFileSync } from "node:fs";
import { createDb } from "../packages/shared/src/db";
import { getOrganizationBySlug } from "../packages/shared/src/model/organizations";
import { createRepoSkillVersion } from "../packages/shared/src/model/repo-skills";
import {
  stripFrontmatter,
  validateSkillBody,
} from "../apps/www/src/server-lib/review/review-skill";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Point it at the target Postgres, e.g.\n" +
      "  DATABASE_URL=postgres://... pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> <skillName> <path-to-md>",
  );
  process.exit(1);
}

const [orgSlug, repoFullName, skillName, skillPath] = process.argv.slice(2);
if (!orgSlug || !repoFullName || !skillName || !skillPath) {
  console.error(
    "Usage: pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> <skillName> <path-to-md>",
  );
  process.exit(1);
}
if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
  console.error(`repo must be 'owner/repo', got: ${repoFullName}`);
  process.exit(1);
}

let raw: string;
try {
  raw = readFileSync(skillPath, "utf8");
} catch (err) {
  console.error(
    `Skill file not readable at ${skillPath}: ${(err as Error).message}`,
  );
  process.exit(1);
}
const body = stripFrontmatter(raw);

// Validate BEFORE touching the DB: a body the resolver would refuse must never
// become a stored version some surface later trips over.
try {
  validateSkillBody(skillName, body, skillPath);
} catch (err) {
  console.error(`Validation failed: ${(err as Error).message}`);
  process.exit(1);
}

const db = createDb(databaseUrl);

async function main() {
  const org = await getOrganizationBySlug({ db, slug: orgSlug! });
  if (!org) {
    console.error(
      `No organization found with slug '${orgSlug}'. Create it first (dashboard).`,
    );
    process.exit(1);
  }

  const { version } = await createRepoSkillVersion({
    db,
    organizationId: org.id,
    repoFullName: repoFullName!,
    skillName: skillName!,
    body,
    source: "api",
  });

  console.log(
    `Pushed '${skillName}' for ${repoFullName} (org '${orgSlug}'): version ` +
      `${version.id}, contentSha ${version.contentSha}`,
  );
  console.log("Live on next run — no seed, no redeploy.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Skill push failed:", err);
  process.exit(1);
});
