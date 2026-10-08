import type { DBMessage } from "@terragon/shared/db/db-message";

import { findLastLeadAgentText } from "@/server-lib/review/lead-text";
import { buildTaggedFence } from "@/server-lib/review/tagged-fence";

/**
 * The pull request title and body a remote task run's agent wrote itself.
 *
 * The agent is the only party that knows what it changed, why, and which gates
 * it ran, so a task prompt can ask it to end its final message with
 *
 *   ```json pull-request
 *   {"title": "feat(scope): summary", "body": "## Summary\n..."}
 *   ```
 *
 * and the platform opens the PR with exactly that content (it holds the only
 * GitHub write credential). The same tagged-fence rules as the review intent
 * apply: a whole fence line opens it, the LAST opener in the last lead agent
 * message that has one decides, sub-agent messages never count.
 *
 * Anything malformed returns null and the caller falls back to generated
 * content, so a bad block can never stop the PR from opening.
 */

const PULL_REQUEST_FENCE = buildTaggedFence("pull-request");

/** GitHub rejects longer titles; a "title" this long is a body pasted wrong. */
export const AGENT_PR_TITLE_MAX = 256;
/** GitHub's body cap is 65536; leave room for the task link appended after. */
export const AGENT_PR_BODY_MAX = 60_000;

export interface AgentPrContent {
  title: string;
  body: string;
}

export function parseAgentPrContent(
  messages: DBMessage[] | null,
): AgentPrContent | null {
  const text = findLastLeadAgentText(messages, PULL_REQUEST_FENCE.hasOpener);
  if (text === null) {
    return null;
  }
  const extracted = PULL_REQUEST_FENCE.extractLast(text);
  if (!extracted?.ok) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(extracted.payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { title, body } = value as { title?: unknown; body?: unknown };
  if (typeof title !== "string" || typeof body !== "string") {
    return null;
  }
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (
    trimmedTitle === "" ||
    trimmedTitle.length > AGENT_PR_TITLE_MAX ||
    /[\r\n]/.test(trimmedTitle) ||
    trimmedBody === "" ||
    trimmedBody.length > AGENT_PR_BODY_MAX
  ) {
    return null;
  }
  return { title: trimmedTitle, body: trimmedBody };
}
