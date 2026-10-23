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
 * module that itself imports nothing (type-only imports are erased).
 */
import type { AutomationAction } from "@terragon/shared/automations";
import type { ThreadSourceMetadata } from "@terragon/shared/db/types";

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
 * Review-mode sections (phase 6): ONE review-skill body carries both the classic
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

/**
 * Control-plane context a review agent cannot fetch itself: it holds no GitHub
 * credential (ADR-004), so the PR view, the prior reviews and the unresolved
 * review threads are read by the control plane with the App token when the
 * thread is created (prefetch-review-context.ts).
 *
 * A skill asks for them with ONE whole-line directive,
 * `<!-- automata:context <fetcher> [<fetcher> …] -->`; the rendered blocks
 * replace that line. Unlike the section markers it is CONTENT, not a marker:
 * every render keeps it, so the substitution happens after rendering and the
 * fetched (untrusted) text is never itself section- or placeholder-processed.
 * A body without the directive is rendered byte-identical.
 */
export const REVIEW_CONTEXT_FETCHERS = [
  "pr-view",
  "prior-reviews",
  "review-threads",
] as const;

export type ReviewContextFetcher = (typeof REVIEW_CONTEXT_FETCHERS)[number];

const CONTEXT_DIRECTIVE = /^<!-- automata:context ([^\r\n]*?) -->[ \t]*\r?$/;

function isContextFetcher(value: string): value is ReviewContextFetcher {
  return (REVIEW_CONTEXT_FETCHERS as readonly string[]).includes(value);
}

/** The fetchers a directive's argument names, or the reason it is invalid. */
function parseContextFetchers(
  argument: string,
): { fetchers: ReviewContextFetcher[] } | { error: string } {
  const names = argument.split(/\s+/).filter((name) => name.length > 0);
  if (names.length === 0) {
    return { error: '"context" names no fetcher' };
  }
  const fetchers: ReviewContextFetcher[] = [];
  for (const name of names) {
    if (!isContextFetcher(name)) {
      return {
        error: `unknown context fetcher "${name}" (allowed: ${REVIEW_CONTEXT_FETCHERS.join(", ")})`,
      };
    }
    if (fetchers.includes(name)) {
      return { error: `context fetcher "${name}" is named twice` };
    }
    fetchers.push(name);
  }
  return { fetchers };
}

/**
 * The fetchers the body's context directive asks for, or null when it has
 * none. Assumes a body the validator accepted (at most one directive).
 */
export function findReviewContextDirective(
  body: string,
): ReviewContextFetcher[] | null {
  if (!body.includes(MARKER_PREFIX)) return null;
  for (const line of body.split("\n")) {
    const match = CONTEXT_DIRECTIVE.exec(line);
    if (!match) continue;
    const parsed = parseContextFetchers(match[1] ?? "");
    return "fetchers" in parsed ? parsed.fetchers : null;
  }
  return null;
}

/** Replace the body's context directive line with `rendered`. */
export function substituteReviewContext(
  body: string,
  rendered: string,
): string {
  return body
    .split("\n")
    .map((line) => (CONTEXT_DIRECTIVE.test(line) ? rendered : line))
    .join("\n");
}

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
  let contextSeen = false;
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    const context = CONTEXT_DIRECTIVE.exec(line);
    if (context) {
      const parsed = parseContextFetchers(context[1] ?? "");
      if ("error" in parsed) {
        return { error: `line ${lineNo}: ${parsed.error}` };
      }
      if (contextSeen) {
        return {
          error: `line ${lineNo}: a second "context" directive (only one is allowed)`,
        };
      }
      contextSeen = true;
      // Content, not a marker: kept by every render (see CONTEXT_DIRECTIVE).
      conditions.push(open);
      markers.push(false);
      continue;
    }
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
        error: `line ${lineNo}: unrecognised review-mode marker (only whole-line "if <condition>", "endif" and "context <fetcher>…" exist)`,
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

