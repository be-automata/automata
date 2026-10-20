/**
 * Review context blocks — what a review agent learns about the PR before it
 * starts, rendered byte-for-byte in the legacy orchestrator's shapes
 * (`src/intake/context-fetchers.ts` + `src/integration/github-client.ts` @
 * b337099). The ported review skills match these shapes LITERALLY — the
 * `<prior_reviews>` / `<review_threads>` tags, the `comment_id:` field a
 * resolved thread is keyed on, the empty-block scope note — so a cosmetic
 * change here silently degrades every review.
 *
 * Pure: the control plane fetches with the App token
 * (apps/www/src/server-lib/review/prefetch-review-context.ts) and the replay
 * tool fetches with the operator's token; both render through this module.
 */
import { capHeadTail, wrapUntrusted } from "./untrusted";

/** Each block's budget before wrapping (legacy MAX_FETCHER_CONTEXT_CHARS). */
export const REVIEW_CONTEXT_BLOCK_MAX_CHARS = 24_000;

/** A prior review body is clipped here (legacy: 4000 holds a full structured body). */
const PRIOR_REVIEW_BODY_MAX_CHARS = 4000;
/** A thread comment body is clipped here. */
const THREAD_COMMENT_MAX_CHARS = 1000;

const SECTION_SEPARATOR = "\n\n---\n\n";

export interface PrViewData {
  number: number;
  title: string;
  /** gh casing: OPEN | CLOSED | MERGED. */
  state: string;
  isDraft: boolean;
  authorLogin: string | null;
  labels: readonly string[];
  url: string;
  headRefName: string;
  baseRefName: string;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** gh casing: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
  /** gh casing: CLEAN | DIRTY | BLOCKED | … */
  mergeStateStatus: string;
  body: string | null;
}

export interface PriorReviewData {
  authorLogin: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  commitId: string | null;
  body: string | null;
}

export interface ReviewThreadCommentData {
  databaseId: number | null;
  authorLogin: string | null;
  body: string | null;
}

export interface ReviewThreadData {
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: readonly ReviewThreadCommentData[];
  /** The thread has more comments than were fetched. */
  commentsTruncated?: boolean;
}

/** gh's non-TTY `pr view` shape: `key:\tvalue` lines, `--`, then the body. */
export function renderPrView(pr: PrViewData): string {
  const fields: Array<[string, string | number | null]> = [
    ["title", pr.title],
    ["state", pr.state],
    ["draft", pr.isDraft ? "true" : "false"],
    ["author", pr.authorLogin ?? ""],
    ["labels", pr.labels.join(", ")],
    ["number", pr.number],
    ["url", pr.url],
    ["headRefName", pr.headRefName],
    ["baseRefName", pr.baseRefName],
    ["additions", pr.additions],
    ["deletions", pr.deletions],
    ["changedFiles", pr.changedFiles],
    ["mergeable", pr.mergeable],
    ["mergeStateStatus", pr.mergeStateStatus],
  ];
  const header = fields.map(([k, v]) => `${k}:\t${v ?? ""}`).join("\n");
  return `${header}\n--\n${(pr.body ?? "").trim()}`;
}

/**
 * Every prior review (all authors), oldest first as GitHub lists them, with
 * whether it is still in force. A review is `dismissed` iff GitHub reports
 * `state === "DISMISSED"`; every other state is `outstanding`.
 */
export function renderPriorReviews(
  reviews: readonly PriorReviewData[],
): string {
  if (reviews.length === 0) return '<prior_reviews count="0" />';
  const lines: string[] = [`<prior_reviews count="${reviews.length}">`];
  for (const r of reviews) {
    const login = r.authorLogin ?? "unknown";
    const commit = r.commitId ? r.commitId.slice(0, 8) : "unknown";
    const standing = r.state === "DISMISSED" ? "dismissed" : "outstanding";
    lines.push(
      `  - author: ${login} | state: ${r.state} | commit: ${commit} | ${standing}`,
    );
    const body = (r.body ?? "").trim();
    if (body.length > 0) {
      const clipped =
        body.length > PRIOR_REVIEW_BODY_MAX_CHARS
          ? `${body.slice(0, PRIOR_REVIEW_BODY_MAX_CHARS)}…`
          : body;
      lines.push("    asks: |");
      for (const bl of clipped.split("\n")) lines.push(`      ${bl}`);
    }
  }
  lines.push("</prior_reviews>");
  return lines.join("\n");
}

/**
 * The PR's UNRESOLVED review threads — line-level asks only. The empty form
 * states its own scope: body-only asks create no thread, so an empty block is
 * never on its own evidence that nothing is outstanding (legacy measured five
 * consecutive reviews reading a bare empty block as full clearance).
 */
export function renderReviewThreads(
  threads: readonly ReviewThreadData[],
  opts: { truncated?: boolean } = {},
): string {
  const open = threads.filter((t) => !t.isResolved);
  const truncatedAttr = opts.truncated ? ' truncated="true"' : "";
  if (open.length === 0) {
    return (
      `<review_threads unresolved="0" scope="line-level-only"${truncatedAttr} ` +
      'note="No LINE-LEVEL asks are open. Body-only asks create no thread and are NOT ' +
      "represented here — reconcile those from the <prior_reviews> bodies and verify each " +
      'at HEAD. This block being empty is never on its own evidence that nothing is outstanding." />'
    );
  }
  const lines: string[] = [
    `<review_threads unresolved="${open.length}" scope="line-level-only"${truncatedAttr}>`,
  ];
  for (const t of open) {
    const where = t.path
      ? `${t.path}${t.line !== null ? `:${t.line}` : ""}`
      : "(file-level)";
    const commentId = t.comments.find((c) => c.databaseId !== null)?.databaseId;
    const idTag = commentId != null ? ` | comment_id: ${commentId}` : "";
    const moreTag = t.commentsTruncated ? ' | comments_truncated="true"' : "";
    lines.push(`  - thread: ${where} | unresolved${idTag}${moreTag}`);
    if (t.comments.length > 0) {
      lines.push("    comments: |");
      for (const c of t.comments) {
        const who = c.authorLogin ?? "unknown";
        const body = (c.body ?? "").trim();
        const clipped =
          body.length > THREAD_COMMENT_MAX_CHARS
            ? `${body.slice(0, THREAD_COMMENT_MAX_CHARS)}…`
            : body;
        for (const bl of `@${who}: ${clipped}`.split("\n")) {
          lines.push(`      ${bl}`);
        }
      }
    }
  }
  lines.push("</review_threads>");
  return lines.join("\n");
}

/** One fetched block, or why it could not be fetched. */
export type ReviewContextBlock =
  | { name: string; content: string }
  | { name: string; unavailable: string };

/**
 * Join the blocks into the text that replaces a skill's context directive:
 * each capped (head + tail) and wrapped as untrusted, separated by `---`. A
 * block that could not be fetched says so — the run is never blocked on it.
 */
export function renderReviewContext(
  blocks: readonly ReviewContextBlock[],
  maxChars: number = REVIEW_CONTEXT_BLOCK_MAX_CHARS,
): string {
  return blocks
    .map((block) => {
      if ("unavailable" in block) {
        return wrapUntrusted(
          `<${block.name} unavailable="true" reason="${block.unavailable.replace(/"/g, "'")}" />`,
          block.name,
        );
      }
      const { text, truncated } = capHeadTail(block.content, maxChars);
      const body = truncated
        ? `${text}\n[block "${block.name}" truncated to ${maxChars} chars]`
        : text;
      return wrapUntrusted(body, block.name);
    })
    .join(SECTION_SEPARATOR);
}
