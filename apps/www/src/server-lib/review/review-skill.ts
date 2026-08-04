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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path to the tracked skill — the ONLY authoritative copy. */
export const TRACKED_REVIEW_SKILL_PATH = fileURLToPath(
  new URL("../../../../../deploy/skills/github-ops/SKILL.md", import.meta.url),
);

/**
 * Strip the Claude Code YAML frontmatter. It carries skill-registry metadata
 * (name/description) that is meaningless inside an automation instruction, and
 * its `---` fences would otherwise read as markdown rules mid-prompt.
 */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md.trim();
  // Match the CLOSING fence only at a line start, so a `---` inside the
  // frontmatter body cannot terminate it early.
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md.trim();
  const afterFence = md.indexOf("\n", end + 1);
  return afterFence === -1 ? "" : md.slice(afterFence + 1).trim();
}

/**
 * The review methodology body, ready to inline into a prompt. Throws rather
 * than returning a partial instruction: a review agent running without its
 * methodology silently degrades every review, so failing the seed is correct.
 */
export function loadReviewSkillBody(
  skillPath: string = TRACKED_REVIEW_SKILL_PATH,
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
  if (!/```json[\s\S]*"verdict"[\s\S]*```/.test(body)) {
    throw new Error(
      `Review skill at ${skillPath} has no fenced-json verdict contract — ` +
        `wrong file or a truncated skill. Refusing to seed a review automation ` +
        `whose agent could not emit a parseable intent.`,
    );
  }
  return body;
}