/** Throws `<subject> has a malformed review-mode section: …` on a bad grammar. */
function assertSectionGrammar(body: string, subject: string): void {
  const sectionError = findReviewModeSectionError(body);
  if (sectionError !== undefined) {
    throw new Error(
      `${subject} has a malformed review-mode section: ${sectionError}`,
    );
  }
}

/** Every text a body renders to, one per mode: just itself without markers. */
function everyRender(body: string): string[] {
  return body.includes(MARKER_PREFIX)
    ? REVIEW_CONTRACT_RENDERS.map((prompt) =>
        renderReviewModeSections(body, prompt),
      )
    : [body];
}

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
  assertSectionGrammar(body, `Review skill from ${sourceLabel}`);
  const contract = /```json[\s\S]*"verdict"[\s\S]*```/;
  if (!everyRender(body).every((render) => contract.test(render))) {
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

/**
 * The fix lane's fixed skill name (phase 9). The run pushes one automata/fix-*
 * branch and emits nothing; the platform opens the draft PR.
 */
export const AUDIT_FIX_SKILL_NAME = "audit-fix";

/** Skill names compare trimmed and case-insensitively, as automations are validated. */
export function skillNameIs(skillName: string, expected: string): boolean {
  return skillName.trim().toLowerCase() === expected;
}

/** A skill_message action that runs the audit-fix skill (any trigger). */
export function isAuditFixAction(
  action: AutomationAction | null | undefined,
): boolean {
  return (
    action?.type === "skill_message" &&
    skillNameIs(action.config.skillName, AUDIT_FIX_SKILL_NAME)
  );
}

/** The automation-skill stamp a thread carries. */
export type AutomationSkillStamp = Extract<
  ThreadSourceMetadata,
  { type: "automation-skill" }
>;

/** A thread stamped by the automation-skill lane for `expected`. */
function isSkillStamp(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
  expected: string,
): sourceMetadata is AutomationSkillStamp {
  return (
    sourceMetadata?.type === "automation-skill" &&
    skillNameIs(sourceMetadata.skillName, expected)
  );
}

/** True for a thread stamped by the fix lane. */
export function isAuditFixStamp(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
): sourceMetadata is AutomationSkillStamp {
  return isSkillStamp(sourceMetadata, AUDIT_FIX_SKILL_NAME);
}

/** True for a thread stamped by the audit lane. */
export function isAuditFindingsStamp(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
): sourceMetadata is AutomationSkillStamp {
  return isSkillStamp(sourceMetadata, AUDIT_FINDINGS_SKILL_NAME);
}

/** Skills whose threads reach the self-heal writer at finish (Drain and the stamp checks cover both). */
export const SELF_HEAL_SKILL_NAMES = [
  AUDIT_FINDINGS_SKILL_NAME,
  AUDIT_FIX_SKILL_NAME,
] as const;

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
 * Phrases the fix skill must carry. Each one is a scope or safety rule the
 * platform also enforces elsewhere (git-broker ref fence, the worker and www
 * deny-list checks, the draft-PR opener); the prompt copy is what keeps a
 * well-behaved agent from tripping those fences in the first place.
 * `automata/fix-` must equal FIX_BRANCH_PREFIX (pinned by the drift test; not
 * imported, so this module stays importable by deploy tsx scripts).
 */
const AUDIT_FIX_REQUIRED_PHRASES = [
  "## Hard rules",
  "Do not open a pull request",
  "git push",
  "Only change the files listed",
  "Do not edit or delete existing tests",
  "eslint-disable",
  "@ts-ignore",
  "nosec",
  "15 minutes",
  "automata/fix-",
] as const;

/**
 * Contract check for the fix skill: every required scope rule is present, the
 * Hard rules heading is a real heading (the tail — its absence means
 * truncation), and the body carries no fenced json block: a fix run emits
 * nothing for the platform to parse, so a block is the wrong skill pushed
 * under this name.
 */
export function assertAuditFixSkillContract(
  body: string,
  sourceLabel: string,
): void {
  const fail = (what: string): never => {
    throw new Error(
      `Fix skill from ${sourceLabel} ${what} — wrong content or a truncated ` +
        `skill. Refusing to dispatch a write-capable fix run without its ` +
        `scope rules.`,
    );
  };
  for (const phrase of AUDIT_FIX_REQUIRED_PHRASES) {
    if (!body.includes(phrase)) fail(`is missing "${phrase}"`);
  }
  if (!/^## Hard rules\s*$/m.test(body)) {
    fail('has no "## Hard rules" section heading');
  }
  if (body.includes("```json")) {
    fail("carries a fenced json block (a fix run emits nothing)");
  }
}

/**
 * The org-owned mention lane's fixed skill name. Like the other lanes the
 * BODY pushed under this name is what a repo's mentions run.
 */
export const MENTION_SKILL_NAME = "github-mention";

/**
 * The kind of the one block a mention run emits. The opener is three
 * backticks, `json`, a space, then this kind (mention-reply-finish.ts).
 */
export const MENTION_REPLY_KIND = "mention-reply";

/**
 * Contract check for the mention skill: the control plane posts only what the
 * agent emits in a fenced json `mention-reply` block, so a body that cannot
 * teach that block would answer every mention with the "couldn't complete"
 * notice. indexOf, not one regex (a repo-controlled override body).
 */
export function assertMentionSkillContract(
  body: string,
  sourceLabel: string,
): void {
  const fence = body.indexOf("```json");
  const kind = fence < 0 ? -1 : body.indexOf(`"${MENTION_REPLY_KIND}"`, fence);
  if (kind < 0 || body.indexOf("```", kind) < 0) {
    throw new Error(
      `Mention skill from ${sourceLabel} has no fenced-json ` +
        `"${MENTION_REPLY_KIND}" contract — wrong content or a truncated ` +
        `skill. Refusing to dispatch a mention whose reply could not be parsed.`,
    );
  }
}

/** The automation-skill stamp of a mention-lane thread. */
export type MentionLaneThreadStamp = AutomationSkillStamp & {
  mention: NonNullable<AutomationSkillStamp["mention"]>;
};

/** True for a thread the org-owned mention lane started. */
export function isMentionLaneStamp(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
): sourceMetadata is MentionLaneThreadStamp {
  return (
    sourceMetadata?.type === "automation-skill" &&
    sourceMetadata.mention !== undefined
  );
}

/**
 * The PR companion lane's skills (advisory, emit-only, one PR comment). Each
 * is pushed and onboarded under its own name; the BODY decides the stack.
 */
export const FLUTTER_COMPANION_SKILL_NAME = "flutter-pr-companion";
export const REACT_COMPANION_SKILL_NAME = "react-pr-companion";
export const COMPANION_SKILL_NAMES = [
  FLUTTER_COMPANION_SKILL_NAME,
  REACT_COMPANION_SKILL_NAME,
] as const;

/**
 * The kind of the one block a companion run emits. The opener is three
 * backticks, `json`, a space, then this kind (companion-report-finish.ts).
 */
export const COMPANION_REPORT_KIND = "companion-report";

/** Must equal the writer's tagged opener (pinned by companion-report-finish.test.ts). */
const COMPANION_REPORT_OPENER = "```json companion-report";

/**
 * Contract check for a companion skill: the control plane posts only what the
 * agent emits in ONE tagged `json companion-report` block, so a body that
 * cannot teach that block would answer every PR with the no-report notice.
 * The block must carry `findings` with severities, the body must end with a
 * `## Hard rules` section (its absence means truncation), there is no second
 * block after the Hard rules (the writer reads the LAST one), and the body
 * never teaches a `"verdict"` key: a companion report is never a review
 * (ADR-009), so a verdict contract means the wrong skill was pushed.
 * indexOf, not one regex (a repo-controlled override body).
 */
export function assertCompanionSkillContract(
  body: string,
  sourceLabel: string,
): void {
  const fail = (what: string): never => {
    throw new Error(
      `Companion skill from ${sourceLabel} ${what} — wrong content or a ` +
        `truncated skill. Refusing to dispatch a companion whose report ` +
        `could not be parsed.`,
    );
  };
  const opener = body.indexOf(COMPANION_REPORT_OPENER);
  if (opener < 0) fail(`has no "${COMPANION_REPORT_OPENER}" block`);
  const kind = body.indexOf(`"${COMPANION_REPORT_KIND}"`, opener);
  const findings = kind < 0 ? -1 : body.indexOf('"findings"', kind);
  const severity = findings < 0 ? -1 : body.indexOf('"severity"', findings);
  if (kind < 0 || findings < 0 || severity < 0) {
    fail(
      `has no "${COMPANION_REPORT_KIND}" contract with "findings" and "severity"`,
    );
  }
  if (body.indexOf("```", severity) < 0) fail("has an unclosed report block");
  if (body.includes('"verdict"')) {
    fail('teaches a "verdict" key (a companion report is never a review)');
  }
  const hard = body.search(/^## Hard rules\s*$/m);
  if (hard < 0) fail('has no "## Hard rules" section');
  if (body.indexOf(COMPANION_REPORT_OPENER, hard) >= 0) {
    fail(
      `has a second "${COMPANION_REPORT_OPENER}" block after the Hard rules`,
    );
  }
}

/** The automation-skill stamp of a companion-lane thread. */
export type CompanionLaneThreadStamp = AutomationSkillStamp & {
  companion: NonNullable<AutomationSkillStamp["companion"]>;
};

/** True for a thread a PR companion automation started. */
export function isCompanionLaneStamp(
  sourceMetadata: ThreadSourceMetadata | null | undefined,
): sourceMetadata is CompanionLaneThreadStamp {
  return (
    sourceMetadata?.type === "automation-skill" &&
    sourceMetadata.companion !== undefined
  );
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
/**
 * The Flutter PR-review skill (ported from the legacy orchestrator). Same
 * emit-only verdict contract as github-ops, so the same validator: a Flutter
 * body without the fenced-json verdict must never be dispatched either.
 */
export const FLUTTER_REVIEW_SKILL_NAME = "flutter-pr-review";

type SkillValidator = (body: string, sourceLabel: string) => void;

/**
 * A lane that never resolves a review mode (mention, companion, audit) gets
 * the classic render (#492), so its contract is checked on that text.
 */
function onClassicRender(validate: SkillValidator): SkillValidator {
  return (body, sourceLabel) =>
    validate(renderReviewModeSections(body), sourceLabel);
}

const SKILL_VALIDATORS: Record<string, SkillValidator> = {
  // Review skills resolve a mode: their contract must survive every render.
  "github-ops": assertReviewSkillContract,
  [FLUTTER_REVIEW_SKILL_NAME]: assertReviewSkillContract,
  [PR_MERGED_SKILL_NAME]: onClassicRender(assertMergeAuditSkillContract),
  [AUDIT_FINDINGS_SKILL_NAME]: onClassicRender(
    assertAuditFindingsSkillContract,
  ),
  [AUDIT_FIX_SKILL_NAME]: onClassicRender(assertAuditFixSkillContract),
  [MENTION_SKILL_NAME]: onClassicRender(assertMentionSkillContract),
  [FLUTTER_COMPANION_SKILL_NAME]: onClassicRender(assertCompanionSkillContract),
  [REACT_COMPANION_SKILL_NAME]: onClassicRender(assertCompanionSkillContract),
};

export function validateSkillBody(
  skillName: string,
  body: string,
  sourceLabel: string,
): void {
  // Every body's sections are rendered (#492), so a broken grammar is refused
  // here instead of failing the run at render time.
  assertSectionGrammar(body, `Skill '${skillName}' body from ${sourceLabel}`);
  const validator = SKILL_VALIDATORS[skillName];
  if (validator) {
    validator(body, sourceLabel);
    return;
  }
  // An unregistered skill may run as a PR review in any mode.
  if (everyRender(body).some((render) => render.trim().length === 0)) {
    throw new Error(
      `Skill '${skillName}' body from ${sourceLabel} is empty — refusing to ` +
        `dispatch an automation run with no instruction.`,
    );
  }
}
