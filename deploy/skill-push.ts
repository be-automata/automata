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
 *   # or import a PINNED git skill pack (source: 'git-pack', #64):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/skill-push.ts \
 *     <orgSlug> <owner/repo> <skillName> --from-git <src-owner/src-repo>@<40-hex-sha>:<src-path>
 *
 * Example:
 *   ... deploy/skill-push.ts beautomata be-automata/automata github-ops \
 *     deploy/skills/github-ops/SKILL.md
 *   ... deploy/skill-push.ts beautomata be-automata/automata github-ops \
 *     --from-git be-automata/skill-library@<sha>:github-ops/SKILL.md
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
import type { RepoSkillVersionSource } from "../packages/shared/src/db/types";
import {
  stripFrontmatter,
  validateSkillBody,
} from "../apps/www/src/server-lib/review/review-skill";
import { fetchGitPackBody, parseGitPackRef } from "./lib/git-pack-ref";

const USAGE =
  "Usage:\n" +
  "  local: pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> <skillName> <path-to-md>\n" +
  "  git:   pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> <skillName> --from-git <src-owner/src-repo>@<40-hex-sha>:<src-path>";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is not set. Point it at the target Postgres, e.g.\n  " +
      USAGE,
  );
  process.exit(1);
}

const [orgSlug, repoFullName, skillName, arg4, arg5] = process.argv.slice(2);
if (!orgSlug || !repoFullName || !skillName || !arg4) {
  console.error(USAGE);
  process.exit(1);
}
if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
  console.error(`repo must be 'owner/repo', got: ${repoFullName}`);
  process.exit(1);
}

const gitMode = arg4 === "--from-git";
if (gitMode && !arg5) {
  console.error(
    "--from-git needs a pinned ref: <src-owner/src-repo>@<40-hex-sha>:<src-path>",
  );
  process.exit(1);
}

const db = createDb(databaseUrl);

async function resolveSource(): Promise<{
  body: string;
  source: RepoSkillVersionSource;
  sourceRef: string | null;
  label: string;
}> {
  if (gitMode) {
    // Parse (validates the 40-hex pin) BEFORE any network call.
    const ref = parseGitPackRef(arg5!);
    const raw = await fetchGitPackBody(ref);
    return {
      body: stripFrontmatter(raw),
      source: "git-pack",
      sourceRef: ref.canonical,
      label: ref.canonical,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(arg4!, "utf8");
  } catch (err) {
    throw new Error(
      `Skill file not readable at ${arg4}: ${(err as Error).message}`,
    );
  }
  return {
    body: stripFrontmatter(raw),
    source: "api",
    sourceRef: null,
    label: arg4!,
  };
}

async function main() {
  const src = await resolveSource();

  // Validate BEFORE touching the DB: a body the resolver would refuse must
  // never become a stored version some surface later trips over. Same registry
  // the resolver applies at dispatch, whichever source the body came from.
  try {
    validateSkillBody(skillName!, src.body, src.label);
  } catch (err) {
    console.error(`Validation failed: ${(err as Error).message}`);
    process.exit(1);
  }

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
    body: src.body,
    source: src.source,
    sourceRef: src.sourceRef,
  });

  console.log(
    `Pushed '${skillName}' for ${repoFullName} (org '${orgSlug}'): version ` +
      `${version.id}, contentSha ${version.contentSha}` +
      (src.sourceRef ? `, from ${src.sourceRef}` : ""),
  );
  console.log("Live on next run — no seed, no redeploy.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Skill push failed:", err);
  process.exit(1);
});
