/**
 * Single source of truth for the emit-only review skill (ADR-036).
 *
 * The seed used to point the review agent at a hardcoded box path
 * (`/Users/senior/.claude/skills/github-ops/SKILL.md`), which created two
 * problems: the instruction only resolved on the pilot box (the
 * `rev3-skill-path-portable` TODO), and the tracked copy under
 * `deploy/skills/` could silently drift from the installed copy the agent
 * actually read — undetectable, because nothing compared them.
 *
 * Instead the seed now INLINES this body into the automation instruction at
 * seed time. The tracked file is the only copy that matters, the agent needs
 * no box-local file, and a skill edit reaches onboarded repos through the
 * existing `upsertAutomation` action-content update.
 *
 * Dependency-free on purpose (node builtins only) so `deploy/*.ts` scripts can
 * import it under tsx without dragging in Next/alias resolution.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Absolute path to the tracked skill — the ONLY authoritative copy.
 *
 * Resolved lazily from cwd, NOT via `new URL(..., import.meta.url)`: webpack
 * rewrites that expression into an asset URL at module scope, which crashes
 * the production build of any route that imports this module (and the Workers
 * runtime has no checkout to read regardless — there the DB tiers of
 * resolveReviewSkill are authoritative and this path is only reached as the
 * loudly-logged last-resort tier). The candidates cover the two real callers:
 * `deploy/*.ts` scripts run from the repo root, and apps/www tests/dev run
 * from `apps/www`.
 */
export function trackedReviewSkillPath(): string {
  const rel = join("deploy", "skills", "github-ops", "SKILL.md");
  const candidates = [
    join(process.cwd(), rel),
    join(process.cwd(), "..", "..", rel),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * Strip the Claude Code YAML frontmatter. It carries skill-registry metadata
 * (name/description) that is meaningless inside an automation instruction, and
 * its `---` fences would otherwise read as markdown rules mid-prompt.
 */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md.trim();
  // The closing fence must be a line that is EXACTLY `---` (trailing spaces/tabs
  // allowed), not merely one STARTING with it. A prefix match — the old
  // `indexOf("\n---")` — let a frontmatter value such as `summary: ---draft`
  // read as the fence and silently truncate the body from there on.
  // The trailing `(?:\r?\n|$)` is what pins it to a whole line, and tolerates
  // CRLF checkouts and a fence with no trailing newline.
  const fence = /\n---[ \t]*(?:\r?\n|$)/.exec(md.slice(3));
  if (!fence) return md.trim();
  return md.slice(3 + fence.index + fence[0].length).trim();
}

/**
 * THE fenced-json verdict-contract check, shared by the tracked-file loader
 * below and the live-skill resolver (resolve-review-skill.ts): a github-ops
 * body that cannot instruct the agent to emit a parseable verdict must never
 * be dispatched, whichever store it came from. Throws with a caller-supplied
 * label so the error names the offending source (a file path, a version id).
 */
export function assertReviewSkillContract(
  body: string,
  sourceLabel: string,
): void {
  if (!/```json[\s\S]*"verdict"[\s\S]*```/.test(body)) {
    throw new Error(
      `Review skill from ${sourceLabel} has no fenced-json verdict contract — ` +
        `wrong content or a truncated skill. Refusing to dispatch a review ` +
        `whose agent could not emit a parseable intent.`,
    );
  }
}

/**
 * Per-skill body validators — THE single registry shared by every surface that
 * accepts or dispatches a skill body: the resolver (read side,
 * resolve-review-skill.ts) and the write surfaces (API route PUT, dashboard
 * server actions, deploy/skill-push.ts). Lives HERE, not in the resolver,
 * because this module is dependency-free (node builtins only) so `deploy/*.ts`
 * scripts can import it under tsx without Next/alias resolution — and so the
 * write boundary can never drift from what the resolver will later accept.
 *
 * Throwing = invalid. Keyed by skill name so a new skill gets the safe default
 * (non-empty) without touching any surface, and a skill with a machine-parsed
 * output contract (github-ops) can pin it here.
 */
const SKILL_VALIDATORS: Record<
  string,
  (body: string, sourceLabel: string) => void
> = {
  "github-ops": assertReviewSkillContract,
};

export function validateSkillBody(
  skillName: string,
  body: string,
  sourceLabel: string,
): void {
  const validator = SKILL_VALIDATORS[skillName];
  if (validator) {
    validator(body, sourceLabel);
    return;
  }
  if (body.trim().length === 0) {
    throw new Error(
      `Skill '${skillName}' body from ${sourceLabel} is empty — refusing to ` +
        `dispatch an automation run with no instruction.`,
    );
  }
}

/**
 * The review methodology body, ready to inline into a prompt. Throws rather
 * than returning a partial instruction: a review agent running without its
 * methodology silently degrades every review, so failing the seed is correct.
 */
export function loadReviewSkillBody(
  skillPath: string = trackedReviewSkillPath(),
): string {
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf8");
  } catch (err) {
    throw new Error(
      `Review skill not readable at ${skillPath}: ${(err as Error).message}. ` +
        `It is tracked in-repo; a missing file means the checkout is incomplete.`,
    );
  }
  const body = stripFrontmatter(raw);
  assertReviewSkillContract(body, skillPath);
  return body;
}
