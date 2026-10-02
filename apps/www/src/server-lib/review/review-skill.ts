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
 * (deploy/lib/review-skill-file.ts) and the live-skill resolver
 * (resolve-review-skill.ts): a github-ops
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
 * The fixed LANE name the merged-PR path looks up (mirror-intake.ts). The lane
 * name is tracker-agnostic on purpose: what a repo does after a merge is
 * decided by the BODY pushed under this name (a YouTrack audit for one org, a
 * different tracker for the next), never by a second lookup key.
 */
export const PR_MERGED_SKILL_NAME = "github-pr-merged";

/**
 * Contract check for the post-merge audit skill (ADR-008). The control-plane
 * executor acts only on an emitted `pr-merged-audit` intent, so a body that
 * cannot instruct the agent to emit one produces a degraded notice on every
 * merge.
 *
 * A `## Hard rules` section is required too. It is the tail of the skill, so
 * its absence means the body was truncated — and the heading is deliberately
 * tracker-neutral: the lane name is, and a different team's body must not have
 * to quote another board's stage names to be accepted.
 */
export function assertMergeAuditSkillContract(
  body: string,
  sourceLabel: string,
): void {
  // indexOf, not one regex: three unbounded wildcards backtrack polynomially
  // on a repo-controlled override body.
  const fence = body.indexOf("```json");
  const kind = fence < 0 ? -1 : body.indexOf('"pr-merged-audit"', fence);
  const criteria = kind < 0 ? -1 : body.indexOf('"criteria"', kind);
  if (criteria < 0 || body.indexOf("```", criteria) < 0) {
    throw new Error(
      `Post-merge audit skill from ${sourceLabel} has no fenced-json ` +
        `"pr-merged-audit" intent contract — wrong content or a truncated ` +
        `skill. Refusing to dispatch an audit whose result could not be parsed.`,
    );
  }
  if (!/^## Hard rules\s*$/m.test(body)) {
    throw new Error(
      `Post-merge audit skill from ${sourceLabel} has no "## Hard rules" ` +
        `section — the body looks truncated.`,
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
  [PR_MERGED_SKILL_NAME]: assertMergeAuditSkillContract,
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
