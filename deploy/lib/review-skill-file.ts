/**
 * Filesystem loader for the tracked review skill — DEPLOY-SIDE ONLY.
 *
 * This module owns the only fs access to `deploy/skills/github-ops/SKILL.md`.
 * It deliberately lives under `deploy/`, not `apps/www`: the Workers runtime
 * has no checkout to read, and a module-scope path resolution inside the www
 * bundle is exactly what broke the production build once (webpack rewrites
 * `new URL(..., import.meta.url)` into an asset URL — see PR #57). The
 * runtime resolver (`resolveReviewSkill`) is pure-DB; the tracked file enters
 * the system solely through the tsx scripts that import this module:
 * `deploy/skill-push.ts` (writes it as a skill version) and
 * `deploy/seed-pilot-mirror.ts` (today inlines it into the `user_message`
 * automation text; the #54 C3 cutover will make it write seed versions too).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertReviewSkillContract,
  stripFrontmatter,
} from "../../apps/www/src/server-lib/review/review-skill";
import { flattenSkillBody } from "./flatten-skill";

/**
 * Absolute path to the tracked skill — the ONLY authoritative in-repo copy,
 * pinned by THIS module's location (`deploy/lib/`), not the caller's cwd.
 * `import.meta.url` is safe again here: the webpack asset-URL hazard only
 * applies inside the www bundle, which this deploy-only module never enters.
 */
export const TRACKED_REVIEW_SKILL_PATH = fileURLToPath(
  new URL("../skills/github-ops/SKILL.md", import.meta.url),
);

/**
 * The review methodology body, ready to push as a skill version: frontmatter
 * stripped and every `<!-- include: <name> -->` line inlined from
 * `<skill dir>/../_shared/<name>.md` — the same text `deploy/skill-push.ts`
 * stores. Throws rather than returning a partial instruction: a review agent
 * running without its methodology silently degrades every review, so failing
 * the seed/push is correct.
 *
 * `include-pinned` lines are refused here: the tracked github-ops skill has
 * none, and the seed must not reach the network. Push such a skill with
 * skill-push.ts instead.
 */
export async function loadReviewSkillBody(
  skillPath: string = TRACKED_REVIEW_SKILL_PATH,
): Promise<string> {
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf8");
  } catch (err) {
    throw new Error(
      `Review skill not readable at ${skillPath}: ${(err as Error).message}. ` +
        `It is tracked in-repo; a missing file means the checkout is incomplete.`,
    );
  }
  const sharedDir = path.resolve(path.dirname(skillPath), "..", "_shared");
  const body = await flattenSkillBody(
    stripFrontmatter(raw),
    {
      readPartial: (name) =>
        readFileSync(path.join(sharedDir, `${name}.md`), "utf8"),
      fetchText: () => {
        throw new Error(
          "the seed loader never fetches; push a skill with include-pinned " +
            "lines through deploy/skill-push.ts",
        );
      },
      stripFrontmatter,
    },
    skillPath,
  );
  assertReviewSkillContract(body, skillPath);
  return body;
}
