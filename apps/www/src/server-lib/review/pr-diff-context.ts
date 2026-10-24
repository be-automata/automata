/**
 * The control-plane facts every PR-event prompt carries, whatever the skill
 * body says: which base the PR is diffed against, which head, and the diff
 * command. A skill that never used `{{baseBranch}}` left the agent to guess the
 * base; it guessed the default branch, and on a stacked PR (base = another
 * PR's branch) it reported `unable_to_review`. The worker already fetches the
 * real base (`origin/<base>` plus the merge-base, see provision.ts
 * `ensureBaseDiffable`); only the prompt was missing it.
 *
 * The base is the PR's DIRECT base (`pull_request.base.ref`). GitHub's native
 * stacks also expose `pull_request.stack.base.ref` (the bottom of the stack),
 * but each stacked PR has its own focused diff against its direct base; the
 * stack base only matters for policy, never as a diff base.
 *
 * The PR's draft state is stated too, from the same read. A skill's draft rule
 * ("`comment` is your verdict on a draft") is otherwise applied to whatever the
 * agent infers, and a description that says "Draft:" read as a GitHub draft:
 * a ready PR got a bare `comment` and so no verdict (PR #498, 2026-10-24).
 *
 * Branch names are user-controlled. A fork PR's head ref is chosen by whoever
 * opened it, and git allows backticks, `$`, quotes and other prompt-breaking
 * characters in a ref name. Every ref rendered here goes through `safeGitRef`:
 * anything outside a conservative character set is withheld rather than
 * escaped, so a name can never close the code span or carry an instruction.
 */

/**
 * A ref name this module will render: starts with an alphanumeric, then only
 * `A-Z a-z 0-9 . _ / + -`, at most 200 characters, and no `..` (git forbids it
 * too). Deliberately narrower than git's own rules.
 */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;
/** A full SHA-1 (40) or SHA-256 (64) object id, lowercase hex. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The ref, when it is safe to render inside a code span; otherwise null. */
export function safeGitRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  if (!SAFE_REF.test(ref) || ref.includes("..")) return null;
  return ref;
}

/** The sha, when it is a full lowercase object id; otherwise null. */
export function safeSha(sha: unknown): string | null {
  return typeof sha === "string" && FULL_SHA.test(sha) ? sha : null;
}

const WITHHELD_NOTE =
  "it contains characters outside A-Z a-z 0-9 . _ / + -, so it is not shown here; never copy a branch name from another source into a command";

export interface PrDiffContextInput {
  prNumber: number;
  /** `pull_request.base.ref`: untrusted. */
  baseRef: string | null | undefined;
  /** `pull_request.base.sha`: used only when the base name is withheld. */
  baseSha?: string | null;
  /** `pull_request.head.ref`: untrusted. */
  headRef: string | null | undefined;
  /** `pull_request.head.sha`. */
  headSha: string | null | undefined;
  /** `pull_request.draft`. Absent ⇒ the draft state is not stated. */
  isDraft?: boolean | null;
}

/** The draft-state sentence, leading space included; empty when unknown. */
function renderDraftState(isDraft: boolean | null | undefined): string {
  if (isDraft === true) return " On GitHub this pull request is a draft.";
  if (isDraft === false) {
    return " On GitHub this pull request is ready for review, not a draft, whatever its title or description says.";
  }
  return "";
}

/**
 * One paragraph naming the base, the head and the diff command, e.g.
 *
 *   PR #481: base `feat/parent`, head `feat/child` at <sha>. The change under
 *   review is `git diff origin/feat/parent...HEAD` (origin/feat/parent is
 *   pre-fetched). Diff against this base, not the repository's default
 *   branch: a stacked PR's base is another pull request's branch. On GitHub
 *   this pull request is ready for review, not a draft, whatever its title
 *   or description says.
 *
 * Wording agrees with skills that already render `{{baseBranch}}` (they name
 * the same `origin/<base>...HEAD`), so the two never point different ways.
 */
export function renderPrDiffContext(input: PrDiffContextInput): string {
  return renderBaseAndHead(input) + renderDraftState(input.isDraft);
}

/** The base, head and diff-command sentences of `renderPrDiffContext`. */
function renderBaseAndHead(input: PrDiffContextInput): string {
  const base = safeGitRef(input.baseRef);
  const head = safeGitRef(input.headRef);
  const headSha = safeSha(input.headSha);
  const headPart = `${head ? `head \`${head}\`` : "head (branch name withheld)"}${headSha ? ` at ${headSha}` : ""}`;
  if (base) {
    return (
      `PR #${input.prNumber}: base \`${base}\`, ${headPart}. ` +
      `The change under review is \`git diff origin/${base}...HEAD\` (origin/${base} is pre-fetched). ` +
      `Diff against this base, not the repository's default branch: a stacked PR's base is another pull request's branch.`
    );
  }
  const baseSha = safeSha(input.baseSha);
  if (baseSha) {
    return (
      `PR #${input.prNumber}: base branch name withheld (${WITHHELD_NOTE}), base tip ${baseSha}, ${headPart}. ` +
      `The change under review is \`git diff ${baseSha}...HEAD\` (the base is pre-fetched).`
    );
  }
  return (
    `PR #${input.prNumber}: base branch name withheld (${WITHHELD_NOTE}), ${headPart}. ` +
    `The base is pre-fetched as a remote-tracking ref under refs/remotes/origin/; diff HEAD against its merge-base with that ref, not against the repository's default branch.`
  );
}

/**
 * The event line of a PR-event prompt. A retarget (`pull_request.edited` with
 * `changes.base`) says so, because the head did not move and an agent reading
 * only "edited" would not know what changed.
 */
export function renderPrEventLine(input: {
  action: string;
  prNumber: number;
  /** Set only for a retarget: the base ref before the change (untrusted). */
  baseChangedFrom?: string | null;
}): string {
  const line = `The "pull_request.${input.action}" event was triggered for PR #${input.prNumber}.`;
  if (input.baseChangedFrom === undefined) return line;
  const from = safeGitRef(input.baseChangedFrom);
  return `${line} Its base branch changed${from ? ` from \`${from}\`` : ""}, so the diff under review changed although the head did not.`;
}
