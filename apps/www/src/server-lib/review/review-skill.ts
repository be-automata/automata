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
 * import it under tsx without dragging in Next/alias resolution. The one
 * exception is the audit rule vocabulary, imported by relative path from a
 * module that itself imports nothing.
 */
import { AUDIT_RULES } from "../../../../../packages/shared/src/self-heal/audit-rules";

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
 * Review-mode sections (phase 6): ONE github-ops body carries both the classic
 * prompt and the orchestrated (lead reviewer + sub-agents) prompt, and the
 * render step keeps the text that matches the run's resolved review mode.
 *
 * Grammar — line-based, each marker is the WHOLE line (trailing spaces/tabs
 * and a trailing CR tolerated), no nesting:
 *   `<!-- automata:if <condition> -->`   begins a block
 *   `<!-- automata:endif -->`            ends it
 * `<condition>` is one of REVIEW_MODE_SECTION_CONDITIONS. Any other line
 * starting with `<!-- automata:` is a grammar error. A kept block loses only
 * its two marker lines; a dropped block loses every line from its begin marker
 * through its end marker inclusive. Authors keep a block's trailing blank line
 * INSIDE the block so both renders keep their paragraph spacing.
 *
 * Why classic must be byte-identical: the classic render is what every
 * onboarded repo receives today, and its bytes are pinned by sha
 * (github-ops-review-mode.test.ts). A marker-free body is returned as the very
 * same string, so old stored versions, repo overrides and other skills are
 * untouched in every mode.
 *
 * Deploy-ordering hazard: a www that predates this renderer serves a
 * marker-bearing body VERBATIM (markers and the orchestrated text included)
 * to every repo. So www ships BEFORE a marker body is pushed, the body goes to
 * the canary repo only, and a rollback reverts the skill version BEFORE www is
 * rolled back (deploy/PILOT-RUNBOOK.md, phase 6).
 */
export const REVIEW_MODE_SECTION_CONDITIONS = [
  "classic",
  "orchestrated",
  "orchestrated run-tests",
  "orchestrated no-run-tests",
] as const;

type ReviewModeSectionCondition =
  (typeof REVIEW_MODE_SECTION_CONDITIONS)[number];

/**
 * The render-time review mode. A LOCAL literal union, not an import of the
 * shared ReviewMode: this module must stay importable by deploy tsx scripts.
 * resolve-review-prompt-mode.ts assigns a ReviewMode into it, so a future
 * third mode is a compile error there.
 */
export type ReviewPromptMode = {
  mode: "classic" | "orchestrated";
  runTests: boolean;
};

/** The classic render — today's prompt, and the fallback wherever no mode resolves. */
export const CLASSIC_REVIEW_PROMPT: Readonly<ReviewPromptMode> = {
  mode: "classic",
  runTests: false,
};

const MARKER_PREFIX = "<!-- automata:";
const SECTION_BEGIN = /^<!-- automata:if ([^\r\n]*?) -->[ \t]*\r?$/;
const SECTION_END = /^<!-- automata:endif -->[ \t]*\r?$/;

type SectionScan =
  | { error: string }
  | {
      lines: string[];
      /** The block condition each line belongs to, or null outside blocks. */
      conditions: (ReviewModeSectionCondition | null)[];
      /** Whether each line is a marker line (always dropped). */
      markers: boolean[];
    };

function isSectionCondition(
  value: string,
): value is ReviewModeSectionCondition {
  return (REVIEW_MODE_SECTION_CONDITIONS as readonly string[]).includes(value);
}

function scanReviewModeSections(body: string): SectionScan {
  const lines = body.split("\n");
  const conditions: (ReviewModeSectionCondition | null)[] = [];
  const markers: boolean[] = [];
  let open: ReviewModeSectionCondition | null = null;
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const begin = SECTION_BEGIN.exec(line);
    if (begin) {
      const condition = begin[1] ?? "";
      if (!isSectionCondition(condition)) {
        return {
          error: `line ${lineNo}: unknown condition "${condition}" (allowed: ${REVIEW_MODE_SECTION_CONDITIONS.join(", ")})`,
        };
      }
      if (open !== null) {
        return {
          error: `line ${lineNo}: nested "if" inside an open "${open}" block`,
        };
      }
      open = condition;
      conditions.push(condition);
      markers.push(true);
      continue;
    }
    if (SECTION_END.test(line)) {
      if (open === null) {
        return { error: `line ${lineNo}: "endif" without an open "if"` };
      }
      conditions.push(open);
      markers.push(true);
      open = null;
      continue;
    }
    if (line.trimStart().startsWith(MARKER_PREFIX)) {
      return {
        error: `line ${lineNo}: unrecognised review-mode marker (only whole-line "if <condition>" and "endif" exist)`,
      };
    }
    conditions.push(open);
    markers.push(false);
  }
  if (open !== null) {
    return { error: `unclosed "${open}" block at end of body` };
  }
  return { lines, conditions, markers };
}

/** The grammar error of a body, or undefined when it is valid / marker-free. */
export function findReviewModeSectionError(body: string): string | undefined {
  if (!body.includes(MARKER_PREFIX)) return undefined;
  const scan = scanReviewModeSections(body);
  return "error" in scan ? scan.error : undefined;
}

