import type { TicketKeyExtraction } from "./extract-ticket-keys";
import {
  describeTrackerError,
  type TrackerClient,
  type TrackerIssue,
} from "./youtrack-client";

/**
 * Builds the two context blocks appended to the post-merge skill body at
 * intake (ADR-008): the trigger (which PR was merged) and the tracker context
 * (the tickets it names, fetched by the control plane so the agent needs no
 * tracker token).
 *
 * Everything in these blocks is third-party-authored text — a PR title, a
 * ticket description, a ticket comment. It is wrapped in `<user_content>` tags
 * and the skill body tells the agent to treat it as data. Any closing tag
 * inside the content is defused so it cannot end the wrapper early.
 */

// A hardened ticket runs to ~25k characters; a tighter cap cut the DoD and UAT
// sections off the very ticket being audited.
const MAX_DESCRIPTION_CHARS = 60_000;
const MAX_COMMENTS = 10;
// Comments are where a miss gets accepted ("AC-3 deferred to ACME-901"). A
// tight cap cut that sentence off and the audit called the miss unacknowledged.
const MAX_COMMENT_CHARS = 4_000;
const MAX_PR_BODY_CHARS = 8_000;

const TRACKER_CONTEXT_HEADER = "## Tracker context";

export interface MergedPrTrigger {
  prNumber: number;
  title?: string | null;
  body?: string | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  htmlUrl?: string | null;
  mergedBy?: string | null;
  mergeCommitSha?: string | null;
}

function fence(content: string): string {
  return content.replace(/<\/?user_content/gi, (tag) => tag.replace("<", "< "));
}

function clip(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}\n… (truncated)`
    : text;
}

/** Header fields sit outside the fence, so they must stay on one line. */
function oneLine(text: string): string {
  return fence(text.replace(/\s+/g, " ").trim()).slice(0, 200);
}

export function buildTriggerBlock(
  repoFullName: string,
  trigger: MergedPrTrigger,
): string {
  const lines = [
    "## Trigger",
    "",
    `- Repository: ${repoFullName}`,
    `- Pull request: #${trigger.prNumber}`,
  ];
  if (trigger.htmlUrl) lines.push(`- URL: ${trigger.htmlUrl}`);
  if (trigger.baseBranch) {
    lines.push(`- Merged into: ${oneLine(trigger.baseBranch)}`);
  }
  if (trigger.mergeCommitSha) {
    lines.push(`- Merge commit: ${trigger.mergeCommitSha}`);
  }
  lines.push(
    "",
    "<user_content>",
    `title: ${fence(trigger.title ?? "")}`,
    `head branch: ${fence(trigger.headBranch ?? "")}`,
    `merged by: ${fence(trigger.mergedBy ?? "")}`,
    "body:",
    fence(clip(trigger.body ?? "", MAX_PR_BODY_CHARS)),
    "</user_content>",
  );
  return lines.join("\n");
}

/**
 * The tracker-context block for a merge with nothing to audit. The skill body
 * keys off this header and instruction, so every such case is worded here.
 */
export function trackerContextNotice(reason: string): string {
  return `${TRACKER_CONTEXT_HEADER}\n\n${reason} Emit an intent with an empty \`tickets\` array.`;
}

function roleOf(key: string, extraction: TicketKeyExtraction): string {
  return key === extraction.primary ? "primary" : "closed by this PR";
}

function renderIssue(issue: TrackerIssue, role: string): string {
  const links = issue.links.flatMap((link) =>
    link.issues.map(
      (linked) =>
        `${link.verb || link.typeName} ${linked.key} (${linked.resolved ? "resolved" : (linked.stage ?? "unknown stage")})`,
    ),
  );
  const comments = issue.comments.slice(-MAX_COMMENTS);
  return [
    `### ${issue.key} (${role})`,
    "",
    `- Stage: ${issue.stage ?? "unknown"}${issue.resolved ? " (resolved)" : ""}`,
    `- Links: ${links.length > 0 ? fence(links.join("; ")) : "none"}`,
    "",
    "<user_content>",
    `summary: ${fence(issue.summary)}`,
    "description:",
    fence(clip(issue.description, MAX_DESCRIPTION_CHARS)),
    ...(issue.description.length > MAX_DESCRIPTION_CHARS
      ? [
          "(The description above was cut. Audit what is visible and say in `remaining` that the ticket was truncated.)",
        ]
      : []),
    ...(comments.length > 0
      ? [
          "",
          `recent comments (${comments.length}):`,
          ...comments.map(
            (comment) => `- ${fence(clip(comment.text, MAX_COMMENT_CHARS))}`,
          ),
        ]
      : []),
    "</user_content>",
  ].join("\n");
}

/**
 * Never throws: an unreachable tracker must not stop the thread from being
 * created. A failed ticket is named in the block so the agent emits no verdicts
 * for it, and the finish executor reports the failure on the PR.
 */
export async function buildTrackerContextBlock({
  tracker,
  extraction,
}: {
  tracker: TrackerClient;
  extraction: TicketKeyExtraction;
}): Promise<string> {
  if (extraction.auditKeys.length === 0) {
    return trackerContextNotice(
      extraction.referencedKeys.length === 0
        ? "No ticket key was found in the PR title, description or branch name."
        : `The PR mentions ${extraction.referencedKeys.join(", ")} but names none as the ticket it delivers (title, head branch or a closing keyword).`,
    );
  }
  // Independent reads: one slow or failing ticket must not stretch the webhook
  // by the others' timeouts.
  const sections = await Promise.all(
    extraction.auditKeys.map(async (key) => {
      try {
        return renderIssue(
          await tracker.getIssue(key),
          roleOf(key, extraction),
        );
      } catch (error) {
        const detail = describeTrackerError(error);
        console.warn("[tracker-context] ticket prefetch failed", {
          key,
          detail,
        });
        return `### ${key}\n\nTracker unavailable for this ticket (${detail}). Do not emit an entry for it.`;
      }
    }),
  );
  if (extraction.referencedKeys.length > 0) {
    // Named so the agent can recognise a deferral ("AC-3 deferred to ACME-901")
    // — not fetched, and never to be audited.
    sections.push(
      `### Referenced only\n\n${extraction.referencedKeys.join(", ")} — mentioned by the PR, not delivered by it. Do not audit these and do not emit entries for them.`,
    );
  }
  return [TRACKER_CONTEXT_HEADER, ...sections].join("\n\n");
}
