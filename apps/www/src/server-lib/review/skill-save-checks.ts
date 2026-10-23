/**
 * Save-time checks for skill bodies — WRITE PATHS ONLY.
 *
 * These run where a NEW body enters the skill store: the /api/repo-skills
 * PUT, the dashboard Skills panel's save action, `deploy/skill-push.ts` and
 * `deploy/seed-pilot-mirror.ts`. They refuse a body before it is stored, so
 * the author sees the problem while editing.
 *
 * NEVER call these from `validateSkillBody`, `SKILL_VALIDATORS` or anything
 * else the resolver runs (resolve-review-skill.ts). The resolver re-validates
 * every STORED version at dispatch, and a new requirement there disqualifies
 * bodies that are already stored: the resolver then falls back past
 * last-known-good and the lane runs no review at all. A save-time rule only
 * stops the next bad body; it never retires a stored one.
 *
 * Dependency-free (node builtins only) for the same reason as review-skill.ts:
 * `deploy/*.ts` scripts import it under tsx without Next/alias resolution.
 */
import {
  COMPANION_SKILL_NAMES,
  FLUTTER_REVIEW_SKILL_NAME,
  MENTION_SKILL_NAME,
  validateSkillBody,
} from "./review-skill";

/**
 * Skills whose agent diffs a pull request against its base. Companion skills
 * are matched by suffix too, so a new `<stack>-pr-companion` is covered
 * without touching this list.
 */
export const PR_DIFF_SKILL_NAMES: readonly string[] = [
  "github-ops",
  FLUTTER_REVIEW_SKILL_NAME,
  MENTION_SKILL_NAME,
  ...COMPANION_SKILL_NAMES,
];

const COMPANION_SUFFIX = "-pr-companion";

/** True for a skill whose body must name the PR base as `{{baseBranch}}`. */
export function diffsPullRequest(skillName: string): boolean {
  const name = skillName.trim().toLowerCase();
  return PR_DIFF_SKILL_NAMES.includes(name) || name.endsWith(COMPANION_SUFFIX);
}

/**
 * `git diff`, optional flags (`--stat`, `-U3`, `--name-only` …), then an
 * `origin/` ref that is NOT `{{baseBranch}}`.
 */
const DIFF_AGAINST_FIXED_REMOTE =
  /git diff(?:\s+-{1,2}[\w=-]+)*\s+origin\/(?!\{\{baseBranch\}\})(\S*)/g;
/** A prose placeholder the agent has to fill in itself. */
const PROSE_BASE = /origin\/<base>/g;
/** A hardcoded default branch as the diff base, wherever it appears. */
const FIXED_DEFAULT_BRANCH_RANGE = /origin\/(?:main|master)\.\.\.?HEAD/g;

/**
 * Every place `body` names a PR base the agent cannot know or guesses wrong.
 * Each entry quotes the offending text. Empty when the body is fine.
 *
 * Why: the control plane renders `{{baseBranch}}` to the PR's real base ref
 * on every run and the worker pre-fetches `origin/<that ref>`. A body that
 * says `origin/main` (or leaves `<base>` for the agent to fill in) makes the
 * agent diff a stacked PR (whose base is another PR's branch) against the
 * wrong ref, and the run ends `unable_to_review`.
 */
export function findPrBaseViolations(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(DIFF_AGAINST_FIXED_REMOTE)) {
    found.add(match[0]);
  }
  for (const match of body.matchAll(PROSE_BASE)) found.add(match[0]);
  for (const match of body.matchAll(FIXED_DEFAULT_BRANCH_RANGE)) {
    found.add(match[0]);
  }
  return [...found];
}

/**
 * Throws when a PR-diffing skill's body names its diff base as anything but
 * `origin/{{baseBranch}}`. Other skills pass untouched.
 */
export function assertSkillBodyNamesPrBase(
  skillName: string,
  body: string,
  sourceLabel: string,
): void {
  if (!diffsPullRequest(skillName)) return;
  const violations = findPrBaseViolations(body);
  if (violations.length === 0) return;
  throw new Error(
    `Skill '${skillName}' body from ${sourceLabel} names the pull request's ` +
      `base as ${violations.map((v) => JSON.stringify(v)).join(", ")}. ` +
      `Write it as \`origin/{{baseBranch}}\` (for example ` +
      `\`git diff origin/{{baseBranch}}...HEAD\`): the control plane renders ` +
      `{{baseBranch}} to the PR's real base on every run, and a stacked PR's ` +
      `base is not main.`,
  );
}

/**
 * The full check a write surface runs before storing a new body: the
 * dispatch-time contract (`validateSkillBody`, the same registry the resolver
 * applies) plus the save-time-only rules above.
 */
export function validateSkillBodyForSave(
  skillName: string,
  body: string,
  sourceLabel: string,
): void {
  validateSkillBody(skillName, body, sourceLabel);
  assertSkillBodyNamesPrBase(skillName, body, sourceLabel);
}