/** True iff the body has at least one valid `orchestrated*` block. */
export function hasReviewModeSections(body: string): boolean {
  if (!body.includes(MARKER_PREFIX)) return false;
  const scan = scanReviewModeSections(body);
  if ("error" in scan) return false;
  return scan.conditions.some(
    (condition) => condition !== null && condition.startsWith("orchestrated"),
  );
}

function activeConditions(
  prompt: ReviewPromptMode | undefined,
): ReadonlySet<ReviewModeSectionCondition> {
  if (!prompt || prompt.mode === "classic") return new Set(["classic"]);
  return new Set([
    "orchestrated",
    prompt.runTests ? "orchestrated run-tests" : "orchestrated no-run-tests",
  ]);
}

/**
 * Render a body's review-mode sections for one run. Absent prompt = classic.
 * Throws on a grammar error: unreachable in production (validateSkillBody
 * rejects such bodies at every write surface and in the resolver), and a throw
 * fails the automation run closed instead of leaking orchestrated text into a
 * classic prompt.
 */
export function renderReviewModeSections(
  body: string,
  prompt?: ReviewPromptMode,
): string {
  if (!body.includes(MARKER_PREFIX)) return body;
  const scan = scanReviewModeSections(body);
  if ("error" in scan) throw new Error(scan.error);
  const active = activeConditions(prompt);
  const kept: string[] = [];
  for (const [index, line] of scan.lines.entries()) {
    if (scan.markers[index]) continue;
    const condition = scan.conditions[index] ?? null;
    if (condition === null || active.has(condition)) kept.push(line);
  }
  return kept.join("\n");
}

const REVIEW_CONTRACT_RENDERS: readonly ReviewPromptMode[] = [
  CLASSIC_REVIEW_PROMPT,
  { mode: "orchestrated", runTests: true },
  { mode: "orchestrated", runTests: false },
];

/**
 * THE fenced-json verdict-contract check, shared by the tracked-file loader
 * (deploy/lib/review-skill-file.ts) and the live-skill resolver
 * (resolve-review-skill.ts): a github-ops
 * body that cannot instruct the agent to emit a parseable verdict must never
 * be dispatched, whichever store it came from. Throws with a caller-supplied
 * label so the error names the offending source (a file path, a version id).
 *
 * Review-mode sections: the grammar must be valid, and the contract must
 * survive EVERY render (classic, orchestrated with and without run-tests) —
 * a contract living only inside a dropped block would leave that mode's agent
 * unable to emit a parseable intent. A marker-free body is checked exactly as
 * before (all three renders are the body itself).
 */
export function assertReviewSkillContract(
  body: string,
  sourceLabel: string,
): void {
  const sectionError = findReviewModeSectionError(body);
  if (sectionError !== undefined) {
    throw new Error(
      `Review skill from ${sourceLabel} has a malformed review-mode section: ${sectionError}`,
    );
  }
  const contract = /```json[\s\S]*"verdict"[\s\S]*```/;
  const renders = body.includes(MARKER_PREFIX)
    ? REVIEW_CONTRACT_RENDERS.map((prompt) =>
        renderReviewModeSections(body, prompt),
      )
    : [body];
  if (!renders.every((render) => contract.test(render))) {
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
 * The audit lane's fixed skill name (phase 8). Like PR_MERGED_SKILL_NAME the
 * lane is looked up by name; the BODY pushed under it is what a repo audits.
 */
export const AUDIT_FINDINGS_SKILL_NAME = "audit-findings";

/** Skills whose threads reach the self-heal writer at finish (Phase 9 appends "audit-fix"). */
export const SELF_HEAL_SKILL_NAMES = [AUDIT_FINDINGS_SKILL_NAME] as const;

/** Must equal the parser's tagged opener (pinned by skill-contract-drift.test.ts). */
const AUDIT_FINDINGS_OPENER = "```json audit-findings";

/**
 * Contract check for the audit skill: it must teach the one tagged block, every
 * rule id of the closed vocabulary, the deterministic dependency audit fallback,
 * the 20 minute budget and the Hard rules tail, and must not carry a second
 * block after the Hard rules (the parser reads the LAST one).
 */
export function assertAuditFindingsSkillContract(
  body: string,
  sourceLabel: string,
): void {
  const fail = (what: string): never => {
    throw new Error(
      `Audit skill from ${sourceLabel} ${what} — wrong content or a ` +
        `truncated skill. Refusing to dispatch an audit whose result could ` +
        `not be parsed.`,
    );
  };
  if (!body.includes(AUDIT_FINDINGS_OPENER)) {
    fail(`has no "${AUDIT_FINDINGS_OPENER}" block`);
  }
  for (const rule of AUDIT_RULES) {
    if (!body.includes(rule.id)) fail(`does not list rule "${rule.id}"`);
  }
  if (!body.includes("pnpm audit --prod --json")) {
    fail('has no "pnpm audit --prod --json" dependency fallback');
  }
  if (!body.includes("20 minutes")) fail("has no 20 minute budget");
  const hard = body.search(/^## Hard rules\s*$/m);
  if (hard < 0) fail('has no "## Hard rules" section');
  if (body.indexOf(AUDIT_FINDINGS_OPENER, hard) >= 0) {
    fail('has a second "json audit-findings" block after the Hard rules');
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
  [AUDIT_FINDINGS_SKILL_NAME]: assertAuditFindingsSkillContract,
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
