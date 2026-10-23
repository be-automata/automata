/**
 * Push a skill body from a local markdown file into the live skill store —
 * the TERMINAL edit surface of issue #54 C4 (twin of the dashboard panel and
 * the /api/repo-skills PUT). The next automation run for the target
 * (org, repo, skill) picks up the new version: the resolver reads Neon live,
 * so there is no seed script and no redeploy.
 *
 * Usage (DATABASE_URL must point at the target Postgres, except with --dry-run):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/skill-push.ts \
 *     <orgSlug> <owner/repo> <skillName> <path-to-md> [--dry-run] [--out <file>]
 *   # or import a PINNED git skill pack (source: 'git-pack', #64):
 *   DATABASE_URL=postgres://... pnpm exec tsx deploy/skill-push.ts \
 *     <orgSlug> <owner/repo> <skillName> --from-git <src-owner/src-repo>@<40-hex-sha>:<src-path>
 *
 * Example:
 *   ... deploy/skill-push.ts beautomata be-automata/automata github-ops \
 *     deploy/skills/github-ops/SKILL.md
 *   # post-merge ticket audit (ADR-008) — the lane name is `github-pr-merged`:
 *   ... deploy/skill-push.ts <orgSlug> <owner/repo> github-pr-merged \
 *     deploy/skills/github-pr-merged-youtrack/SKILL.md
 *   ... deploy/skill-push.ts beautomata be-automata/automata github-ops \
 *     --from-git be-automata/skill-library@<sha>:github-ops/SKILL.md
 *   # inspect the flattened body without touching any database:
 *   ... deploy/skill-push.ts <orgSlug> <owner/repo> flutter-pr-review \
 *     deploy/skills/flutter-pr-review/SKILL.md --dry-run --out /tmp/flutter.md
 *
 * Flattening (A5, deploy/lib/flatten-skill.ts): `<!-- include: <name> -->`
 * lines are replaced by `<skill dir>/../_shared/<name>.md` and
 * `<!-- include-pinned: <url> -->` lines by the pinned file fetched now, so
 * the stored version is self-contained. Any failure exits 1 before anything
 * is written. `--dry-run` prints the flattened body's contentSha and byte
 * length and writes nothing to the DB; `--out <file>` writes the flattened
 * body to a file (with or without --dry-run). Unknown flags are a hard error.
 * A live push of a skill other than github-ops whose body carries review-mode
 * sections is refused unless `--allow-review-mode-sections` is passed: until
 * #493 is deployed, www renders those sections for github-ops only.
 *
 * The body is validated LOCALLY with the SAME per-skill registry the resolver
 * applies at dispatch (github-ops / flutter-pr-review: fenced-json verdict
 * contract; github-pr-merged: fenced-json audit-intent contract + hard rules;
 * others: non-empty) AFTER flattening and BEFORE any write — a push that would
 * only be rejected or fallen-back-from at run time must fail here, loudly,
 * instead. The save-time-only rules run too (`validateSkillBodyForSave`,
 * skill-save-checks.ts: a PR-diffing skill names its diff base as
 * `origin/{{baseBranch}}`, never `origin/main` or a prose `<base>`); the
 * resolver never applies those to a stored version. Frontmatter is stripped
 * exactly like the seed loader (deploy/lib/review-skill-file) so a SKILL.md
 * pushes the same text the seed would inline. The body is NEVER logged — only its sha (it can be multi-KB
 * and shas are the traceability currency).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "../packages/shared/src/db";
import { getOrganizationBySlug } from "../packages/shared/src/model/organizations";
import { createRepoSkillVersion } from "../packages/shared/src/model/repo-skills";
import type { RepoSkillVersionSource } from "../packages/shared/src/db/types";
import {
  hasReviewModeSections,
  skillNameIs,
  stripFrontmatter,
} from "../apps/www/src/server-lib/review/review-skill";
import { validateSkillBodyForSave } from "../apps/www/src/server-lib/review/skill-save-checks";
import { fetchGitPackBody, parseGitPackRef } from "./lib/git-pack-ref";
import {
  prepareSkillBody,
  type FlattenOptions,
  type PreparedSkillBody,
} from "./lib/flatten-skill";

const USAGE =
  "Usage:\n" +
  "  local: pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> <skillName> <path-to-md> [--dry-run] [--out <file>] [--allow-review-mode-sections]\n" +
  "  git:   pnpm exec tsx deploy/skill-push.ts <orgSlug> <owner/repo> <skillName> --from-git <src-owner/src-repo>@<40-hex-sha>:<src-path> [--dry-run] [--out <file>] [--allow-review-mode-sections]";

/** Pinned-file fetch budget: a hung CDN must fail the push, not stall it. */
const PINNED_FETCH_TIMEOUT_MS = 30_000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---- Arguments ---------------------------------------------------------------
// Unknown --flags are a HARD ERROR, never silently dropped: a typo like
// `--dryrun` must abort, not fall through to a live production write.
const VALUE_FLAGS = new Set(["--from-git", "--out"]);
const ALLOW_SECTIONS_FLAG = "--allow-review-mode-sections";
const BOOLEAN_FLAGS = new Set(["--dry-run", ALLOW_SECTIONS_FLAG]);
const positional: string[] = [];
const flagValues = new Map<string, string>();
let dryRun = false;
let allowReviewModeSections = false;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === ALLOW_SECTIONS_FLAG) allowReviewModeSections = true;
      else dryRun = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${arg} needs a value.\n${USAGE}`);
      }
      if (flagValues.has(arg)) fail(`${arg} given twice.\n${USAGE}`);
      flagValues.set(arg, value);
      i++;
      continue;
    }
    fail(
      `Unknown flag: ${arg}. Known: ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].join(", ")}. ` +
        `Aborting — a mistyped --dry-run must never become a live write.`,
    );
  }
}

const gitRef = flagValues.get("--from-git");
const outPath = flagValues.get("--out");
const [orgSlug, repoFullName, skillName, localPath, ...extra] = positional;
if (
  !orgSlug ||
  !repoFullName ||
  !skillName ||
  extra.length > 0 ||
  (gitRef === undefined) === (localPath === undefined)
) {
  fail(USAGE);
}
if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
  fail(`repo must be 'owner/repo', got: ${repoFullName}`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && !dryRun) {
  fail(
    "DATABASE_URL is not set. Point it at the target Postgres (or pass --dry-run), e.g.\n  " +
      USAGE,
  );
}

async function fetchPinnedText(url: string) {
  return fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(PINNED_FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "automata-skill-push" },
  });
}

async function resolveSource(): Promise<{
  raw: string;
  source: RepoSkillVersionSource;
  sourceRef: string | null;
  label: string;
  readPartial: FlattenOptions["readPartial"];
}> {
  if (gitRef !== undefined) {
    // Parse (validates the 40-hex pin) BEFORE any network call.
    const ref = parseGitPackRef(gitRef);
    return {
      raw: await fetchGitPackBody(ref),
      source: "git-pack",
      sourceRef: ref.canonical,
      label: ref.canonical,
      readPartial: () => {
        throw new Error(
          "local `include` partials are not available to a --from-git skill pack",
        );
      },
    };
  }
  let raw: string;
  try {
    raw = readFileSync(localPath!, "utf8");
  } catch (err) {
    throw new Error(
      `Skill file not readable at ${localPath}: ${(err as Error).message}`,
    );
  }
  const sharedDir = path.resolve(path.dirname(localPath!), "..", "_shared");
  return {
    raw,
    source: "api",
    sourceRef: null,
    label: localPath!,
    readPartial: (name) =>
      readFileSync(path.join(sharedDir, `${name}.md`), "utf8"),
  };
}

async function main() {
  const src = await resolveSource();

  // Flatten, then validate, BEFORE any write: a body the resolver would refuse
  // must never become a stored version some surface later trips over. Same
  // registry the resolver applies at dispatch, whichever source the body came
  // from. Any failure here exits 1 with nothing written (no --out, no DB).
  let prepared: PreparedSkillBody;
  try {
    prepared = await prepareSkillBody({
      raw: src.raw,
      skillName: skillName!,
      label: src.label,
      flatten: {
        readPartial: src.readPartial,
        fetchText: fetchPinnedText,
        stripFrontmatter,
      },
      validate: validateSkillBodyForSave,
      writeOut: outPath
        ? (body) => writeFileSync(outPath, body, "utf8")
        : undefined,
    });
  } catch (err) {
    fail(`Skill push aborted, nothing written: ${(err as Error).message}`);
  }
  if (outPath) {
    console.log(`Wrote the flattened body to ${outPath}.`);
  }

  // Deploy-order fence (#493): until www renders review-mode sections for every
  // skill, it renders them ONLY for github-ops. Any other marker-bearing body
  // reaches the agent RAW, the agent emits a tagged block the classic parser
  // cannot read, and every run of that lane posts a no-verdict notice. Refuse
  // the live write unless the operator states #493 is deployed.
  const sectionsFenced =
    hasReviewModeSections(prepared.body) &&
    !skillNameIs(skillName!, "github-ops") &&
    !allowReviewModeSections;
  const sectionsMessage =
    `'${skillName}' carries review-mode sections (<!-- automata:if … -->), ` +
    `which www renders only for github-ops until #493 is deployed. Pushed ` +
    `before then, the agent reads them raw and every run posts a no-verdict ` +
    `notice. Pass ${ALLOW_SECTIONS_FLAG} only once #493 is live.`;

  if (dryRun) {
    if (sectionsFenced) console.warn(`[dry-run] WARNING: ${sectionsMessage}`);
    console.log(
      `[dry-run] '${skillName}' for ${repoFullName} (org '${orgSlug}') from ` +
        `${src.label}: contentSha ${prepared.sha}, ${prepared.bytes} bytes. ` +
        `Nothing was written to the database.`,
    );
    process.exit(0);
  }
  if (sectionsFenced) {
    fail(`Skill push aborted, nothing written: ${sectionsMessage}`);
  }

  const db = createDb(databaseUrl!);
  const org = await getOrganizationBySlug({ db, slug: orgSlug! });
  if (!org) {
    fail(
      `No organization found with slug '${orgSlug}'. Create it first (dashboard).`,
    );
  }

  const { version } = await createRepoSkillVersion({
    db,
    organizationId: org.id,
    repoFullName: repoFullName!,
    skillName: skillName!,
    body: prepared.body,
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
